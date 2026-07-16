//! Workspace project-file creation across directories, documents, and assets.

use super::{
    assets_persistence, files_persistence, lock_project_content_mutation, mark_project_dirty,
    ProjectFileKind,
};
use crate::object_cleanup::{
    cleanup_uncommitted_object, delete_queued_objects_now, enqueue_object_deletions,
};
use crate::object_storage::{put_object, ObjectStorage, ObjectStorageError};
use chrono::Utc;
use sqlx::PgPool;
use thiserror::Error;
use tracing::warn;
use uuid::Uuid;

pub(super) struct CreateProjectFileCommand {
    pub project_id: Uuid,
    pub path: String,
    pub kind: ProjectFileKind,
    pub content: String,
    pub content_type: String,
    pub is_text: bool,
    pub actor_user_id: Option<Uuid>,
    pub guest_display_name: Option<String>,
}

enum PreparedProjectFile {
    Directory,
    Text(String),
    Asset {
        id: Uuid,
        object_key: String,
        content_type: String,
        inline_data: Option<Vec<u8>>,
    },
}

#[derive(Clone, Copy, Debug)]
enum CreateProjectFilePersistenceStage {
    Begin,
    LockContentGeneration,
    Persist,
    EnqueueReplacedObjectDeletion,
    MarkDirty,
    Commit,
}

#[derive(Debug, Error)]
#[error("project file creation failed during {stage:?} for project {project_id} at {path}")]
pub(super) struct CreateProjectFilePersistenceError {
    stage: CreateProjectFilePersistenceStage,
    project_id: Uuid,
    path: String,
    #[source]
    source: sqlx::Error,
}

impl CreateProjectFilePersistenceError {
    fn new(
        stage: CreateProjectFilePersistenceStage,
        project_id: Uuid,
        path: impl Into<String>,
        source: sqlx::Error,
    ) -> Self {
        Self {
            stage,
            project_id,
            path: path.into(),
            source,
        }
    }
}

#[derive(Debug, Error)]
#[error("project file storage failed for project {project_id} and object {object_key}")]
pub(super) struct ProjectFileStorageError {
    project_id: Uuid,
    object_key: String,
    #[source]
    source: ObjectStorageError,
}

