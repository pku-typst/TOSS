//! Compiled PDF artifacts produced by browser compilation sessions.

use super::pdf_artifacts_persistence;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct PdfArtifact {
    pub id: Uuid,
    pub project_id: Uuid,
    pub entry_file_path: String,
    pub content_type: String,
    pub size_bytes: i64,
    #[schema(required)]
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

pub(super) struct StoredPdfArtifact {
    pub entry_file_path: String,
    pub content_type: String,
    pub pdf_bytes: Vec<u8>,
}

pub(super) struct UploadPdfArtifact {
    pub project_id: Uuid,
    pub entry_file_path: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
    pub actor_user_id: Uuid,
}

#[derive(Debug, Error)]
pub(super) enum UploadPdfArtifactError {
    #[error("PDF artifact is too large")]
    PayloadTooLarge,
    #[error("PDF artifact {artifact_id} persistence failed for project {project_id}")]
    Persistence {
        project_id: Uuid,
        artifact_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

#[derive(Debug, Error)]
pub(super) enum LoadLatestPdfArtifactError {
    #[error("PDF artifact was not found")]
    ArtifactNotFound,
    #[error("latest PDF artifact lookup failed for project {project_id}")]
    Persistence {
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

pub(super) async fn upload_pdf_artifact(
    db: &PgPool,
    command: UploadPdfArtifact,
) -> Result<PdfArtifact, UploadPdfArtifactError> {
    let size_bytes =
        i64::try_from(command.bytes.len()).map_err(|_| UploadPdfArtifactError::PayloadTooLarge)?;
    let artifact_id = Uuid::new_v4();
    let artifact = pdf_artifacts_persistence::insert_pdf_artifact(
        db,
        &pdf_artifacts_persistence::PdfArtifactWrite {
            id: artifact_id,
            project_id: command.project_id,
            entry_file_path: &command.entry_file_path,
            content_type: &command.content_type,
            pdf_bytes: &command.bytes,
            size_bytes,
            created_by: command.actor_user_id,
            created_at: Utc::now(),
        },
    )
    .await
    .map_err(|source| UploadPdfArtifactError::Persistence {
        project_id: command.project_id,
        artifact_id,
        source,
    })?;

    Ok(pdf_artifact_from_record(artifact))
}

pub(super) async fn load_latest_pdf_artifact(
    db: &PgPool,
    project_id: Uuid,
) -> Result<StoredPdfArtifact, LoadLatestPdfArtifactError> {
    pdf_artifacts_persistence::find_latest_pdf_artifact(db, project_id)
        .await
        .map_err(|source| LoadLatestPdfArtifactError::Persistence { project_id, source })?
        .map(|artifact| StoredPdfArtifact {
            entry_file_path: artifact.entry_file_path,
            content_type: artifact.content_type,
            pdf_bytes: artifact.pdf_bytes,
        })
        .ok_or(LoadLatestPdfArtifactError::ArtifactNotFound)
}

fn pdf_artifact_from_record(record: pdf_artifacts_persistence::PdfArtifactRecord) -> PdfArtifact {
    PdfArtifact {
        id: record.id,
        project_id: record.project_id,
        entry_file_path: record.entry_file_path,
        content_type: record.content_type,
        size_bytes: record.size_bytes,
        created_by: record.created_by,
        created_at: record.created_at,
    }
}
