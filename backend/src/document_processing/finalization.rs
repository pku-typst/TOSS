//! Core-owned result publication, lease recovery, and lifecycle maintenance.

use super::model::{processing_retry_delay, ProcessingJobState, ProcessingOperation};
use super::operation_contract::{ArtifactSizeClass, FinalizationKind};
use super::pptx::validate_pptx;
use super::workspace_bundle::validate_workspace_bundle;
use super::workspace_bundle::ValidatedWorkspaceBundle;
use super::{DocumentProcessingContext, ProcessingConfig};
use crate::access::{ensure_project_role_for_user, AccessNeed, ProjectAuthorizationError};
use crate::audit::record_event;
use crate::process_lifecycle::DrainSignal;
use crate::workspace::{
    mark_project_dirty, provision_project, stage_workspace_import_assets, CreateProjectGraph,
    ProjectName, ProjectType, StagedWorkspaceImportAssets, WorkspaceImportAsset,
};
use chrono::{DateTime, Utc};
use serde_json::Value;
use sha2::Digest;
use sqlx::{PgPool, Row};
use std::collections::HashSet;
use std::time::Duration;
use thiserror::Error;
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
    normalized_options: Value,
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

struct WorkspacePublication<'a> {
    lease: &'a FinalizationLease,
    staged: &'a [StagedArtifact],
    bundle: &'a ValidatedWorkspaceBundle,
    project_name: &'a ProjectName,
    staged_assets: &'a StagedWorkspaceImportAssets,
    project_id: Uuid,
    now: DateTime<Utc>,
}

enum ValidationFailure {
    AccessRevoked,
    ArtifactSet,
    PdfInvalid,
    PptxInvalid,
    DiagnosticInvalid,
    WorkspaceInvalid,
}

enum ValidatedFinalization {
    Artifacts,
    Workspace {
        bundle: ValidatedWorkspaceBundle,
        project_name: crate::workspace::ProjectName,
    },
}

#[derive(Debug, Error)]
enum FinalizationError {
    #[error(transparent)]
    Persistence(#[from] sqlx::Error),
    #[error(transparent)]
    WorkspaceAssets(#[from] crate::workspace::StageWorkspaceImportAssetsError),
}

impl ValidationFailure {
    const fn class(&self) -> &'static str {
        match self {
            Self::AccessRevoked => "authorization",
            Self::ArtifactSet
            | Self::PdfInvalid
            | Self::PptxInvalid
            | Self::DiagnosticInvalid
            | Self::WorkspaceInvalid => "internal_contract_violation",
        }
    }

    const fn code(&self) -> &'static str {
        match self {
            Self::AccessRevoked => "project_access_revoked",
            Self::ArtifactSet => "artifact_set_invalid",
            Self::PdfInvalid => "pdf_invalid",
            Self::PptxInvalid => "pptx_invalid",
            Self::DiagnosticInvalid => "diagnostic_invalid",
            Self::WorkspaceInvalid => "workspace_bundle_invalid",
        }
    }

    const fn message(&self) -> &'static str {
        match self {
            Self::AccessRevoked => "Project access was revoked before result publication",
            Self::ArtifactSet => "Processor output did not match the operation contract",
            Self::PdfInvalid => "Processor output was not a valid PDF artifact",
            Self::PptxInvalid => "Processor output was not a valid PPTX artifact",
            Self::DiagnosticInvalid => "Processor diagnostic output was invalid",
            Self::WorkspaceInvalid => "Processor output was not a valid Workspace bundle",
        }
    }
}