#[derive(Debug, Error)]
pub(super) enum CreateProjectFileError {
    #[error("a project file already exists at this path")]
    PathConflict,
    #[error(transparent)]
    Storage(#[from] ProjectFileStorageError),
    #[error(transparent)]
    Persistence(#[from] CreateProjectFilePersistenceError),
}

pub(super) async fn create_project_file(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    command: CreateProjectFileCommand,
) -> Result<(), CreateProjectFileError> {
    let prepared = if command.kind == ProjectFileKind::Directory {
        PreparedProjectFile::Directory
    } else if command.is_text {
        PreparedProjectFile::Text(command.content)
    } else {
        prepare_empty_asset(db, storage, command.project_id, &command.content_type).await?
    };
    let now = Utc::now();
    let mut transaction = match db.begin().await {
        Ok(transaction) => transaction,
        Err(source) => {
            cleanup_prepared_project_file(db, storage, &prepared).await;
            return Err(CreateProjectFilePersistenceError::new(
                CreateProjectFilePersistenceStage::Begin,
                command.project_id,
                &command.path,
                source,
            )
            .into());
        }
    };
    if let Err(source) = lock_project_content_mutation(&mut transaction, command.project_id).await {
        rollback_project_file(
            db,
            storage,
            transaction,
            &prepared,
            command.project_id,
            &command.path,
        )
        .await;
        return Err(CreateProjectFilePersistenceError::new(
            CreateProjectFilePersistenceStage::LockContentGeneration,
            command.project_id,
            &command.path,
            source,
        )
        .into());
    }
    let persistence: Result<(bool, Vec<String>), sqlx::Error> = async {
        match &prepared {
            PreparedProjectFile::Directory => {
                let changed = files_persistence::insert_directory(
                    &mut transaction,
                    command.project_id,
                    &command.path,
                    now,
                )
                .await?;
                Ok((changed, Vec::new()))
            }
            PreparedProjectFile::Text(content) => {
                let replaced_object_keys = assets_persistence::lock_object_keys_at_path(
                    &mut transaction,
                    command.project_id,
                    &command.path,
                )
                .await?;
                files_persistence::upsert_document(
                    &mut transaction,
                    command.project_id,
                    &command.path,
                    content,
                    now,
                )
                .await?;
                assets_persistence::delete_at_path(
                    &mut transaction,
                    command.project_id,
                    &command.path,
                )
                .await?;
                Ok((true, replaced_object_keys))
            }
            PreparedProjectFile::Asset {
                id,
                object_key,
                content_type,
                inline_data,
            } => {
                let replaced_object_keys = assets_persistence::lock_object_keys_at_path(
                    &mut transaction,
                    command.project_id,
                    &command.path,
                )
                .await?;
                assets_persistence::upsert(
                    &mut transaction,
                    &assets_persistence::AssetWrite {
                        id: *id,
                        project_id: command.project_id,
                        path: &command.path,
                        content_revision: *id,
                        object_key,
                        content_type,
                        size_bytes: 0,
                        uploaded_by: command.actor_user_id,
                        created_at: now,
                        inline_data: inline_data.as_deref(),
                    },
                )
                .await?;
                files_persistence::delete_document_at_path(
                    &mut transaction,
                    command.project_id,
                    &command.path,
                )
                .await?;
                Ok((true, replaced_object_keys))
            }
        }
    }
    .await;
    let (changed, replaced_object_keys) = match persistence {
        Ok(value) => value,
        Err(source) => {
            let path_conflict = files_persistence::is_project_path_conflict(&source);
            rollback_project_file(
                db,
                storage,
                transaction,
                &prepared,
                command.project_id,
                &command.path,
            )
            .await;
            if path_conflict {
                return Err(CreateProjectFileError::PathConflict);
            }
            return Err(CreateProjectFilePersistenceError::new(
                CreateProjectFilePersistenceStage::Persist,
                command.project_id,
                &command.path,
                source,
            )
            .into());
        }
    };
    if changed {
        if let Err(source) = enqueue_object_deletions(&mut transaction, &replaced_object_keys).await
        {
            rollback_project_file(
                db,
                storage,
                transaction,
                &prepared,
                command.project_id,
                &command.path,
            )
            .await;
            return Err(CreateProjectFilePersistenceError::new(
                CreateProjectFilePersistenceStage::EnqueueReplacedObjectDeletion,
                command.project_id,
                &command.path,
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
            rollback_project_file(
                db,
                storage,
                transaction,
                &prepared,
                command.project_id,
                &command.path,
            )
            .await;
            return Err(CreateProjectFilePersistenceError::new(
                CreateProjectFilePersistenceStage::MarkDirty,
                command.project_id,
                &command.path,
                source,
            )
            .into());
        }
    }
    transaction.commit().await.map_err(|source| {
        CreateProjectFilePersistenceError::new(
            CreateProjectFilePersistenceStage::Commit,
            command.project_id,
            &command.path,
            source,
        )
    })?;
    delete_queued_objects_now(db, storage, &replaced_object_keys).await;
    Ok(())
}

async fn prepare_empty_asset(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    project_id: Uuid,
    content_type: &str,
) -> Result<PreparedProjectFile, ProjectFileStorageError> {
    let id = Uuid::new_v4();
    let (object_key, inline_data) = if let Some(storage) = storage {
        let object_key = format!("projects/{project_id}/assets/{id}");
        if let Err(source) = put_object(storage, &object_key, content_type, Vec::new()).await {
            cleanup_uncommitted_object(db, Some(storage), &object_key).await;
            return Err(ProjectFileStorageError {
                project_id,
                object_key,
                source,
            });
        }
        (object_key, None)
    } else {
        (format!("inline://{id}"), Some(Vec::new()))
    };
    Ok(PreparedProjectFile::Asset {
        id,
        object_key,
        content_type: content_type.to_string(),
        inline_data,
    })
}

async fn rollback_project_file(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    transaction: sqlx::Transaction<'_, sqlx::Postgres>,
    prepared: &PreparedProjectFile,
    project_id: Uuid,
    path: &str,
) {
    if let Err(rollback_error) = transaction.rollback().await {
        warn!(%rollback_error, %project_id, path, "project file rollback failed");
    }
    cleanup_prepared_project_file(db, storage, prepared).await;
}

async fn cleanup_prepared_project_file(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    prepared: &PreparedProjectFile,
) {
    if let PreparedProjectFile::Asset { object_key, .. } = prepared {
        cleanup_uncommitted_object(db, storage, object_key).await;
    }
}
