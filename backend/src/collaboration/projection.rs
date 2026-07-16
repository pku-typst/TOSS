//! Durable CRDT compaction and the Workspace text projection barrier.

use super::persistence::{BootstrapState, CollaborationPersistence, PersistedUpdateContributor};
use super::yjs_state::{merge_updates, MergedYjsState, YjsStateError};
use super::{CollaborationContext, CollaborationDocument, WorkspaceChange};
use crate::workspace::{
    project_collaboration_document, CollaborationContributor, CollaborationProjectionError,
    CollaborationProjectionOutcome, ProjectCollaborationDocument,
};
use sqlx::PgConnection;
use std::time::Duration;
use thiserror::Error;
use tracing::warn;
use uuid::Uuid;

const PROJECTION_BATCH_SIZE: usize = 64;
const PROJECTION_POLL_INTERVAL: Duration = Duration::from_millis(250);

pub(super) struct ReconciledCollaborationDocument {
    pub snapshot_payload: Vec<u8>,
    pub upto_update_id: i64,
    pub workspace_change: Option<WorkspaceChange>,
}

pub(super) enum ReconcileCollaborationDocumentOutcome {
    Current(ReconciledCollaborationDocument),
    ContentEpochChanged,
    DocumentChanged,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum ReconcileCollaborationDocumentStage {
    Begin,
    LockContentEpoch,
    LockDocument,
    LoadState,
    ClearDocumentRevision,
    UpsertSnapshot,
    PruneUpdates,
    Commit,
}

#[derive(Debug, Error)]
pub(crate) enum ReconcileCollaborationDocumentError {
    #[error("collaboration state merge failed for project {project_id}")]
    Merge {
        project_id: Uuid,
        #[source]
        source: YjsStateError,
    },
    #[error("Workspace projection failed for project {project_id}")]
    Projection {
        project_id: Uuid,
        #[source]
        source: CollaborationProjectionError,
    },
    #[error(
        "collaboration projection persistence failed during {stage:?} for project {project_id}"
    )]
    Persistence {
        stage: ReconcileCollaborationDocumentStage,
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

impl ReconcileCollaborationDocumentError {
    fn persistence(
        stage: ReconcileCollaborationDocumentStage,
        project_id: Uuid,
        source: sqlx::Error,
    ) -> Self {
        Self::Persistence {
            stage,
            project_id,
            source,
        }
    }
}

fn contributors(state: &BootstrapState) -> Vec<CollaborationContributor> {
    state
        .contributors
        .iter()
        .map(|contributor| match contributor {
            PersistedUpdateContributor::User(user_id) => CollaborationContributor::User(*user_id),
            PersistedUpdateContributor::Guest(display_name) => {
                CollaborationContributor::Guest(display_name.clone())
            }
        })
        .collect()
}

impl CollaborationContext {
    pub(super) async fn reconcile_collaboration_document(
        &self,
        connection: &mut PgConnection,
        document: CollaborationDocument,
        state: BootstrapState,
        canonical_seed: Option<&[u8]>,
    ) -> Result<ReconcileCollaborationDocumentOutcome, ReconcileCollaborationDocumentError> {
        let MergedYjsState { update, text } = merge_updates(
            state.snapshot_payload.as_deref().or(canonical_seed),
            state.updates.iter().map(|(_, payload)| payload.as_slice()),
        )
        .map_err(|source| ReconcileCollaborationDocumentError::Merge {
            project_id: document.project_id,
            source,
        })?;
        let contributors = contributors(&state);
        let projection = project_collaboration_document(
            connection,
            &ProjectCollaborationDocument {
                project_id: document.project_id,
                document_id: document.document_id,
                collaboration_revision: document.collaboration_revision,
                content_epoch: document.content_epoch,
                text: &text,
                contributors: &contributors,
            },
        )
        .await
        .map_err(|source| ReconcileCollaborationDocumentError::Projection {
            project_id: document.project_id,
            source,
        })?;
        let workspace_change = match projection {
            CollaborationProjectionOutcome::Projected(projected) => {
                Some(WorkspaceChange::Document {
                    path: projected.path,
                    document_id: projected.document_id,
                    collaboration_revision: projected.collaboration_revision,
                    change_sequence: projected.change_sequence,
                })
            }
            CollaborationProjectionOutcome::Unchanged => None,
            CollaborationProjectionOutcome::ContentEpochChanged => {
                return Ok(ReconcileCollaborationDocumentOutcome::ContentEpochChanged)
            }
            CollaborationProjectionOutcome::DocumentChanged => {
                CollaborationPersistence::clear_document_revision(connection, document)
                    .await
                    .map_err(|source| {
                        ReconcileCollaborationDocumentError::persistence(
                            ReconcileCollaborationDocumentStage::ClearDocumentRevision,
                            document.project_id,
                            source,
                        )
                    })?;
                return Ok(ReconcileCollaborationDocumentOutcome::DocumentChanged);
            }
        };
        self.persistence
            .upsert_snapshot(connection, document, state.upto_update_id, &update)
            .await
            .map_err(|source| {
                ReconcileCollaborationDocumentError::persistence(
                    ReconcileCollaborationDocumentStage::UpsertSnapshot,
                    document.project_id,
                    source,
                )
            })?;
        self.persistence
            .prune_updates(connection, document, state.upto_update_id)
            .await
            .map_err(|source| {
                ReconcileCollaborationDocumentError::persistence(
                    ReconcileCollaborationDocumentStage::PruneUpdates,
                    document.project_id,
                    source,
                )
            })?;
        Ok(ReconcileCollaborationDocumentOutcome::Current(
            ReconciledCollaborationDocument {
                snapshot_payload: update,
                upto_update_id: state.upto_update_id,
                workspace_change,
            },
        ))
    }

    async fn reconcile_pending_document(
        &self,
        document: CollaborationDocument,
    ) -> Result<ReconcileCollaborationDocumentOutcome, ReconcileCollaborationDocumentError> {
        let mut transaction = self.db.begin().await.map_err(|source| {
            ReconcileCollaborationDocumentError::persistence(
                ReconcileCollaborationDocumentStage::Begin,
                document.project_id,
                source,
            )
        })?;
        let epoch = crate::workspace::lock_project_content_epoch(
            &mut transaction,
            document.project_id,
            document.content_epoch,
        )
        .await
        .map_err(|source| {
            ReconcileCollaborationDocumentError::persistence(
                ReconcileCollaborationDocumentStage::LockContentEpoch,
                document.project_id,
                source,
            )
        })?;
        if epoch != crate::workspace::ProjectContentEpochMatch::Current {
            return Ok(ReconcileCollaborationDocumentOutcome::ContentEpochChanged);
        }
        CollaborationPersistence::lock_document_updates(&mut transaction, document.document_id)
            .await
            .map_err(|source| {
                ReconcileCollaborationDocumentError::persistence(
                    ReconcileCollaborationDocumentStage::LockDocument,
                    document.project_id,
                    source,
                )
            })?;
        let state = CollaborationPersistence::load_state(&mut transaction, document)
            .await
            .map_err(|source| {
                ReconcileCollaborationDocumentError::persistence(
                    ReconcileCollaborationDocumentStage::LoadState,
                    document.project_id,
                    source,
                )
            })?;
        let result = self
            .reconcile_collaboration_document(&mut transaction, document, state, None)
            .await?;
        transaction.commit().await.map_err(|source| {
            ReconcileCollaborationDocumentError::persistence(
                ReconcileCollaborationDocumentStage::Commit,
                document.project_id,
                source,
            )
        })?;
        Ok(result)
    }

    pub(crate) async fn flush_project_collaboration(
        &self,
        project_id: Uuid,
    ) -> Result<(), FlushProjectCollaborationError> {
        let Some(target_update_id) = self
            .persistence
            .latest_project_update_id(project_id)
            .await
            .map_err(|source| FlushProjectCollaborationError::LoadTarget { project_id, source })?
        else {
            return Ok(());
        };
        let documents = self
            .persistence
            .pending_project_documents(project_id, target_update_id)
            .await
            .map_err(|source| FlushProjectCollaborationError::LoadDocuments {
                project_id,
                source,
            })?;
        for document in documents {
            let result = self
                .reconcile_pending_document(document)
                .await
                .map_err(|source| FlushProjectCollaborationError::Project { project_id, source })?;
            if let ReconcileCollaborationDocumentOutcome::Current(compacted) = result {
                if let Some(change) = compacted.workspace_change {
                    self.workspace_changed(project_id, change).await;
                }
            }
        }
        Ok(())
    }

    pub(crate) async fn flush_project_collaboration_for_capture(
        &self,
        connection: &mut PgConnection,
        project_id: Uuid,
    ) -> Result<Vec<WorkspaceChange>, FlushProjectCollaborationError> {
        let Some(target_update_id) =
            CollaborationPersistence::latest_project_update_id_in_transaction(
                connection, project_id,
            )
            .await
            .map_err(|source| FlushProjectCollaborationError::LoadTarget { project_id, source })?
        else {
            return Ok(Vec::new());
        };
        let documents = CollaborationPersistence::pending_project_documents_in_transaction(
            connection,
            project_id,
            target_update_id,
        )
        .await
        .map_err(|source| FlushProjectCollaborationError::LoadDocuments { project_id, source })?;
        let mut changes = Vec::new();
        for document in documents {
            CollaborationPersistence::lock_document_updates(connection, document.document_id)
                .await
                .map_err(|source| FlushProjectCollaborationError::Project {
                    project_id,
                    source: ReconcileCollaborationDocumentError::persistence(
                        ReconcileCollaborationDocumentStage::LockDocument,
                        project_id,
                        source,
                    ),
                })?;
            let state = CollaborationPersistence::load_state(connection, document)
                .await
                .map_err(|source| FlushProjectCollaborationError::Project {
                    project_id,
                    source: ReconcileCollaborationDocumentError::persistence(
                        ReconcileCollaborationDocumentStage::LoadState,
                        project_id,
                        source,
                    ),
                })?;
            let result = self
                .reconcile_collaboration_document(connection, document, state, None)
                .await
                .map_err(|source| FlushProjectCollaborationError::Project { project_id, source })?;
            if let ReconcileCollaborationDocumentOutcome::Current(compacted) = result {
                if let Some(change) = compacted.workspace_change {
                    changes.push(change);
                }
            }
        }
        Ok(changes)
    }
}

#[derive(Debug, Error)]
pub(crate) enum FlushProjectCollaborationError {
    #[error("could not load the collaboration projection target for project {project_id}")]
    LoadTarget {
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("could not load pending collaboration documents for project {project_id}")]
    LoadDocuments {
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("could not project collaboration state for project {project_id}")]
    Project {
        project_id: Uuid,
        #[source]
        source: ReconcileCollaborationDocumentError,
    },
}

pub(crate) fn spawn_collaboration_projection_worker(collaboration: CollaborationContext) {
    tokio::spawn(async move {
        loop {
            for _ in 0..PROJECTION_BATCH_SIZE {
                let document = match collaboration.persistence.next_pending_document().await {
                    Ok(Some(document)) => document,
                    Ok(None) => break,
                    Err(error) => {
                        warn!(
                            ?error,
                            "collaboration projector could not load pending work"
                        );
                        break;
                    }
                };
                let project_id = document.project_id;
                match collaboration.reconcile_pending_document(document).await {
                    Ok(result) => {
                        if let ReconcileCollaborationDocumentOutcome::Current(compacted) = result {
                            if let Some(change) = compacted.workspace_change {
                                collaboration.workspace_changed(project_id, change).await;
                            }
                        }
                    }
                    Err(error) => {
                        warn!(?error, %project_id, "collaboration projector failed");
                        break;
                    }
                }
            }
            tokio::time::sleep(PROJECTION_POLL_INTERVAL).await;
        }
    });
}
