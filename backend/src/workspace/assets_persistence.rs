//! Project-asset persistence owned by the Workspace context.

use chrono::{DateTime, Utc};
use sqlx::postgres::PgRow;
use sqlx::{FromRow, PgConnection, PgPool, Row};
use uuid::Uuid;

pub(crate) struct ProjectAssetRecord {
    pub id: Uuid,
    pub project_id: Uuid,
    pub path: String,
    pub content_revision: Uuid,
    pub object_key: String,
    pub content_type: String,
    pub size_bytes: i64,
    pub uploaded_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

impl<'row> FromRow<'row, PgRow> for ProjectAssetRecord {
    fn from_row(row: &'row PgRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            id: row.try_get("id")?,
            project_id: row.try_get("project_id")?,
            path: row.try_get("path")?,
            content_revision: row.try_get("content_revision")?,
            object_key: row.try_get("object_key")?,
            content_type: row.try_get("content_type")?,
            size_bytes: row.try_get("size_bytes")?,
            uploaded_by: row.try_get("uploaded_by")?,
            created_at: row.try_get("created_at")?,
        })
    }
}

pub(crate) struct StoredProjectAssetRecord {
    pub asset: ProjectAssetRecord,
    pub inline_data: Option<Vec<u8>>,
}

impl<'row> FromRow<'row, PgRow> for StoredProjectAssetRecord {
    fn from_row(row: &'row PgRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            asset: ProjectAssetRecord::from_row(row)?,
            inline_data: row.try_get("inline_data")?,
        })
    }
}

pub(crate) async fn list_by_project(
    db: &PgPool,
    project_id: Uuid,
    limit: i64,
) -> Result<Vec<ProjectAssetRecord>, sqlx::Error> {
    sqlx::query_as::<_, ProjectAssetRecord>(
        "select id, project_id, path, content_revision, object_key, content_type, size_bytes,
                uploaded_by, created_at
         from project_assets
         where project_id = $1
         order by created_at desc
         limit $2",
    )
    .bind(project_id)
    .bind(limit)
    .fetch_all(db)
    .await
}

pub(crate) async fn find_stored_by_id(
    db: &PgPool,
    project_id: Uuid,
    asset_id: Uuid,
) -> Result<Option<StoredProjectAssetRecord>, sqlx::Error> {
    sqlx::query_as::<_, StoredProjectAssetRecord>(
        "select id, project_id, path, content_revision, object_key, content_type, size_bytes,
                uploaded_by, created_at, inline_data
         from project_assets
         where project_id = $1 and id = $2",
    )
    .bind(project_id)
    .bind(asset_id)
    .fetch_optional(db)
    .await
}

pub(crate) struct AssetWrite<'value> {
    pub id: Uuid,
    pub project_id: Uuid,
    pub path: &'value str,
    pub content_revision: Uuid,
    pub object_key: &'value str,
    pub content_type: &'value str,
    pub size_bytes: i64,
    pub uploaded_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub inline_data: Option<&'value [u8]>,
}

pub(crate) async fn lock_object_key_by_path(
    connection: &mut PgConnection,
    project_id: Uuid,
    path: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar::<_, String>(
        "select object_key
         from project_assets
         where project_id = $1 and path = $2
         for update",
    )
    .bind(project_id)
    .bind(path)
    .fetch_optional(connection)
    .await
}

pub(crate) async fn lock_object_key_by_id(
    connection: &mut PgConnection,
    project_id: Uuid,
    asset_id: Uuid,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar::<_, String>(
        "select object_key
         from project_assets
         where project_id = $1 and id = $2
         for update",
    )
    .bind(project_id)
    .bind(asset_id)
    .fetch_optional(connection)
    .await
}

pub(crate) async fn upsert(
    connection: &mut PgConnection,
    asset: &AssetWrite<'_>,
) -> Result<ProjectAssetRecord, sqlx::Error> {
    sqlx::query_as::<_, ProjectAssetRecord>(
        "insert into project_assets (
             id, project_id, path, content_revision, object_key, content_type,
             size_bytes, uploaded_by, created_at, inline_data
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (project_id, path) do update
         set content_revision = excluded.content_revision,
             object_key = excluded.object_key,
             content_type = excluded.content_type,
             size_bytes = excluded.size_bytes,
             uploaded_by = excluded.uploaded_by,
             created_at = excluded.created_at,
             inline_data = excluded.inline_data
         returning id, project_id, path, content_revision, object_key, content_type, size_bytes,
                   uploaded_by, created_at",
    )
    .bind(asset.id)
    .bind(asset.project_id)
    .bind(asset.path)
    .bind(asset.content_revision)
    .bind(asset.object_key)
    .bind(asset.content_type)
    .bind(asset.size_bytes)
    .bind(asset.uploaded_by)
    .bind(asset.created_at)
    .bind(asset.inline_data)
    .fetch_one(connection)
    .await
}

