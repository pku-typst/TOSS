//! Durable collaboration-update admission and atomic persistence.

use super::persistence::{CollaborationPersistence, CollaborationUpdateWrite, PersistedUpdateKind};
use super::projection::{
    ReconcileCollaborationDocumentError, ReconcileCollaborationDocumentOutcome,
};
use super::{CollaborationContext, CollaborationDocument, WorkspaceChange};
use crate::access::{lock_project_access_epoch, ProjectAccessEpochMatch};
use crate::workspace::{
    lock_project_collaboration_document, lock_project_content_epoch, ProjectContentEpochMatch,
};
use thiserror::Error;
use uuid::Uuid;

impl CollaborationContext {
    pub(super) async fn persist_update(
        &self,
        document: CollaborationDocument,
        user_id: Option<Uuid>,
        kind: PersistedUpdateKind,
        payload: &[u8],
        access_epoch: i64,
        guest_display_name: Option<&str>,
    ) -> Result<PersistUpdateOutcome, PersistUpdateError> {
        let mut transaction = self.db.begin().await.map_err(|source| {
            PersistUpdateError::persistence(PersistUpdateStage::Begin, document.project_id, source)
        })?;
        let epoch_match = lock_project_content_epoch(
            &mut transaction,
            document.project_id,
            document.content_epoch,
        )
        .await
        .map_err(|source| {
            PersistUpdateError::persistence(
                PersistUpdateStage::LockContentEpoch,
                document.project_id,
                source,
            )
        })?;
        if epoch_match != ProjectContentEpochMatch::Current {
            return Ok(PersistUpdateOutcome::ContentEpochChanged);
        }
        let access_epoch_match =
            lock_project_access_epoch(&mut transaction, document.project_id, access_epoch)
                .await
                .map_err(|source| {
                    PersistUpdateError::persistence(
                        PersistUpdateStage::LockAccessEpoch,
                        document.project_id,
                        source,
                    )
                })?;
        match access_epoch_match {
            ProjectAccessEpochMatch::Current => {}
            ProjectAccessEpochMatch::Changed => return Ok(PersistUpdateOutcome::AccessChanged),
            ProjectAccessEpochMatch::ProjectNotFound => {
                return Ok(PersistUpdateOutcome::ContentEpochChanged)
            }
        }
        CollaborationPersistence::lock_document_updates(&mut transaction, document.document_id)
            .await
            .map_err(|source| {
                PersistUpdateError::persistence(
                    PersistUpdateStage::LockDocument,
                    document.project_id,
                    source,
                )
            })?;
        let document_matches = lock_project_collaboration_document(
            &mut transaction,
            document.project_id,
            document.document_id,
            document.collaboration_revision,
        )
        .await
        .map_err(|source| {
            PersistUpdateError::persistence(
                PersistUpdateStage::LockDocumentIdentity,
                document.project_id,
                source,
            )
        })?;
        if !document_matches {
            return Ok(PersistUpdateOutcome::DocumentChanged);
        }
        let update_id = self
            .persistence
            .insert_update(
                &mut transaction,
                &CollaborationUpdateWrite {
                    document,
                    user_id,
                    kind,
                    payload,
                    guest_display_name,
                },
            )
            .await
            .map_err(|source| {
                PersistUpdateError::persistence(
                    PersistUpdateStage::InsertUpdate,
                    document.project_id,
                    source,
                )
            })?;
        let mut projected = false;
        let mut workspace_change = None;
        if kind == PersistedUpdateKind::Sync {
            let state = CollaborationPersistence::load_state(&mut transaction, document)
                .await
                .map_err(|source| {
                    PersistUpdateError::persistence(
                        PersistUpdateStage::LoadCompactionState,
                        document.project_id,
                        source,
                    )
                })?;
            let result = self
                .reconcile_collaboration_document(&mut transaction, document, state, None)
                .await
                .map_err(|source| {
                    PersistUpdateError::reconciliation(document.project_id, source)
                })?;
            match result {
                ReconcileCollaborationDocumentOutcome::Current(compacted) => {
                    projected = true;
                    workspace_change = compacted.workspace_change;
                }
                ReconcileCollaborationDocumentOutcome::ContentEpochChanged => {
                    return Ok(PersistUpdateOutcome::ContentEpochChanged)
                }
                ReconcileCollaborationDocumentOutcome::DocumentChanged => {
                    return Ok(PersistUpdateOutcome::DocumentChanged)
                }
            }
        } else {
            self.persistence
                .prune_updates(&mut transaction, document, update_id)
                .await
                .map_err(|source| {
                    PersistUpdateError::persistence(
                        PersistUpdateStage::PruneUpdates,
                        document.project_id,
                        source,
                    )
                })?;
        }
        transaction.commit().await.map_err(|source| {
            PersistUpdateError::persistence(PersistUpdateStage::Commit, document.project_id, source)
        })?;
        Ok(PersistUpdateOutcome::Accepted(PersistedUpdateAck {
            update_id,
            projected,
            workspace_change,
        }))
    }
}

