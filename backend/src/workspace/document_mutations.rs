//! Transactional Workspace document mutations.

use super::documents::document_from_record;
use super::project_entry_point::find_project_entry_point_in_transaction;
use super::{
    documents_persistence, lock_project_content_epoch, lock_project_content_exclusively,
    lock_project_content_mutation, mark_project_dirty, Document, ProjectContentEpochMatch,
};
use crate::database_error::is_unique_constraint_violation;
use chrono::Utc;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

const DOCUMENT_PATH_CONSTRAINT: &str = "documents_project_id_path_key";

#[derive(Clone, Copy, Debug)]
enum DocumentMutationPersistenceStage {
    Begin,
    Insert,
    LockContentGeneration,
    LockProjectContent,
    LoadEntryPoint,
    FindDocument,
    LockContentEpoch,
    Upsert,
    Update,
    Delete,
    MarkProjectDirty,
    Commit,
}

#[derive(Debug, Error)]
#[error(
    "document mutation failed during {stage:?} for project {project_id} and document {document_id}"
)]
pub(super) struct DocumentMutationPersistenceError {
    stage: DocumentMutationPersistenceStage,
    project_id: Uuid,
    document_id: Uuid,
    #[source]
    source: sqlx::Error,
}

impl DocumentMutationPersistenceError {
    fn new(
        stage: DocumentMutationPersistenceStage,
        project_id: Uuid,
        document_id: Uuid,
        source: sqlx::Error,
    ) -> Self {
        Self {
            stage,
            project_id,
            document_id,
            source,
        }
    }
}

