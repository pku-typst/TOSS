//! Core-owned result publication, lease recovery, and lifecycle maintenance.

use super::model::{processing_retry_delay, ProcessingJobState, ProcessingOperation};
use super::{DocumentProcessingContext, ProcessingConfig};
use crate::access::{ensure_project_role_for_user, AccessNeed, ProjectAuthorizationError};
use chrono::{DateTime, Utc};
use sha2::Digest;
use sqlx::{PgPool, Row};
use std::time::Duration;
use uuid::Uuid;

const MAINTENANCE_INTERVAL: Duration = Duration::from_secs(1);
const MAINTENANCE_BATCH: usize = 16;
const PDF_EOF_SCAN_BYTES: usize = 1024;

struct FinalizationLease {
    job_id: Uuid,
    token: Uuid,
    operation: ProcessingOperation,
    requester_user_id: Uuid,
    project_id: Option<Uuid>,
    cache_source_job_id: Option<Uuid>,
}

struct StagedArtifact {
    transfer_id: Option<Uuid>,
    blob_id: Uuid,
    role: String,
    media_type: String,
    filename: String,
    size_bytes: i64,
    sha256: Vec<u8>,
    content: Vec<u8>,
}

enum ValidationFailure {
    AccessRevoked,
    ArtifactSet,
    PdfInvalid,
    DiagnosticInvalid,
}

impl ValidationFailure {
    const fn class(&self) -> &'static str {
        match self {
            Self::AccessRevoked => "authorization",
            Self::ArtifactSet | Self::PdfInvalid | Self::DiagnosticInvalid => {
                "internal_contract_violation"
            }
        }
    }

    const fn code(&self) -> &'static str {
        match self {
            Self::AccessRevoked => "project_access_revoked",
            Self::ArtifactSet => "artifact_set_invalid",
            Self::PdfInvalid => "pdf_invalid",
            Self::DiagnosticInvalid => "diagnostic_invalid",
        }
    }

    const fn message(&self) -> &'static str {
        match self {
            Self::AccessRevoked => "Project access was revoked before result publication",
            Self::ArtifactSet => "Processor output did not match the operation contract",
            Self::PdfInvalid => "Processor output was not a valid PDF artifact",
            Self::DiagnosticInvalid => "Processor diagnostic output was invalid",
        }
    }
}

pub(crate) fn spawn_processing_maintenance(context: DocumentProcessingContext) {
    tokio::spawn(async move {
        loop {
            if let Err(error) = maintain_lifecycle(&context.db).await {
                tracing::error!(?error, "document processing lifecycle maintenance failed");
            }
            for _ in 0..MAINTENANCE_BATCH {
                match finalize_one(&context.db, &context.config).await {
                    Ok(true) => {}
                    Ok(false) => break,
                    Err(error) => {
                        tracing::error!(?error, "document processing finalization failed");
                        break;
                    }
                }
            }
            tokio::time::sleep(MAINTENANCE_INTERVAL).await;
        }
    });
}

