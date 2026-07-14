//! Compiled PDF artifact persistence owned by Workspace.

use chrono::{DateTime, Utc};
use sqlx::postgres::PgRow;
use sqlx::{FromRow, PgPool, Row};
use uuid::Uuid;

pub(super) struct PdfArtifactRecord {
    pub id: Uuid,
    pub project_id: Uuid,
    pub entry_file_path: String,
    pub content_type: String,
    pub size_bytes: i64,
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

impl<'row> FromRow<'row, PgRow> for PdfArtifactRecord {
    fn from_row(row: &'row PgRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            id: row.try_get("id")?,
            project_id: row.try_get("project_id")?,
            entry_file_path: row.try_get("entry_file_path")?,
            content_type: row.try_get("content_type")?,
            size_bytes: row.try_get("size_bytes")?,
            created_by: row.try_get("created_by")?,
            created_at: row.try_get("created_at")?,
        })
    }
}

pub(super) struct StoredPdfArtifactRecord {
    pub entry_file_path: String,
    pub content_type: String,
    pub pdf_bytes: Vec<u8>,
}

impl<'row> FromRow<'row, PgRow> for StoredPdfArtifactRecord {
    fn from_row(row: &'row PgRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            entry_file_path: row.try_get("entry_file_path")?,
            content_type: row.try_get("content_type")?,
            pdf_bytes: row.try_get("pdf_bytes")?,
        })
    }
}

pub(super) struct PdfArtifactWrite<'value> {
    pub id: Uuid,
    pub project_id: Uuid,
    pub entry_file_path: &'value str,
    pub content_type: &'value str,
    pub pdf_bytes: &'value [u8],
    pub size_bytes: i64,
    pub created_by: Uuid,
    pub created_at: DateTime<Utc>,
}

pub(super) async fn insert_pdf_artifact(
    db: &PgPool,
    artifact: &PdfArtifactWrite<'_>,
) -> Result<PdfArtifactRecord, sqlx::Error> {
    sqlx::query_as::<_, PdfArtifactRecord>(
        "insert into project_pdf_artifacts (
             id, project_id, entry_file_path, content_type, pdf_bytes,
             size_bytes, created_by, created_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning id, project_id, entry_file_path, content_type,
                   size_bytes, created_by, created_at",
    )
    .bind(artifact.id)
    .bind(artifact.project_id)
    .bind(artifact.entry_file_path)
    .bind(artifact.content_type)
    .bind(artifact.pdf_bytes)
    .bind(artifact.size_bytes)
    .bind(artifact.created_by)
    .bind(artifact.created_at)
    .fetch_one(db)
    .await
}

pub(super) async fn find_latest_pdf_artifact(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Option<StoredPdfArtifactRecord>, sqlx::Error> {
    sqlx::query_as::<_, StoredPdfArtifactRecord>(
        "select entry_file_path, content_type, pdf_bytes
         from project_pdf_artifacts
         where project_id = $1
         order by created_at desc
         limit 1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await
}
