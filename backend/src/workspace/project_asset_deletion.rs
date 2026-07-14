//! Transactional Workspace project-asset deletion.

use super::{assets_persistence, lock_project_content_mutation, mark_project_dirty};
use crate::object_cleanup::{delete_queued_objects_now, enqueue_object_deletions};
use crate::object_storage::ObjectStorage;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

pub(super) struct DeleteProjectAssetCommand {
    pub project_id: Uuid,
    pub asset_id: Uuid,
    pub actor_user_id: Option<Uuid>,
    pub guest_display_name: Option<String>,
}

#[derive(Clone, Copy, Debug)]
pub(super) enum DeleteProjectAssetPersistenceStage {
    Begin,
    LockContentGeneration,
    Lock,
    Delete,
    EnqueueObject,
    MarkDirty,
    Commit,
}

#[derive(Debug, Error)]
pub(super) enum DeleteProjectAssetError {
    #[error("project asset was not found")]
    AssetNotFound,
    #[error(
        "project asset deletion failed during {stage:?} for project {project_id} and asset {asset_id}"
    )]
    Persistence {
        stage: DeleteProjectAssetPersistenceStage,
        project_id: Uuid,
        asset_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

pub(super) async fn delete_project_asset(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    command: DeleteProjectAssetCommand,
) -> Result<(), DeleteProjectAssetError> {
    let mut transaction = db.begin().await.map_err(|source| {
        persistence_error(DeleteProjectAssetPersistenceStage::Begin, &command, source)
    })?;
    lock_project_content_mutation(&mut transaction, command.project_id)
        .await
        .map_err(|source| {
            persistence_error(
                DeleteProjectAssetPersistenceStage::LockContentGeneration,
                &command,
                source,
            )
        })?;
    let object_key = assets_persistence::lock_object_key_by_id(
        &mut transaction,
        command.project_id,
        command.asset_id,
    )
    .await
    .map_err(|source| {
        persistence_error(DeleteProjectAssetPersistenceStage::Lock, &command, source)
    })?
    .ok_or(DeleteProjectAssetError::AssetNotFound)?;
    if assets_persistence::delete_by_id(&mut transaction, command.project_id, command.asset_id)
        .await
        .map_err(|source| {
            persistence_error(DeleteProjectAssetPersistenceStage::Delete, &command, source)
        })?
        == 0
    {
        return Err(DeleteProjectAssetError::AssetNotFound);
    }
    let object_keys = vec![object_key];
    enqueue_object_deletions(&mut transaction, &object_keys)
        .await
        .map_err(|source| {
            persistence_error(
                DeleteProjectAssetPersistenceStage::EnqueueObject,
                &command,
                source,
            )
        })?;
    mark_project_dirty(
        &mut transaction,
        command.project_id,
        command.actor_user_id,
        command.guest_display_name.as_deref(),
    )
    .await
    .map_err(|source| {
        persistence_error(
            DeleteProjectAssetPersistenceStage::MarkDirty,
            &command,
            source,
        )
    })?;
    transaction.commit().await.map_err(|source| {
        persistence_error(DeleteProjectAssetPersistenceStage::Commit, &command, source)
    })?;
    delete_queued_objects_now(db, storage, &object_keys).await;
    Ok(())
}

fn persistence_error(
    stage: DeleteProjectAssetPersistenceStage,
    command: &DeleteProjectAssetCommand,
    source: sqlx::Error,
) -> DeleteProjectAssetError {
    DeleteProjectAssetError::Persistence {
        stage,
        project_id: command.project_id,
        asset_id: command.asset_id,
        source,
    }
}
