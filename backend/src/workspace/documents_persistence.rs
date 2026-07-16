//! Document persistence owned by the Workspace context.

use chrono::{DateTime, Utc};
use sqlx::postgres::PgRow;
use sqlx::{FromRow, PgConnection, PgPool, Row};
use uuid::Uuid;

pub(crate) struct DocumentRecord {
    pub id: Uuid,
    pub project_id: Uuid,
    pub path: String,
    pub path_revision: i64,
    pub collaboration_revision: i64,
    pub change_sequence: i64,
    pub content: String,
    pub updated_at: DateTime<Utc>,
}

impl<'row> FromRow<'row, PgRow> for DocumentRecord {
    fn from_row(row: &'row PgRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            id: row.try_get("id")?,
            project_id: row.try_get("project_id")?,
            path: row.try_get("path")?,
            path_revision: row.try_get("path_revision")?,
            collaboration_revision: row.try_get("collaboration_revision")?,
            change_sequence: row.try_get("change_sequence")?,
            content: row.try_get("content")?,
            updated_at: row.try_get("updated_at")?,
        })
    }
}

pub(crate) async fn list_by_path(
    db: &PgPool,
    project_id: Uuid,
    path: &str,
) -> Result<Vec<DocumentRecord>, sqlx::Error> {
    sqlx::query_as::<_, DocumentRecord>(
        "select id, project_id, path, path_revision, collaboration_revision, change_sequence, content, updated_at
         from documents
         where project_id = $1 and path = $2
         order by updated_at desc",
    )
    .bind(project_id)
    .bind(path)
    .fetch_all(db)
    .await
}

pub(crate) async fn list_after_change_sequence(
    db: &PgPool,
    project_id: Uuid,
    after_change_sequence: Option<i64>,
    limit: i64,
) -> Result<Vec<DocumentRecord>, sqlx::Error> {
    sqlx::query_as::<_, DocumentRecord>(
        "select id, project_id, path, path_revision, collaboration_revision, change_sequence, content, updated_at
         from documents
         where project_id = $1 and change_sequence > $2
         order by change_sequence asc
         limit $3",
    )
    .bind(project_id)
    .bind(after_change_sequence.unwrap_or(0))
    .bind(limit)
    .fetch_all(db)
    .await
}

pub(crate) async fn find_by_id(
    db: &PgPool,
    project_id: Uuid,
    document_id: Uuid,
) -> Result<Option<DocumentRecord>, sqlx::Error> {
    sqlx::query_as::<_, DocumentRecord>(
        "select id, project_id, path, path_revision, collaboration_revision, change_sequence, content, updated_at
         from documents
         where project_id = $1 and id = $2",
    )
    .bind(project_id)
    .bind(document_id)
    .fetch_optional(db)
    .await
}

pub(crate) async fn find_path_by_id_in_transaction(
    connection: &mut PgConnection,
    project_id: Uuid,
    document_id: Uuid,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("select path from documents where project_id = $1 and id = $2")
        .bind(project_id)
        .bind(document_id)
        .fetch_optional(connection)
        .await
}

pub(crate) async fn collaboration_revision_matches(
    db: &PgPool,
    project_id: Uuid,
    document_id: Uuid,
    collaboration_revision: i64,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, bool>(
        "select exists(
             select 1 from documents
             where project_id = $1 and id = $2 and collaboration_revision = $3
         )",
    )
    .bind(project_id)
    .bind(document_id)
    .bind(collaboration_revision)
    .fetch_one(db)
    .await
}

pub(crate) async fn collaboration_seed_content(
    connection: &mut PgConnection,
    project_id: Uuid,
    document_id: Uuid,
    collaboration_revision: i64,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select content
         from documents
         where project_id = $1
           and id = $2
           and collaboration_revision = $3",
    )
    .bind(project_id)
    .bind(document_id)
    .bind(collaboration_revision)
    .fetch_optional(connection)
    .await
}

pub(crate) async fn insert(
    connection: &mut PgConnection,
    id: Uuid,
    project_id: Uuid,
    path: &str,
    content: &str,
    updated_at: DateTime<Utc>,
) -> Result<DocumentRecord, sqlx::Error> {
    sqlx::query_as::<_, DocumentRecord>(
        "insert into documents (id, project_id, path, content, updated_at)
         values ($1, $2, $3, $4, $5)
         returning id, project_id, path, path_revision, collaboration_revision, change_sequence, content, updated_at",
    )
    .bind(id)
    .bind(project_id)
    .bind(path)
    .bind(content)
    .bind(updated_at)
    .fetch_one(connection)
    .await
}

