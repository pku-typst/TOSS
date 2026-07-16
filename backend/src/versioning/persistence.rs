use super::local_repository::project_repository_path;
use super::{WorkspaceChangeKind, WorkspaceContributor};
use chrono::{DateTime, Utc};
use sqlx::PgConnection;
use uuid::Uuid;

pub(super) async fn initialize_project(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into git_sync_states (project_id, branch, has_conflicts, status)
         values ($1, 'main', false, 'clean')",
    )
    .bind(project_id)
    .execute(connection)
    .await?;
    Ok(())
}

pub(super) async fn record_workspace_change(
    connection: &mut PgConnection,
    project_id: Uuid,
    contributor: WorkspaceContributor<'_>,
    change_kind: WorkspaceChangeKind,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into git_repositories (
             project_id, remote_url, local_path, default_branch, pending_sync, updated_at
         ) values ($1, null, $2, 'main', true, $3)
         on conflict (project_id) do update
         set pending_sync = true, updated_at = excluded.updated_at",
    )
    .bind(project_id)
    .bind(
        project_repository_path(project_id)
            .to_string_lossy()
            .to_string(),
    )
    .bind(now)
    .execute(&mut *connection)
    .await?;
    match change_kind {
        WorkspaceChangeKind::Incremental => {
            sqlx::query(
                "insert into project_sync_queue (
                     project_id, dirty_since, last_enqueued_at,
                     last_attempt_at, attempt_count, last_error
                 ) values ($1, $2, $2, null, 0, null)
                 on conflict (project_id) do update
                 set last_enqueued_at = excluded.last_enqueued_at",
            )
            .bind(project_id)
            .bind(now)
            .execute(&mut *connection)
            .await?;
        }
        WorkspaceChangeKind::Replacement => {
            sqlx::query(
                "insert into project_sync_queue (
                     project_id, dirty_since, last_enqueued_at,
                     last_attempt_at, attempt_count, last_error
                 ) values ($1, $2, $2, null, 0, null)
                 on conflict (project_id) do update
                 set dirty_since = excluded.dirty_since,
                     last_enqueued_at = excluded.last_enqueued_at,
                     last_error = null",
            )
            .bind(project_id)
            .bind(now)
            .execute(&mut *connection)
            .await?;
        }
    }
    match contributor {
        WorkspaceContributor::User(user_id) => {
            sqlx::query(
                "insert into git_pending_authors (project_id, user_id, touched_at)
                 values ($1, $2, $3)
                 on conflict (project_id, user_id) do update
                 set touched_at = excluded.touched_at",
            )
            .bind(project_id)
            .bind(user_id)
            .bind(now)
            .execute(connection)
            .await?;
        }
        WorkspaceContributor::Guest(display_name) => {
            if let Some(display_name) = normalized_guest_name(display_name) {
                sqlx::query(
                    "insert into git_pending_guest_authors (
                         project_id, display_name, touched_at
                     ) values ($1, $2, $3)
                     on conflict (project_id, display_name) do update
                     set touched_at = excluded.touched_at",
                )
                .bind(project_id)
                .bind(display_name)
                .bind(now)
                .execute(connection)
                .await?;
            }
        }
        WorkspaceContributor::System => {}
    }
    Ok(())
}

fn normalized_guest_name(display_name: &str) -> Option<&str> {
    let display_name = display_name.trim();
    (!display_name.is_empty()).then_some(display_name)
}