async fn maintain_lifecycle(db: &PgPool) -> Result<(), sqlx::Error> {
    let now = Utc::now();
    sqlx::query(
        "update processing_worker_sessions
         set state = 'expired', updated_at = $1
         where state = 'active' and expires_at <= $1",
    )
    .bind(now)
    .execute(db)
    .await?;
    sqlx::query(
        "update processing_worker_sessions sessions
         set state = 'expired', updated_at = $1
         where sessions.state = 'draining'
           and not exists (
               select 1 from processing_attempts attempts
               where attempts.worker_session_id = sessions.id
                 and attempts.state = 'running'
           )",
    )
    .bind(now)
    .execute(db)
    .await?;

    let mut transaction = db.begin().await?;
    let expired = sqlx::query(
        "select id, current_claim_id, cancellation_requested,
                attempt_count, max_attempts, queue_expires_at
         from processing_jobs
         where state = 'running' and claim_expires_at <= $1
         order by claim_expires_at
         for update skip locked
         limit $2",
    )
    .bind(now)
    .bind(i64::try_from(MAINTENANCE_BATCH).unwrap_or(16))
    .fetch_all(&mut *transaction)
    .await?;
    for row in expired {
        let job_id: Uuid = row.try_get("id")?;
        let claim_id: Option<Uuid> = row.try_get("current_claim_id")?;
        let cancellation_requested: bool = row.try_get("cancellation_requested")?;
        let attempt_count: i32 = row.try_get("attempt_count")?;
        let max_attempts: i32 = row.try_get("max_attempts")?;
        let queue_expires_at: DateTime<Utc> = row.try_get("queue_expires_at")?;
        if let Some(claim_id) = claim_id {
            sqlx::query(
                "update processing_attempts
                 set state = 'lost', phase = 'complete',
                     failure_class = 'worker_interrupted', failure_code = 'claim_expired',
                     failure_message = 'Worker claim expired before a closed outcome',
                     updated_at = $2, completed_at = $2
                 where claim_id = $1 and state = 'running'",
            )
            .bind(claim_id)
            .bind(now)
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                "update processing_transfers set state = 'expired', updated_at = $2
                 where claim_id = $1 and state in ('issued', 'uploaded')",
            )
            .bind(claim_id)
            .bind(now)
            .execute(&mut *transaction)
            .await?;
        }
        let (state, failure_class, failure_code, failure_message) = if cancellation_requested {
            (ProcessingJobState::Cancelled, None, None, None)
        } else if attempt_count < max_attempts && queue_expires_at > now {
            (ProcessingJobState::Queued, None, None, None)
        } else if queue_expires_at <= now {
            (
                ProcessingJobState::Expired,
                Some("worker_interrupted"),
                Some("queue_expired"),
                Some("Processing capacity was unavailable before queue expiry"),
            )
        } else {
            (
                ProcessingJobState::Failed,
                Some("worker_interrupted"),
                Some("attempts_exhausted"),
                Some("Processing worker attempts were exhausted"),
            )
        };
        let next_attempt_at = if state == ProcessingJobState::Queued {
            now + processing_retry_delay(attempt_count)
        } else {
            now
        };
        sqlx::query(
            "update processing_jobs
             set state = $2,
                 phase = case when $2 = 'queued' then 'waiting_for_worker' else 'complete' end,
                 current_claim_id = null, claim_expires_at = null,
                 failure_class = $3, failure_code = $4, failure_message = $5,
                 updated_at = $6,
                 completed_at = case when $2 = 'queued' then null else $6 end,
                 next_attempt_at = case when $2 = 'queued' then $7 else next_attempt_at end
             where id = $1",
        )
        .bind(job_id)
        .bind(state)
        .bind(failure_class)
        .bind(failure_code)
        .bind(failure_message)
        .bind(now)
        .bind(next_attempt_at)
        .execute(&mut *transaction)
        .await?;
    }

    sqlx::query(
        "update processing_jobs
         set state = 'expired', phase = 'complete',
             failure_class = 'capacity', failure_code = 'queue_expired',
             failure_message = 'Processing capacity was unavailable before queue expiry',
             updated_at = $1, completed_at = $1
         where state in ('preparing', 'queued') and queue_expires_at <= $1",
    )
    .bind(now)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        "delete from processing_input_asset_pins pins
         using processing_jobs jobs
         where pins.job_id = jobs.id and jobs.state in ('failed', 'cancelled', 'expired')",
    )
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        "update processing_transfers set state = 'expired', updated_at = $1
         where state in ('issued', 'uploaded') and expires_at <= $1",
    )
    .bind(now)
    .execute(&mut *transaction)
    .await?;
    sqlx::query("delete from processing_worker_requests where expires_at <= $1")
        .bind(now)
        .execute(&mut *transaction)
        .await?;
    // A cache-hit job references its source until finalization has published its
    // own artifact rows. Keep the source job alive for the lifetime of every
    // dependent job so retention cannot turn a valid cache hit into an empty
    // staged result at the expiry boundary.
    sqlx::query(
        "delete from processing_jobs expired
         where expired.retained_until <= $1 and expired.completed_at is not null
           and not exists (
               select 1 from processing_jobs dependent
               where dependent.cache_source_job_id = expired.id
           )",
    )
    .bind(now)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        "delete from processing_blobs blobs
         where not exists (select 1 from processing_jobs jobs where jobs.input_blob_id = blobs.id)
           and not exists (select 1 from processing_transfers transfers where transfers.blob_id = blobs.id)
           and not exists (select 1 from processing_artifacts artifacts where artifacts.blob_id = blobs.id)",
    )
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await
}

