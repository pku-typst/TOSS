//! Local Git history and direct smart-HTTP integration.

mod authors;
mod commit;
mod flush;
mod git_persistence;
mod http;
mod local_repository;
mod materialization;
mod persistence;
mod project_lock;
mod revision_documents;
mod revision_history;
mod revision_history_http;
mod revision_state;
mod revision_transfer;
mod revision_transfer_http;
mod state;
mod worktree_files;

use chrono::{DateTime, Utc};
use sqlx::PgConnection;
use uuid::Uuid;

pub(crate) use authors::GitIdentity;
pub(crate) use commit::{create_checkpoint_commit, CreateCheckpointCommitError};
pub(crate) use flush::{
    flush_pending_server_commit, spawn_git_flush_worker, FlushPendingServerCommitError,
};
pub(crate) use git_persistence::{
    clear_pending_authors, clear_queue_item, ensure_repository, find_sync_state, list_due_projects,
    load_repository, mark_repository_pending, mark_repository_synced, mark_sync_attempt,
    record_sync_failure, set_repository_sync_state, update_sync_state,
};
pub(crate) use http::{git_http_backend, git_repo_link, git_status, GitRepoLink};
pub(crate) use local_repository::storage_root;
pub(crate) use materialization::{
    sync_project_documents_to_repo, sync_repo_documents_to_project, MaterializeWorkspaceError,
    RepositoryImportError,
};
pub(crate) use project_lock::VersioningContext;
pub(crate) use revision_history::Revision;
pub(crate) use revision_history_http::{
    create_revision, list_revisions, CreateRevisionInput, RevisionsResponse,
};
pub(crate) use revision_transfer::RevisionTransfer;
#[cfg(test)]
pub(crate) use revision_transfer::{RevisionBaseAnchor, RevisionTransferMode};
pub(crate) use revision_transfer_http::get_revision_documents;
pub(crate) use state::{
    complete_materialized_workspace_sync, git_username_hint, record_receive_pack_import_failure,
    record_receive_pack_sync, GitSyncState, GitSyncStatus,
};

#[derive(sqlx::FromRow)]
pub(crate) struct GitRepositoryConfig {
    pub local_path: String,
    pub default_branch: String,
    pub pending_sync: bool,
}

pub(crate) struct LiveRevisionSyncState {
    pub pending_sync: bool,
    pub last_server_sync_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum MaterializedWorkspaceCompletion {
    Completed,
    WorkspaceChanged,
    ProjectNotFound,
}

#[derive(Clone, Copy)]
pub(crate) enum WorkspaceChangeKind {
    Incremental,
    Replacement,
}

#[derive(Clone, Copy)]
pub(crate) enum WorkspaceContributor<'contributor> {
    User(Uuid),
    Guest(&'contributor str),
    System,
}

pub(crate) async fn record_workspace_change(
    connection: &mut PgConnection,
    project_id: Uuid,
    contributor: WorkspaceContributor<'_>,
    change_kind: WorkspaceChangeKind,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    persistence::record_workspace_change(connection, project_id, contributor, change_kind, now)
        .await
}

pub(crate) async fn initialize_project(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<(), sqlx::Error> {
    persistence::initialize_project(connection, project_id).await
}
