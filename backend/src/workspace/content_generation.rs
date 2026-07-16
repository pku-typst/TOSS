//! Workspace-owned content-generation reads and transactional admission locks.

use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProjectContentEpochMatch {
    Current,
    Changed,
    ProjectNotFound,
}

pub(crate) async fn project_content_epoch(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Option<i64>, sqlx::Error> {
    sqlx::query_scalar("select content_epoch from projects where id = $1")
        .bind(project_id)
        .fetch_optional(db)
        .await
}

async fn lock_content_epoch_value(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<Option<i64>, sqlx::Error> {
    // Destructive replacement takes FOR UPDATE on this row. Incremental content
    // mutations take this compatible lock before touching child rows, which
    // establishes one project-before-child lock order across Workspace.
    sqlx::query_scalar::<_, i64>(
        "select content_epoch
         from projects
         where id = $1
         for key share",
    )
    .bind(project_id)
    .fetch_optional(connection)
    .await
}

pub(crate) async fn lock_project_content_mutation(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<(), sqlx::Error> {
    lock_content_epoch_value(connection, project_id)
        .await
        .map(|_| ())
}

pub(crate) async fn lock_project_content_exclusively(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query_scalar::<_, i64>(
        "select content_epoch
         from projects
         where id = $1
         for update",
    )
    .bind(project_id)
    .fetch_optional(connection)
    .await
    .map(|_| ())
}

pub(crate) async fn lock_project_content_epoch(
    connection: &mut PgConnection,
    project_id: Uuid,
    expected_epoch: i64,
) -> Result<ProjectContentEpochMatch, sqlx::Error> {
    let current_epoch = lock_content_epoch_value(connection, project_id).await?;
    Ok(match current_epoch {
        Some(current_epoch) if current_epoch == expected_epoch => ProjectContentEpochMatch::Current,
        Some(_) => ProjectContentEpochMatch::Changed,
        None => ProjectContentEpochMatch::ProjectNotFound,
    })
}
