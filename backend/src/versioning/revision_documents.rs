use super::local_repository::{checkout_branch, ensure_initialized, InitializeRepositoryError};
use super::revision_transfer::{
    add_live_anchor_candidate, materialize_best_revision_transfer, prepare_revision_transfer,
    RevisionTransfer, RevisionTransferError,
};
use super::VersioningContext;
use crate::workspace::{
    load_project_entry_point, LoadProjectEntryPointError, RevisionPathSnapshotError,
};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

pub(crate) struct RevisionTransferRequest {
    pub current_revision_id: Option<String>,
    pub include_live_anchor: bool,
}

#[derive(Debug, Error)]
pub(crate) enum RevisionDocumentsError {
    #[error("project {project_id} has no revision repository")]
    ProjectNotFound { project_id: Uuid },
    #[error("revision repository lookup failed for project {project_id}")]
    RepositoryPersistence {
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("revision repository initialization failed for project {project_id}")]
    RepositoryInitialization {
        project_id: Uuid,
        #[source]
        source: InitializeRepositoryError,
    },
    #[error("revision repository checkout failed for project {project_id}")]
    Git {
        project_id: Uuid,
        #[source]
        source: git2::Error,
    },
    #[error("revision entry-file lookup failed for project {project_id}")]
    WorkspaceSettings {
        project_id: Uuid,
        #[source]
        source: LoadProjectEntryPointError,
    },
    #[error("revision content transfer failed for project {project_id}")]
    Transfer {
        project_id: Uuid,
        #[source]
        source: RevisionTransferError,
    },
    #[error("live revision sync-state lookup failed for project {project_id}")]
    LiveSyncPersistence {
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("live revision path lookup failed for project {project_id}")]
    LivePaths {
        project_id: Uuid,
        #[source]
        source: RevisionPathSnapshotError,
    },
}

pub(crate) async fn revision_documents(
    db: &PgPool,
    versioning: &VersioningContext,
    project_id: Uuid,
    revision_id: String,
    request: RevisionTransferRequest,
) -> Result<RevisionTransfer, RevisionDocumentsError> {
    let _git_lock = versioning.acquire_project_lock(project_id).await;
    let config = crate::versioning::load_repository(db, project_id)
        .await
        .map_err(|source| RevisionDocumentsError::RepositoryPersistence { project_id, source })?
        .ok_or(RevisionDocumentsError::ProjectNotFound { project_id })?;
    ensure_initialized(&config.local_path, &config.default_branch).map_err(|source| {
        RevisionDocumentsError::RepositoryInitialization { project_id, source }
    })?;
    checkout_branch(&config.local_path, &config.default_branch)
        .map_err(|source| RevisionDocumentsError::Git { project_id, source })?;
    let entry_point =
        load_project_entry_point(db, project_id)
            .await
            .map_err(|source| match source {
                LoadProjectEntryPointError::ProjectNotFound => {
                    RevisionDocumentsError::ProjectNotFound { project_id }
                }
                source @ LoadProjectEntryPointError::Persistence { .. } => {
                    RevisionDocumentsError::WorkspaceSettings { project_id, source }
                }
            })?;
    let mut prepared = prepare_revision_transfer(
        &config.local_path,
        &config.default_branch,
        &revision_id,
        request.current_revision_id.as_deref(),
    )
    .map_err(|source| RevisionDocumentsError::Transfer { project_id, source })?;

    if request.include_live_anchor && request.current_revision_id.is_none() {
        match load_live_revision_paths(db, project_id).await? {
            Some(snapshot) => add_live_anchor_candidate(
                &mut prepared,
                true,
                &snapshot.changed_document_paths,
                &snapshot.changed_asset_paths,
                &snapshot.live_document_paths,
                &snapshot.live_asset_paths,
            ),
            None => add_live_anchor_candidate(&mut prepared, false, &[], &[], &[], &[]),
        }
    }

    materialize_best_revision_transfer(
        &config.local_path,
        revision_id,
        entry_point.entry_file_path,
        prepared,
    )
    .map_err(|source| RevisionDocumentsError::Transfer { project_id, source })
}

async fn load_live_revision_paths(
    db: &sqlx::PgPool,
    project_id: Uuid,
) -> Result<Option<crate::workspace::RevisionPathSnapshot>, RevisionDocumentsError> {
    let sync_state = super::git_persistence::load_live_sync_state(db, project_id)
        .await
        .map_err(|source| RevisionDocumentsError::LiveSyncPersistence { project_id, source })?;
    let Some(sync_state) = sync_state else {
        return Ok(None);
    };
    if !sync_state.pending_sync {
        return Ok(None);
    }
    let last_sync_at = sync_state
        .last_server_sync_at
        .unwrap_or(chrono::DateTime::<chrono::Utc>::UNIX_EPOCH);
    crate::workspace::revision_path_snapshot(db, project_id, last_sync_at)
        .await
        .map(Some)
        .map_err(|source| RevisionDocumentsError::LivePaths { project_id, source })
}
