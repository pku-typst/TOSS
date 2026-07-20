//! PostgreSQL persistence and concurrency fences owned by Document Processing.

use super::model::{
    ProcessingArtifact, ProcessingFailure, ProcessingJob, ProcessingJobState, ProcessingOperation,
    ProcessingPhase,
};
use super::ProcessingConfig;
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{PgConnection, PgPool, Postgres, Row, Transaction};
use thiserror::Error;
use uuid::Uuid;

const ADMISSION_LOCK_KEY: i64 = 0x5450_524f_4345_5353;

pub(super) struct ReserveJob<'a> {
    pub id: Uuid,
    pub operation: ProcessingOperation,
    pub requester_user_id: Uuid,
    pub project_id: Option<Uuid>,
    pub idempotency_scope: &'a str,
    pub idempotency_key: &'a str,
    pub command_digest: &'a [u8],
    pub normalized_options: &'a Value,
    pub options_digest: &'a [u8],
    pub now: DateTime<Utc>,
}

pub(super) enum ReserveJobOutcome {
    Reserved,
    Existing(JobRecord),
}

#[derive(Debug, Error)]
pub(super) enum ReserveJobError {
    #[error("idempotency key was reused with a different command")]
    IdempotencyConflict,
    #[error("global processing queue is full")]
    GlobalLimit,
    #[error("requester has too many active processing jobs")]
    RequesterLimit,
    #[error("project has too many active processing jobs")]
    ProjectLimit,
    #[error("processing job admission failed")]
    Persistence(#[source] sqlx::Error),
}

#[derive(Clone)]
pub(super) struct JobRecord {
    pub id: Uuid,
    pub operation: ProcessingOperation,
    pub project_id: Option<Uuid>,
    pub result_project_id: Option<Uuid>,
    pub state: ProcessingJobState,
    pub phase: ProcessingPhase,
    pub cancellation_requested: bool,
    pub attempt_count: i32,
    pub processor_contract: Option<String>,
    pub failure_class: Option<String>,
    pub failure_code: Option<String>,
    pub failure_message: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Clone)]
pub(super) struct ArtifactRecord {
    pub id: Uuid,
    pub job_id: Uuid,
    pub role: String,
    pub media_type: String,
    pub filename: String,
    pub size_bytes: i64,
    pub sha256: Vec<u8>,
}

pub(super) struct ArtifactContent {
    pub artifact: ArtifactRecord,
    pub content: Vec<u8>,
}

pub(super) struct CapabilityStats {
    pub healthy_sessions: i64,
    pub active_slots: i64,
    pub active_jobs: i64,
    pub queued_jobs: i64,
}

impl JobRecord {
    pub(super) fn into_public(self, artifacts: Vec<ArtifactRecord>) -> ProcessingJob {
        let failure = match (self.failure_class, self.failure_code, self.failure_message) {
            (Some(class), Some(code), Some(message)) => Some(ProcessingFailure {
                class,
                code,
                message,
            }),
            _ => None,
        };
        ProcessingJob {
            id: self.id,
            operation: self.operation,
            project_id: self.project_id,
            result_project_id: self.result_project_id,
            state: self.state,
            phase: self.phase,
            cancellation_requested: self.cancellation_requested,
            attempt_count: self.attempt_count,
            processor_contract: self.processor_contract,
            failure,
            artifacts: artifacts
                .into_iter()
                .map(|artifact| ProcessingArtifact {
                    id: artifact.id,
                    role: artifact.role,
                    media_type: artifact.media_type,
                    filename: artifact.filename,
                    size_bytes: artifact.size_bytes,
                    sha256: hex::encode(artifact.sha256),
                    download_url: format!(
                        "/v1/processing/jobs/{}/artifacts/{}",
                        artifact.job_id, artifact.id
                    ),
                })
                .collect(),
            created_at: self.created_at,
            updated_at: self.updated_at,
            completed_at: self.completed_at,
        }
    }
}