pub(crate) fn spawn_processing_maintenance(
    context: DocumentProcessingContext,
    drain: DrainSignal,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            if drain.is_triggered() {
                return;
            }
            if let Err(error) = maintain_lifecycle(&context.db).await {
                tracing::error!(?error, "document processing lifecycle maintenance failed");
            }
            for _ in 0..MAINTENANCE_BATCH {
                if drain.is_triggered() {
                    return;
                }
                match finalize_one(&context).await {
                    Ok(true) => {}
                    Ok(false) => break,
                    Err(error) => {
                        tracing::error!(?error, "document processing finalization failed");
                        break;
                    }
                }
            }
            tokio::select! {
                _ = drain.triggered() => return,
                _ = tokio::time::sleep(MAINTENANCE_INTERVAL) => {}
            }
        }
    })
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

async fn finalize_one(context: &DocumentProcessingContext) -> Result<bool, FinalizationError> {
    let Some(lease) = acquire_finalization_lease(&context.db, &context.config).await? else {
        return Ok(false);
    };
    let staged = load_staged_artifacts(&context.db, &lease).await?;
    let validation = validate_finalization(&context.db, &lease, &staged, &context.config).await;
    match validation {
        Ok(ValidatedFinalization::Artifacts) => {
            publish_artifacts(&context.db, &lease, &staged).await?
        }
        Ok(ValidatedFinalization::Workspace {
            bundle,
            project_name,
        }) => publish_workspace(context, &lease, &staged, bundle, project_name).await?,
        Err(FinalizationCheckError::Rejected(failure)) => {
            reject_artifacts(&context.db, &lease, failure).await?
        }
        Err(FinalizationCheckError::Unavailable(error)) => return Err(error.into()),
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
        "select id, operation, requester_user_id, project_id, cache_source_job_id,
                normalized_options
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
        normalized_options: row.try_get("normalized_options")?,
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
) -> Result<ValidatedFinalization, FinalizationCheckError> {
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
    let contract = lease.operation.contract();
    let mut roles = HashSet::with_capacity(staged.len());
    for artifact in staged {
        let Some(artifact_contract) = contract.artifact(&artifact.role) else {
            return Err(FinalizationCheckError::Rejected(
                ValidationFailure::ArtifactSet,
            ));
        };
        let limit = match artifact_contract.size_class {
            ArtifactSizeClass::Output => config.max_output_bytes,
            ArtifactSizeClass::Diagnostic => config.max_diagnostic_bytes,
        };
        if artifact.size_bytes != i64::try_from(artifact.content.len()).unwrap_or(i64::MAX)
            || artifact.sha256 != sha2::Sha256::digest(&artifact.content).as_slice()
            || artifact.size_bytes <= 0
            || artifact.size_bytes > limit
            || artifact.media_type != artifact_contract.media_type
            || !artifact
                .filename
                .ends_with(artifact_contract.filename_suffix)
            || !roles.insert(artifact.role.as_str())
        {
            return Err(FinalizationCheckError::Rejected(
                ValidationFailure::ArtifactSet,
            ));
        }
    }
    if contract
        .artifacts
        .iter()
        .any(|artifact| artifact.required && !roles.contains(artifact.role))
    {
        return Err(FinalizationCheckError::Rejected(
            ValidationFailure::ArtifactSet,
        ));
    }
    let output_expansion_limit = u64::try_from(config.max_output_bytes)
        .unwrap_or(u64::MAX)
        .saturating_mul(4);
    let validated = match contract.finalization {
        FinalizationKind::PdfArtifacts => {
            if !staged
                .iter()
                .find(|artifact| artifact.role == "pdf")
                .is_some_and(|artifact| valid_pdf(&artifact.content))
            {
                return Err(FinalizationCheckError::Rejected(
                    ValidationFailure::PdfInvalid,
                ));
            }
            if staged
                .iter()
                .find(|artifact| artifact.role == "log")
                .is_some_and(|artifact| std::str::from_utf8(&artifact.content).is_err())
            {
                return Err(FinalizationCheckError::Rejected(
                    ValidationFailure::DiagnosticInvalid,
                ));
            }
            ValidatedFinalization::Artifacts
        }
        FinalizationKind::PptxArtifacts => {
            if !staged
                .iter()
                .find(|artifact| artifact.role == "pptx")
                .is_some_and(|artifact| {
                    validate_pptx(&artifact.content, output_expansion_limit).is_ok()
                })
            {
                return Err(FinalizationCheckError::Rejected(
                    ValidationFailure::PptxInvalid,
                ));
            }
            validate_report(staged, "pptx-export-report/v1")?;
            ValidatedFinalization::Artifacts
        }
        FinalizationKind::TypstWorkspace => {
            let bundle = staged
                .iter()
                .find(|artifact| artifact.role == "workspace")
                .and_then(|artifact| {
                    validate_workspace_bundle(&artifact.content, output_expansion_limit).ok()
                })
                .ok_or(FinalizationCheckError::Rejected(
                    ValidationFailure::WorkspaceInvalid,
                ))?;
            validate_report(staged, "pptx-import-report/v1")?;
            let project_name = lease
                .normalized_options
                .get("project_name")
                .and_then(Value::as_str)
                .and_then(|value| crate::workspace::ProjectName::parse(value).ok())
                .ok_or(FinalizationCheckError::Rejected(
                    ValidationFailure::WorkspaceInvalid,
                ))?;
            ValidatedFinalization::Workspace {
                bundle,
                project_name,
            }
        }
    };
    Ok(validated)
}

fn validate_report(
    staged: &[StagedArtifact],
    expected_schema: &str,
) -> Result<(), FinalizationCheckError> {
    let valid = staged
        .iter()
        .find(|artifact| artifact.role == "report")
        .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.content).ok())
        .is_some_and(|report| {
            report.get("schema").and_then(Value::as_str) == Some(expected_schema)
        });
    if valid {
        Ok(())
    } else {
        Err(FinalizationCheckError::Rejected(
            ValidationFailure::DiagnosticInvalid,
        ))
    }
}

