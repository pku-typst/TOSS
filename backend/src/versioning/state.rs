use crate::text_enum::text_enum;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use tracing::error;
use uuid::Uuid;

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum GitSyncStatus {
        Clean => "clean",
        ReceivePackImportFailed => "receive_pack_import_failed",
    }
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct GitSyncState {
    pub project_id: Uuid,
    pub branch: String,
    #[schema(required)]
    pub last_pull_at: Option<DateTime<Utc>>,
    #[schema(required)]
    pub last_push_at: Option<DateTime<Utc>>,
    pub has_conflicts: bool,
    pub status: GitSyncStatus,
}

pub(crate) async fn complete_materialized_workspace_sync(
    db: &PgPool,
    project_id: Uuid,
    materialized_workspace_version: i64,
) -> Result<super::MaterializedWorkspaceCompletion, sqlx::Error> {
    let mut transaction = db.begin().await?;
    let current_workspace_version =
        crate::workspace::lock_workspace_version(&mut transaction, project_id).await?;
    let completion = match current_workspace_version {
        None => super::MaterializedWorkspaceCompletion::ProjectNotFound,
        Some(current) if current != materialized_workspace_version => {
            super::MaterializedWorkspaceCompletion::WorkspaceChanged
        }
        Some(_) => {
            super::mark_repository_synced(&mut transaction, project_id, Utc::now()).await?;
            super::clear_pending_authors(&mut transaction, project_id).await?;
            super::clear_queue_item(&mut transaction, project_id).await?;
            super::MaterializedWorkspaceCompletion::Completed
        }
    };
    transaction.commit().await?;
    Ok(completion)
}

pub(crate) async fn clear_sync_queue_if_repository_clean(
    db: &PgPool,
    project_id: Uuid,
) -> Result<(), sqlx::Error> {
    let mut transaction = db.begin().await?;
    let project_exists = crate::workspace::lock_workspace_version(&mut transaction, project_id)
        .await?
        .is_some();
    let repository_pending =
        super::git_persistence::repository_pending_sync(&mut transaction, project_id).await?;
    if !project_exists || repository_pending != Some(true) {
        super::clear_queue_item(&mut transaction, project_id).await?;
    }
    transaction.commit().await
}

pub(crate) async fn git_username_hint(db: &PgPool, user_id: Uuid) -> String {
    match crate::access::user_username(db, user_id).await {
        Ok(Some(username)) => username,
        Ok(None) => format!("user-{}", user_id.simple()),
        Err(identity_error) => {
            error!(?identity_error, %user_id, "Git username hint lookup failed");
            format!("user-{}", user_id.simple())
        }
    }
}

pub(crate) async fn record_receive_pack_sync(
    db: &PgPool,
    project_id: Uuid,
    materialized_workspace_version: i64,
    pending_sync: bool,
    clear_pending_authors: bool,
) -> Result<super::MaterializedWorkspaceCompletion, sqlx::Error> {
    let now = Utc::now();
    let mut transaction = db.begin().await?;
    let current_workspace_version =
        crate::workspace::lock_workspace_version(&mut transaction, project_id).await?;
    super::update_sync_state(
        &mut transaction,
        project_id,
        GitSyncStatus::Clean,
        false,
        None,
        Some(now),
    )
    .await?;
    let completion = match current_workspace_version {
        None => super::MaterializedWorkspaceCompletion::ProjectNotFound,
        Some(current) if current != materialized_workspace_version => {
            super::MaterializedWorkspaceCompletion::WorkspaceChanged
        }
        Some(_) => {
            super::set_repository_sync_state(&mut transaction, project_id, pending_sync, now)
                .await?;
            if clear_pending_authors {
                super::clear_pending_authors(&mut transaction, project_id).await?;
            }
            if !pending_sync {
                super::clear_queue_item(&mut transaction, project_id).await?;
            }
            super::MaterializedWorkspaceCompletion::Completed
        }
    };
    transaction.commit().await?;
    Ok(completion)
}

pub(crate) async fn record_receive_pack_import_failure(
    db: &PgPool,
    project_id: Uuid,
) -> Result<(), sqlx::Error> {
    let mut transaction = db.begin().await?;
    super::update_sync_state(
        &mut transaction,
        project_id,
        GitSyncStatus::ReceivePackImportFailed,
        true,
        None,
        Some(Utc::now()),
    )
    .await?;
    transaction.commit().await
}