pub(super) async fn reserve_job(
    db: &PgPool,
    config: &ProcessingConfig,
    command: &ReserveJob<'_>,
) -> Result<ReserveJobOutcome, ReserveJobError> {
    let mut transaction = db.begin().await.map_err(ReserveJobError::Persistence)?;
    sqlx::query("select pg_advisory_xact_lock($1)")
        .bind(ADMISSION_LOCK_KEY)
        .execute(&mut *transaction)
        .await
        .map_err(ReserveJobError::Persistence)?;
    if let Some(existing) = find_idempotent_job(
        &mut transaction,
        command.requester_user_id,
        command.idempotency_scope,
        command.idempotency_key,
    )
    .await
    .map_err(ReserveJobError::Persistence)?
    {
        let digest: Vec<u8> =
            sqlx::query_scalar("select command_digest from processing_jobs where id = $1")
                .bind(existing.id)
                .fetch_one(&mut *transaction)
                .await
                .map_err(ReserveJobError::Persistence)?;
        if digest != command.command_digest {
            return Err(ReserveJobError::IdempotencyConflict);
        }
        transaction
            .commit()
            .await
            .map_err(ReserveJobError::Persistence)?;
        return Ok(ReserveJobOutcome::Existing(existing));
    }

    let global_active: i64 = sqlx::query_scalar(
        "select count(*) from processing_jobs
         where state = any(array['preparing', 'queued', 'running', 'finalizing'])",
    )
    .fetch_one(&mut *transaction)
    .await
    .map_err(ReserveJobError::Persistence)?;
    if global_active >= config.max_queued_jobs {
        return Err(ReserveJobError::GlobalLimit);
    }
    let requester_active: i64 = sqlx::query_scalar(
        "select count(*) from processing_jobs
         where requester_user_id = $1
           and state = any(array['preparing', 'queued', 'running', 'finalizing'])",
    )
    .bind(command.requester_user_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(ReserveJobError::Persistence)?;
    if requester_active >= config.max_active_jobs_per_user {
        return Err(ReserveJobError::RequesterLimit);
    }
    if let Some(project_id) = command.project_id {
        let project_active: i64 = sqlx::query_scalar(
            "select count(*) from processing_jobs
             where project_id = $1
               and state = any(array['preparing', 'queued', 'running', 'finalizing'])",
        )
        .bind(project_id)
        .fetch_one(&mut *transaction)
        .await
        .map_err(ReserveJobError::Persistence)?;
        if project_active >= config.max_active_jobs_per_project {
            return Err(ReserveJobError::ProjectLimit);
        }
    }

    let queue_expires_at = command.now + config.queue_wait;
    let retained_until = command.now + config.retention;
    sqlx::query(
        "insert into processing_jobs (
             id, operation, requester_user_id, project_id,
             idempotency_scope, idempotency_key, command_digest,
             normalized_options, options_digest, state, phase,
             max_attempts, next_attempt_at, created_at, updated_at,
             queue_expires_at, retained_until
         ) values (
             $1, $2, $3, $4, $5, $6, $7, $8, $9,
             'preparing', 'capturing_input', 3, $10, $10, $10, $11, $12
         )",
    )
    .bind(command.id)
    .bind(command.operation)
    .bind(command.requester_user_id)
    .bind(command.project_id)
    .bind(command.idempotency_scope)
    .bind(command.idempotency_key)
    .bind(command.command_digest)
    .bind(command.normalized_options)
    .bind(command.options_digest)
    .bind(command.now)
    .bind(queue_expires_at)
    .bind(retained_until)
    .execute(&mut *transaction)
    .await
    .map_err(ReserveJobError::Persistence)?;
    transaction
        .commit()
        .await
        .map_err(ReserveJobError::Persistence)?;
    Ok(ReserveJobOutcome::Reserved)
}

async fn find_idempotent_job(
    connection: &mut PgConnection,
    requester_user_id: Uuid,
    scope: &str,
    key: &str,
) -> Result<Option<JobRecord>, sqlx::Error> {
    let row = sqlx::query(
        "select id, operation, requester_user_id, project_id, result_project_id, state, phase,
                cancellation_requested, attempt_count, processor_contract,
                failure_class, failure_code, failure_message,
                created_at, updated_at, completed_at
         from processing_jobs
         where requester_user_id = $1 and idempotency_scope = $2 and idempotency_key = $3",
    )
    .bind(requester_user_id)
    .bind(scope)
    .bind(key)
    .fetch_optional(connection)
    .await?;
    row.as_ref().map(job_from_row).transpose()
}

