//! Recursive Workspace project-file and directory deletion.

use super::file_policy::path_is_in_subtree;
use super::project_entry_point::find_project_entry_point_in_transaction;
use super::{files_persistence, lock_project_content_exclusively, mark_project_dirty};
use crate::object_cleanup::{delete_queued_objects_now, enqueue_object_deletions};
use crate::object_storage::ObjectStorage;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

pub(super) struct DeleteProjectFileCommand {
    pub project_id: Uuid,
    pub path: String,
    pub actor_user_id: Option<Uuid>,
    pub guest_display_name: Option<String>,
}

#[derive(Clone, Copy, Debug)]
pub(super) enum DeleteProjectFilePersistenceStage {
    Begin,
    LockProjectContent,
    LoadEntryPoint,
    Delete,
    EnqueueDeletedObject,
    MarkDirty,
    Commit,
}

#[derive(Debug, Error)]
pub(super) enum DeleteProjectFileError {
    #[error("the project entry file cannot be deleted")]
    EntryFileDeletion,
    #[error("project file deletion failed during {stage:?} for project {project_id} at {path}")]
    Persistence {
        stage: DeleteProjectFilePersistenceStage,
        project_id: Uuid,
        path: String,
        #[source]
        source: sqlx::Error,
    },
}

pub(super) async fn delete_project_file(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    command: DeleteProjectFileCommand,
) -> Result<(), DeleteProjectFileError> {
    let mut transaction = db.begin().await.map_err(|source| {
        persistence_error(DeleteProjectFilePersistenceStage::Begin, &command, source)
    })?;
    lock_project_content_exclusively(&mut transaction, command.project_id)
        .await
        .map_err(|source| {
            persistence_error(
                DeleteProjectFilePersistenceStage::LockProjectContent,
                &command,
                source,
            )
        })?;
    let entry_point = find_project_entry_point_in_transaction(&mut transaction, command.project_id)
        .await
        .map_err(|source| {
            persistence_error(
                DeleteProjectFilePersistenceStage::LoadEntryPoint,
                &command,
                source,
            )
        })?;
    if let Some(entry_point) = entry_point {
        if path_is_in_subtree(&entry_point.entry_file_path, &command.path) {
            return Err(DeleteProjectFileError::EntryFileDeletion);
        }
    }
    let deleted =
        files_persistence::delete_subtree(&mut transaction, command.project_id, &command.path)
            .await
            .map_err(|source| {
                persistence_error(DeleteProjectFilePersistenceStage::Delete, &command, source)
            })?;
    if deleted.counts.changed() {
        enqueue_object_deletions(&mut transaction, &deleted.object_keys)
            .await
            .map_err(|source| {
                persistence_error(
                    DeleteProjectFilePersistenceStage::EnqueueDeletedObject,
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
                DeleteProjectFilePersistenceStage::MarkDirty,
                &command,
                source,
            )
        })?;
    }
    transaction.commit().await.map_err(|source| {
        persistence_error(DeleteProjectFilePersistenceStage::Commit, &command, source)
    })?;
    delete_queued_objects_now(db, storage, &deleted.object_keys).await;
    Ok(())
}

fn persistence_error(
    stage: DeleteProjectFilePersistenceStage,
    command: &DeleteProjectFileCommand,
    source: sqlx::Error,
) -> DeleteProjectFileError {
    DeleteProjectFileError::Persistence {
        stage,
        project_id: command.project_id,
        path: command.path.clone(),
        source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    async fn migrated_test_pool() -> Result<Option<PgPool>, Box<dyn std::error::Error + Send + Sync>>
    {
        let database_url =
            std::env::var("TEST_DATABASE_URL").or_else(|_| std::env::var("DATABASE_URL"));
        let Ok(database_url) = database_url else {
            return Ok(None);
        };
        let pool = PgPool::connect(&database_url).await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Some(pool))
    }

    #[tokio::test]
    async fn entry_file_cannot_be_deleted() -> Result<(), Box<dyn std::error::Error + Send + Sync>>
    {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let project_id = Uuid::new_v4();
        let document_id = Uuid::new_v4();
        let now = Utc::now();
        sqlx::query(
            "insert into projects (id, name, created_at, project_type)
             values ($1, 'Entry deletion test', $2, 'typst')",
        )
        .bind(project_id)
        .bind(now)
        .execute(&pool)
        .await?;
        sqlx::query(
            "insert into project_settings (project_id, entry_file_path, updated_at)
             values ($1, 'main.typ', $2)",
        )
        .bind(project_id)
        .bind(now)
        .execute(&pool)
        .await?;
        sqlx::query(
            "insert into documents (id, project_id, path, content, updated_at)
             values ($1, $2, 'main.typ', '= Test', $3)",
        )
        .bind(document_id)
        .bind(project_id)
        .bind(now)
        .execute(&pool)
        .await?;

        let result = delete_project_file(
            &pool,
            None,
            DeleteProjectFileCommand {
                project_id,
                path: "main.typ".to_string(),
                actor_user_id: None,
                guest_display_name: None,
            },
        )
        .await;
        assert!(matches!(
            result,
            Err(DeleteProjectFileError::EntryFileDeletion)
        ));
        let document_exists =
            sqlx::query_scalar::<_, bool>("select exists(select 1 from documents where id = $1)")
                .bind(document_id)
                .fetch_one(&pool)
                .await?;
        assert!(document_exists);

        sqlx::query("delete from projects where id = $1")
            .bind(project_id)
            .execute(&pool)
            .await?;
        Ok(())
    }
}
