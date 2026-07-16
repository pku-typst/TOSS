//! Project-thumbnail metadata persistence owned by Workspace.

use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};
use uuid::Uuid;

pub(super) struct ThumbnailMetadata {
    pub content_type: String,
}

pub(super) async fn upsert_metadata(
    db: &PgPool,
    project_id: Uuid,
    content_type: &str,
    actor_user_id: Uuid,
    updated_at: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into project_thumbnails
           (project_id, content_type, updated_by, updated_at)
         values ($1, $2, $3, $4)
         on conflict (project_id) do update
         set content_type = excluded.content_type,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at",
    )
    .bind(project_id)
    .bind(content_type)
    .bind(actor_user_id)
    .bind(updated_at)
    .execute(db)
    .await?;
    Ok(())
}

pub(super) async fn load_metadata(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Option<ThumbnailMetadata>, sqlx::Error> {
    let row = sqlx::query(
        "select content_type
         from project_thumbnails
         where project_id = $1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|value| ThumbnailMetadata {
        content_type: value.get("content_type"),
    }))
}

pub(super) async fn delete_metadata(db: &PgPool, project_id: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query("delete from project_thumbnails where project_id = $1")
        .bind(project_id)
        .execute(db)
        .await?;
    Ok(())
}

pub(crate) async fn project_ids_with_thumbnails(
    db: &PgPool,
    project_ids: &[Uuid],
) -> Result<Vec<Uuid>, sqlx::Error> {
    sqlx::query_scalar(
        "select project_id
         from project_thumbnails
         where project_id = any($1)",
    )
    .bind(project_ids)
    .fetch_all(db)
    .await
}