async fn publish_artifacts(
    db: &PgPool,
    lease: &FinalizationLease,
    staged: &[StagedArtifact],
) -> Result<(), sqlx::Error> {
    let now = Utc::now();
    let mut transaction = db.begin().await?;
    let locked = lock_finalization(&mut transaction, lease, now).await?;
    if !locked {
        transaction.rollback().await?;
        return Ok(());
    }
    publish_staged_artifacts(&mut transaction, lease.job_id, staged, now).await?;
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

async fn publish_workspace(
    context: &DocumentProcessingContext,
    lease: &FinalizationLease,
    staged: &[StagedArtifact],
    mut bundle: ValidatedWorkspaceBundle,
    project_name: ProjectName,
) -> Result<(), FinalizationError> {
    let project_id = Uuid::new_v4();
    let import_assets = bundle
        .assets
        .drain(..)
        .map(|asset| WorkspaceImportAsset {
            path: asset.path,
            content_type: asset.media_type,
            bytes: asset.bytes,
        })
        .collect();
    let staged_assets = stage_workspace_import_assets(
        &context.db,
        context.storage.as_ref(),
        project_id,
        import_assets,
    )
    .await?;
    let now = Utc::now();
    let mut transaction = match context.db.begin().await {
        Ok(transaction) => transaction,
        Err(error) => {
            staged_assets
                .cleanup(&context.db, context.storage.as_ref())
                .await;
            return Err(error.into());
        }
    };
    let publish = publish_workspace_transaction(
        &mut transaction,
        &WorkspacePublication {
            lease,
            staged,
            bundle: &bundle,
            project_name: &project_name,
            staged_assets: &staged_assets,
            project_id,
            now,
        },
    )
    .await;
    let published = match publish {
        Ok(published) => published,
        Err(error) => {
            let _ = transaction.rollback().await;
            staged_assets
                .cleanup(&context.db, context.storage.as_ref())
                .await;
            return Err(error.into());
        }
    };
    if !published {
        let rollback = transaction.rollback().await;
        staged_assets
            .cleanup(&context.db, context.storage.as_ref())
            .await;
        rollback?;
        return Ok(());
    }
    if let Err(error) = transaction.commit().await {
        // PostgreSQL commit errors are outcome-ambiguous. Recheck references
        // before removing staged objects so a successful commit is preserved.
        staged_assets
            .cleanup_if_unreferenced(&context.db, context.storage.as_ref())
            .await;
        return Err(error.into());
    }
    record_event(
        &context.db,
        Some(lease.requester_user_id),
        "project.import.pptx",
        serde_json::json!({"job_id": lease.job_id, "project_id": project_id}),
    )
    .await;
    Ok(())
}

async fn publish_workspace_transaction(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    publication: &WorkspacePublication<'_>,
) -> Result<bool, sqlx::Error> {
    if !lock_finalization(transaction, publication.lease, publication.now).await? {
        return Ok(false);
    }
    let project = CreateProjectGraph {
        project_id: publication.project_id,
        owner_user_id: publication.lease.requester_user_id,
        name: publication.project_name,
        project_type: ProjectType::Typst,
        entry_file_path: &publication.bundle.entry_file_path,
        latex_engine: None,
        directories: &publication.bundle.directories,
        documents: &publication.bundle.documents,
        assets: &publication.staged_assets.assets,
        created_at: publication.now,
    };
    provision_project(transaction, &project).await?;
    mark_project_dirty(
        transaction,
        publication.project_id,
        Some(publication.lease.requester_user_id),
        None,
    )
    .await?;
    publish_staged_artifacts(
        transaction,
        publication.lease.job_id,
        publication.staged,
        publication.now,
    )
    .await?;
    let updated = sqlx::query(
        "update processing_jobs
         set state = 'succeeded', phase = 'complete', result_project_id = $3,
             finalization_token = null, finalization_expires_at = null,
             updated_at = $4, completed_at = $4
         where id = $1 and state = 'finalizing' and finalization_token = $2",
    )
    .bind(publication.lease.job_id)
    .bind(publication.lease.token)
    .bind(publication.project_id)
    .bind(publication.now)
    .execute(&mut **transaction)
    .await?;
    Ok(updated.rows_affected() == 1)
}

async fn lock_finalization(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    lease: &FinalizationLease,
    now: DateTime<Utc>,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
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
    .fetch_one(&mut **transaction)
    .await
}

async fn publish_staged_artifacts(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    job_id: Uuid,
    staged: &[StagedArtifact],
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    for artifact in staged {
        sqlx::query(
            "insert into processing_artifacts (
                 id, job_id, blob_id, role, media_type, filename,
                 size_bytes, sha256, created_at
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             on conflict (job_id, role) do nothing",
        )
        .bind(Uuid::new_v4())
        .bind(job_id)
        .bind(artifact.blob_id)
        .bind(&artifact.role)
        .bind(&artifact.media_type)
        .bind(&artifact.filename)
        .bind(artifact.size_bytes)
        .bind(&artifact.sha256)
        .bind(now)
        .execute(&mut **transaction)
        .await?;
        if let Some(transfer_id) = artifact.transfer_id {
            sqlx::query(
                "update processing_transfers set state = 'consumed', updated_at = $2
                 where id = $1",
            )
            .bind(transfer_id)
            .bind(now)
            .execute(&mut **transaction)
            .await?;
        }
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
    use super::*;
    use crate::document_processing::workspace_bundle::WorkspaceBundleAsset;
    use crate::document_processing::ProcessingConfigFile;
    use crate::workspace::WorkspaceDocument;
    use std::path::Path;

    async fn migrated_test_pool() -> Result<Option<PgPool>, Box<dyn std::error::Error + Send + Sync>>
    {
        let database_url =
            std::env::var("TEST_DATABASE_URL").or_else(|_| std::env::var("DATABASE_URL"));
        let Ok(database_url) = database_url else {
            return Ok(None);
        };
        let pool = PgPool::connect(&database_url).await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Some(pool))
    }

    #[test]
    fn pdf_validation_requires_header_and_trailer() {
        assert!(valid_pdf(b"%PDF-1.7\n1 0 obj\nendobj\n%%EOF\n"));
        assert!(!valid_pdf(b"%PDF-1.7\ntruncated"));
        assert!(!valid_pdf(b"not a pdf\n%%EOF"));
    }

    #[tokio::test]
    async fn expired_finalization_lease_is_reacquired_and_fences_its_predecessor(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let user_id = Uuid::new_v4();
        let job_id = Uuid::new_v4();
        let now = Utc::now();
        let oldest = now - chrono::Duration::days(3_650);
        let username = format!("finalizer-{}", user_id.simple());
        sqlx::query(
            "insert into users (id, email, username, display_name, created_at)
             values ($1, $2, $3, 'Finalizer recovery', $4)",
        )
        .bind(user_id)
        .bind(format!("{user_id}@example.test"))
        .bind(username.chars().take(32).collect::<String>())
        .bind(now)
        .execute(&pool)
        .await?;
        sqlx::query(
            "insert into processing_jobs (
                 id, operation, requester_user_id, project_id,
                 idempotency_scope, idempotency_key, command_digest,
                 normalized_options, options_digest, state, phase,
                 max_attempts, next_attempt_at, created_at, updated_at,
                 queue_expires_at, retained_until
             ) values (
                 $1, 'latex.compile.pdf/v1', $2, null,
                 'finalization-recovery', $3, $4,
                 '{}'::jsonb, $4, 'finalizing', 'validating_result',
                 3, $5, $5, $5, $6, $6
             )",
        )
        .bind(job_id)
        .bind(user_id)
        .bind(Uuid::new_v4().to_string())
        .bind(vec![0_u8; 32])
        .bind(oldest)
        .bind(now + chrono::Duration::days(1))
        .execute(&pool)
        .await?;
        let config = ProcessingConfig::from_config(ProcessingConfigFile::default(), Path::new("."))
            .map_err(std::io::Error::other)?;
        let first = acquire_finalization_lease(&pool, &config)
            .await?
            .ok_or_else(|| std::io::Error::other("first finalization lease was not acquired"))?;
        assert_eq!(first.job_id, job_id);

        sqlx::query(
            "update processing_jobs
             set finalization_expires_at = $2, updated_at = $3
             where id = $1",
        )
        .bind(job_id)
        .bind(now - chrono::Duration::seconds(1))
        .bind(oldest)
        .execute(&pool)
        .await?;
        let second = acquire_finalization_lease(&pool, &config)
            .await?
            .ok_or_else(|| {
                std::io::Error::other("expired finalization lease was not reacquired")
            })?;
        assert_eq!(second.job_id, job_id);
        assert_ne!(first.token, second.token);

        publish_artifacts(&pool, &first, &[]).await?;
        reject_artifacts(&pool, &first, ValidationFailure::ArtifactSet).await?;
        let (state, token) = sqlx::query_as::<_, (String, Option<Uuid>)>(
            "select state, finalization_token from processing_jobs where id = $1",
        )
        .bind(job_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(state, "finalizing");
        assert_eq!(token, Some(second.token));

        reject_artifacts(&pool, &second, ValidationFailure::ArtifactSet).await?;
        let (state, token) = sqlx::query_as::<_, (String, Option<Uuid>)>(
            "select state, finalization_token from processing_jobs where id = $1",
        )
        .bind(job_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(state, "failed");
        assert_eq!(token, None);
        sqlx::query("delete from users where id = $1")
            .bind(user_id)
            .execute(&pool)
            .await?;
        Ok(())
    }

    #[tokio::test]
    async fn workspace_publication_creates_the_result_project_atomically(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let user_id = Uuid::new_v4();
        let job_id = Uuid::new_v4();
        let token = Uuid::new_v4();
        let now = Utc::now();
        let username = format!("importer-{}", user_id.simple());
        sqlx::query(
            "insert into users (id, email, username, display_name, created_at)
             values ($1, $2, $3, 'PPTX importer', $4)",
        )
        .bind(user_id)
        .bind(format!("{user_id}@example.test"))
        .bind(username.chars().take(32).collect::<String>())
        .bind(now)
        .execute(&pool)
        .await?;
        sqlx::query(
            "insert into processing_jobs (
                 id, operation, requester_user_id, project_id,
                 idempotency_scope, idempotency_key, command_digest,
                 normalized_options, options_digest, state, phase,
                 max_attempts, finalization_token, finalization_expires_at,
                 next_attempt_at, created_at, updated_at,
                 queue_expires_at, retained_until
             ) values (
                 $1, 'pptx.import.typst/v1', $2, null,
                 'workspace-publication', $3, $4,
                 $5, $4, 'finalizing', 'validating_result',
                 3, $6, $7, $8, $8, $8, $7, $7
             )",
        )
        .bind(job_id)
        .bind(user_id)
        .bind(Uuid::new_v4().to_string())
        .bind(vec![0_u8; 32])
        .bind(serde_json::json!({"project_name": "Imported deck"}))
        .bind(token)
        .bind(now + chrono::Duration::days(1))
        .bind(now)
        .execute(&pool)
        .await?;
        let config = ProcessingConfig::from_config(ProcessingConfigFile::default(), Path::new("."))
            .map_err(std::io::Error::other)?;
        let context = DocumentProcessingContext::new(pool.clone(), None, config);
        let lease = FinalizationLease {
            job_id,
            token,
            operation: ProcessingOperation::PptxImportTypstV1,
            requester_user_id: user_id,
            project_id: None,
            cache_source_job_id: None,
            normalized_options: serde_json::json!({"project_name": "Imported deck"}),
        };
        let bundle = ValidatedWorkspaceBundle {
            entry_file_path: "slides.typ".to_string(),
            directories: vec!["media".to_string()],
            documents: vec![WorkspaceDocument {
                path: "slides.typ".to_string(),
                content: "= Imported deck".to_string(),
            }],
            assets: vec![WorkspaceBundleAsset {
                path: "media/source.txt.bin".to_string(),
                media_type: "application/octet-stream".to_string(),
                bytes: b"source".to_vec(),
            }],
        };
        let project_name = ProjectName::parse("Imported deck").map_err(std::io::Error::other)?;

        publish_workspace(&context, &lease, &[], bundle, project_name).await?;

        let (state, result_project_id) = sqlx::query_as::<_, (String, Option<Uuid>)>(
            "select state, result_project_id from processing_jobs where id = $1",
        )
        .bind(job_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(state, "succeeded");
        let result_project_id = result_project_id
            .ok_or_else(|| std::io::Error::other("result project was not recorded"))?;
        let (owner_user_id, name, project_type) = sqlx::query_as::<_, (Uuid, String, ProjectType)>(
            "select owner_user_id, name, project_type from projects where id = $1",
        )
        .bind(result_project_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(owner_user_id, user_id);
        assert_eq!(name, "Imported deck");
        assert_eq!(project_type, ProjectType::Typst);
        let document_count: i64 =
            sqlx::query_scalar("select count(*) from documents where project_id = $1")
                .bind(result_project_id)
                .fetch_one(&pool)
                .await?;
        let asset_count: i64 =
            sqlx::query_scalar("select count(*) from project_assets where project_id = $1")
                .bind(result_project_id)
                .fetch_one(&pool)
                .await?;
        assert_eq!(document_count, 1);
        assert_eq!(asset_count, 1);
        sqlx::query("delete from audit_events where actor_user_id = $1")
            .bind(user_id)
            .execute(&pool)
            .await?;
        sqlx::query("delete from projects where id = $1")
            .bind(result_project_id)
            .execute(&pool)
            .await?;
        sqlx::query("delete from users where id = $1")
            .bind(user_id)
            .execute(&pool)
            .await?;
        Ok(())
    }
}
