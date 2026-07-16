//! Authoritative document bootstrap and safe Yjs snapshot compaction.

use super::persistence::{BootstrapState, CollaborationPersistence};
use super::projection::{
    ReconcileCollaborationDocumentError, ReconcileCollaborationDocumentOutcome,
};
use super::yjs_state::seed_text;
use super::{CollaborationContext, CollaborationDocument};
use crate::workspace::{document_collaboration_seed, DocumentIdentityQueryError};
use thiserror::Error;
use uuid::Uuid;

impl CollaborationContext {
    pub(super) async fn prepare_document_bootstrap(
        &self,
        document: CollaborationDocument,
    ) -> Result<BootstrapState, PrepareBootstrapError> {
        let mut transaction = self.db.begin().await.map_err(|source| {
            PrepareBootstrapError::persistence(BootstrapStage::Begin, document.project_id, source)
        })?;
        CollaborationPersistence::lock_document_updates(&mut transaction, document.document_id)
            .await
            .map_err(|source| {
                PrepareBootstrapError::persistence(
                    BootstrapStage::LockDocument,
                    document.project_id,
                    source,
                )
            })?;
        let document_content = document_collaboration_seed(
            &mut transaction,
            document.project_id,
            document.document_id,
            document.collaboration_revision,
        )
        .await
        .map_err(|source| PrepareBootstrapError::ReadDocument {
            project_id: document.project_id,
            source,
        })?
        .ok_or(PrepareBootstrapError::DocumentChanged {
            project_id: document.project_id,
        })?;
        CollaborationPersistence::clear_superseded_document_revisions(&mut transaction, document)
            .await
            .map_err(|source| {
                PrepareBootstrapError::persistence(
                    BootstrapStage::ClearSupersededRevisions,
                    document.project_id,
                    source,
                )
            })?;
        let state = CollaborationPersistence::load_state(&mut transaction, document)
            .await
            .map_err(|source| {
                PrepareBootstrapError::persistence(
                    BootstrapStage::LoadState,
                    document.project_id,
                    source,
                )
            })?;
        let has_persisted_state = state.snapshot_payload.is_some() || !state.updates.is_empty();
        let canonical_seed = if has_persisted_state {
            None
        } else {
            Some(seed_text(&document_content))
        };
        let projected = self
            .reconcile_collaboration_document(
                &mut transaction,
                document,
                state,
                canonical_seed.as_deref(),
            )
            .await
            .map_err(|source| PrepareBootstrapError::Projection {
                project_id: document.project_id,
                source,
            })?;
        let ReconcileCollaborationDocumentOutcome::Current(compacted) = projected else {
            return Err(PrepareBootstrapError::DocumentChanged {
                project_id: document.project_id,
            });
        };
        let workspace_change = compacted.workspace_change;
        transaction.commit().await.map_err(|source| {
            PrepareBootstrapError::persistence(BootstrapStage::Commit, document.project_id, source)
        })?;
        if let Some(change) = workspace_change {
            self.workspace_changed(document.project_id, change).await;
        }
        Ok(BootstrapState {
            upto_update_id: compacted.upto_update_id,
            snapshot_payload: Some(compacted.snapshot_payload),
            updates: Vec::new(),
            contributors: Vec::new(),
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub(super) enum BootstrapStage {
    Begin,
    LockDocument,
    ClearSupersededRevisions,
    LoadState,
    Commit,
}

#[derive(Debug, Error)]
pub(super) enum PrepareBootstrapError {
    #[error(
        "collaboration bootstrap preparation failed during {stage:?} for project {project_id}"
    )]
    Persistence {
        stage: BootstrapStage,
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("could not read the collaboration document for project {project_id}")]
    ReadDocument {
        project_id: Uuid,
        #[source]
        source: DocumentIdentityQueryError,
    },
    #[error("the collaboration document changed for project {project_id}")]
    DocumentChanged { project_id: Uuid },
    #[error("could not project collaboration state for project {project_id}")]
    Projection {
        project_id: Uuid,
        #[source]
        source: ReconcileCollaborationDocumentError,
    },
}

impl PrepareBootstrapError {
    fn persistence(stage: BootstrapStage, project_id: Uuid, source: sqlx::Error) -> Self {
        Self::Persistence {
            stage,
            project_id,
            source,
        }
    }
}
