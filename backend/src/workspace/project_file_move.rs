//! Workspace project-file and directory subtree moves.

use super::file_policy::move_path_with_subtree;
use super::project_entry_point::find_project_entry_point_in_transaction;
use super::{
    files_persistence, lock_project_content_exclusively, mark_project_dirty, settings_persistence,
};
use chrono::Utc;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

pub(super) struct MoveProjectFileCommand {
    pub project_id: Uuid,
    pub from_path: String,
    pub to_path: String,
    pub actor_user_id: Option<Uuid>,
    pub guest_display_name: Option<String>,
}

#[derive(Clone, Copy, Debug)]
pub(super) enum MoveProjectFilePersistenceStage {
    Begin,
    LockProjectContent,
    LoadEntryPoint,
    Move,
    UpdateEntrySettings,
    MarkDirty,
    Commit,
}

#[derive(Debug, Error)]
pub(super) enum MoveProjectFileError {
    #[error("a project file already exists at the destination path")]
    PathConflict,
    #[error("the moved entry file does not apply to this project type")]
    EntryFileTypeMismatch,
    #[error(
        "project file move failed during {stage:?} for project {project_id}, from {from_path} to {to_path}"
    )]
    Persistence {
        stage: MoveProjectFilePersistenceStage,
        project_id: Uuid,
        from_path: String,
        to_path: String,
        #[source]
        source: sqlx::Error,
    },
}

pub(super) async fn move_project_file(
    db: &PgPool,
    command: MoveProjectFileCommand,
) -> Result<(), MoveProjectFileError> {
    let mut transaction = db.begin().await.map_err(|source| {
        persistence_error(MoveProjectFilePersistenceStage::Begin, &command, source)
    })?;
    lock_project_content_exclusively(&mut transaction, command.project_id)
        .await
        .map_err(|source| {
            persistence_error(
                MoveProjectFilePersistenceStage::LockProjectContent,
                &command,
                source,
            )
        })?;
    let entry_point = find_project_entry_point_in_transaction(&mut transaction, command.project_id)
        .await
        .map_err(|source| {
            persistence_error(
                MoveProjectFilePersistenceStage::LoadEntryPoint,
                &command,
                source,
            )
        })?;
    let moved_entry = entry_point.as_ref().and_then(|entry_point| {
        move_path_with_subtree(
            &entry_point.entry_file_path,
            &command.from_path,
            &command.to_path,
        )
    });
    if let (Some(entry_point), Some(moved_entry)) = (&entry_point, &moved_entry) {
        if !entry_point
            .project_type
            .accepts_entry_file_path(moved_entry)
        {
            return Err(MoveProjectFileError::EntryFileTypeMismatch);
        }
    }
    let now = Utc::now();
    let counts = files_persistence::move_subtree(
        &mut transaction,
        command.project_id,
        &command.from_path,
        &command.to_path,
        now,
    )
    .await
    .map_err(|source| {
        if files_persistence::is_project_path_conflict(&source) {
            MoveProjectFileError::PathConflict
        } else {
            persistence_error(MoveProjectFilePersistenceStage::Move, &command, source)
        }
    })?;
    if counts.changed() {
        if let (Some(entry_point), Some(moved_entry)) = (entry_point, moved_entry) {
            settings_persistence::ensure(
                &mut transaction,
                command.project_id,
                entry_point.project_type.default_entry_file_path(),
                entry_point.project_type.default_latex_engine(),
                now,
            )
            .await
            .map_err(|source| {
                persistence_error(
                    MoveProjectFilePersistenceStage::UpdateEntrySettings,
                    &command,
                    source,
                )
            })?;
            settings_persistence::update_entry_file_path(
                &mut transaction,
                command.project_id,
                &moved_entry,
                now,
            )
            .await
            .map_err(|source| {
                persistence_error(
                    MoveProjectFilePersistenceStage::UpdateEntrySettings,
                    &command,
                    source,
                )
            })?;
        }
        mark_project_dirty(
            &mut transaction,
            command.project_id,
            command.actor_user_id,
            command.guest_display_name.as_deref(),
        )
        .await
        .map_err(|source| {
            persistence_error(MoveProjectFilePersistenceStage::MarkDirty, &command, source)
        })?;
    }
    transaction.commit().await.map_err(|source| {
        persistence_error(MoveProjectFilePersistenceStage::Commit, &command, source)
    })?;
    Ok(())
}

fn persistence_error(
    stage: MoveProjectFilePersistenceStage,
    command: &MoveProjectFileCommand,
    source: sqlx::Error,
) -> MoveProjectFileError {
    MoveProjectFileError::Persistence {
        stage,
        project_id: command.project_id,
        from_path: command.from_path.clone(),
        to_path: command.to_path.clone(),
        source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use sqlx::Row;
    use std::time::Duration;

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
    async fn project_lock_precedes_document_lock(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let project_id = Uuid::new_v4();
        let document_id = Uuid::new_v4();
        let now = Utc::now();
        sqlx::query(
            "insert into projects (id, name, created_at, project_type)
             values ($1, 'Lock ordering test', $2, 'typst')",
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

        let mut replacement = pool.begin().await?;
        sqlx::query("select id from projects where id = $1 for update")
            .bind(project_id)
            .execute(&mut *replacement)
            .await?;

        let mover_pool = pool.clone();
        let mover = tokio::spawn(async move {
            move_project_file(
                &mover_pool,
                MoveProjectFileCommand {
                    project_id,
                    from_path: "main.typ".to_string(),
                    to_path: "renamed.typ".to_string(),
                    actor_user_id: None,
                    guest_display_name: None,
                },
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert!(!mover.is_finished());

        sqlx::query("select id from documents where id = $1 for update nowait")
            .bind(document_id)
            .execute(&mut *replacement)
            .await?;
        replacement.rollback().await?;

        let move_result = tokio::time::timeout(Duration::from_secs(2), mover).await?;
        move_result??;
        let path = sqlx::query_scalar::<_, String>("select path from documents where id = $1")
            .bind(document_id)
            .fetch_one(&pool)
            .await?;
        assert_eq!(path, "renamed.typ");
        let settings = sqlx::query(
            "select entry_file_path, settings_revision
             from project_settings where project_id = $1",
        )
        .bind(project_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(settings.get::<String, _>("entry_file_path"), "renamed.typ");
        assert_eq!(settings.get::<i64, _>("settings_revision"), 1);

        sqlx::query("delete from projects where id = $1")
            .bind(project_id)
            .execute(&pool)
            .await?;
        Ok(())
    }
}