pub(super) enum PersistUpdateOutcome {
    Accepted(PersistedUpdateAck),
    ContentEpochChanged,
    AccessChanged,
    DocumentChanged,
}

pub(super) struct PersistedUpdateAck {
    pub update_id: i64,
    pub projected: bool,
    pub workspace_change: Option<WorkspaceChange>,
}

#[derive(Clone, Copy, Debug)]
pub(super) enum PersistUpdateStage {
    Begin,
    LockContentEpoch,
    LockAccessEpoch,
    LockDocument,
    LockDocumentIdentity,
    InsertUpdate,
    LoadCompactionState,
    PruneUpdates,
    Commit,
}

#[derive(Debug, Error)]
pub(super) enum PersistUpdateError {
    #[error("collaboration update persistence failed during {stage:?} for project {project_id}")]
    Persistence {
        stage: PersistUpdateStage,
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("collaboration update reconciliation failed for project {project_id}")]
    Reconciliation {
        project_id: Uuid,
        #[source]
        source: ReconcileCollaborationDocumentError,
    },
}

impl PersistUpdateError {
    fn persistence(stage: PersistUpdateStage, project_id: Uuid, source: sqlx::Error) -> Self {
        Self::Persistence {
            stage,
            project_id,
            source,
        }
    }

    fn reconciliation(project_id: Uuid, source: ReconcileCollaborationDocumentError) -> Self {
        Self::Reconciliation { project_id, source }
    }
}

#[cfg(test)]
mod tests {
    use super::{CollaborationDocument, PersistUpdateOutcome, PersistedUpdateKind};
    use crate::collaboration::CollaborationContext;
    use crate::workspace::{
        replace_project_content, ReplaceProjectContent, ReplaceProjectContentResult,
        WorkspaceDocument,
    };
    use chrono::Utc;
    use sqlx::PgPool;
    use std::time::Duration;
    use uuid::Uuid;
    use yrs::updates::decoder::Decode;
    use yrs::{Doc, GetString, ReadTxn, StateVector, Transact, Update};

