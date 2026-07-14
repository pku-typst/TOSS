//! Workspace project-copy policy, source projection, and object coordination.

use super::persistence::lock_project_content_snapshot;
use super::{
    load_project_thumbnail, mark_project_dirty, project_copy_persistence, provision_project,
    store_project_thumbnail, CreateProjectGraph, LatexEngine, LoadProjectThumbnailError, Project,
    ProjectName, ProjectType, WorkspaceAsset, WorkspaceDocument,
};
use crate::access::{
    project_user_has_catalog_access, user_display_name, IdentityLookupError, ProjectRole,
};
use crate::distribution::DistributionConfig;
use crate::object_cleanup::{cleanup_uncommitted_object, cleanup_uncommitted_objects};
use crate::object_storage::{get_object, put_object, ObjectStorage, ObjectStorageError};
use chrono::Utc;
use sqlx::PgPool;
use std::path::Path;
use thiserror::Error;
use tracing::warn;
use uuid::Uuid;

pub(super) struct CopyProject<'value> {
    pub actor_user_id: Uuid,
    pub source_project_id: Uuid,
    pub name: &'value ProjectName,
}

struct ProjectCopyAsset {
    path: String,
    object_key: String,
    content_type: String,
    inline_data: Option<Vec<u8>>,
}

struct ProjectCopySource {
    project_type: ProjectType,
    entry_file_path: Option<String>,
    latex_engine: Option<LatexEngine>,
    directories: Vec<String>,
    documents: Vec<WorkspaceDocument>,
    assets: Vec<ProjectCopyAsset>,
}

#[derive(Clone, Copy, Debug)]
enum CopyProjectPersistenceStage {
    BeginSourceRead,
    LockSourceContent,
    LoadSourceMetadata,
    CommitSourceRead,
    BeginDestinationWrite,
    PersistDestinationGraph,
    CommitDestinationWrite,
}

#[derive(Debug, Error)]
#[error("project copy persistence failed during {stage:?} for project {project_id}")]
pub(super) struct CopyProjectPersistenceError {
    stage: CopyProjectPersistenceStage,
    project_id: Uuid,
    #[source]
    source: sqlx::Error,
}

impl CopyProjectPersistenceError {
    fn new(stage: CopyProjectPersistenceStage, project_id: Uuid, source: sqlx::Error) -> Self {
        Self {
            stage,
            project_id,
            source,
        }
    }
}

