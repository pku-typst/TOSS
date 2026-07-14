//! Workspace project-thumbnail storage and read-visibility policy.

use super::{project_template_status, project_thumbnail_persistence};
use crate::access::project_user_has_catalog_access;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use std::path::{Path, PathBuf};
use thiserror::Error;
use uuid::Uuid;

pub(crate) struct ProjectThumbnail {
    pub content_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Copy, Debug)]
enum ThumbnailPersistenceStage {
    ProjectClassification,
    MetadataLookup,
    UpsertMetadata,
    DeleteMetadata,
}

#[derive(Debug, Error)]
#[error("thumbnail persistence failed during {stage:?} for project {project_id}")]
pub(crate) struct ThumbnailPersistenceError {
    stage: ThumbnailPersistenceStage,
    project_id: Uuid,
    #[source]
    source: sqlx::Error,
}

impl ThumbnailPersistenceError {
    fn new(stage: ThumbnailPersistenceStage, project_id: Uuid, source: sqlx::Error) -> Self {
        Self {
            stage,
            project_id,
            source,
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum ThumbnailFilesystemStage {
    Read,
    CreateDirectory,
    WriteTemporaryFile,
    ReplaceFile,
}

#[derive(Debug, Error)]
#[error("thumbnail filesystem operation {stage:?} failed for project {project_id}")]
pub(crate) struct ThumbnailFilesystemError {
    stage: ThumbnailFilesystemStage,
    project_id: Uuid,
    #[source]
    source: std::io::Error,
}

impl ThumbnailFilesystemError {
    fn new(stage: ThumbnailFilesystemStage, project_id: Uuid, source: std::io::Error) -> Self {
        Self {
            stage,
            project_id,
            source,
        }
    }
}

#[derive(Debug, Error)]
pub(super) enum CheckProjectThumbnailReadabilityError {
    #[error(transparent)]
    Persistence(#[from] ThumbnailPersistenceError),
    #[error("project thumbnail access lookup failed")]
    CatalogAccess(#[source] sqlx::Error),
}

#[derive(Debug, Error)]
pub(crate) enum LoadProjectThumbnailError {
    #[error(transparent)]
    Persistence(#[from] ThumbnailPersistenceError),
    #[error(transparent)]
    Filesystem(#[from] ThumbnailFilesystemError),
}

#[derive(Debug, Error)]
pub(crate) enum StoreProjectThumbnailError {
    #[error(transparent)]
    Persistence(#[from] ThumbnailPersistenceError),
    #[error(transparent)]
    Filesystem(#[from] ThumbnailFilesystemError),
}

pub(crate) async fn project_thumbnail_is_readable(
    db: &PgPool,
    actor_user_id: Uuid,
    project_id: Uuid,
) -> Result<bool, CheckProjectThumbnailReadabilityError> {
    let is_template = project_template_status(db, project_id)
        .await
        .map_err(|source| {
            ThumbnailPersistenceError::new(
                ThumbnailPersistenceStage::ProjectClassification,
                project_id,
                source,
            )
        })?
        .unwrap_or(false);
    project_user_has_catalog_access(db, actor_user_id, project_id, is_template)
        .await
        .map_err(CheckProjectThumbnailReadabilityError::CatalogAccess)
}

pub(crate) async fn load_project_thumbnail(
    db: &PgPool,
    data_dir: &Path,
    project_id: Uuid,
) -> Result<Option<ProjectThumbnail>, LoadProjectThumbnailError> {
    let Some(metadata) = project_thumbnail_persistence::load_metadata(db, project_id)
        .await
        .map_err(|source| {
            ThumbnailPersistenceError::new(
                ThumbnailPersistenceStage::MetadataLookup,
                project_id,
                source,
            )
        })?
    else {
        return Ok(None);
    };
    let Some(bytes) = read_project_thumbnail_bytes(data_dir, project_id).await? else {
        delete_project_thumbnail_metadata(db, project_id).await?;
        return Ok(None);
    };
    Ok(Some(ProjectThumbnail {
        content_type: metadata.content_type,
        bytes,
    }))
}

pub(crate) async fn store_project_thumbnail(
    db: &PgPool,
    data_dir: &Path,
    project_id: Uuid,
    content_type: &str,
    actor_user_id: Uuid,
    updated_at: DateTime<Utc>,
    bytes: &[u8],
) -> Result<(), StoreProjectThumbnailError> {
    write_project_thumbnail_bytes(data_dir, project_id, bytes).await?;
    project_thumbnail_persistence::upsert_metadata(
        db,
        project_id,
        content_type,
        actor_user_id,
        updated_at,
    )
    .await
    .map_err(|source| {
        ThumbnailPersistenceError::new(
            ThumbnailPersistenceStage::UpsertMetadata,
            project_id,
            source,
        )
    })?;
    Ok(())
}

async fn delete_project_thumbnail_metadata(
    db: &PgPool,
    project_id: Uuid,
) -> Result<(), ThumbnailPersistenceError> {
    project_thumbnail_persistence::delete_metadata(db, project_id)
        .await
        .map_err(|source| {
            ThumbnailPersistenceError::new(
                ThumbnailPersistenceStage::DeleteMetadata,
                project_id,
                source,
            )
        })?;
    Ok(())
}

async fn read_project_thumbnail_bytes(
    data_dir: &Path,
    project_id: Uuid,
) -> Result<Option<Vec<u8>>, ThumbnailFilesystemError> {
    match tokio::fs::read(project_thumbnail_path(data_dir, project_id)).await {
        Ok(bytes) => Ok(Some(bytes)),
        Err(file_error) if file_error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(ThumbnailFilesystemError::new(
            ThumbnailFilesystemStage::Read,
            project_id,
            source,
        )),
    }
}

fn project_thumbnail_path(data_dir: &Path, project_id: Uuid) -> PathBuf {
    data_dir
        .join("thumbnails")
        .join(format!("{project_id}.thumb"))
}

async fn write_project_thumbnail_bytes(
    data_dir: &Path,
    project_id: Uuid,
    bytes: &[u8],
) -> Result<(), ThumbnailFilesystemError> {
    let directory = data_dir.join("thumbnails");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|source| {
            ThumbnailFilesystemError::new(
                ThumbnailFilesystemStage::CreateDirectory,
                project_id,
                source,
            )
        })?;
    let final_path = project_thumbnail_path(data_dir, project_id);
    let temporary_path = directory.join(format!(".{project_id}.{}.tmp", Uuid::new_v4()));
    tokio::fs::write(&temporary_path, bytes)
        .await
        .map_err(|source| {
            ThumbnailFilesystemError::new(
                ThumbnailFilesystemStage::WriteTemporaryFile,
                project_id,
                source,
            )
        })?;
    tokio::fs::rename(&temporary_path, &final_path)
        .await
        .map_err(|source| {
            ThumbnailFilesystemError::new(ThumbnailFilesystemStage::ReplaceFile, project_id, source)
        })?;
    Ok(())
}