async fn finalize_one(db: &PgPool, config: &ProcessingConfig) -> Result<bool, sqlx::Error> {
    let Some(lease) = acquire_finalization_lease(db, config).await? else {
        return Ok(false);
    };
    let staged = load_staged_artifacts(db, &lease).await?;
    let validation = validate_finalization(db, &lease, &staged, config).await;
    match validation {
        Ok(()) => publish_artifacts(db, &lease, &staged).await?,
        Err(FinalizationCheckError::Rejected(failure)) => {
            reject_artifacts(db, &lease, failure).await?
        }
        Err(FinalizationCheckError::Unavailable(error)) => return Err(error),
    }
    Ok(true)
}

async fn acquire_finalization_lease(
    db: &PgPool,
    config: &ProcessingConfig,
) -> Result<Option<FinalizationLease>, sqlx::Error> {
    let now = Utc::now();
    let token = Uuid::new_v4();
    let expires_at = now + config.finalization_lease;
    let mut transaction = db.begin().await?;
    let row = sqlx::query(
        "select id, operation, requester_user_id, project_id, cache_source_job_id
         from processing_jobs
         where state = 'finalizing'
           and (finalization_token is null or finalization_expires_at <= $1)
         order by updated_at
         for update skip locked
         limit 1",
    )
    .bind(now)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some(row) = row else {
        transaction.commit().await?;
        return Ok(None);
    };
    let lease = FinalizationLease {
        job_id: row.try_get("id")?,
        token,
        operation: row.try_get("operation")?,
        requester_user_id: row.try_get("requester_user_id")?,
        project_id: row.try_get("project_id")?,
        cache_source_job_id: row.try_get("cache_source_job_id")?,
    };
    sqlx::query(
        "update processing_jobs
         set finalization_token = $2, finalization_expires_at = $3,
             phase = 'validating_result', updated_at = $4
         where id = $1",
    )
    .bind(lease.job_id)
    .bind(lease.token)
    .bind(expires_at)
    .bind(now)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(Some(lease))
}

