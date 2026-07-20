//! Durable worker sessions, claims, transfer capabilities, and fenced mutations.

use super::config::AuthenticatedWorker;
use super::model::{
    processing_retry_delay, ProcessingJobState, ProcessingOperation, ProcessingPhase,
};
use super::operation_contract::ArtifactSizeClass;
use super::persistence::store_blob;
use super::worker_protocol::{
    ClaimHeartbeatResponse, ClaimHeartbeatState, CompletedArtifactInput, IssuedTransfer,
    WorkerClaim, WorkerClaimInput, WorkerClaimLimits, WorkerFailureClass,
    WorkerProcessorAdvertisement,
};
use super::ProcessingConfig;
use chrono::{DateTime, Duration, Utc};
use rand::distr::{Alphanumeric, SampleString};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use subtle::ConstantTimeEq;
use thiserror::Error;
use uuid::Uuid;

const INPUT_TRANSFER_READS: i32 = 3;
const MAX_PROCESSORS_PER_SESSION: usize = 16;
const MAX_WORKER_SLOTS: i32 = 64;

pub(super) struct RegisteredSession {
    pub id: Uuid,
}

pub(super) struct ProcessorCapacityOffer {
    pub operation: ProcessingOperation,
    pub processor_contract: String,
    pub slots: i32,
}

struct RegisteredProcessor {
    operation: ProcessingOperation,
    processor_contract: String,
    slots: i32,
    healthy: bool,
}

#[derive(Debug, Error)]
pub(super) enum WorkerSessionError {
    #[error("worker session was not found")]
    NotFound,
    #[error("worker session has expired")]
    Expired,
    #[error("worker session is draining")]
    Draining,
    #[error("worker session request is invalid")]
    Invalid,
    #[error("worker session persistence failed")]
    Persistence(#[source] sqlx::Error),
}

#[derive(Debug, Error)]
pub(super) enum ClaimError {
    #[error("worker session is unavailable")]
    SessionUnavailable,
    #[error("worker claim was lost")]
    Lost,
    #[error("worker claim request is invalid")]
    Invalid,
    #[error("worker claim persistence failed")]
    Persistence(#[source] sqlx::Error),
}

pub(super) enum TransferDownloadOutcome {
    Content {
        content: Vec<u8>,
        media_type: String,
        sha256: Vec<u8>,
    },
    Rejected,
}

pub(super) enum TransferUploadOutcome {
    Stored { size_bytes: i64, sha256: Vec<u8> },
    Rejected,
    TooLarge,
    DigestMismatch,
}

pub(super) enum CompleteClaimOutcome {
    Accepted { job_id: Uuid },
    Lost,
    Cancelled,
    Invalid,
}

pub(super) enum ClaimMutationOutcome {
    Updated {
        job_id: Uuid,
        state: ProcessingJobState,
    },
    Lost,
}

pub(super) struct ArtifactTransferRequest<'a> {
    pub session_id: Uuid,
    pub claim_id: Uuid,
    pub role: &'a str,
    pub media_type: &'a str,
    pub filename: &'a str,
    pub size_bytes: i64,
    pub expected_sha256: &'a [u8],
}

pub(super) async fn register_session(
    db: &PgPool,
    worker: &AuthenticatedWorker,
    worker_instance: &str,
    processors: &[WorkerProcessorAdvertisement],
    config: &ProcessingConfig,
) -> Result<RegisteredSession, WorkerSessionError> {
    if worker_instance.trim().is_empty()
        || worker_instance.len() > 128
        || processors.is_empty()
        || processors.len() > MAX_PROCESSORS_PER_SESSION
    {
        return Err(WorkerSessionError::Invalid);
    }
    let mut unique = std::collections::HashSet::new();
    for processor in processors {
        if processor.slots <= 0
            || processor.slots > MAX_WORKER_SLOTS
            || processor.runtime_version.trim().is_empty()
            || processor.runtime_version.len() > 256
            || !worker.approves(processor.operation, &processor.processor_contract)
            || !unique.insert((processor.operation, processor.processor_contract.as_str()))
        {
            return Err(WorkerSessionError::Invalid);
        }
    }
    let now = Utc::now();
    let expires_at = now + config.session_lease;
    let id = Uuid::new_v4();
    let mut transaction = db.begin().await.map_err(WorkerSessionError::Persistence)?;
    sqlx::query(
        "insert into processing_worker_sessions (
             id, worker_identity, worker_instance, protocol_version, state,
             created_at, updated_at, last_heartbeat_at, expires_at
         ) values ($1, $2, $3, 1, 'active', $4, $4, $4, $5)",
    )
    .bind(id)
    .bind(&worker.identity)
    .bind(worker_instance)
    .bind(now)
    .bind(expires_at)
    .execute(&mut *transaction)
    .await
    .map_err(WorkerSessionError::Persistence)?;
    for processor in processors {
        sqlx::query(
            "insert into processing_worker_processors (
                 session_id, operation, processor_contract, runtime_version,
                 slots, healthy, updated_at
             ) values ($1, $2, $3, $4, $5, true, $6)",
        )
        .bind(id)
        .bind(processor.operation)
        .bind(&processor.processor_contract)
        .bind(&processor.runtime_version)
        .bind(processor.slots)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(WorkerSessionError::Persistence)?;
    }
    transaction
        .commit()
        .await
        .map_err(WorkerSessionError::Persistence)?;
    Ok(RegisteredSession { id })
}

