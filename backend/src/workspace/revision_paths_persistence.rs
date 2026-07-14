//! Live Workspace path projection for revision transfer.

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

pub(super) async fn document_paths_updated_since(
    db: &PgPool,
    project_id: Uuid,
    updated_after: DateTime<Utc>,
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select path
         from documents
         where project_id = $1 and updated_at > $2",
    )
    .bind(project_id)
    .bind(updated_after)
    .fetch_all(db)
    .await
}

pub(super) async fn asset_paths_created_since(
    db: &PgPool,
    project_id: Uuid,
    created_after: DateTime<Utc>,
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select path
         from project_assets
         where project_id = $1 and created_at > $2",
    )
    .bind(project_id)
    .bind(created_after)
    .fetch_all(db)
    .await
}

pub(super) async fn document_paths(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar("select path from documents where project_id = $1")
        .bind(project_id)
        .fetch_all(db)
        .await
}

pub(super) async fn asset_paths(db: &PgPool, project_id: Uuid) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar("select path from project_assets where project_id = $1")
        .bind(project_id)
        .fetch_all(db)
        .await
}
