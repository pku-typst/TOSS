//! Transactional Workspace project-asset upload and replacement.

use super::project_assets::project_asset_from_record;
use super::{assets_persistence, lock_project_content_mutation, mark_project_dirty, ProjectAsset};
use crate::object_cleanup::{
    cleanup_uncommitted_object, delete_queued_objects_now, enqueue_object_deletions,
};
use crate::object_storage::{put_object, ObjectStorage, ObjectStorageError};
use chrono::Utc;
use sqlx::PgPool;
use thiserror::Error;
use tracing::warn;
use uuid::Uuid;

pub(super) struct UploadProjectAssetCommand {
    pub project_id: Uuid,
    pub path: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
    pub actor_user_id: Option<Uuid>,
    pub guest_display_name: Option<String>,
}

#[derive(Clone, Copy, Debug)]
enum UploadProjectAssetPersistenceStage {
    Begin,
    LockContentGeneration,
    LockExistingPath,
    Upsert,
    EnqueueReplacedObjectDeletion,
    MarkDirty,
    Commit,
}

#[derive(Debug, Error)]
#[error(
    "project asset upload persistence failed during {stage:?} for project {project_id} and asset {asset_id}"
)]
pub(super) struct UploadProjectAssetPersistenceError {
    stage: UploadProjectAssetPersistenceStage,
    project_id: Uuid,
    asset_id: Uuid,
    #[source]
    source: sqlx::Error,
}

impl UploadProjectAssetPersistenceError {
    fn new(
        stage: UploadProjectAssetPersistenceStage,
        project_id: Uuid,
        asset_id: Uuid,
        source: sqlx::Error,
    ) -> Self {
        Self {
            stage,
            project_id,
            asset_id,
            source,
        }
    }
}

#[derive(Debug, Error)]
pub(super) enum UploadProjectAssetError {
    #[error("project asset is too large")]
    PayloadTooLarge,
    #[error(
        "project asset upload failed for project {project_id}, asset {asset_id}, and object {object_key}"
    )]
    Storage {
        project_id: Uuid,
        asset_id: Uuid,
        object_key: String,
        #[source]
        source: ObjectStorageError,
    },
    #[error(transparent)]
    Persistence(#[from] UploadProjectAssetPersistenceError),
}

pub(super) async fn upload_project_asset(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    command: UploadProjectAssetCommand,
) -> Result<ProjectAsset, UploadProjectAssetError> {
    let size_bytes =
        i64::try_from(command.bytes.len()).map_err(|_| UploadProjectAssetError::PayloadTooLarge)?;
    let asset_id = Uuid::new_v4();
    let content_revision = Uuid::new_v4();
    let (object_key, inline_data) = if let Some(storage) = storage {
        let object_key = format!("projects/{}/assets/{content_revision}", command.project_id);
        if let Err(source) =
            put_object(storage, &object_key, &command.content_type, command.bytes).await
        {
            cleanup_uncommitted_object(db, Some(storage), &object_key).await;
            return Err(UploadProjectAssetError::Storage {
                project_id: command.project_id,
                asset_id,
                object_key,
                source,
            });
        }
        (object_key, None)
    } else {
        (format!("inline://{asset_id}"), Some(command.bytes))
    };
    let mut transaction = match db.begin().await {
        Ok(transaction) => transaction,
        Err(source) => {
            cleanup_uncommitted_object(db, storage, &object_key).await;
            return Err(UploadProjectAssetPersistenceError::new(
                UploadProjectAssetPersistenceStage::Begin,
                command.project_id,
                asset_id,
                source,
            )
            .into());
        }
    };
    if let Err(source) = lock_project_content_mutation(&mut transaction, command.project_id).await {
        rollback_failed_asset_upload(db, storage, transaction, &object_key).await;
        return Err(UploadProjectAssetPersistenceError::new(
            UploadProjectAssetPersistenceStage::LockContentGeneration,
            command.project_id,
            asset_id,
            source,
        )
        .into());
    }
    let replaced_object_key = match assets_persistence::lock_object_key_by_path(
        &mut transaction,
        command.project_id,
        &command.path,
    )
    .await
    {
        Ok(value) => value,
        Err(source) => {
            rollback_failed_asset_upload(db, storage, transaction, &object_key).await;
            return Err(UploadProjectAssetPersistenceError::new(
                UploadProjectAssetPersistenceStage::LockExistingPath,
                command.project_id,
                asset_id,
                source,
            )
            .into());
        }
    };
    let asset = assets_persistence::AssetWrite {
        id: asset_id,
        project_id: command.project_id,
        path: &command.path,
        content_revision,
        object_key: &object_key,
        content_type: &command.content_type,
        size_bytes,
        uploaded_by: command.actor_user_id,
        created_at: Utc::now(),
        inline_data: inline_data.as_deref(),
    };
    let record = match assets_persistence::upsert(&mut transaction, &asset).await {
        Ok(record) => record,
        Err(source) => {
            rollback_failed_asset_upload(db, storage, transaction, &object_key).await;
            return Err(UploadProjectAssetPersistenceError::new(
                UploadProjectAssetPersistenceStage::Upsert,
                command.project_id,
                asset_id,
                source,
            )
            .into());
        }
    };
    let replaced_object_keys = replaced_object_key
        .filter(|old_object_key| old_object_key != &object_key)
        .into_iter()
        .collect::<Vec<_>>();
    if let Err(source) = enqueue_object_deletions(&mut transaction, &replaced_object_keys).await {
        rollback_failed_asset_upload(db, storage, transaction, &object_key).await;
        return Err(UploadProjectAssetPersistenceError::new(
            UploadProjectAssetPersistenceStage::EnqueueReplacedObjectDeletion,
            command.project_id,
            asset_id,
            source,
        )
        .into());
    }
    if let Err(source) = mark_project_dirty(
        &mut transaction,
        command.project_id,
        command.actor_user_id,
        command.guest_display_name.as_deref(),
    )
    .await
    {
        rollback_failed_asset_upload(db, storage, transaction, &object_key).await;
        return Err(UploadProjectAssetPersistenceError::new(
            UploadProjectAssetPersistenceStage::MarkDirty,
            command.project_id,
            asset_id,
            source,
        )
        .into());
    }
    transaction.commit().await.map_err(|source| {
        UploadProjectAssetPersistenceError::new(
            UploadProjectAssetPersistenceStage::Commit,
            command.project_id,
            asset_id,
            source,
        )
    })?;
    delete_queued_objects_now(db, storage, &replaced_object_keys).await;
    Ok(project_asset_from_record(record))
}

async fn rollback_failed_asset_upload(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    transaction: sqlx::Transaction<'_, sqlx::Postgres>,
    object_key: &str,
) {
    if let Err(rollback_error) = transaction.rollback().await {
        warn!(%rollback_error, object_key, "asset upload rollback failed");
    }
    cleanup_uncommitted_object(db, storage, object_key).await;
}