pub(crate) async fn upsert_by_path(
    connection: &mut PgConnection,
    id: Uuid,
    project_id: Uuid,
    path: &str,
    content: &str,
    updated_at: DateTime<Utc>,
) -> Result<DocumentRecord, sqlx::Error> {
    sqlx::query_as::<_, DocumentRecord>(
        "insert into documents (id, project_id, path, content, updated_at)
         values ($1, $2, $3, $4, $5)
         on conflict (project_id, path) do update
         set content = excluded.content,
             updated_at = excluded.updated_at,
             collaboration_revision = documents.collaboration_revision + 1,
             change_sequence = nextval('documents_change_sequence_seq')
         returning id, project_id, path, path_revision, collaboration_revision, change_sequence, content, updated_at",
    )
    .bind(id)
    .bind(project_id)
    .bind(path)
    .bind(content)
    .bind(updated_at)
    .fetch_one(connection)
    .await
}

pub(crate) async fn update_content(
    connection: &mut PgConnection,
    project_id: Uuid,
    document_id: Uuid,
    expected_path_revision: i64,
    expected_collaboration_revision: i64,
    content: &str,
    updated_at: DateTime<Utc>,
) -> Result<Option<DocumentRecord>, sqlx::Error> {
    sqlx::query_as::<_, DocumentRecord>(
        "update documents
         set content = $5,
             updated_at = $6,
             collaboration_revision = collaboration_revision + 1,
             change_sequence = nextval('documents_change_sequence_seq')
         where project_id = $1
           and id = $2
           and path_revision = $3
           and collaboration_revision = $4
         returning id, project_id, path, path_revision, collaboration_revision, change_sequence, content, updated_at",
    )
    .bind(project_id)
    .bind(document_id)
    .bind(expected_path_revision)
    .bind(expected_collaboration_revision)
    .bind(content)
    .bind(updated_at)
    .fetch_optional(connection)
    .await
}

pub(crate) async fn lock_by_collaboration_identity(
    connection: &mut PgConnection,
    project_id: Uuid,
    document_id: Uuid,
    collaboration_revision: i64,
) -> Result<Option<DocumentRecord>, sqlx::Error> {
    sqlx::query_as::<_, DocumentRecord>(
        "select id, project_id, path, path_revision, collaboration_revision, change_sequence, content, updated_at
         from documents
         where project_id = $1 and id = $2 and collaboration_revision = $3
         for update",
    )
    .bind(project_id)
    .bind(document_id)
    .bind(collaboration_revision)
    .fetch_optional(connection)
    .await
}

pub(crate) async fn update_projected_content(
    connection: &mut PgConnection,
    project_id: Uuid,
    document_id: Uuid,
    collaboration_revision: i64,
    content: &str,
    updated_at: DateTime<Utc>,
) -> Result<Option<DocumentRecord>, sqlx::Error> {
    sqlx::query_as::<_, DocumentRecord>(
        "update documents
         set content = $4,
             updated_at = $5,
             change_sequence = nextval('documents_change_sequence_seq')
         where project_id = $1
           and id = $2
           and collaboration_revision = $3
         returning id, project_id, path, path_revision, collaboration_revision, change_sequence, content, updated_at",
    )
    .bind(project_id)
    .bind(document_id)
    .bind(collaboration_revision)
    .bind(content)
    .bind(updated_at)
    .fetch_optional(connection)
    .await
}

pub(crate) async fn revisions_by_id(
    connection: &mut PgConnection,
    project_id: Uuid,
    document_id: Uuid,
) -> Result<Option<(i64, i64)>, sqlx::Error> {
    sqlx::query_as(
        "select path_revision, collaboration_revision
         from documents
         where project_id = $1 and id = $2",
    )
    .bind(project_id)
    .bind(document_id)
    .fetch_optional(connection)
    .await
}

pub(crate) async fn delete_by_id(
    connection: &mut PgConnection,
    project_id: Uuid,
    document_id: Uuid,
) -> Result<u64, sqlx::Error> {
    Ok(
        sqlx::query("delete from documents where project_id = $1 and id = $2")
            .bind(project_id)
            .bind(document_id)
            .execute(connection)
            .await?
            .rows_affected(),
    )
}