pub(super) async fn pin_project_assets(
    transaction: &mut Transaction<'_, Postgres>,
    job_id: Uuid,
    object_keys: &[String],
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    for object_key in object_keys
        .iter()
        .filter(|key| !key.starts_with("inline://"))
    {
        sqlx::query(
            "insert into processing_input_asset_pins (job_id, object_key, created_at)
             values ($1, $2, $3)
             on conflict (job_id, object_key) do nothing",
        )
        .bind(job_id)
        .bind(object_key)
        .bind(now)
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}

pub(super) async fn release_project_asset_pins(
    db: &PgPool,
    job_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("delete from processing_input_asset_pins where job_id = $1")
        .bind(job_id)
        .execute(db)
        .await?;
    Ok(())
}

pub(super) struct PreparedInput<'a> {
    pub schema: &'a str,
    pub media_type: &'a str,
    pub bytes: &'a [u8],
    pub digest: &'a [u8],
    pub normalized_options: &'a Value,
    pub options_digest: &'a [u8],
    pub workspace_version: Option<i64>,
    pub content_epoch: Option<i64>,
    pub source_epoch: Option<i64>,
    pub now: DateTime<Utc>,
}

pub(super) async fn store_prepared_input(
    db: &PgPool,
    job_id: Uuid,
    input: &PreparedInput<'_>,
) -> Result<Option<JobRecord>, sqlx::Error> {
    let mut transaction = db.begin().await?;
    let blob_id = store_blob(
        &mut transaction,
        input.digest,
        input.media_type,
        input.bytes,
        input.now,
    )
    .await?;
    let row = sqlx::query(
        "update processing_jobs
         set input_schema = $2, input_blob_id = $3, input_digest = $4,
             normalized_options = $5, options_digest = $6,
             source_workspace_version = $7, source_content_epoch = $8,
             source_epoch = $9, state = 'queued', phase = 'waiting_for_worker',
             queued_at = $10, updated_at = $10
         where id = $1 and state = 'preparing' and not cancellation_requested
         returning id, operation, requester_user_id, project_id, result_project_id, state, phase,
                   cancellation_requested, attempt_count, processor_contract,
                   failure_class, failure_code, failure_message,
                   created_at, updated_at, completed_at",
    )
    .bind(job_id)
    .bind(input.schema)
    .bind(blob_id)
    .bind(input.digest)
    .bind(input.normalized_options)
    .bind(input.options_digest)
    .bind(input.workspace_version)
    .bind(input.content_epoch)
    .bind(input.source_epoch)
    .bind(input.now)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some(row) = row else {
        transaction.rollback().await?;
        return Ok(None);
    };
    sqlx::query("delete from processing_input_asset_pins where job_id = $1")
        .bind(job_id)
        .execute(&mut *transaction)
        .await?;
    let job = job_from_row(&row)?;
    transaction.commit().await?;
    Ok(Some(job))
}

pub(super) async fn mark_preparation_failed(
    db: &PgPool,
    job_id: Uuid,
    code: &str,
    message: &str,
) -> Result<(), sqlx::Error> {
    let now = Utc::now();
    let mut transaction = db.begin().await?;
    sqlx::query(
        "update processing_jobs
         set state = 'failed', phase = 'complete', failure_class = 'internal',
             failure_code = $2, failure_message = $3,
             updated_at = $4, completed_at = $4
         where id = $1 and state = 'preparing'",
    )
    .bind(job_id)
    .bind(code)
    .bind(message)
    .bind(now)
    .execute(&mut *transaction)
    .await?;
    sqlx::query("delete from processing_input_asset_pins where job_id = $1")
        .bind(job_id)
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await
}