pub(super) async fn heartbeat_session(
    db: &PgPool,
    worker: &AuthenticatedWorker,
    session_id: Uuid,
    processors: &[(ProcessingOperation, String, bool)],
    config: &ProcessingConfig,
) -> Result<DateTime<Utc>, WorkerSessionError> {
    let now = Utc::now();
    let expires_at = now + config.session_lease;
    let mut transaction = db.begin().await.map_err(WorkerSessionError::Persistence)?;
    let row = sqlx::query(
        "select state, expires_at from processing_worker_sessions
         where id = $1 and worker_identity = $2 for update",
    )
    .bind(session_id)
    .bind(&worker.identity)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(WorkerSessionError::Persistence)?
    .ok_or(WorkerSessionError::NotFound)?;
    let state: &str = row
        .try_get("state")
        .map_err(WorkerSessionError::Persistence)?;
    let previous_expiry: DateTime<Utc> = row
        .try_get("expires_at")
        .map_err(WorkerSessionError::Persistence)?;
    if state == "draining" {
        return Err(WorkerSessionError::Draining);
    }
    if state != "active" || previous_expiry <= now {
        sqlx::query(
            "update processing_worker_sessions set state = 'expired', updated_at = $2
             where id = $1",
        )
        .bind(session_id)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(WorkerSessionError::Persistence)?;
        transaction
            .commit()
            .await
            .map_err(WorkerSessionError::Persistence)?;
        return Err(WorkerSessionError::Expired);
    }
    let expected: i64 = sqlx::query_scalar(
        "select count(*) from processing_worker_processors where session_id = $1",
    )
    .bind(session_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(WorkerSessionError::Persistence)?;
    if usize::try_from(expected).ok() != Some(processors.len()) {
        return Err(WorkerSessionError::Invalid);
    }
    let mut unique = std::collections::HashSet::new();
    for (operation, contract, healthy) in processors {
        if !unique.insert((*operation, contract.as_str())) {
            return Err(WorkerSessionError::Invalid);
        }
        let result = sqlx::query(
            "update processing_worker_processors
             set healthy = $4, updated_at = $5
             where session_id = $1 and operation = $2 and processor_contract = $3
            ",
        )
        .bind(session_id)
        .bind(operation)
        .bind(contract)
        .bind(healthy)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(WorkerSessionError::Persistence)?;
        if result.rows_affected() != 1 {
            return Err(WorkerSessionError::Invalid);
        }
    }
    sqlx::query(
        "update processing_worker_sessions
         set last_heartbeat_at = $2, updated_at = $2, expires_at = $3
         where id = $1",
    )
    .bind(session_id)
    .bind(now)
    .bind(expires_at)
    .execute(&mut *transaction)
    .await
    .map_err(WorkerSessionError::Persistence)?;
    transaction
        .commit()
        .await
        .map_err(WorkerSessionError::Persistence)?;
    Ok(expires_at)
}

pub(super) async fn drain_session(
    db: &PgPool,
    worker: &AuthenticatedWorker,
    session_id: Uuid,
) -> Result<(), WorkerSessionError> {
    let result = sqlx::query(
        "update processing_worker_sessions
         set state = 'draining', updated_at = $3
         where id = $1 and worker_identity = $2 and state in ('active', 'draining')",
    )
    .bind(session_id)
    .bind(&worker.identity)
    .bind(Utc::now())
    .execute(db)
    .await
    .map_err(WorkerSessionError::Persistence)?;
    if result.rows_affected() == 0 {
        return Err(WorkerSessionError::NotFound);
    }
    Ok(())
}

pub(super) async fn try_claim(
    db: &PgPool,
    worker: &AuthenticatedWorker,
    session_id: Uuid,
    offers: &[ProcessorCapacityOffer],
    config: &ProcessingConfig,
) -> Result<Option<WorkerClaim>, ClaimError> {
    let now = Utc::now();
    let mut transaction = db.begin().await.map_err(ClaimError::Persistence)?;
    let session = sqlx::query(
        "select state, expires_at from processing_worker_sessions
         where id = $1 and worker_identity = $2 for update",
    )
    .bind(session_id)
    .bind(&worker.identity)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(ClaimError::Persistence)?
    .ok_or(ClaimError::SessionUnavailable)?;
    let state: &str = session.try_get("state").map_err(ClaimError::Persistence)?;
    let expires_at: DateTime<Utc> = session
        .try_get("expires_at")
        .map_err(ClaimError::Persistence)?;
    if state != "active" || expires_at <= now {
        return Err(ClaimError::SessionUnavailable);
    }
    let processor_rows = sqlx::query(
        "select operation, processor_contract, slots, healthy
         from processing_worker_processors
         where session_id = $1
         order by operation, processor_contract",
    )
    .bind(session_id)
    .fetch_all(&mut *transaction)
    .await
    .map_err(ClaimError::Persistence)?;

    let mut processors = Vec::with_capacity(processor_rows.len());
    for row in processor_rows {
        processors.push(RegisteredProcessor {
            operation: row.try_get("operation").map_err(ClaimError::Persistence)?,
            processor_contract: row
                .try_get("processor_contract")
                .map_err(ClaimError::Persistence)?,
            slots: row.try_get("slots").map_err(ClaimError::Persistence)?,
            healthy: row.try_get("healthy").map_err(ClaimError::Persistence)?,
        });
    }

    for offer in offers {
        if !worker.approves(offer.operation, &offer.processor_contract) {
            return Err(ClaimError::Invalid);
        }
        let Some(processor) = processors.iter().find(|processor| {
            processor.operation == offer.operation
                && processor.processor_contract == offer.processor_contract
        }) else {
            return Err(ClaimError::Invalid);
        };
        if offer.slots <= 0 || offer.slots > processor.slots {
            return Err(ClaimError::Invalid);
        }
        if !processor.healthy {
            continue;
        }
        let operation = processor.operation;
        let processor_contract = processor.processor_contract.clone();
        let active: i64 = sqlx::query_scalar(
            "select count(*)
             from processing_attempts attempts
             join processing_jobs jobs on jobs.id = attempts.job_id
             where attempts.worker_session_id = $1
               and attempts.processor_contract = $2
               and jobs.operation = $3
               and attempts.state = 'running'
               and attempts.lease_expires_at > $4",
        )
        .bind(session_id)
        .bind(&processor_contract)
        .bind(operation)
        .bind(now)
        .fetch_one(&mut *transaction)
        .await
        .map_err(ClaimError::Persistence)?;
        let ceiling = i64::from(processor.slots);
        if active >= ceiling {
            continue;
        }
        let candidate = sqlx::query(
            "select jobs.id, jobs.requester_user_id, jobs.project_id,
                    jobs.attempt_count, jobs.normalized_options,
                    jobs.input_digest, jobs.options_digest,
                    jobs.input_schema, blobs.id as input_blob_id,
                    blobs.size_bytes, blobs.sha256
             from processing_jobs jobs
             join processing_blobs blobs on blobs.id = jobs.input_blob_id
             where jobs.operation = $1 and jobs.state = 'queued'
               and not jobs.cancellation_requested and jobs.queue_expires_at > $2
               and jobs.next_attempt_at <= $2
             order by jobs.created_at asc
             for update of jobs skip locked
             limit 1",
        )
        .bind(operation)
        .bind(now)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(ClaimError::Persistence)?;
        let Some(candidate) = candidate else {
            continue;
        };
        let job_id: Uuid = candidate.try_get("id").map_err(ClaimError::Persistence)?;
        let requester_user_id: Uuid = candidate
            .try_get("requester_user_id")
            .map_err(ClaimError::Persistence)?;
        let project_id: Option<Uuid> = candidate
            .try_get("project_id")
            .map_err(ClaimError::Persistence)?;
        let input_digest: Vec<u8> = candidate
            .try_get("input_digest")
            .map_err(ClaimError::Persistence)?;
        let options_digest: Vec<u8> = candidate
            .try_get("options_digest")
            .map_err(ClaimError::Persistence)?;
        let cache_source = sqlx::query_scalar::<_, Uuid>(
            "select prior.id
             from processing_jobs prior
             where prior.id <> $1 and prior.state = 'succeeded'
               and prior.operation = $2 and prior.input_digest = $3
               and prior.processor_contract = $4 and prior.options_digest = $5
               and prior.retained_until > $6
               and (($7::uuid is not null and prior.project_id = $7)
                    or ($7::uuid is null and prior.project_id is null
                        and prior.requester_user_id = $8))
               and exists (select 1 from processing_artifacts where job_id = prior.id)
             order by prior.completed_at desc
             limit 1",
        )
        .bind(job_id)
        .bind(operation)
        .bind(&input_digest)
        .bind(&processor_contract)
        .bind(&options_digest)
        .bind(now)
        .bind(project_id)
        .bind(requester_user_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(ClaimError::Persistence)?;
        if let Some(source_job_id) = cache_source {
            sqlx::query(
                "update processing_jobs
                 set state = 'finalizing', phase = 'validating_result',
                     processor_contract = $2, cache_hit = true,
                     cache_source_job_id = $3, updated_at = $4
                 where id = $1 and state = 'queued'",
            )
            .bind(job_id)
            .bind(&processor_contract)
            .bind(source_job_id)
            .bind(now)
            .execute(&mut *transaction)
            .await
            .map_err(ClaimError::Persistence)?;
            transaction
                .commit()
                .await
                .map_err(ClaimError::Persistence)?;
            return Ok(None);
        }
        let attempt_number: i32 = candidate
            .try_get::<i32, _>("attempt_count")
            .map_err(ClaimError::Persistence)?
            .saturating_add(1);
        let options: Value = candidate
            .try_get("normalized_options")
            .map_err(ClaimError::Persistence)?;
        let input_schema: String = candidate
            .try_get("input_schema")
            .map_err(ClaimError::Persistence)?;
        let input_blob_id: Uuid = candidate
            .try_get("input_blob_id")
            .map_err(ClaimError::Persistence)?;
        let input_size: i64 = candidate
            .try_get("size_bytes")
            .map_err(ClaimError::Persistence)?;
        let input_sha256: Vec<u8> = candidate
            .try_get("sha256")
            .map_err(ClaimError::Persistence)?;
        let attempt_id = Uuid::new_v4();
        let claim_id = Uuid::new_v4();
        let lease_expires_at = now + config.claim_lease;
        let limits = WorkerClaimLimits {
            wall_seconds: config.job_wall_seconds,
            output_bytes: config.max_output_bytes,
            diagnostic_bytes: config.max_diagnostic_bytes,
        };
        let limits_json = serde_json::to_value(&limits)
            .map_err(|error| ClaimError::Persistence(sqlx::Error::Protocol(error.to_string())))?;
        sqlx::query(
            "insert into processing_attempts (
                 id, job_id, attempt_number, claim_id, worker_session_id,
                 processor_contract, state, phase, lease_expires_at, limits,
                 created_at, updated_at
             ) values ($1, $2, $3, $4, $5, $6, 'running', 'processing', $7, $8, $9, $9)",
        )
        .bind(attempt_id)
        .bind(job_id)
        .bind(attempt_number)
        .bind(claim_id)
        .bind(session_id)
        .bind(&processor_contract)
        .bind(lease_expires_at)
        .bind(limits_json)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(ClaimError::Persistence)?;
        sqlx::query(
            "update processing_jobs
             set state = 'running', phase = 'processing', attempt_count = $2,
                 current_claim_id = $3, claim_expires_at = $4,
                 processor_contract = $5, started_at = coalesce(started_at, $6),
                 updated_at = $6
             where id = $1",
        )
        .bind(job_id)
        .bind(attempt_number)
        .bind(claim_id)
        .bind(lease_expires_at)
        .bind(&processor_contract)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(ClaimError::Persistence)?;
        let transfer = issue_transfer(
            &mut transaction,
            job_id,
            attempt_id,
            claim_id,
            "download",
            "input",
            operation.contract().input_media_type,
            None,
            Some(input_size),
            input_size,
            Some(&input_sha256),
            Some(input_blob_id),
            INPUT_TRANSFER_READS,
            now + config.transfer_ttl,
        )
        .await
        .map_err(ClaimError::Persistence)?;
        transaction
            .commit()
            .await
            .map_err(ClaimError::Persistence)?;
        return Ok(Some(WorkerClaim {
            job_id,
            attempt: attempt_number,
            claim_id,
            lease_expires_at,
            operation,
            processor_contract,
            options,
            input: WorkerClaimInput {
                schema: input_schema,
                size_bytes: input_size,
                sha256: hex::encode(input_sha256),
                download_url: format!("/internal/v1/processing/transfers/{}", transfer.id),
                download_token: transfer.token,
            },
            limits,
        }));
    }
    transaction
        .commit()
        .await
        .map_err(ClaimError::Persistence)?;
    Ok(None)
}

pub(super) async fn heartbeat_claim(
    db: &PgPool,
    worker: &AuthenticatedWorker,
    session_id: Uuid,
    claim_id: Uuid,
    phase: ProcessingPhase,
    config: &ProcessingConfig,
) -> Result<ClaimHeartbeatResponse, ClaimError> {
    if !matches!(
        phase,
        ProcessingPhase::Processing | ProcessingPhase::UploadingResult
    ) {
        return Err(ClaimError::Invalid);
    }
    let now = Utc::now();
    let mut transaction = db.begin().await.map_err(ClaimError::Persistence)?;
    let row = sqlx::query(
        "select attempts.id as attempt_id, attempts.state as attempt_state,
                attempts.lease_expires_at, jobs.id as job_id, jobs.state as job_state,
                jobs.current_claim_id, jobs.cancellation_requested
         from processing_attempts attempts
         join processing_jobs jobs on jobs.id = attempts.job_id
         join processing_worker_sessions sessions on sessions.id = attempts.worker_session_id
         where attempts.claim_id = $1 and attempts.worker_session_id = $2
           and sessions.worker_identity = $3
         for update of attempts, jobs",
    )
    .bind(claim_id)
    .bind(session_id)
    .bind(&worker.identity)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(ClaimError::Persistence)?;
    let Some(row) = row else {
        return Ok(ClaimHeartbeatResponse {
            state: ClaimHeartbeatState::ClaimLost,
            server_time: now,
            lease_expires_at: None,
            cancellation_deadline: None,
        });
    };
    let attempt_id: Uuid = row.try_get("attempt_id").map_err(ClaimError::Persistence)?;
    let attempt_state: &str = row
        .try_get("attempt_state")
        .map_err(ClaimError::Persistence)?;
    let job_id: Uuid = row.try_get("job_id").map_err(ClaimError::Persistence)?;
    let job_state: ProcessingJobState =
        row.try_get("job_state").map_err(ClaimError::Persistence)?;
    let current_claim_id: Option<Uuid> = row
        .try_get("current_claim_id")
        .map_err(ClaimError::Persistence)?;
    let previous_expiry: DateTime<Utc> = row
        .try_get("lease_expires_at")
        .map_err(ClaimError::Persistence)?;
    let cancellation_requested: bool = row
        .try_get("cancellation_requested")
        .map_err(ClaimError::Persistence)?;
    if job_state.is_terminal() {
        return Ok(ClaimHeartbeatResponse {
            state: ClaimHeartbeatState::JobTerminal,
            server_time: now,
            lease_expires_at: None,
            cancellation_deadline: None,
        });
    }
    if attempt_state != "running"
        || current_claim_id != Some(claim_id)
        || previous_expiry <= now
        || job_state != ProcessingJobState::Running
    {
        return Ok(ClaimHeartbeatResponse {
            state: ClaimHeartbeatState::ClaimLost,
            server_time: now,
            lease_expires_at: None,
            cancellation_deadline: None,
        });
    }
    let (state, lease_expires_at, cancellation_deadline) = if cancellation_requested {
        let deadline = previous_expiry.min(now + Duration::seconds(10));
        (
            ClaimHeartbeatState::CancellationRequested,
            deadline,
            Some(deadline),
        )
    } else {
        (ClaimHeartbeatState::Active, now + config.claim_lease, None)
    };
    sqlx::query(
        "update processing_attempts
         set phase = $2, lease_expires_at = $3, updated_at = $4 where id = $1",
    )
    .bind(attempt_id)
    .bind(phase)
    .bind(lease_expires_at)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(ClaimError::Persistence)?;
    sqlx::query(
        "update processing_jobs
         set phase = $2, claim_expires_at = $3, updated_at = $4 where id = $1",
    )
    .bind(job_id)
    .bind(phase)
    .bind(lease_expires_at)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(ClaimError::Persistence)?;
    transaction
        .commit()
        .await
        .map_err(ClaimError::Persistence)?;
    Ok(ClaimHeartbeatResponse {
        state,
        server_time: now,
        lease_expires_at: Some(lease_expires_at),
        cancellation_deadline,
    })
}

#[allow(
    clippy::too_many_arguments,
    reason = "transfer capability bindings are explicit"
)]
async fn issue_transfer(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    job_id: Uuid,
    attempt_id: Uuid,
    claim_id: Uuid,
    direction: &str,
    role: &str,
    media_type: &str,
    filename: Option<&str>,
    exact_size_bytes: Option<i64>,
    max_size_bytes: i64,
    expected_sha256: Option<&[u8]>,
    blob_id: Option<Uuid>,
    remaining_uses: i32,
    expires_at: DateTime<Utc>,
) -> Result<IssuedTransfer, sqlx::Error> {
    let id = Uuid::new_v4();
    let token = format!("ptx_{}", Alphanumeric.sample_string(&mut rand::rng(), 48));
    let token_fingerprint: [u8; 32] = Sha256::digest(token.as_bytes()).into();
    let now = Utc::now();
    sqlx::query(
        "insert into processing_transfers (
             id, token_fingerprint, job_id, attempt_id, claim_id,
             direction, role, media_type, filename, exact_size_bytes,
             max_size_bytes, expected_sha256, blob_id, state, remaining_uses,
             created_at, updated_at, expires_at
         ) values (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             'issued', $14, $15, $15, $16
         )",
    )
    .bind(id)
    .bind(token_fingerprint.as_slice())
    .bind(job_id)
    .bind(attempt_id)
    .bind(claim_id)
    .bind(direction)
    .bind(role)
    .bind(media_type)
    .bind(filename)
    .bind(exact_size_bytes)
    .bind(max_size_bytes)
    .bind(expected_sha256)
    .bind(blob_id)
    .bind(remaining_uses)
    .bind(now)
    .bind(expires_at)
    .execute(&mut **transaction)
    .await?;
    Ok(IssuedTransfer {
        id,
        token,
        expires_at,
    })
}