async fn load_staged_artifacts(
    db: &PgPool,
    lease: &FinalizationLease,
) -> Result<Vec<StagedArtifact>, sqlx::Error> {
    let rows = if let Some(source_job_id) = lease.cache_source_job_id {
        sqlx::query(
            "select null::uuid as transfer_id, artifacts.blob_id, artifacts.role,
                    artifacts.media_type, artifacts.filename, artifacts.size_bytes,
                    artifacts.sha256, blobs.content
             from processing_jobs jobs
             join processing_jobs source
               on source.id = jobs.cache_source_job_id and source.state = 'succeeded'
             join processing_artifacts artifacts on artifacts.job_id = source.id
             join processing_blobs blobs on blobs.id = artifacts.blob_id
             where jobs.id = $1 and jobs.state = 'finalizing'
               and jobs.finalization_token = $2 and source.id = $3
             order by artifacts.role",
        )
        .bind(lease.job_id)
        .bind(lease.token)
        .bind(source_job_id)
        .fetch_all(db)
        .await?
    } else {
        sqlx::query(
            "select transfers.id as transfer_id, transfers.blob_id, transfers.role,
                    transfers.media_type, transfers.filename,
                    transfers.exact_size_bytes as size_bytes,
                    transfers.expected_sha256 as sha256, blobs.content
             from processing_jobs jobs
             join processing_attempts attempts
               on attempts.job_id = jobs.id and attempts.attempt_number = jobs.attempt_count
             join processing_transfers transfers on transfers.attempt_id = attempts.id
             join processing_blobs blobs on blobs.id = transfers.blob_id
             where jobs.id = $1 and jobs.state = 'finalizing'
               and jobs.finalization_token = $2 and attempts.state = 'delivered'
               and transfers.direction = 'upload' and transfers.state = 'uploaded'
             order by transfers.role",
        )
        .bind(lease.job_id)
        .bind(lease.token)
        .fetch_all(db)
        .await?
    };
    rows.into_iter()
        .map(|row| {
            Ok(StagedArtifact {
                transfer_id: row.try_get("transfer_id")?,
                blob_id: row.try_get("blob_id")?,
                role: row.try_get("role")?,
                media_type: row.try_get("media_type")?,
                filename: row.try_get("filename")?,
                size_bytes: row.try_get("size_bytes")?,
                sha256: row.try_get("sha256")?,
                content: row.try_get("content")?,
            })
        })
        .collect()
}

enum FinalizationCheckError {
    Rejected(ValidationFailure),
    Unavailable(sqlx::Error),
}

async fn validate_finalization(
    db: &PgPool,
    lease: &FinalizationLease,
    staged: &[StagedArtifact],
    config: &ProcessingConfig,
) -> Result<(), FinalizationCheckError> {
    if let Some(project_id) = lease.project_id {
        match ensure_project_role_for_user(
            db,
            lease.requester_user_id,
            project_id,
            AccessNeed::Read,
        )
        .await
        {
            Ok(()) => {}
            Err(ProjectAuthorizationError::PermissionDenied) => {
                return Err(FinalizationCheckError::Rejected(
                    ValidationFailure::AccessRevoked,
                ));
            }
            Err(error) => {
                tracing::warn!(?error, job_id = %lease.job_id, "processing finalizer could not recheck access");
                return Err(FinalizationCheckError::Unavailable(sqlx::Error::Protocol(
                    "project authorization unavailable".to_string(),
                )));
            }
        }
    }
    if lease.operation != ProcessingOperation::LatexCompilePdfV1 {
        return Err(FinalizationCheckError::Rejected(
            ValidationFailure::ArtifactSet,
        ));
    }
    let mut pdf_count = 0;
    let mut log_count = 0;
    for artifact in staged {
        if artifact.size_bytes != i64::try_from(artifact.content.len()).unwrap_or(i64::MAX)
            || artifact.sha256 != sha2::Sha256::digest(&artifact.content).as_slice()
        {
            return Err(FinalizationCheckError::Rejected(
                ValidationFailure::ArtifactSet,
            ));
        }
        match (artifact.role.as_str(), artifact.media_type.as_str()) {
            ("pdf", "application/pdf") => {
                pdf_count += 1;
                if artifact.size_bytes > config.max_output_bytes || !valid_pdf(&artifact.content) {
                    return Err(FinalizationCheckError::Rejected(
                        ValidationFailure::PdfInvalid,
                    ));
                }
            }
            ("log", "text/plain") => {
                log_count += 1;
                if artifact.size_bytes > config.max_diagnostic_bytes
                    || std::str::from_utf8(&artifact.content).is_err()
                {
                    return Err(FinalizationCheckError::Rejected(
                        ValidationFailure::DiagnosticInvalid,
                    ));
                }
            }
            _ => {
                return Err(FinalizationCheckError::Rejected(
                    ValidationFailure::ArtifactSet,
                ));
            }
        }
    }
    if pdf_count != 1 || log_count > 1 || staged.len() != pdf_count + log_count {
        return Err(FinalizationCheckError::Rejected(
            ValidationFailure::ArtifactSet,
        ));
    }
    Ok(())
}