    fn empty_yjs_update() -> Vec<u8> {
        Doc::new()
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    fn collaboration_document(
        project_id: Uuid,
        document_id: Uuid,
        collaboration_revision: i64,
        content_epoch: i64,
    ) -> CollaborationDocument {
        CollaborationDocument {
            project_id,
            document_id,
            collaboration_revision,
            content_epoch,
        }
    }

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
    async fn workspace_replacement_clears_old_updates_and_rejects_stale_epochs(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let project_id = Uuid::new_v4();
        let document_id = Uuid::new_v4();
        let now = Utc::now();
        sqlx::query(
            "insert into projects (id, name, created_at, project_type)
             values ($1, $2, $3, 'typst')",
        )
        .bind(project_id)
        .bind("Collaboration generation test")
        .bind(now)
        .execute(&pool)
        .await?;
        sqlx::query(
            "insert into documents (id, project_id, path, content, updated_at)
             values ($1, $2, 'main.typ', 'canonical seed', $3)",
        )
        .bind(document_id)
        .bind(project_id)
        .bind(now)
        .execute(&pool)
        .await?;
        let collaboration =
            CollaborationContext::new(pool.clone(), crate::process_lifecycle::DrainSignal::idle());
        let bootstrap = collaboration
            .prepare_document_bootstrap(collaboration_document(project_id, document_id, 0, 0))
            .await?;
        let Some(snapshot) = bootstrap.snapshot_payload else {
            return Err("document bootstrap did not create a canonical snapshot".into());
        };
        let restored = Doc::new();
        restored
            .transact_mut()
            .apply_update(Update::decode_v1(&snapshot)?)?;
        assert_eq!(
            restored
                .get_or_insert_text("main")
                .get_string(&restored.transact()),
            "canonical seed"
        );
        assert!(bootstrap.updates.is_empty());
        let initial_update = empty_yjs_update();
        assert!(matches!(
            collaboration
                .persist_update(
                    collaboration_document(project_id, document_id, 0, 0),
                    None,
                    PersistedUpdateKind::Sync,
                    &initial_update,
                    0,
                    None,
                )
                .await?,
            PersistUpdateOutcome::Accepted(_)
        ));
        let before_replacement = sqlx::query_as::<_, (i64, i64)>(
            "select
               (select count(*) from collab_doc_updates where project_id = $1),
               (select count(*) from collab_doc_latest_snapshots where project_id = $1)",
        )
        .bind(project_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(before_replacement, (1, 1));

        let documents = vec![WorkspaceDocument {
            path: "main.typ".to_string(),
            content: "= Replaced".to_string(),
        }];
        let mut transaction = pool.begin().await?;
        let replaced = replace_project_content(
            &mut transaction,
            &ReplaceProjectContent {
                project_id,
                expected_workspace_version: None,
                documents: &documents,
                assets: &[],
                directories: &[],
                entry_file_path: "main.typ",
                asset_uploaded_by: None,
                updated_at: now,
            },
        )
        .await?;
        let ReplaceProjectContentResult::Replaced(replaced) = replaced else {
            return Err("test project content was not replaced".into());
        };
        let stale_collaboration = collaboration.clone();
        let stale_payload = empty_yjs_update();
        let stale_write = tokio::spawn(async move {
            stale_collaboration
                .persist_update(
                    collaboration_document(project_id, document_id, 0, 0),
                    None,
                    PersistedUpdateKind::Update,
                    &stale_payload,
                    0,
                    None,
                )
                .await
        });
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert!(!stale_write.is_finished());
        collaboration
            .clear_persisted_project(&mut transaction, project_id)
            .await?;
        transaction.commit().await?;
        assert_eq!(replaced.content_epoch, 1);
        let replacement_document_id = sqlx::query_scalar::<_, Uuid>(
            "select id from documents where project_id = $1 and path = 'main.typ'",
        )
        .bind(project_id)
        .fetch_one(&pool)
        .await?;

        assert!(matches!(
            stale_write.await??,
            PersistUpdateOutcome::ContentEpochChanged
        ));
        let after_stale_update = sqlx::query_as::<_, (i64, i64)>(
            "select
               (select count(*) from collab_doc_updates where project_id = $1),
               (select count(*) from collab_doc_latest_snapshots where project_id = $1)",
        )
        .bind(project_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(after_stale_update, (0, 0));
        let current_payload = empty_yjs_update();
        assert!(matches!(
            collaboration
                .persist_update(
                    collaboration_document(
                        project_id,
                        replacement_document_id,
                        0,
                        replaced.content_epoch,
                    ),
                    None,
                    PersistedUpdateKind::Update,
                    &current_payload,
                    0,
                    None,
                )
                .await?,
            PersistUpdateOutcome::Accepted(_)
        ));
        let current_epochs = sqlx::query_scalar::<_, i64>(
            "select count(*)
             from collab_doc_updates
             where project_id = $1 and content_epoch = $2",
        )
        .bind(project_id)
        .bind(replaced.content_epoch)
        .fetch_one(&pool)
        .await?;
        assert_eq!(current_epochs, 1);

        sqlx::query(
            "update documents
             set collaboration_revision = collaboration_revision + 1
             where id = $1",
        )
        .bind(replacement_document_id)
        .execute(&pool)
        .await?;
        let replacement_bootstrap = collaboration
            .prepare_document_bootstrap(collaboration_document(
                project_id,
                replacement_document_id,
                1,
                replaced.content_epoch,
            ))
            .await?;
        assert!(replacement_bootstrap.snapshot_payload.is_some());
        let superseded_state = sqlx::query_as::<_, (i64, i64)>(
            "select
               (select count(*) from collab_doc_updates where project_id = $1),
               (select count(*) from collab_doc_latest_snapshots
                where project_id = $1 and collaboration_revision = 0)",
        )
        .bind(project_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(superseded_state, (0, 0));
        let stale_document_payload = empty_yjs_update();
        assert!(matches!(
            collaboration
                .persist_update(
                    collaboration_document(
                        project_id,
                        replacement_document_id,
                        0,
                        replaced.content_epoch,
                    ),
                    None,
                    PersistedUpdateKind::Update,
                    &stale_document_payload,
                    0,
                    None,
                )
                .await?,
            PersistUpdateOutcome::DocumentChanged
        ));

        sqlx::query("update projects set access_epoch = access_epoch + 1 where id = $1")
            .bind(project_id)
            .execute(&pool)
            .await?;
        let stale_access_payload = empty_yjs_update();
        assert!(matches!(
            collaboration
                .persist_update(
                    collaboration_document(
                        project_id,
                        replacement_document_id,
                        1,
                        replaced.content_epoch,
                    ),
                    None,
                    PersistedUpdateKind::Update,
                    &stale_access_payload,
                    0,
                    None,
                )
                .await?,
            PersistUpdateOutcome::AccessChanged
        ));
        let after_access_change = sqlx::query_scalar::<_, i64>(
            "select count(*) from collab_doc_updates where project_id = $1",
        )
        .bind(project_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(after_access_change, 0);

        sqlx::query("delete from documents where id = $1")
            .bind(replacement_document_id)
            .execute(&pool)
            .await?;
        let collaboration_after_document_delete = sqlx::query_as::<_, (i64, i64)>(
            "select
               (select count(*) from collab_doc_updates where project_id = $1),
               (select count(*) from collab_doc_latest_snapshots where project_id = $1)",
        )
        .bind(project_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(collaboration_after_document_delete, (0, 0));

        sqlx::query("delete from projects where id = $1")
            .bind(project_id)
            .execute(&pool)
            .await?;
        Ok(())
    }
}