pub(super) async fn create_artifact_transfer(
    db: &PgPool,
    worker: &AuthenticatedWorker,
    request: &ArtifactTransferRequest<'_>,
    config: &ProcessingConfig,
) -> Result<IssuedTransfer, ClaimError> {
    let now = Utc::now();
    let mut transaction = db.begin().await.map_err(ClaimError::Persistence)?;
    let row = sqlx::query(
        "select attempts.id as attempt_id, attempts.job_id, jobs.operation
         from processing_attempts attempts
         join processing_jobs jobs on jobs.id = attempts.job_id
         join processing_worker_sessions sessions on sessions.id = attempts.worker_session_id
         where attempts.claim_id = $1 and attempts.worker_session_id = $2
           and sessions.worker_identity = $3 and attempts.state = 'running'
           and attempts.lease_expires_at > $4 and jobs.state = 'running'
           and jobs.current_claim_id = $1 and not jobs.cancellation_requested
         for update of attempts, jobs",
    )
    .bind(request.claim_id)
    .bind(request.session_id)
    .bind(&worker.identity)
    .bind(now)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(ClaimError::Persistence)?
    .ok_or(ClaimError::Lost)?;
    let attempt_id: Uuid = row.try_get("attempt_id").map_err(ClaimError::Persistence)?;
    let job_id: Uuid = row.try_get("job_id").map_err(ClaimError::Persistence)?;
    let operation: ProcessingOperation =
        row.try_get("operation").map_err(ClaimError::Persistence)?;
    let valid_declaration = operation
        .contract()
        .artifact(request.role)
        .is_some_and(|artifact| {
            let max_bytes = match artifact.size_class {
                ArtifactSizeClass::Output => config.max_output_bytes,
                ArtifactSizeClass::Diagnostic => config.max_diagnostic_bytes,
            };
            request.media_type == artifact.media_type
                && request.filename.ends_with(artifact.filename_suffix)
                && request.size_bytes > 0
                && request.size_bytes <= max_bytes
        });
    if !valid_declaration
        || request.filename.is_empty()
        || request.filename.len() > 160
        || request
            .filename
            .bytes()
            .any(|byte| byte == b'/' || byte == b'\\' || byte.is_ascii_control())
    {
        return Err(ClaimError::Invalid);
    }
    sqlx::query(
        "update processing_transfers
         set state = 'expired', updated_at = $3
         where attempt_id = $1 and direction = 'upload' and role = $2
           and state = 'issued' and expires_at <= $3",
    )
    .bind(attempt_id)
    .bind(request.role)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(ClaimError::Persistence)?;
    let role_exists: bool = sqlx::query_scalar(
        "select exists(
             select 1 from processing_transfers
             where attempt_id = $1 and direction = 'upload' and role = $2
               and state in ('issued', 'uploaded', 'consumed')
         )",
    )
    .bind(attempt_id)
    .bind(request.role)
    .fetch_one(&mut *transaction)
    .await
    .map_err(ClaimError::Persistence)?;
    if role_exists {
        return Err(ClaimError::Invalid);
    }
    let transfer = issue_transfer(
        &mut transaction,
        job_id,
        attempt_id,
        request.claim_id,
        "upload",
        request.role,
        request.media_type,
        Some(request.filename),
        Some(request.size_bytes),
        request.size_bytes,
        Some(request.expected_sha256),
        None,
        1,
        now + config.transfer_ttl,
    )
    .await
    .map_err(ClaimError::Persistence)?;
    transaction
        .commit()
        .await
        .map_err(ClaimError::Persistence)?;
    Ok(transfer)
}