async fn publish_artifacts(
    db: &PgPool,
    lease: &FinalizationLease,
    staged: &[StagedArtifact],
) -> Result<(), sqlx::Error> {
    let now = Utc::now();
    let mut transaction = db.begin().await?;
    let locked: bool = sqlx::query_scalar(
        "select exists(
             select 1 from processing_jobs
             where id = $1 and state = 'finalizing' and finalization_token = $2
               and finalization_expires_at > $3
             for update
         )",
    )
    .bind(lease.job_id)
    .bind(lease.token)
    .bind(now)
    .fetch_one(&mut *transaction)
    .await?;
    if !locked {
        transaction.rollback().await?;
        return Ok(());
    }
    for artifact in staged {
        sqlx::query(
            "insert into processing_artifacts (
                 id, job_id, blob_id, role, media_type, filename,
                 size_bytes, sha256, created_at
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             on conflict (job_id, role) do nothing",
        )
        .bind(Uuid::new_v4())
        .bind(lease.job_id)
        .bind(artifact.blob_id)
        .bind(&artifact.role)
        .bind(&artifact.media_type)
        .bind(&artifact.filename)
        .bind(artifact.size_bytes)
        .bind(&artifact.sha256)
        .bind(now)
        .execute(&mut *transaction)
        .await?;
        if let Some(transfer_id) = artifact.transfer_id {
            sqlx::query(
                "update processing_transfers set state = 'consumed', updated_at = $2
                 where id = $1",
            )
            .bind(transfer_id)
            .bind(now)
            .execute(&mut *transaction)
            .await?;
        }
    }
    let result = sqlx::query(
        "update processing_jobs
         set state = 'succeeded', phase = 'complete',
             finalization_token = null, finalization_expires_at = null,
             updated_at = $3, completed_at = $3
         where id = $1 and state = 'finalizing' and finalization_token = $2",
    )
    .bind(lease.job_id)
    .bind(lease.token)
    .bind(now)
    .execute(&mut *transaction)
    .await?;
    if result.rows_affected() == 1 {
        transaction.commit().await?;
    } else {
        transaction.rollback().await?;
    }
    Ok(())
}

async fn reject_artifacts(
    db: &PgPool,
    lease: &FinalizationLease,
    failure: ValidationFailure,
) -> Result<(), sqlx::Error> {
    let now = Utc::now();
    sqlx::query(
        "update processing_jobs
         set state = 'failed', phase = 'complete',
             failure_class = $3,
             failure_code = $4, failure_message = $5,
             finalization_token = null, finalization_expires_at = null,
             updated_at = $6, completed_at = $6
         where id = $1 and state = 'finalizing' and finalization_token = $2
           and finalization_expires_at > $6",
    )
    .bind(lease.job_id)
    .bind(lease.token)
    .bind(failure.class())
    .bind(failure.code())
    .bind(failure.message())
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}

fn valid_pdf(content: &[u8]) -> bool {
    if !content.starts_with(b"%PDF-") || content.len() < 8 {
        return false;
    }
    let start = content.len().saturating_sub(PDF_EOF_SCAN_BYTES);
    content.get(start..).is_some_and(|tail| {
        tail.windows(b"%%EOF".len())
            .any(|window| window == b"%%EOF")
    })
}

#[cfg(test)]
mod tests {
    use super::valid_pdf;

    #[test]
    fn pdf_validation_requires_header_and_trailer() {
        assert!(valid_pdf(b"%PDF-1.7\n1 0 obj\nendobj\n%%EOF\n"));
        assert!(!valid_pdf(b"%PDF-1.7\ntruncated"));
        assert!(!valid_pdf(b"not a pdf\n%%EOF"));
    }
}
