//! Cross-context bookkeeping triggered by an incremental Workspace change.

use crate::external_repositories;
use crate::versioning::{WorkspaceChangeKind, WorkspaceContributor};
use chrono::Utc;
use sqlx::{PgConnection, Postgres, Transaction};
use uuid::Uuid;

pub(crate) async fn mark_project_dirty(
    transaction: &mut Transaction<'_, Postgres>,
    project_id: Uuid,
    actor_user_id: Option<Uuid>,
    guest_display_name: Option<&str>,
) -> Result<(), sqlx::Error> {
    let now = Utc::now();
    super::advance_workspace_version(transaction, project_id).await?;
    let contributor = match (actor_user_id, guest_display_name) {
        (Some(user_id), _) => WorkspaceContributor::User(user_id),
        (None, Some(display_name)) => WorkspaceContributor::Guest(display_name),
        (None, None) => WorkspaceContributor::System,
    };
    crate::versioning::record_workspace_change(
        transaction,
        project_id,
        contributor,
        WorkspaceChangeKind::Incremental,
        now,
    )
    .await?;
    external_repositories::record_project_activity(
        transaction,
        project_id,
        actor_user_id,
        guest_display_name,
        now,
    )
    .await
}

pub(super) async fn record_collaborative_document_activity(
    connection: &mut PgConnection,
    project_id: Uuid,
    contributors: &[super::CollaborationContributor],
) -> Result<(), sqlx::Error> {
    let now = Utc::now();
    super::advance_workspace_version(&mut *connection, project_id).await?;
    if contributors.is_empty() {
        crate::versioning::record_workspace_change(
            &mut *connection,
            project_id,
            WorkspaceContributor::System,
            WorkspaceChangeKind::Incremental,
            now,
        )
        .await?;
        return external_repositories::record_project_activity(
            connection, project_id, None, None, now,
        )
        .await;
    }
    for contributor in contributors {
        let (versioning_contributor, actor_user_id, guest_display_name) = match contributor {
            super::CollaborationContributor::User(user_id) => {
                (WorkspaceContributor::User(*user_id), Some(*user_id), None)
            }
            super::CollaborationContributor::Guest(display_name) => (
                WorkspaceContributor::Guest(display_name),
                None,
                Some(display_name.as_str()),
            ),
        };
        crate::versioning::record_workspace_change(
            &mut *connection,
            project_id,
            versioning_contributor,
            WorkspaceChangeKind::Incremental,
            now,
        )
        .await?;
        external_repositories::record_project_activity(
            &mut *connection,
            project_id,
            actor_user_id,
            guest_display_name,
            now,
        )
        .await?;
    }
    Ok(())
}