pub(super) async fn download_transfer(
    db: &PgPool,
    transfer_id: Uuid,
    token: &str,
) -> Result<TransferDownloadOutcome, sqlx::Error> {
    let now = Utc::now();
    let fingerprint: [u8; 32] = Sha256::digest(token.as_bytes()).into();
    let mut transaction = db.begin().await?;
    let row = sqlx::query(
        "select transfers.token_fingerprint, transfers.state, transfers.direction,
                transfers.remaining_uses, transfers.expires_at,
                transfers.media_type, transfers.expected_sha256,
                blobs.content
         from processing_transfers transfers
         join processing_attempts attempts on attempts.id = transfers.attempt_id
         join processing_jobs jobs on jobs.id = transfers.job_id
         join processing_blobs blobs on blobs.id = transfers.blob_id
         where transfers.id = $1
           and attempts.state = 'running' and attempts.lease_expires_at > $2
           and jobs.state = 'running' and jobs.current_claim_id = transfers.claim_id
         for update of transfers",
    )
    .bind(transfer_id)
    .bind(now)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some(row) = row else {
        return Ok(TransferDownloadOutcome::Rejected);
    };
    let stored: Vec<u8> = row.try_get("token_fingerprint")?;
    let authorized: bool = stored.as_slice().ct_eq(fingerprint.as_slice()).into();
    let state: &str = row.try_get("state")?;
    let direction: &str = row.try_get("direction")?;
    let remaining_uses: i32 = row.try_get("remaining_uses")?;
    let expires_at: DateTime<Utc> = row.try_get("expires_at")?;
    if !authorized
        || state != "issued"
        || direction != "download"
        || remaining_uses <= 0
        || expires_at <= now
    {
        return Ok(TransferDownloadOutcome::Rejected);
    }
    let next_uses = remaining_uses - 1;
    sqlx::query(
        "update processing_transfers
         set remaining_uses = $2,
             state = case when $2 = 0 then 'consumed' else state end,
             updated_at = $3
         where id = $1",
    )
    .bind(transfer_id)
    .bind(next_uses)
    .bind(now)
    .execute(&mut *transaction)
    .await?;
    let content: Vec<u8> = row.try_get("content")?;
    let media_type: String = row.try_get("media_type")?;
    let sha256: Vec<u8> = row.try_get("expected_sha256")?;
    transaction.commit().await?;
    Ok(TransferDownloadOutcome::Content {
        content,
        media_type,
        sha256,
    })
}