#[derive(Debug, Error)]
pub(super) enum CreateDocumentError {
    #[error("a project file already exists at this path")]
    PathConflict,
    #[error(transparent)]
    Persistence(#[from] DocumentMutationPersistenceError),
}

#[derive(Debug, Error)]
pub(super) enum UpsertDocumentByPathError {
    #[error("project was not found")]
    ProjectNotFound,
    #[error("project content changed")]
    ContentEpochChanged,
    #[error("a project file already exists at this path")]
    PathConflict,
    #[error(transparent)]
    Persistence(#[from] DocumentMutationPersistenceError),
}

#[derive(Debug, Error)]
pub(super) enum UpdateDocumentError {
    #[error("project was not found")]
    ProjectNotFound,
    #[error("project content changed")]
    ContentEpochChanged,
    #[error("document was not found")]
    DocumentNotFound,
    #[error("document identity revision changed")]
    DocumentRevisionChanged,
    #[error(transparent)]
    Persistence(#[from] DocumentMutationPersistenceError),
}

#[derive(Debug, Error)]
pub(super) enum DeleteDocumentError {
    #[error("document was not found")]
    DocumentNotFound,
    #[error("the project entry file cannot be deleted")]
    EntryFileDeletion,
    #[error(transparent)]
    Persistence(#[from] DocumentMutationPersistenceError),
}

pub(super) struct CreateDocumentCommand {
    pub project_id: Uuid,
    pub path: String,
    pub content: String,
    pub actor_user_id: Option<Uuid>,
    pub guest_display_name: Option<String>,
}

pub(super) async fn create_document(
    db: &PgPool,
    command: CreateDocumentCommand,
) -> Result<Document, CreateDocumentError> {
    let document_id = Uuid::new_v4();
    let mut transaction = begin_document_transaction(db, command.project_id, document_id).await?;
    lock_project_content_mutation(&mut transaction, command.project_id)
        .await
        .map_err(|source| {
            DocumentMutationPersistenceError::new(
                DocumentMutationPersistenceStage::LockContentGeneration,
                command.project_id,
                document_id,
                source,
            )
        })?;
    let record = documents_persistence::insert(
        &mut transaction,
        document_id,
        command.project_id,
        &command.path,
        &command.content,
        Utc::now(),
    )
    .await
    .map_err(|source| {
        if is_unique_constraint_violation(&source, DOCUMENT_PATH_CONSTRAINT) {
            CreateDocumentError::PathConflict
        } else {
            DocumentMutationPersistenceError::new(
                DocumentMutationPersistenceStage::Insert,
                command.project_id,
                document_id,
                source,
            )
            .into()
        }
    })?;
    mark_dirty(
        &mut transaction,
        command.project_id,
        command.actor_user_id,
        command.guest_display_name.as_deref(),
        document_id,
    )
    .await?;
    commit_document_transaction(transaction, command.project_id, document_id).await?;
    Ok(document_from_record(record))
}

pub(super) struct UpsertDocumentByPathCommand {
    pub project_id: Uuid,
    pub path: String,
    pub content: String,
    pub expected_content_epoch: i64,
    pub actor_user_id: Option<Uuid>,
    pub guest_display_name: Option<String>,
}

pub(super) async fn upsert_document_by_path(
    db: &PgPool,
    command: UpsertDocumentByPathCommand,
) -> Result<Document, UpsertDocumentByPathError> {
    let document_id = Uuid::new_v4();
    let mut transaction = begin_document_transaction(db, command.project_id, document_id).await?;
    match lock_content_epoch(
        &mut transaction,
        command.project_id,
        document_id,
        command.expected_content_epoch,
    )
    .await?
    {
        ProjectContentEpochMatch::Current => {}
        ProjectContentEpochMatch::Changed => {
            return Err(UpsertDocumentByPathError::ContentEpochChanged)
        }
        ProjectContentEpochMatch::ProjectNotFound => {
            return Err(UpsertDocumentByPathError::ProjectNotFound)
        }
    }
    let record = documents_persistence::upsert_by_path(
        &mut transaction,
        document_id,
        command.project_id,
        &command.path,
        &command.content,
        Utc::now(),
    )
    .await
    .map_err(|source| {
        if is_unique_constraint_violation(&source, DOCUMENT_PATH_CONSTRAINT) {
            UpsertDocumentByPathError::PathConflict
        } else {
            DocumentMutationPersistenceError::new(
                DocumentMutationPersistenceStage::Upsert,
                command.project_id,
                document_id,
                source,
            )
            .into()
        }
    })?;
    mark_dirty(
        &mut transaction,
        command.project_id,
        command.actor_user_id,
        command.guest_display_name.as_deref(),
        document_id,
    )
    .await?;
    commit_document_transaction(transaction, command.project_id, document_id).await?;
    Ok(document_from_record(record))
}

pub(super) struct UpdateDocumentCommand {
    pub project_id: Uuid,
    pub document_id: Uuid,
    pub expected_content_epoch: i64,
    pub expected_path_revision: i64,
    pub expected_collaboration_revision: i64,
    pub content: String,
    pub actor_user_id: Option<Uuid>,
    pub guest_display_name: Option<String>,
}

pub(super) async fn update_document(
    db: &PgPool,
    command: UpdateDocumentCommand,
) -> Result<Document, UpdateDocumentError> {
    let mut transaction =
        begin_document_transaction(db, command.project_id, command.document_id).await?;
    match lock_content_epoch(
        &mut transaction,
        command.project_id,
        command.document_id,
        command.expected_content_epoch,
    )
    .await?
    {
        ProjectContentEpochMatch::Current => {}
        ProjectContentEpochMatch::Changed => return Err(UpdateDocumentError::ContentEpochChanged),
        ProjectContentEpochMatch::ProjectNotFound => {
            return Err(UpdateDocumentError::ProjectNotFound)
        }
    }
    let record = documents_persistence::update_content(
        &mut transaction,
        command.project_id,
        command.document_id,
        command.expected_path_revision,
        command.expected_collaboration_revision,
        &command.content,
        Utc::now(),
    )
    .await
    .map_err(|source| {
        DocumentMutationPersistenceError::new(
            DocumentMutationPersistenceStage::Update,
            command.project_id,
            command.document_id,
            source,
        )
    })?;
    let record = match record {
        Some(record) => record,
        None => {
            let current_revisions = documents_persistence::revisions_by_id(
                &mut transaction,
                command.project_id,
                command.document_id,
            )
            .await
            .map_err(|source| {
                DocumentMutationPersistenceError::new(
                    DocumentMutationPersistenceStage::Update,
                    command.project_id,
                    command.document_id,
                    source,
                )
            })?;
            return Err(if current_revisions.is_some() {
                UpdateDocumentError::DocumentRevisionChanged
            } else {
                UpdateDocumentError::DocumentNotFound
            });
        }
    };
    mark_dirty(
        &mut transaction,
        command.project_id,
        command.actor_user_id,
        command.guest_display_name.as_deref(),
        command.document_id,
    )
    .await?;
    commit_document_transaction(transaction, command.project_id, command.document_id).await?;
    Ok(document_from_record(record))
}

pub(super) struct DeleteDocumentCommand {
    pub project_id: Uuid,
    pub document_id: Uuid,
    pub actor_user_id: Option<Uuid>,
    pub guest_display_name: Option<String>,
}

pub(super) async fn delete_document(
    db: &PgPool,
    command: DeleteDocumentCommand,
) -> Result<(), DeleteDocumentError> {
    let mut transaction =
        begin_document_transaction(db, command.project_id, command.document_id).await?;
    lock_project_content_exclusively(&mut transaction, command.project_id)
        .await
        .map_err(|source| {
            DocumentMutationPersistenceError::new(
                DocumentMutationPersistenceStage::LockProjectContent,
                command.project_id,
                command.document_id,
                source,
            )
        })?;
    let entry_point = find_project_entry_point_in_transaction(&mut transaction, command.project_id)
        .await
        .map_err(|source| {
            DocumentMutationPersistenceError::new(
                DocumentMutationPersistenceStage::LoadEntryPoint,
                command.project_id,
                command.document_id,
                source,
            )
        })?;
    let document_path = documents_persistence::find_path_by_id_in_transaction(
        &mut transaction,
        command.project_id,
        command.document_id,
    )
    .await
    .map_err(|source| {
        DocumentMutationPersistenceError::new(
            DocumentMutationPersistenceStage::FindDocument,
            command.project_id,
            command.document_id,
            source,
        )
    })?
    .ok_or(DeleteDocumentError::DocumentNotFound)?;
    if entry_point.is_some_and(|entry_point| entry_point.entry_file_path == document_path) {
        return Err(DeleteDocumentError::EntryFileDeletion);
    }
    let deleted = documents_persistence::delete_by_id(
        &mut transaction,
        command.project_id,
        command.document_id,
    )
    .await
    .map_err(|source| {
        DocumentMutationPersistenceError::new(
            DocumentMutationPersistenceStage::Delete,
            command.project_id,
            command.document_id,
            source,
        )
    })?;
    if deleted == 0 {
        return Err(DeleteDocumentError::DocumentNotFound);
    }
    mark_dirty(
        &mut transaction,
        command.project_id,
        command.actor_user_id,
        command.guest_display_name.as_deref(),
        command.document_id,
    )
    .await?;
    commit_document_transaction(transaction, command.project_id, command.document_id).await?;
    Ok(())
}

async fn begin_document_transaction(
    db: &PgPool,
    project_id: Uuid,
    document_id: Uuid,
) -> Result<sqlx::Transaction<'_, sqlx::Postgres>, DocumentMutationPersistenceError> {
    db.begin().await.map_err(|source| {
        DocumentMutationPersistenceError::new(
            DocumentMutationPersistenceStage::Begin,
            project_id,
            document_id,
            source,
        )
    })
}

async fn lock_content_epoch(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    project_id: Uuid,
    document_id: Uuid,
    expected_content_epoch: i64,
) -> Result<ProjectContentEpochMatch, DocumentMutationPersistenceError> {
    lock_project_content_epoch(transaction, project_id, expected_content_epoch)
        .await
        .map_err(|source| {
            DocumentMutationPersistenceError::new(
                DocumentMutationPersistenceStage::LockContentEpoch,
                project_id,
                document_id,
                source,
            )
        })
}

async fn mark_dirty(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    project_id: Uuid,
    actor_user_id: Option<Uuid>,
    guest_display_name: Option<&str>,
    document_id: Uuid,
) -> Result<(), DocumentMutationPersistenceError> {
    mark_project_dirty(transaction, project_id, actor_user_id, guest_display_name)
        .await
        .map_err(|source| {
            DocumentMutationPersistenceError::new(
                DocumentMutationPersistenceStage::MarkProjectDirty,
                project_id,
                document_id,
                source,
            )
        })
}

async fn commit_document_transaction(
    transaction: sqlx::Transaction<'_, sqlx::Postgres>,
    project_id: Uuid,
    document_id: Uuid,
) -> Result<(), DocumentMutationPersistenceError> {
    transaction.commit().await.map_err(|source| {
        DocumentMutationPersistenceError::new(
            DocumentMutationPersistenceStage::Commit,
            project_id,
            document_id,
            source,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::files_persistence;
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
    async fn stale_save_cannot_cross_a_move_or_recreate_a_deleted_document(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let project_id = Uuid::new_v4();
        let document_id = Uuid::new_v4();
        let now = Utc::now();
        sqlx::query(
            "insert into projects (id, name, created_at, project_type)
             values ($1, 'Document CAS test', $2, 'typst')",
        )
        .bind(project_id)
        .bind(now)
        .execute(&pool)
        .await?;
        sqlx::query(
            "insert into documents (id, project_id, path, content, updated_at)
             values ($1, $2, 'main.typ', 'initial', $3)",
        )
        .bind(document_id)
        .bind(project_id)
        .bind(now)
        .execute(&pool)
        .await?;

        let entry_delete = delete_document(
            &pool,
            DeleteDocumentCommand {
                project_id,
                document_id,
                actor_user_id: None,
                guest_display_name: None,
            },
        )
        .await;
        assert!(matches!(
            entry_delete,
            Err(DeleteDocumentError::EntryFileDeletion)
        ));

        let saved = update_document(
            &pool,
            UpdateDocumentCommand {
                project_id,
                document_id,
                expected_content_epoch: 0,
                expected_path_revision: 0,
                expected_collaboration_revision: 0,
                content: "saved before move".to_string(),
                actor_user_id: None,
                guest_display_name: None,
            },
        )
        .await?;
        assert_eq!(saved.path, "main.typ");

        let mut move_transaction = pool.begin().await?;
        let moved = files_persistence::move_subtree(
            &mut move_transaction,
            project_id,
            "main.typ",
            "renamed.typ",
            Utc::now(),
        )
        .await?;
        assert_eq!(moved.documents, 1);
        move_transaction.commit().await?;

        let stale_after_move = update_document(
            &pool,
            UpdateDocumentCommand {
                project_id,
                document_id,
                expected_content_epoch: 0,
                expected_path_revision: 0,
                expected_collaboration_revision: 0,
                content: "stale after move".to_string(),
                actor_user_id: None,
                guest_display_name: None,
            },
        )
        .await;
        assert!(matches!(
            stale_after_move,
            Err(UpdateDocumentError::DocumentRevisionChanged)
        ));
        let stored = sqlx::query_as::<_, (String, String, i64)>(
            "select path, content, path_revision from documents where id = $1",
        )
        .bind(document_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(
            stored,
            (
                "renamed.typ".to_string(),
                "saved before move".to_string(),
                1
            )
        );

        let mut overwrite_transaction = pool.begin().await?;
        let overwritten = documents_persistence::upsert_by_path(
            &mut overwrite_transaction,
            Uuid::new_v4(),
            project_id,
            "renamed.typ",
            "authoritative overwrite",
            Utc::now(),
        )
        .await?;
        overwrite_transaction.commit().await?;
        assert_eq!(overwritten.id, document_id);
        assert_eq!(overwritten.collaboration_revision, 2);
        let stale_after_overwrite = update_document(
            &pool,
            UpdateDocumentCommand {
                project_id,
                document_id,
                expected_content_epoch: 0,
                expected_path_revision: 1,
                expected_collaboration_revision: 0,
                content: "stale after overwrite".to_string(),
                actor_user_id: None,
                guest_display_name: None,
            },
        )
        .await;
        assert!(matches!(
            stale_after_overwrite,
            Err(UpdateDocumentError::DocumentRevisionChanged)
        ));
        let content_after_overwrite =
            sqlx::query_scalar::<_, String>("select content from documents where id = $1")
                .bind(document_id)
                .fetch_one(&pool)
                .await?;
        assert_eq!(content_after_overwrite, "authoritative overwrite");

        sqlx::query("delete from documents where id = $1")
            .bind(document_id)
            .execute(&pool)
            .await?;
        let stale_after_delete = update_document(
            &pool,
            UpdateDocumentCommand {
                project_id,
                document_id,
                expected_content_epoch: 0,
                expected_path_revision: 1,
                expected_collaboration_revision: 0,
                content: "stale after delete".to_string(),
                actor_user_id: None,
                guest_display_name: None,
            },
        )
        .await;
        assert!(matches!(
            stale_after_delete,
            Err(UpdateDocumentError::DocumentNotFound)
        ));
        let recreated =
            sqlx::query_scalar::<_, i64>("select count(*) from documents where project_id = $1")
                .bind(project_id)
                .fetch_one(&pool)
                .await?;
        assert_eq!(recreated, 0);
        sqlx::query("delete from projects where id = $1")
            .bind(project_id)
            .execute(&pool)
            .await?;
        Ok(())
    }
}