#[derive(Debug, Error)]
pub(super) enum CopyProjectError {
    #[error("source project was not found")]
    SourceProjectNotFound,
    #[error("source project access is forbidden")]
    SourceProjectAccessForbidden,
    #[error("project type {project_type:?} is disabled")]
    ProjectTypeDisabled { project_type: ProjectType },
    #[error("object storage is unavailable for source asset {object_key}")]
    StorageUnavailable { object_key: String },
    #[error("project asset is too large: {path}")]
    AssetTooLarge { path: String },
    #[error("project source asset download failed for {object_key}")]
    AssetDownload {
        object_key: String,
        #[source]
        source: ObjectStorageError,
    },
    #[error("project asset upload failed for {object_key}")]
    AssetUpload {
        object_key: String,
        #[source]
        source: ObjectStorageError,
    },
    #[error("source project catalog access lookup failed")]
    CatalogAccess(#[source] sqlx::Error),
    #[error(transparent)]
    Identity(#[from] IdentityLookupError),
    #[error(transparent)]
    Thumbnail(#[from] LoadProjectThumbnailError),
    #[error(transparent)]
    Persistence(#[from] CopyProjectPersistenceError),
}

pub(super) async fn copy_project(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    data_dir: &Path,
    distribution: &DistributionConfig,
    command: CopyProject<'_>,
) -> Result<Project, CopyProjectError> {
    let source =
        load_project_copy_source(db, command.actor_user_id, command.source_project_id).await?;
    if !distribution.supports_project_type(source.project_type) {
        return Err(CopyProjectError::ProjectTypeDisabled {
            project_type: source.project_type,
        });
    }
    let thumbnail = load_project_thumbnail(db, data_dir, command.source_project_id).await?;
    let owner_display_name = user_display_name(db, command.actor_user_id)
        .await?
        .unwrap_or_else(|| "Unknown".to_string());
    let new_project_id = Uuid::new_v4();
    let copied_assets = prepare_copied_assets(db, storage, new_project_id, source.assets).await?;
    let object_keys = prepared_object_keys(&copied_assets);
    let created_at = Utc::now();
    let entry_file_path = source
        .entry_file_path
        .unwrap_or_else(|| source.project_type.default_entry_file_path().to_string());
    let latex_engine = if source.project_type == ProjectType::Latex {
        Some(source.latex_engine.unwrap_or(LatexEngine::Xetex))
    } else {
        None
    };
    let mut transaction = match db.begin().await {
        Ok(transaction) => transaction,
        Err(source) => {
            cleanup_uncommitted_objects(db, storage, &object_keys).await;
            return Err(CopyProjectPersistenceError::new(
                CopyProjectPersistenceStage::BeginDestinationWrite,
                new_project_id,
                source,
            )
            .into());
        }
    };
    let project = CreateProjectGraph {
        project_id: new_project_id,
        owner_user_id: command.actor_user_id,
        name: command.name,
        project_type: source.project_type,
        entry_file_path: &entry_file_path,
        latex_engine,
        directories: &source.directories,
        documents: &source.documents,
        assets: &copied_assets,
        created_at,
    };
    let persistence = async {
        provision_project(&mut transaction, &project).await?;
        mark_project_dirty(
            &mut transaction,
            new_project_id,
            Some(command.actor_user_id),
            None,
        )
        .await?;
        Ok::<(), sqlx::Error>(())
    }
    .await;
    if let Err(source) = persistence {
        if let Err(rollback_error) = transaction.rollback().await {
            warn!(%rollback_error, %new_project_id, "project copy rollback failed");
        }
        cleanup_uncommitted_objects(db, storage, &object_keys).await;
        return Err(CopyProjectPersistenceError::new(
            CopyProjectPersistenceStage::PersistDestinationGraph,
            new_project_id,
            source,
        )
        .into());
    }
    if let Err(source) = transaction.commit().await {
        return Err(CopyProjectPersistenceError::new(
            CopyProjectPersistenceStage::CommitDestinationWrite,
            new_project_id,
            source,
        )
        .into());
    }
    let has_thumbnail = if let Some(thumbnail) = thumbnail {
        match store_project_thumbnail(
            db,
            data_dir,
            new_project_id,
            &thumbnail.content_type,
            command.actor_user_id,
            created_at,
            &thumbnail.bytes,
        )
        .await
        {
            Ok(()) => true,
            Err(error) => {
                warn!(error = ?error, project_id = %new_project_id, "copied project thumbnail was not stored");
                false
            }
        }
    } else {
        false
    };
    Ok(Project {
        id: new_project_id,
        name: command.name.as_str().to_string(),
        project_type: source.project_type,
        latex_engine,
        owner_user_id: Some(command.actor_user_id),
        owner_display_name,
        my_role: ProjectRole::Owner,
        can_read: true,
        is_template: false,
        has_thumbnail,
        created_at,
        last_edited_at: created_at,
        archived: false,
        archived_at: None,
    })
}

async fn load_project_copy_source(
    db: &PgPool,
    actor_user_id: Uuid,
    project_id: Uuid,
) -> Result<ProjectCopySource, CopyProjectError> {
    let mut transaction = db.begin().await.map_err(|source| {
        CopyProjectPersistenceError::new(
            CopyProjectPersistenceStage::BeginSourceRead,
            project_id,
            source,
        )
    })?;
    let snapshot = lock_project_content_snapshot(&mut transaction, project_id)
        .await
        .map_err(|source| {
            CopyProjectPersistenceError::new(
                CopyProjectPersistenceStage::LockSourceContent,
                project_id,
                source,
            )
        })?
        .ok_or(CopyProjectError::SourceProjectNotFound)?;
    let metadata = project_copy_persistence::find_metadata(&mut transaction, project_id)
        .await
        .map_err(|source| {
            CopyProjectPersistenceError::new(
                CopyProjectPersistenceStage::LoadSourceMetadata,
                project_id,
                source,
            )
        })?
        .ok_or(CopyProjectError::SourceProjectNotFound)?;
    if !project_user_has_catalog_access(db, actor_user_id, project_id, metadata.is_template)
        .await
        .map_err(CopyProjectError::CatalogAccess)?
    {
        return Err(CopyProjectError::SourceProjectAccessForbidden);
    }
    transaction.commit().await.map_err(|source| {
        CopyProjectPersistenceError::new(
            CopyProjectPersistenceStage::CommitSourceRead,
            project_id,
            source,
        )
    })?;
    Ok(ProjectCopySource {
        project_type: metadata.project_type,
        entry_file_path: metadata.entry_file_path,
        latex_engine: metadata.latex_engine,
        directories: snapshot.directories,
        documents: snapshot
            .documents
            .into_iter()
            .map(|(path, content)| WorkspaceDocument { path, content })
            .collect(),
        assets: snapshot
            .assets
            .into_iter()
            .map(|(path, asset)| ProjectCopyAsset {
                path,
                object_key: asset.object_key,
                content_type: asset.content_type,
                inline_data: asset.inline_data,
            })
            .collect(),
    })
}

async fn prepare_copied_assets(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    new_project_id: Uuid,
    source_assets: Vec<ProjectCopyAsset>,
) -> Result<Vec<WorkspaceAsset>, CopyProjectError> {
    let mut copied_assets = Vec::with_capacity(source_assets.len());
    for source in source_assets {
        let ProjectCopyAsset {
            path,
            object_key: source_object_key,
            content_type,
            inline_data,
        } = source;
        let bytes = if let Some(inline_data) = inline_data {
            inline_data
        } else {
            let Some(storage) = storage else {
                cleanup_prepared_assets(db, storage, &copied_assets).await;
                return Err(CopyProjectError::StorageUnavailable {
                    object_key: source_object_key,
                });
            };
            match get_object(storage, &source_object_key).await {
                Ok(bytes) => bytes,
                Err(source) => {
                    cleanup_prepared_assets(db, Some(storage), &copied_assets).await;
                    return Err(CopyProjectError::AssetDownload {
                        object_key: source_object_key,
                        source,
                    });
                }
            }
        };
        let size_bytes = match i64::try_from(bytes.len()) {
            Ok(size_bytes) => size_bytes,
            Err(_) => {
                cleanup_prepared_assets(db, storage, &copied_assets).await;
                return Err(CopyProjectError::AssetTooLarge { path });
            }
        };
        let asset_id = Uuid::new_v4();
        let (object_key, inline_data) = if let Some(storage) = storage {
            let object_key = format!("projects/{new_project_id}/assets/{asset_id}");
            if let Err(source) = put_object(storage, &object_key, &content_type, bytes).await {
                cleanup_uncommitted_object(db, Some(storage), &object_key).await;
                cleanup_prepared_assets(db, Some(storage), &copied_assets).await;
                return Err(CopyProjectError::AssetUpload { object_key, source });
            }
            (object_key, None)
        } else {
            (format!("inline://{asset_id}"), Some(bytes))
        };
        copied_assets.push(WorkspaceAsset {
            id: asset_id,
            path,
            object_key,
            content_type,
            size_bytes,
            inline_data,
        });
    }
    Ok(copied_assets)
}

fn prepared_object_keys(assets: &[WorkspaceAsset]) -> Vec<String> {
    assets
        .iter()
        .map(|asset| asset.object_key.clone())
        .collect()
}

async fn cleanup_prepared_assets(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    assets: &[WorkspaceAsset],
) {
    cleanup_uncommitted_objects(db, storage, &prepared_object_keys(assets)).await;
}
