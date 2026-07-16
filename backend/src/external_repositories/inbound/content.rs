use super::persistence;
use super::ExternalGitInboundOperation;
use crate::collaboration::CollaborationContext;
use crate::distribution::DistributionConfig;
use crate::object_cleanup::enqueue_object_deletions;
use crate::object_storage::ObjectStorage;
use crate::versioning::{FlushPendingServerCommitError, WorkspaceChangeKind, WorkspaceContributor};
use crate::workspace::{
    ReplaceProjectContent, ReplaceProjectContentResult, WorkspaceAsset, WorkspaceDocument,
};
use chrono::Utc;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

pub(crate) struct ApplyExternalGitInboundCommand {
    pub job_id: Uuid,
    pub project_id: Uuid,
    pub actor_user_id: Uuid,
    pub operation: ExternalGitInboundOperation,
    pub source_branch: String,
    pub remote_sha: String,
    pub entry_file_path: String,
    pub documents: Vec<WorkspaceDocument>,
    pub directories: Vec<String>,
    pub assets: Vec<WorkspaceAsset>,
}

pub(crate) struct AppliedExternalGitInboundState {
    pub workspace_version: i64,
    pub content_epoch: i64,
    pub old_object_keys: Vec<String>,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum ApplyInboundPersistenceStage {
    Begin,
    ReplaceWorkspace,
    ClearCollaboration,
    RecordVersioning,
    RecordContributor,
    RecordLinkImport,
    MarkJobApplied,
    EnqueueObjectDeletion,
}

#[derive(Debug, Error)]
pub(crate) enum ApplyExternalGitInboundError {
    #[error("project {project_id} was not found while applying inbound repository content")]
    ProjectNotFound { project_id: Uuid },
    #[error("workspace changed while applying inbound repository content to project {project_id}")]
    WorkspaceChanged { project_id: Uuid },
    #[error("inbound repository has no valid entry file for project {project_id}")]
    InvalidEntryFile { project_id: Uuid },
    #[error("pending workspace changes could not be flushed for project {project_id}")]
    WorkspaceFlush {
        project_id: Uuid,
        #[source]
        source: FlushPendingServerCommitError,
    },
    #[error("inbound repository apply failed during {stage:?} for project {project_id}")]
    Persistence {
        stage: ApplyInboundPersistenceStage,
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("inbound repository apply commit result is ambiguous for project {project_id}")]
    CommitAmbiguous {
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

pub(crate) async fn apply_external_git_inbound_content(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    distribution: &DistributionConfig,
    collaboration: &CollaborationContext,
    command: ApplyExternalGitInboundCommand,
) -> Result<AppliedExternalGitInboundState, ApplyExternalGitInboundError> {
    if command.operation == ExternalGitInboundOperation::Sync {
        crate::versioning::flush_pending_server_commit(
            db,
            storage,
            distribution,
            command.project_id,
            Some(command.actor_user_id),
            None,
            None,
        )
        .await
        .map_err(|source| ApplyExternalGitInboundError::WorkspaceFlush {
            project_id: command.project_id,
            source,
        })?;
    }
    let now = Utc::now();
    let mut transaction =
        db.begin()
            .await
            .map_err(|source| ApplyExternalGitInboundError::Persistence {
                stage: ApplyInboundPersistenceStage::Begin,
                project_id: command.project_id,
                source,
            })?;
    let applied = crate::workspace::replace_project_content(
        &mut transaction,
        &ReplaceProjectContent {
            project_id: command.project_id,
            expected_workspace_version: None,
            documents: &command.documents,
            directories: &command.directories,
            assets: &command.assets,
            entry_file_path: &command.entry_file_path,
            asset_uploaded_by: Some(command.actor_user_id),
            updated_at: now,
        },
    )
    .await
    .map_err(|source| ApplyExternalGitInboundError::Persistence {
        stage: ApplyInboundPersistenceStage::ReplaceWorkspace,
        project_id: command.project_id,
        source,
    })?;
    let applied = match applied {
        ReplaceProjectContentResult::Replaced(applied) => applied,
        ReplaceProjectContentResult::NotFound => {
            return Err(ApplyExternalGitInboundError::ProjectNotFound {
                project_id: command.project_id,
            });
        }
        ReplaceProjectContentResult::WorkspaceVersionChanged => {
            return Err(ApplyExternalGitInboundError::WorkspaceChanged {
                project_id: command.project_id,
            });
        }
        ReplaceProjectContentResult::InvalidEntryFile => {
            return Err(ApplyExternalGitInboundError::InvalidEntryFile {
                project_id: command.project_id,
            });
        }
    };
    collaboration
        .clear_persisted_project(&mut transaction, command.project_id)
        .await
        .map_err(|source| ApplyExternalGitInboundError::Persistence {
            stage: ApplyInboundPersistenceStage::ClearCollaboration,
            project_id: command.project_id,
            source,
        })?;
    crate::versioning::record_workspace_change(
        &mut transaction,
        command.project_id,
        WorkspaceContributor::User(command.actor_user_id),
        WorkspaceChangeKind::Replacement,
        now,
    )
    .await
    .map_err(|source| ApplyExternalGitInboundError::Persistence {
        stage: ApplyInboundPersistenceStage::RecordVersioning,
        project_id: command.project_id,
        source,
    })?;
    crate::external_repositories::record_project_activity(
        &mut transaction,
        command.project_id,
        Some(command.actor_user_id),
        None,
        now,
    )
    .await
    .map_err(|source| ApplyExternalGitInboundError::Persistence {
        stage: ApplyInboundPersistenceStage::RecordContributor,
        project_id: command.project_id,
        source,
    })?;
    persistence::record_link_import(
        &mut transaction,
        command.project_id,
        &command.source_branch,
        &command.remote_sha,
        now,
    )
    .await
    .map_err(|source| ApplyExternalGitInboundError::Persistence {
        stage: ApplyInboundPersistenceStage::RecordLinkImport,
        project_id: command.project_id,
        source,
    })?;
    persistence::mark_job_applied(
        &mut transaction,
        command.job_id,
        &command.remote_sha,
        applied.workspace_version,
        now,
    )
    .await
    .map_err(|source| ApplyExternalGitInboundError::Persistence {
        stage: ApplyInboundPersistenceStage::MarkJobApplied,
        project_id: command.project_id,
        source,
    })?;
    enqueue_object_deletions(&mut transaction, &applied.old_object_keys)
        .await
        .map_err(|source| ApplyExternalGitInboundError::Persistence {
            stage: ApplyInboundPersistenceStage::EnqueueObjectDeletion,
            project_id: command.project_id,
            source,
        })?;
    transaction
        .commit()
        .await
        .map_err(|source| ApplyExternalGitInboundError::CommitAmbiguous {
            project_id: command.project_id,
            source,
        })?;
    Ok(AppliedExternalGitInboundState {
        workspace_version: applied.workspace_version,
        content_epoch: applied.content_epoch,
        old_object_keys: applied.old_object_keys,
    })
}