pub(super) async fn upload_transfer(
    db: &PgPool,
    transfer_id: Uuid,
    token: &str,
    content: &[u8],
) -> Result<TransferUploadOutcome, sqlx::Error> {
    let now = Utc::now();
    let fingerprint: [u8; 32] = Sha256::digest(token.as_bytes()).into();
    let digest: [u8; 32] = Sha256::digest(content).into();
    let size_bytes = i64::try_from(content.len()).unwrap_or(i64::MAX);
    let mut transaction = db.begin().await?;
    let row = sqlx::query(
        "select transfers.token_fingerprint, transfers.state, transfers.direction,
                transfers.expires_at, transfers.exact_size_bytes,
                transfers.max_size_bytes, transfers.expected_sha256,
                transfers.media_type, blobs.size_bytes as stored_size_bytes,
                blobs.sha256 as stored_sha256
         from processing_transfers transfers
         join processing_attempts attempts on attempts.id = transfers.attempt_id
         join processing_jobs jobs on jobs.id = transfers.job_id
         left join processing_blobs blobs on blobs.id = transfers.blob_id
         where transfers.id = $1
           and attempts.state = 'running' and attempts.lease_expires_at > $2
           and jobs.state = 'running' and jobs.current_claim_id = transfers.claim_id
         for update of transfers",
    )
    .bind(transfer_id)
    .bind(now)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some(row) = row else {
        return Ok(TransferUploadOutcome::Rejected);
    };
    let stored: Vec<u8> = row.try_get("token_fingerprint")?;
    let authorized: bool = stored.as_slice().ct_eq(fingerprint.as_slice()).into();
    let state: &str = row.try_get("state")?;
    let direction: &str = row.try_get("direction")?;
    let expires_at: DateTime<Utc> = row.try_get("expires_at")?;
    if !authorized
        || !matches!(state, "issued" | "uploaded")
        || direction != "upload"
        || expires_at <= now
    {
        return Ok(TransferUploadOutcome::Rejected);
    }
    let exact_size: Option<i64> = row.try_get("exact_size_bytes")?;
    let max_size: i64 = row.try_get("max_size_bytes")?;
    if size_bytes > max_size || exact_size.is_some_and(|exact| exact != size_bytes) {
        return Ok(TransferUploadOutcome::TooLarge);
    }
    let expected_digest: Option<Vec<u8>> = row.try_get("expected_sha256")?;
    if expected_digest
        .as_deref()
        .is_some_and(|expected| expected != digest)
    {
        return Ok(TransferUploadOutcome::DigestMismatch);
    }
    if state == "uploaded" {
        let stored_size: Option<i64> = row.try_get("stored_size_bytes")?;
        let stored_sha256: Option<Vec<u8>> = row.try_get("stored_sha256")?;
        return if stored_size == Some(size_bytes)
            && stored_sha256.as_deref() == Some(digest.as_slice())
        {
            Ok(TransferUploadOutcome::Stored {
                size_bytes,
                sha256: digest.to_vec(),
            })
        } else {
            Ok(TransferUploadOutcome::Rejected)
        };
    }
    let media_type: String = row.try_get("media_type")?;
    let blob_id = store_blob(&mut transaction, &digest, &media_type, content, now).await?;
    sqlx::query(
        "update processing_transfers
         set blob_id = $2, state = 'uploaded', remaining_uses = 0, updated_at = $3
         where id = $1",
    )
    .bind(transfer_id)
    .bind(blob_id)
    .bind(now)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(TransferUploadOutcome::Stored {
        size_bytes,
        sha256: digest.to_vec(),
    })
}