pub(super) async fn list_jobs_for_user(
    db: &PgPool,
    user_id: Uuid,
) -> Result<Vec<JobRecord>, sqlx::Error> {
    let rows = sqlx::query(
        "select id, operation, requester_user_id, project_id, result_project_id, state, phase,
                cancellation_requested, attempt_count, processor_contract,
                failure_class, failure_code, failure_message,
                created_at, updated_at, completed_at
         from processing_jobs
         where requester_user_id = $1
         order by
             case when state = any(array['preparing', 'queued', 'running', 'finalizing'])
                  then 0 else 1 end,
             updated_at desc
         limit 50",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    rows.iter().map(job_from_row).collect()
}

pub(super) async fn job_for_user(
    db: &PgPool,
    user_id: Uuid,
    job_id: Uuid,
) -> Result<Option<JobRecord>, sqlx::Error> {
    let row = sqlx::query(
        "select id, operation, requester_user_id, project_id, result_project_id, state, phase,
                cancellation_requested, attempt_count, processor_contract,
                failure_class, failure_code, failure_message,
                created_at, updated_at, completed_at
         from processing_jobs
         where id = $1 and requester_user_id = $2",
    )
    .bind(job_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    row.as_ref().map(job_from_row).transpose()
}

pub(super) async fn artifacts_for_jobs(
    db: &PgPool,
    job_ids: &[Uuid],
) -> Result<Vec<ArtifactRecord>, sqlx::Error> {
    if job_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = sqlx::query(
        "select id, job_id, blob_id, role, media_type, filename, size_bytes, sha256
         from processing_artifacts where job_id = any($1) order by role asc",
    )
    .bind(job_ids)
    .fetch_all(db)
    .await?;
    rows.iter().map(artifact_from_row).collect()
}

pub(super) async fn cancel_job(
    db: &PgPool,
    user_id: Uuid,
    job_id: Uuid,
) -> Result<Option<JobRecord>, sqlx::Error> {
    let now = Utc::now();
    let mut transaction = db.begin().await?;
    let row = sqlx::query(
        "select state from processing_jobs
         where id = $1 and requester_user_id = $2 for update",
    )
    .bind(job_id)
    .bind(user_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let state: ProcessingJobState = row.try_get("state")?;
    match state {
        ProcessingJobState::Preparing | ProcessingJobState::Queued => {
            sqlx::query(
                "update processing_jobs
                 set state = 'cancelled', phase = 'complete', cancellation_requested = true,
                     updated_at = $2, completed_at = $2
                 where id = $1",
            )
            .bind(job_id)
            .bind(now)
            .execute(&mut *transaction)
            .await?;
            sqlx::query("delete from processing_input_asset_pins where job_id = $1")
                .bind(job_id)
                .execute(&mut *transaction)
                .await?;
        }
        ProcessingJobState::Running => {
            sqlx::query(
                "update processing_jobs set cancellation_requested = true, updated_at = $2
                 where id = $1",
            )
            .bind(job_id)
            .bind(now)
            .execute(&mut *transaction)
            .await?;
        }
        ProcessingJobState::Finalizing
        | ProcessingJobState::Succeeded
        | ProcessingJobState::Failed
        | ProcessingJobState::Cancelled
        | ProcessingJobState::Expired => {}
    }
    let row = sqlx::query(
        "select id, operation, requester_user_id, project_id, result_project_id, state, phase,
                cancellation_requested, attempt_count, processor_contract,
                failure_class, failure_code, failure_message,
                created_at, updated_at, completed_at
         from processing_jobs where id = $1",
    )
    .bind(job_id)
    .fetch_one(&mut *transaction)
    .await?;
    let job = job_from_row(&row)?;
    transaction.commit().await?;
    Ok(Some(job))
}

pub(super) async fn artifact_content_for_user(
    db: &PgPool,
    user_id: Uuid,
    job_id: Uuid,
    artifact_id: Uuid,
) -> Result<Option<(Option<Uuid>, ArtifactContent)>, sqlx::Error> {
    let row = sqlx::query(
        "select jobs.project_id,
                artifacts.id, artifacts.job_id, artifacts.blob_id,
                artifacts.role, artifacts.media_type, artifacts.filename,
                artifacts.size_bytes, artifacts.sha256, blobs.content
         from processing_artifacts artifacts
         join processing_jobs jobs on jobs.id = artifacts.job_id
         join processing_blobs blobs on blobs.id = artifacts.blob_id
         where artifacts.id = $1 and artifacts.job_id = $2
           and jobs.requester_user_id = $3 and jobs.state = 'succeeded'",
    )
    .bind(artifact_id)
    .bind(job_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    row.map(|row| {
        let project_id = row.try_get("project_id")?;
        let artifact = artifact_from_row(&row)?;
        let content = row.try_get("content")?;
        Ok((project_id, ArtifactContent { artifact, content }))
    })
    .transpose()
}

pub(super) async fn artifacts_by_job(
    db: &PgPool,
    job_id: Uuid,
) -> Result<Vec<ArtifactRecord>, sqlx::Error> {
    artifacts_for_jobs(db, &[job_id]).await
}

pub(super) async fn capability_stats(
    db: &PgPool,
    operation: ProcessingOperation,
) -> Result<CapabilityStats, sqlx::Error> {
    let now = Utc::now();
    let row = sqlx::query(
        "select
             (select count(distinct sessions.id)
              from processing_worker_sessions sessions
              join processing_worker_processors processors on processors.session_id = sessions.id
              where processors.operation = $1 and processors.healthy
                and sessions.state = 'active' and sessions.expires_at > $2) as healthy_sessions,
             (select coalesce(sum(processors.slots), 0)
              from processing_worker_sessions sessions
              join processing_worker_processors processors on processors.session_id = sessions.id
              where processors.operation = $1 and processors.healthy
                and sessions.state = 'active' and sessions.expires_at > $2) as active_slots,
             (select count(*) from processing_jobs
              where operation = $1 and state in ('running', 'finalizing')) as active_jobs,
             (select count(*) from processing_jobs
              where operation = $1 and state = 'queued') as queued_jobs",
    )
    .bind(operation)
    .bind(now)
    .fetch_one(db)
    .await?;
    Ok(CapabilityStats {
        healthy_sessions: row.try_get("healthy_sessions")?,
        active_slots: row.try_get("active_slots")?,
        active_jobs: row.try_get("active_jobs")?,
        queued_jobs: row.try_get("queued_jobs")?,
    })
}

pub(super) async fn store_blob(
    transaction: &mut Transaction<'_, Postgres>,
    digest: &[u8],
    media_type: &str,
    content: &[u8],
    now: DateTime<Utc>,
) -> Result<Uuid, sqlx::Error> {
    let size_bytes = i64::try_from(content.len()).unwrap_or(i64::MAX);
    sqlx::query_scalar(
        "insert into processing_blobs (id, sha256, size_bytes, media_type, content, created_at)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (sha256, size_bytes) do update set sha256 = excluded.sha256
         returning id",
    )
    .bind(Uuid::new_v4())
    .bind(digest)
    .bind(size_bytes)
    .bind(media_type)
    .bind(content)
    .bind(now)
    .fetch_one(&mut **transaction)
    .await
}

fn job_from_row(row: &sqlx::postgres::PgRow) -> Result<JobRecord, sqlx::Error> {
    Ok(JobRecord {
        id: row.try_get("id")?,
        operation: row.try_get("operation")?,
        project_id: row.try_get("project_id")?,
        result_project_id: row.try_get("result_project_id")?,
        state: row.try_get("state")?,
        phase: row.try_get("phase")?,
        cancellation_requested: row.try_get("cancellation_requested")?,
        attempt_count: row.try_get("attempt_count")?,
        processor_contract: row.try_get("processor_contract")?,
        failure_class: row.try_get("failure_class")?,
        failure_code: row.try_get("failure_code")?,
        failure_message: row.try_get("failure_message")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        completed_at: row.try_get("completed_at")?,
    })
}

fn artifact_from_row(row: &sqlx::postgres::PgRow) -> Result<ArtifactRecord, sqlx::Error> {
    Ok(ArtifactRecord {
        id: row.try_get("id")?,
        job_id: row.try_get("job_id")?,
        role: row.try_get("role")?,
        media_type: row.try_get("media_type")?,
        filename: row.try_get("filename")?,
        size_bytes: row.try_get("size_bytes")?,
        sha256: row.try_get("sha256")?,
    })
}
