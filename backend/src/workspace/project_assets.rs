//! Workspace project-asset read contract and queries.

use super::assets_persistence::{self, ProjectAssetRecord};
use crate::object_storage::{get_object, ObjectStorage, ObjectStorageError};
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

const ASSET_LIST_LIMIT: i64 = 500;

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ProjectAsset {
    pub id: Uuid,
    pub project_id: Uuid,
    pub path: String,
    pub content_revision: Uuid,
    pub content_type: String,
    pub size_bytes: i64,
    #[schema(required)]
    pub uploaded_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

pub(super) struct LoadedProjectAsset {
    pub asset: ProjectAsset,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Copy, Debug)]
enum ProjectAssetQuery {
    List,
    Find,
}

#[derive(Debug, Error)]
#[error("project asset query {query:?} failed for project {project_id} and asset {asset_id:?}")]
pub(super) struct ProjectAssetQueryError {
    query: ProjectAssetQuery,
    project_id: Uuid,
    asset_id: Option<Uuid>,
    #[source]
    source: sqlx::Error,
}

impl ProjectAssetQueryError {
    fn new(
        query: ProjectAssetQuery,
        project_id: Uuid,
        asset_id: Option<Uuid>,
        source: sqlx::Error,
    ) -> Self {
        Self {
            query,
            project_id,
            asset_id,
            source,
        }
    }
}

#[derive(Debug, Error)]
pub(super) enum LoadProjectAssetError {
    #[error("project asset was not found")]
    AssetNotFound,
    #[error("object storage is unavailable for project asset {object_key}")]
    StorageUnavailable { object_key: String },
    #[error(
        "project asset download failed for project {project_id}, asset {asset_id}, and object {object_key}"
    )]
    Storage {
        project_id: Uuid,
        asset_id: Uuid,
        object_key: String,
        #[source]
        source: ObjectStorageError,
    },
    #[error(transparent)]
    Query(#[from] ProjectAssetQueryError),
}

pub(super) async fn list_project_assets(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Vec<ProjectAsset>, ProjectAssetQueryError> {
    assets_persistence::list_by_project(db, project_id, ASSET_LIST_LIMIT)
        .await
        .map_err(|source| {
            ProjectAssetQueryError::new(ProjectAssetQuery::List, project_id, None, source)
        })
        .map(|records| records.into_iter().map(project_asset_from_record).collect())
}

pub(super) async fn load_project_asset(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    project_id: Uuid,
    asset_id: Uuid,
) -> Result<LoadedProjectAsset, LoadProjectAssetError> {
    let stored = assets_persistence::find_stored_by_id(db, project_id, asset_id)
        .await
        .map_err(|source| {
            ProjectAssetQueryError::new(ProjectAssetQuery::Find, project_id, Some(asset_id), source)
        })?
        .ok_or(LoadProjectAssetError::AssetNotFound)?;
    let bytes = if let Some(inline_data) = stored.inline_data.as_ref() {
        inline_data.clone()
    } else {
        let storage = storage.ok_or_else(|| LoadProjectAssetError::StorageUnavailable {
            object_key: stored.asset.object_key.clone(),
        })?;
        get_object(storage, &stored.asset.object_key)
            .await
            .map_err(|source| LoadProjectAssetError::Storage {
                project_id: stored.asset.project_id,
                asset_id: stored.asset.id,
                object_key: stored.asset.object_key.clone(),
                source,
            })?
    };

    Ok(LoadedProjectAsset {
        asset: project_asset_from_record(stored.asset),
        bytes,
    })
}

pub(super) fn project_asset_from_record(record: ProjectAssetRecord) -> ProjectAsset {
    ProjectAsset {
        id: record.id,
        project_id: record.project_id,
        path: record.path,
        content_revision: record.content_revision,
        content_type: record.content_type,
        size_bytes: record.size_bytes,
        uploaded_by: record.uploaded_by,
        created_at: record.created_at,
    }
}