pub(super) async fn complete_claim(
    db: &PgPool,
    worker: &AuthenticatedWorker,
    session_id: Uuid,
    claim_id: Uuid,
    artifacts: &[CompletedArtifactInput],
) -> Result<CompleteClaimOutcome, ClaimError> {
    if artifacts.is_empty() {
        return Ok(CompleteClaimOutcome::Invalid);
    }
    let now = Utc::now();
    let mut transaction = db.begin().await.map_err(ClaimError::Persistence)?;
    let row = sqlx::query(
        "select attempts.id as attempt_id, attempts.job_id, attempts.state as attempt_state,
                attempts.lease_expires_at, jobs.operation, jobs.state, jobs.current_claim_id,
                jobs.cancellation_requested
         from processing_attempts attempts
         join processing_jobs jobs on jobs.id = attempts.job_id
         join processing_worker_sessions sessions on sessions.id = attempts.worker_session_id
         where attempts.claim_id = $1 and attempts.worker_session_id = $2
           and sessions.worker_identity = $3
         for update of attempts, jobs",
    )
    .bind(claim_id)
    .bind(session_id)
    .bind(&worker.identity)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(ClaimError::Persistence)?;
    let Some(row) = row else {
        return Ok(CompleteClaimOutcome::Lost);
    };
    let attempt_id: Uuid = row.try_get("attempt_id").map_err(ClaimError::Persistence)?;
    let attempt_state: &str = row
        .try_get("attempt_state")
        .map_err(ClaimError::Persistence)?;
    let job_id: Uuid = row.try_get("job_id").map_err(ClaimError::Persistence)?;
    let lease_expires_at: DateTime<Utc> = row
        .try_get("lease_expires_at")
        .map_err(ClaimError::Persistence)?;
    let state: ProcessingJobState = row.try_get("state").map_err(ClaimError::Persistence)?;
    let operation: ProcessingOperation =
        row.try_get("operation").map_err(ClaimError::Persistence)?;
    let current_claim_id: Option<Uuid> = row
        .try_get("current_claim_id")
        .map_err(ClaimError::Persistence)?;
    let cancelled: bool = row
        .try_get("cancellation_requested")
        .map_err(ClaimError::Persistence)?;
    let delivery_replay = attempt_state == "delivered"
        && matches!(
            state,
            ProcessingJobState::Finalizing
                | ProcessingJobState::Succeeded
                | ProcessingJobState::Failed
        );
    if cancelled && !delivery_replay {
        return Ok(CompleteClaimOutcome::Cancelled);
    }
    if !delivery_replay
        && (attempt_state != "running"
            || state != ProcessingJobState::Running
            || current_claim_id != Some(claim_id)
            || lease_expires_at <= now)
    {
        return Ok(CompleteClaimOutcome::Lost);
    }
    let mut roles = std::collections::HashSet::new();
    let contract = operation.contract();
    if artifacts.len() > contract.artifacts.len() {
        return Ok(CompleteClaimOutcome::Invalid);
    }
    for artifact in artifacts {
        if !roles.insert(artifact.role.as_str()) || contract.artifact(&artifact.role).is_none() {
            return Ok(CompleteClaimOutcome::Invalid);
        }
        let digest = match hex::decode(&artifact.sha256) {
            Ok(value) if value.len() == 32 => value,
            Ok(_) | Err(_) => return Ok(CompleteClaimOutcome::Invalid),
        };
        let matched: bool = sqlx::query_scalar(
            "select exists(
                 select 1 from processing_transfers
                 where id = $1 and attempt_id = $2 and claim_id = $3
                   and direction = 'upload' and state in ('uploaded', 'consumed')
                   and role = $4 and exact_size_bytes = $5
                   and expected_sha256 = $6 and blob_id is not null
             )",
        )
        .bind(artifact.transfer_id)
        .bind(attempt_id)
        .bind(claim_id)
        .bind(&artifact.role)
        .bind(artifact.size_bytes)
        .bind(&digest)
        .fetch_one(&mut *transaction)
        .await
        .map_err(ClaimError::Persistence)?;
        if !matched {
            return Ok(CompleteClaimOutcome::Invalid);
        }
    }
    if contract
        .artifacts
        .iter()
        .any(|artifact| artifact.required && !roles.contains(artifact.role))
    {
        return Ok(CompleteClaimOutcome::Invalid);
    }
    if delivery_replay {
        transaction
            .commit()
            .await
            .map_err(ClaimError::Persistence)?;
        return Ok(CompleteClaimOutcome::Accepted { job_id });
    }
    sqlx::query(
        "update processing_attempts
         set state = 'delivered', phase = 'complete', updated_at = $2, completed_at = $2
         where id = $1",
    )
    .bind(attempt_id)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(ClaimError::Persistence)?;
    sqlx::query(
        "update processing_jobs
         set state = 'finalizing', phase = 'validating_result',
             current_claim_id = null, claim_expires_at = null,
             finalization_token = null, finalization_expires_at = null,
             updated_at = $2
         where id = $1",
    )
    .bind(job_id)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(ClaimError::Persistence)?;
    transaction
        .commit()
        .await
        .map_err(ClaimError::Persistence)?;
    Ok(CompleteClaimOutcome::Accepted { job_id })
}