pub(crate) async fn delete_by_id(
    connection: &mut PgConnection,
    project_id: Uuid,
    asset_id: Uuid,
) -> Result<u64, sqlx::Error> {
    Ok(
        sqlx::query("delete from project_assets where project_id = $1 and id = $2")
            .bind(project_id)
            .bind(asset_id)
            .execute(connection)
            .await?
            .rows_affected(),
    )
}

pub(crate) async fn lock_object_keys_at_path(
    connection: &mut PgConnection,
    project_id: Uuid,
    path: &str,
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar::<_, String>(
        "select object_key
         from project_assets
         where project_id = $1 and path = $2
         for update",
    )
    .bind(project_id)
    .bind(path)
    .fetch_all(connection)
    .await
}

pub(crate) async fn delete_at_path(
    connection: &mut PgConnection,
    project_id: Uuid,
    path: &str,
) -> Result<u64, sqlx::Error> {
    Ok(
        sqlx::query("delete from project_assets where project_id = $1 and path = $2")
            .bind(project_id)
            .bind(path)
            .execute(connection)
            .await?
            .rows_affected(),
    )
}

pub(crate) async fn lock_object_keys_in_subtree(
    connection: &mut PgConnection,
    project_id: Uuid,
    path: &str,
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar::<_, String>(
        "select object_key
         from project_assets
         where project_id = $1
           and (path = $2 or left(path, char_length($2) + 1) = $2 || '/')
         for update",
    )
    .bind(project_id)
    .bind(path)
    .fetch_all(connection)
    .await
}

pub(crate) async fn delete_subtree(
    connection: &mut PgConnection,
    project_id: Uuid,
    path: &str,
) -> Result<u64, sqlx::Error> {
    Ok(sqlx::query(
        "delete from project_assets
         where project_id = $1
           and (path = $2 or left(path, char_length($2) + 1) = $2 || '/')",
    )
    .bind(project_id)
    .bind(path)
    .execute(connection)
    .await?
    .rows_affected())
}

pub(crate) async fn move_subtree(
    connection: &mut PgConnection,
    project_id: Uuid,
    from_path: &str,
    to_path: &str,
) -> Result<u64, sqlx::Error> {
    Ok(sqlx::query(
        "update project_assets
         set path = case
             when path = $2 then $3
             else $3 || substring(path from char_length($2) + 1)
         end
         where project_id = $1
           and (path = $2 or left(path, char_length($2) + 1) = $2 || '/')",
    )
    .bind(project_id)
    .bind(from_path)
    .bind(to_path)
    .execute(connection)
    .await?
    .rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    async fn migrated_test_pool() -> Result<Option<PgPool>, Box<dyn std::error::Error + Send + Sync>>
    {
        let database_url =
            std::env::var("TEST_DATABASE_URL").or_else(|_| std::env::var("DATABASE_URL"));
        let Ok(database_url) = database_url else {
            return Ok(None);
        };
        let pool = PgPool::connect(&database_url).await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Some(pool))
    }

    #[tokio::test]
    async fn replacement_advances_content_revision_without_changing_asset_identity(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let user_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        let initial_asset_id = Uuid::new_v4();
        let initial_revision = Uuid::new_v4();
        let replacement_revision = Uuid::new_v4();
        let now = Utc::now();
        let mut transaction = pool.begin().await?;
        let username_suffix = user_id
            .simple()
            .to_string()
            .chars()
            .take(8)
            .collect::<String>();
        sqlx::query(
            "insert into users (id, email, username, display_name, created_at)
             values ($1, $2, $3, 'Owner', $4)",
        )
        .bind(user_id)
        .bind(format!("{user_id}@example.test"))
        .bind(format!("user-{username_suffix}"))
        .bind(now)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "insert into projects (id, owner_user_id, name, created_at, project_type)
             values ($1, $2, 'Asset revision test', $3, 'typst')",
        )
        .bind(project_id)
        .bind(user_id)
        .bind(now)
        .execute(&mut *transaction)
        .await?;

        let initial = upsert(
            &mut transaction,
            &AssetWrite {
                id: initial_asset_id,
                project_id,
                path: "image.png",
                content_revision: initial_revision,
                object_key: "inline://initial",
                content_type: "image/png",
                size_bytes: 7,
                uploaded_by: Some(user_id),
                created_at: now,
                inline_data: Some(b"initial"),
            },
        )
        .await?;
        assert_eq!(initial.id, initial_asset_id);
        assert_eq!(initial.content_revision, initial_revision);

        let replacement = upsert(
            &mut transaction,
            &AssetWrite {
                id: Uuid::new_v4(),
                project_id,
                path: "image.png",
                content_revision: replacement_revision,
                object_key: "inline://replacement",
                content_type: "image/png",
                size_bytes: 11,
                uploaded_by: Some(user_id),
                created_at: now,
                inline_data: Some(b"replacement"),
            },
        )
        .await?;
        assert_eq!(replacement.id, initial_asset_id);
        assert_eq!(replacement.content_revision, replacement_revision);

        transaction.rollback().await?;
        Ok(())
    }
}
