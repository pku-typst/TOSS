use super::{LatexEngine, ProjectName, ProjectType};
use crate::object_storage::{get_object, ObjectStorage, ObjectStorageError};
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use std::collections::HashMap;
use thiserror::Error;
use uuid::Uuid;

pub(crate) struct WorkspaceDocument {
    pub path: String,
    pub content: String,
}

pub(crate) struct WorkspaceAsset {
    pub id: Uuid,
    pub path: String,
    pub object_key: String,
    pub content_type: String,
    pub size_bytes: i64,
    pub inline_data: Option<Vec<u8>>,
}

pub(crate) struct CreateProjectGraph<'project> {
    pub project_id: Uuid,
    pub owner_user_id: Uuid,
    pub name: &'project ProjectName,
    pub project_type: ProjectType,
    pub entry_file_path: &'project str,
    pub latex_engine: Option<LatexEngine>,
    pub directories: &'project [String],
    pub documents: &'project [WorkspaceDocument],
    pub assets: &'project [WorkspaceAsset],
    pub created_at: DateTime<Utc>,
}

impl<'project> CreateProjectGraph<'project> {
    pub(crate) fn empty(
        project_id: Uuid,
        owner_user_id: Uuid,
        name: &'project ProjectName,
        project_type: ProjectType,
        latex_engine: LatexEngine,
        created_at: DateTime<Utc>,
    ) -> Self {
        let entry_file_path = project_type.default_entry_file_path();
        let latex_engine = (project_type == ProjectType::Latex).then_some(latex_engine);
        Self {
            project_id,
            owner_user_id,
            name,
            project_type,
            entry_file_path,
            latex_engine,
            directories: &[],
            documents: &[],
            assets: &[],
            created_at,
        }
    }
}

pub(crate) struct ReplaceProjectContent<'content> {
    pub project_id: Uuid,
    pub expected_workspace_version: Option<i64>,
    pub documents: &'content [WorkspaceDocument],
    pub assets: &'content [WorkspaceAsset],
    pub directories: &'content [String],
    pub entry_file_path: &'content str,
    pub asset_uploaded_by: Option<Uuid>,
    pub updated_at: DateTime<Utc>,
}

pub(crate) struct ReplacedProjectContent {
    pub old_object_keys: Vec<String>,
    pub workspace_version: i64,
    pub content_epoch: i64,
}

pub(crate) enum ReplaceProjectContentResult {
    Replaced(ReplacedProjectContent),
    NotFound,
    WorkspaceVersionChanged,
    InvalidEntryFile,
}

pub(crate) struct ProjectContentAsset {
    pub object_key: String,
    pub content_type: String,
    pub inline_data: Option<Vec<u8>>,
}

pub(crate) struct ProjectContentSnapshot {
    pub workspace_version: i64,
    pub documents: HashMap<String, String>,
    pub assets: HashMap<String, ProjectContentAsset>,
    pub directories: Vec<String>,
}

#[derive(Debug, Error)]
pub(crate) enum LoadProjectContentAssetError {
    #[error("object storage is unavailable for project asset {object_key}")]
    StorageUnavailable { object_key: String },
    #[error("project asset download failed for {object_key}")]
    Storage {
        object_key: String,
        #[source]
        source: ObjectStorageError,
    },
}

pub(crate) async fn load_project_content_asset_bytes(
    storage: Option<&ObjectStorage>,
    asset: &ProjectContentAsset,
) -> Result<Vec<u8>, LoadProjectContentAssetError> {
    if let Some(inline_data) = asset.inline_data.as_ref() {
        return Ok(inline_data.clone());
    }
    let storage = storage.ok_or_else(|| LoadProjectContentAssetError::StorageUnavailable {
        object_key: asset.object_key.clone(),
    })?;
    get_object(storage, &asset.object_key)
        .await
        .map_err(|source| LoadProjectContentAssetError::Storage {
            object_key: asset.object_key.clone(),
            source,
        })
}

pub(crate) async fn load_project_content_snapshot(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Option<ProjectContentSnapshot>, sqlx::Error> {
    let mut transaction = db.begin().await?;
    let snapshot =
        super::persistence::lock_project_content_snapshot(&mut transaction, project_id).await?;
    transaction.commit().await?;
    Ok(snapshot)
}
