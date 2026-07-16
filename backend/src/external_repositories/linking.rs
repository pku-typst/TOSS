mod persistence;
mod state;

use super::inbound::{active_job_exists, latest_inbound_job, ExternalRepositoryInboundJob};
use super::provider::{ExternalGitGateway, ProviderInstanceId, RemoteRepositoryDetails};
use super::{
    ExternalGitCheckpointPhase, ExternalGitCheckpointState, ExternalGitFailureCode,
    ExternalGitGrantStatus,
};
use crate::distribution::CheckpointBranchPrefix;
use crate::workspace::project_workspace_version;
use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool};
pub(crate) use state::{ExternalGitLinkStatus, ExternalGitProjectState};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub(super) enum PersistRepositoryLinkError {
    #[error("external repository provider is not configured")]
    NotConfigured,
    #[error("external repository provider returned an invalid repository")]
    InvalidProviderResponse,
    #[error("external repository is already linked")]
    Conflict,
    #[error("external repository link could not be persisted for project {project_id}")]
    Persistence {
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

#[derive(Debug, Error)]
pub(super) enum RepositoryLinkAvailabilityError {
    #[error("external repository is already linked to project {project_id}")]
    AlreadyLinked { project_id: Uuid },
    #[error("external repository link availability could not be checked for project {project_id}")]
    Persistence {
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

pub(crate) async fn persist_external_git_repository_link(
    db: &PgPool,
    gateway: &ExternalGitGateway<'_>,
    checkpoint_branch_prefix: &CheckpointBranchPrefix,
    project_id: Uuid,
    actor_user_id: Uuid,
    details: &RemoteRepositoryDetails,
) -> Result<(), PersistRepositoryLinkError> {
    let provider_id = gateway
        .provider_id()
        .ok_or(PersistRepositoryLinkError::NotConfigured)?;
    if !gateway.validate_repository(details) {
        return Err(PersistRepositoryLinkError::InvalidProviderResponse);
    }
    let repository = &details.repository;
    let default_branch = repository
        .default_branch
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("main");
    let checkpoint_branch = checkpoint_branch_prefix.branch_for(project_id);
    let result = persistence::upsert_repository_link(
        db,
        persistence::UpsertRepositoryLinkRecord {
            project_id,
            provider_instance_id: provider_id,
            repository_id: &repository.id,
            full_path: &repository.full_path,
            web_url: &repository.web_url,
            clone_url: &details.clone_url,
            default_branch,
            checkpoint_branch: &checkpoint_branch,
            actor_user_id,
            now: chrono::Utc::now(),
        },
    )
    .await;
    match result {
        Ok(true) => Ok(()),
        Ok(false) => Err(PersistRepositoryLinkError::Conflict),
        Err(error)
            if crate::database_error::is_unique_constraint_violation(
                &error,
                "external_git_project_links_provider_repository_key",
            ) =>
        {
            Err(PersistRepositoryLinkError::Conflict)
        }
        Err(source) => Err(PersistRepositoryLinkError::Persistence { project_id, source }),
    }
}

pub(super) async fn resume_reauthorized_links(
    connection: &mut PgConnection,
    user_id: Uuid,
    provider: &ProviderInstanceId,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    persistence::resume_reauthorized_links(connection, user_id, provider, now).await
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ExternalRepositoryProjectStatus {
    project_id: Uuid,
    linked: bool,
    #[schema(required)]
    provider: Option<ProviderInstanceId>,
    #[schema(required)]
    repository_id: Option<String>,
    #[schema(required)]
    full_path: Option<String>,
    #[schema(required)]
    web_url: Option<String>,
    #[schema(required)]
    default_branch: Option<String>,
    #[schema(required)]
    checkpoint_branch: Option<String>,
    #[schema(required)]
    connector_username: Option<String>,
    workspace_version: i64,
    synced_workspace_version: i64,
    state: ExternalGitProjectState,
    #[schema(required)]
    sync_phase: Option<ExternalGitCheckpointPhase>,
    #[schema(required)]
    next_retry_at: Option<DateTime<Utc>>,
    #[schema(required)]
    last_remote_sha: Option<String>,
    #[schema(required)]
    last_import_branch: Option<String>,
    #[schema(required)]
    last_import_sha: Option<String>,
    #[schema(required)]
    last_import_at: Option<DateTime<Utc>>,
    #[schema(required)]
    last_import_error: Option<ExternalGitFailureCode>,
    #[schema(required)]
    inbound_job: Option<ExternalRepositoryInboundJob>,
    #[schema(required)]
    last_error: Option<ExternalGitFailureCode>,
    #[schema(required)]
    updated_at: Option<DateTime<Utc>>,
}

pub(super) struct UnlinkedRepository {
    pub(super) provider: ProviderInstanceId,
    pub(super) repository_id: String,
    pub(super) full_path: String,
}

pub(super) struct LinkedRepository {
    pub(super) provider: ProviderInstanceId,
    pub(super) repository_id: String,
    pub(super) linked_by_user_id: Uuid,
}

pub(super) struct NewRepositoryLink<'a> {
    pub(super) project_id: Uuid,
    pub(super) provider: ProviderInstanceId,
    pub(super) repository_id: &'a str,
    pub(super) full_path: &'a str,
    pub(super) web_url: &'a str,
    pub(super) clone_url: &'a str,
    pub(super) default_branch: &'a str,
    pub(super) checkpoint_branch: &'a str,
    pub(super) actor_user_id: Uuid,
    pub(super) now: DateTime<Utc>,
}

pub(super) async fn linked_repository(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Option<LinkedRepository>, sqlx::Error> {
    persistence::repository_link(db, project_id)
        .await
        .map(|record| {
            record.map(|record| LinkedRepository {
                provider: record.provider_instance_id,
                repository_id: record.repository_id,
                linked_by_user_id: record.linked_by_user_id,
            })
        })
}

pub(super) async fn insert_repository_link(
    connection: &mut PgConnection,
    link: NewRepositoryLink<'_>,
) -> Result<(), sqlx::Error> {
    persistence::insert_repository_link(
        connection,
        persistence::InsertRepositoryLinkRecord {
            project_id: link.project_id,
            provider_instance_id: link.provider,
            repository_id: link.repository_id,
            full_path: link.full_path,
            web_url: link.web_url,
            clone_url: link.clone_url,
            default_branch: link.default_branch,
            checkpoint_branch: link.checkpoint_branch,
            actor_user_id: link.actor_user_id,
            now: link.now,
        },
    )
    .await
}

pub(crate) async fn ensure_external_git_link_available(
    db: &PgPool,
    project_id: Uuid,
) -> Result<(), RepositoryLinkAvailabilityError> {
    let exists = persistence::repository_link_exists(db, project_id)
        .await
        .map_err(|source| RepositoryLinkAvailabilityError::Persistence { project_id, source })?;
    if exists {
        Err(RepositoryLinkAvailabilityError::AlreadyLinked { project_id })
    } else {
        Ok(())
    }
}

#[derive(Clone, Copy, Debug)]
pub(super) enum UnlinkRepositoryPersistenceStage {
    Begin,
    LockProject,
    CheckCheckpoint,
    CheckInbound,
    DeleteLink,
    Commit,
}

#[derive(Debug, Error)]
pub(super) enum UnlinkRepositoryError {
    #[error("project {project_id} was not found")]
    ProjectNotFound { project_id: Uuid },
    #[error("project {project_id} has an active external repository operation")]
    ActiveOperation { project_id: Uuid },
    #[error("external repository unlink failed during {stage:?} for project {project_id}")]
    Persistence {
        stage: UnlinkRepositoryPersistenceStage,
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

pub(crate) async fn unlink_repository_link(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Option<UnlinkedRepository>, UnlinkRepositoryError> {
    let mut transaction =
        db.begin()
            .await
            .map_err(|source| UnlinkRepositoryError::Persistence {
                stage: UnlinkRepositoryPersistenceStage::Begin,
                project_id,
                source,
            })?;
    let project_exists = crate::workspace::lock_workspace_version(&mut transaction, project_id)
        .await
        .map_err(|source| UnlinkRepositoryError::Persistence {
            stage: UnlinkRepositoryPersistenceStage::LockProject,
            project_id,
            source,
        })?;
    if project_exists.is_none() {
        return Err(UnlinkRepositoryError::ProjectNotFound { project_id });
    }
    let checkpoint_active =
        super::checkpoint::checkpoint_operation_exists(&mut transaction, project_id)
            .await
            .map_err(|source| UnlinkRepositoryError::Persistence {
                stage: UnlinkRepositoryPersistenceStage::CheckCheckpoint,
                project_id,
                source,
            })?;
    let inbound_active = active_job_exists(&mut transaction, project_id)
        .await
        .map_err(|source| UnlinkRepositoryError::Persistence {
            stage: UnlinkRepositoryPersistenceStage::CheckInbound,
            project_id,
            source,
        })?;
    if checkpoint_active || inbound_active {
        return Err(UnlinkRepositoryError::ActiveOperation { project_id });
    }
    let deleted = persistence::delete_repository_link(&mut transaction, project_id)
        .await
        .map_err(|source| UnlinkRepositoryError::Persistence {
            stage: UnlinkRepositoryPersistenceStage::DeleteLink,
            project_id,
            source,
        })?;
    transaction
        .commit()
        .await
        .map_err(|source| UnlinkRepositoryError::Persistence {
            stage: UnlinkRepositoryPersistenceStage::Commit,
            project_id,
            source,
        })?;
    Ok(deleted.map(|record| UnlinkedRepository {
        provider: record.provider_instance_id,
        repository_id: record.repository_id,
        full_path: record.full_path,
    }))
}

#[derive(Clone, Copy, Debug)]
pub(super) enum ProjectStatusPersistenceStage {
    Workspace,
    Link,
    InboundJob,
}

#[derive(Debug, Error)]
pub(super) enum ExternalRepositoryProjectStatusError {
    #[error("project {project_id} was not found")]
    ProjectNotFound { project_id: Uuid },
    #[error("external repository status failed during {stage:?} for project {project_id}")]
    Persistence {
        stage: ProjectStatusPersistenceStage,
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

pub(crate) async fn external_git_project_status(
    db: &PgPool,
    project_id: Uuid,
) -> Result<ExternalRepositoryProjectStatus, ExternalRepositoryProjectStatusError> {
    let workspace = async {
        project_workspace_version(db, project_id)
            .await
            .map_err(|source| ExternalRepositoryProjectStatusError::Persistence {
                stage: ProjectStatusPersistenceStage::Workspace,
                project_id,
                source,
            })
    };
    let project_status = async {
        persistence::project_status(db, project_id)
            .await
            .map_err(|source| ExternalRepositoryProjectStatusError::Persistence {
                stage: ProjectStatusPersistenceStage::Link,
                project_id,
                source,
            })
    };
    let inbound_job = async {
        latest_inbound_job(db, project_id).await.map_err(|source| {
            ExternalRepositoryProjectStatusError::Persistence {
                stage: ProjectStatusPersistenceStage::InboundJob,
                project_id,
                source,
            }
        })
    };
    let (workspace_version, status, inbound_job) =
        tokio::try_join!(workspace, project_status, inbound_job)?;
    let workspace_version = workspace_version
        .ok_or(ExternalRepositoryProjectStatusError::ProjectNotFound { project_id })?;
    let status = status.unwrap_or_default();
    let linked = status.repository_id.is_some();
    let state = derive_project_state(&status, linked, workspace_version);
    let next_retry_at = if status.queue_state == Some(ExternalGitCheckpointState::RetryWait) {
        status.next_attempt_at
    } else {
        None
    };
    Ok(ExternalRepositoryProjectStatus {
        project_id,
        linked,
        provider: status.provider_instance_id,
        repository_id: status.repository_id,
        full_path: status.full_path,
        web_url: status.web_url,
        default_branch: status.default_branch,
        checkpoint_branch: status.checkpoint_branch,
        connector_username: status.connector_username,
        workspace_version,
        synced_workspace_version: status.synced_workspace_version,
        state,
        sync_phase: status.sync_phase,
        next_retry_at,
        last_remote_sha: status.last_remote_sha,
        last_import_branch: status.last_import_branch,
        last_import_sha: status.last_import_sha,
        last_import_at: status.last_import_at,
        last_import_error: status.last_import_error,
        inbound_job,
        last_error: status.last_error,
        updated_at: status.updated_at,
    })
}

fn derive_project_state(
    status: &persistence::ProjectStatusRecord,
    linked: bool,
    workspace_version: i64,
) -> ExternalGitProjectState {
    if !linked {
        ExternalGitProjectState::Unlinked
    } else if status.grant_status != Some(ExternalGitGrantStatus::Active) {
        ExternalGitProjectState::ReauthRequired
    } else if status.queue_state == Some(ExternalGitCheckpointState::Processing) {
        ExternalGitProjectState::Syncing
    } else if status.queue_state == Some(ExternalGitCheckpointState::RetryWait) {
        ExternalGitProjectState::RetryWait
    } else if status.queue_state == Some(ExternalGitCheckpointState::Pending) {
        ExternalGitProjectState::Pending
    } else if matches!(
        status.link_status,
        Some(ExternalGitLinkStatus::Conflict | ExternalGitLinkStatus::ReauthRequired)
    ) {
        status
            .link_status
            .map(ExternalGitProjectState::from)
            .unwrap_or(ExternalGitProjectState::Error)
    } else if status.last_remote_sha.is_none()
        || workspace_version > status.synced_workspace_version
    {
        ExternalGitProjectState::Dirty
    } else {
        status
            .link_status
            .map(ExternalGitProjectState::from)
            .unwrap_or(ExternalGitProjectState::Error)
    }
}

#[cfg(test)]
mod tests {
    use super::persistence::ProjectStatusRecord;
    use super::*;

    fn status() -> Result<
        ProjectStatusRecord,
        crate::external_repositories::provider::InvalidProviderInstanceId,
    > {
        Ok(ProjectStatusRecord {
            provider_instance_id: Some("gitlab".parse::<ProviderInstanceId>()?),
            repository_id: Some("42".to_string()),
            full_path: Some("nv/slides".to_string()),
            web_url: None,
            default_branch: Some("main".to_string()),
            checkpoint_branch: Some("checkpoint".to_string()),
            synced_workspace_version: 1,
            link_status: Some(ExternalGitLinkStatus::Active),
            last_remote_sha: Some("abc".to_string()),
            last_import_branch: None,
            last_import_sha: None,
            last_import_at: None,
            last_import_error: None,
            last_error: None,
            updated_at: None,
            grant_status: Some(ExternalGitGrantStatus::Active),
            connector_username: None,
            queue_state: None,
            sync_phase: None,
            next_attempt_at: None,
        })
    }

    #[test]
    fn dirty_workspace_takes_precedence_over_active_link(
    ) -> Result<(), crate::external_repositories::provider::InvalidProviderInstanceId> {
        let status = status()?;
        assert_eq!(
            derive_project_state(&status, true, 2),
            ExternalGitProjectState::Dirty
        );
        Ok(())
    }

    #[test]
    fn queue_state_takes_precedence_over_dirty_workspace(
    ) -> Result<(), crate::external_repositories::provider::InvalidProviderInstanceId> {
        let mut status = status()?;
        status.queue_state = Some(ExternalGitCheckpointState::Processing);
        assert_eq!(
            derive_project_state(&status, true, 2),
            ExternalGitProjectState::Syncing
        );
        Ok(())
    }
}