pub(super) async fn fail_claim(
    db: &PgPool,
    worker: &AuthenticatedWorker,
    session_id: Uuid,
    claim_id: Uuid,
    class: WorkerFailureClass,
    code: &str,
    message: &str,
) -> Result<ClaimMutationOutcome, ClaimError> {
    mutate_failed_claim(
        db,
        worker,
        session_id,
        claim_id,
        Some((class, code, message)),
    )
    .await
}

pub(super) async fn release_claim(
    db: &PgPool,
    worker: &AuthenticatedWorker,
    session_id: Uuid,
    claim_id: Uuid,
) -> Result<ClaimMutationOutcome, ClaimError> {
    mutate_failed_claim(db, worker, session_id, claim_id, None).await
}

async fn mutate_failed_claim(
    db: &PgPool,
    worker: &AuthenticatedWorker,
    session_id: Uuid,
    claim_id: Uuid,
    failure: Option<(WorkerFailureClass, &str, &str)>,
) -> Result<ClaimMutationOutcome, ClaimError> {
    let now = Utc::now();
    let mut transaction = db.begin().await.map_err(ClaimError::Persistence)?;
    let row = sqlx::query(
        "select attempts.id as attempt_id, attempts.job_id,
                attempts.state as attempt_state, attempts.lease_expires_at,
                jobs.state, jobs.current_claim_id, jobs.cancellation_requested,
                jobs.attempt_count, jobs.max_attempts
         from processing_attempts attempts
         join processing_jobs jobs on jobs.id = attempts.job_id
         join processing_worker_sessions sessions on sessions.id = attempts.worker_session_id
         where attempts.claim_id = $1 and attempts.worker_session_id = $2
           and sessions.worker_identity = $3
         for update of attempts, jobs",
    )
    .bind(claim_id)
    .bind(session_id)
    .bind(&worker.identity)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(ClaimError::Persistence)?;
    let Some(row) = row else {
        return Ok(ClaimMutationOutcome::Lost);
    };
    let attempt_id: Uuid = row.try_get("attempt_id").map_err(ClaimError::Persistence)?;
    let attempt_state: &str = row
        .try_get("attempt_state")
        .map_err(ClaimError::Persistence)?;
    let job_id: Uuid = row.try_get("job_id").map_err(ClaimError::Persistence)?;
    let lease_expires_at: DateTime<Utc> = row
        .try_get("lease_expires_at")
        .map_err(ClaimError::Persistence)?;
    let state: ProcessingJobState = row.try_get("state").map_err(ClaimError::Persistence)?;
    let current_claim_id: Option<Uuid> = row
        .try_get("current_claim_id")
        .map_err(ClaimError::Persistence)?;
    if matches!(attempt_state, "failed" | "released") {
        transaction
            .commit()
            .await
            .map_err(ClaimError::Persistence)?;
        return Ok(ClaimMutationOutcome::Updated { job_id, state });
    }
    if state != ProcessingJobState::Running
        || current_claim_id != Some(claim_id)
        || lease_expires_at <= now
    {
        return Ok(ClaimMutationOutcome::Lost);
    }
    let cancellation_requested: bool = row
        .try_get("cancellation_requested")
        .map_err(ClaimError::Persistence)?;
    let attempt_count: i32 = row
        .try_get("attempt_count")
        .map_err(ClaimError::Persistence)?;
    let max_attempts: i32 = row
        .try_get("max_attempts")
        .map_err(ClaimError::Persistence)?;
    let retryable = failure
        .as_ref()
        .is_none_or(|(class, _, _)| class.retryable());
    let next_state = if cancellation_requested {
        ProcessingJobState::Cancelled
    } else if retryable && attempt_count < max_attempts {
        ProcessingJobState::Queued
    } else {
        ProcessingJobState::Failed
    };
    let next_attempt_at = if next_state == ProcessingJobState::Queued {
        now + processing_retry_delay(attempt_count)
    } else {
        now
    };
    let (attempt_state, failure_class, failure_code, failure_message) = match failure {
        Some((class, code, message)) => (
            "failed",
            Some(class.as_ref().to_owned()),
            Some(code),
            Some(message),
        ),
        None => ("released", None, None, None),
    };
    sqlx::query(
        "update processing_attempts
         set state = $2, phase = 'complete', failure_class = $3,
             failure_code = $4, failure_message = $5,
             updated_at = $6, completed_at = $6
         where id = $1",
    )
    .bind(attempt_id)
    .bind(attempt_state)
    .bind(&failure_class)
    .bind(failure_code)
    .bind(failure_message)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(ClaimError::Persistence)?;
    let terminal = next_state.is_terminal();
    sqlx::query(
        "update processing_jobs
         set state = $2,
             phase = case when $2 = 'queued' then 'waiting_for_worker' else 'complete' end,
             current_claim_id = null, claim_expires_at = null,
             failure_class = case when $2 = 'failed' then $3 else null end,
             failure_code = case when $2 = 'failed' then $4 else null end,
             failure_message = case when $2 = 'failed' then $5 else null end,
             updated_at = $6,
             completed_at = case when $7 then $6 else null end,
             next_attempt_at = case when $2 = 'queued' then $8 else next_attempt_at end
         where id = $1",
    )
    .bind(job_id)
    .bind(next_state)
    .bind(&failure_class)
    .bind(failure_code)
    .bind(failure_message)
    .bind(now)
    .bind(terminal)
    .bind(next_attempt_at)
    .execute(&mut *transaction)
    .await
    .map_err(ClaimError::Persistence)?;
    transaction
        .commit()
        .await
        .map_err(ClaimError::Persistence)?;
    Ok(ClaimMutationOutcome::Updated {
        job_id,
        state: next_state,
    })
}

pub(super) fn transfer_token(headers: &axum::http::HeaderMap) -> Option<&str> {
    headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("ProcessingTransfer ")
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub(super) fn decode_sha256(value: &str) -> Option<[u8; 32]> {
    let bytes = hex::decode(value).ok()?;
    bytes.try_into().ok()
}
