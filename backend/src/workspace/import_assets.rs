//! Object-storage staging for atomically provisioned imported projects.

use super::WorkspaceAsset;
use crate::object_cleanup::cleanup_uncommitted_object;
use crate::object_storage::{put_object, ObjectStorage, ObjectStorageError};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

pub(crate) struct WorkspaceImportAsset {
    pub path: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

pub(crate) struct StagedWorkspaceImportAssets {
    pub assets: Vec<WorkspaceAsset>,
    object_keys: Vec<String>,
}

#[derive(Debug, Error)]
pub(crate) enum StageWorkspaceImportAssetsError {
    #[error("imported project asset is too large")]
    TooLarge,
    #[error("imported project asset staging failed")]
    Storage(#[source] ObjectStorageError),
}

pub(crate) async fn stage_workspace_import_assets(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    project_id: Uuid,
    inputs: Vec<WorkspaceImportAsset>,
) -> Result<StagedWorkspaceImportAssets, StageWorkspaceImportAssetsError> {
    let mut assets = Vec::with_capacity(inputs.len());
    let mut object_keys = Vec::new();
    for input in inputs {
        let size_bytes = i64::try_from(input.bytes.len())
            .map_err(|_| StageWorkspaceImportAssetsError::TooLarge)?;
        let asset_id = Uuid::new_v4();
        let (object_key, inline_data) = if let Some(storage) = storage {
            let object_key = format!("projects/{project_id}/assets/{asset_id}");
            if let Err(source) =
                put_object(storage, &object_key, &input.content_type, input.bytes).await
            {
                cleanup_staged_workspace_import_assets(db, Some(storage), &object_keys).await;
                cleanup_uncommitted_object(db, Some(storage), &object_key).await;
                return Err(StageWorkspaceImportAssetsError::Storage(source));
            }
            object_keys.push(object_key.clone());
            (object_key, None)
        } else {
            (format!("inline://{asset_id}"), Some(input.bytes))
        };
        assets.push(WorkspaceAsset {
            id: asset_id,
            path: input.path,
            object_key,
            content_type: input.content_type,
            size_bytes,
            inline_data,
        });
    }
    Ok(StagedWorkspaceImportAssets {
        assets,
        object_keys,
    })
}

pub(crate) async fn cleanup_staged_workspace_import_assets(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    object_keys: &[String],
) {
    for object_key in object_keys {
        cleanup_uncommitted_object(db, storage, object_key).await;
    }
}

impl StagedWorkspaceImportAssets {
    pub(crate) async fn cleanup(self, db: &PgPool, storage: Option<&ObjectStorage>) {
        cleanup_staged_workspace_import_assets(db, storage, &self.object_keys).await;
    }

    pub(crate) async fn cleanup_if_unreferenced(
        self,
        db: &PgPool,
        storage: Option<&ObjectStorage>,
    ) {
        for object_key in self.object_keys {
            let referenced = sqlx::query_scalar::<_, bool>(
                "select exists(select 1 from project_assets where object_key = $1)",
            )
            .bind(&object_key)
            .fetch_one(db)
            .await;
            match referenced {
                Ok(false) => cleanup_uncommitted_object(db, storage, &object_key).await,
                Ok(true) => {}
                Err(error) => {
                    tracing::warn!(%object_key, %error, "ambiguous import asset cleanup was deferred")
                }
            }
        }
    }
}
