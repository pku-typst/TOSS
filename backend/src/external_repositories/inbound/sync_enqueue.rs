//! Enqueueing an inbound synchronization for an already linked project.

use super::super::provider::ProviderInstanceId;
use super::branch::SourceBranch;
use super::persistence;
use super::{ExternalGitInboundOperation, ExternalRepositoryInboundJob};
use crate::database_error::is_unique_constraint_violation;
use chrono::Utc;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
pub(super) enum EnqueueSyncPersistenceStage {
    Begin,
    LockProject,
    CheckCheckpoint,
    InsertJob,
    ClearImportError,
    Commit,
}

#[derive(Debug, Error)]
pub(super) enum EnqueueSyncError {
    #[error("project was not found")]
    ProjectNotFound,
    #[error("an outbound checkpoint is active")]
    OutboundCheckpointActive,
    #[error("an inbound repository job is active")]
    InboundJobActive,
    #[error("inbound sync enqueue failed during {stage:?} for project {project_id}")]
    Persistence {
        stage: EnqueueSyncPersistenceStage,
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

pub(super) struct EnqueueInboundSync {
    pub project_id: Uuid,
    pub actor_user_id: Uuid,
    pub provider: ProviderInstanceId,
    pub source_branch: SourceBranch,
}

pub(super) async fn enqueue_sync(
    db: &PgPool,
    command: EnqueueInboundSync,
) -> Result<ExternalRepositoryInboundJob, EnqueueSyncError> {
    let now = Utc::now();
    let job_id = Uuid::new_v4();
    let mut transaction = db
        .begin()
        .await
        .map_err(|source| EnqueueSyncError::Persistence {
            stage: EnqueueSyncPersistenceStage::Begin,
            project_id: command.project_id,
            source,
        })?;
    if crate::workspace::lock_workspace_version(&mut transaction, command.project_id)
        .await
        .map_err(|source| EnqueueSyncError::Persistence {
            stage: EnqueueSyncPersistenceStage::LockProject,
            project_id: command.project_id,
            source,
        })?
        .is_none()
    {
        return Err(EnqueueSyncError::ProjectNotFound);
    }
    if super::super::checkpoint::checkpoint_operation_exists_for_update(
        &mut transaction,
        command.project_id,
    )
    .await
    .map_err(|source| EnqueueSyncError::Persistence {
        stage: EnqueueSyncPersistenceStage::CheckCheckpoint,
        project_id: command.project_id,
        source,
    })? {
        return Err(EnqueueSyncError::OutboundCheckpointActive);
    }
    if let Err(database_error) = persistence::insert_inbound_job(
        &mut transaction,
        persistence::InsertInboundJobRecord {
            job_id,
            project_id: command.project_id,
            provider_instance_id: &command.provider,
            operation: ExternalGitInboundOperation::Sync,
            source_branch: command.source_branch.as_str(),
            requested_by_user_id: command.actor_user_id,
            now,
        },
    )
    .await
    {
        if is_unique_constraint_violation(
            &database_error,
            "external_git_inbound_jobs_one_active_project",
        ) {
            return Err(EnqueueSyncError::InboundJobActive);
        }
        return Err(EnqueueSyncError::Persistence {
            stage: EnqueueSyncPersistenceStage::InsertJob,
            project_id: command.project_id,
            source: database_error,
        });
    }
    persistence::clear_last_import_error(&mut transaction, command.project_id, now)
        .await
        .map_err(|source| EnqueueSyncError::Persistence {
            stage: EnqueueSyncPersistenceStage::ClearImportError,
            project_id: command.project_id,
            source,
        })?;
    transaction
        .commit()
        .await
        .map_err(|source| EnqueueSyncError::Persistence {
            stage: EnqueueSyncPersistenceStage::Commit,
            project_id: command.project_id,
            source,
        })?;
    Ok(ExternalRepositoryInboundJob::pending(
        job_id,
        command.project_id,
        command.provider,
        ExternalGitInboundOperation::Sync,
        command.source_branch.into_string(),
        now,
    ))
}
