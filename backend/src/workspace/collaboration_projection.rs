//! Applying an acknowledged CRDT state to Workspace's canonical text projection.

use super::{
    documents_persistence, lock_project_content_epoch, record_collaborative_document_activity,
    ProjectContentEpochMatch,
};
use chrono::Utc;
use sqlx::PgConnection;
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum CollaborationContributor {
    User(Uuid),
    Guest(String),
}

pub(crate) struct ProjectCollaborationDocument<'document> {
    pub project_id: Uuid,
    pub document_id: Uuid,
    pub collaboration_revision: i64,
    pub content_epoch: i64,
    pub text: &'document str,
    pub contributors: &'document [CollaborationContributor],
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProjectedCollaborationDocument {
    pub path: String,
    pub document_id: Uuid,
    pub collaboration_revision: i64,
    pub change_sequence: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum CollaborationProjectionOutcome {
    Projected(ProjectedCollaborationDocument),
    Unchanged,
    ContentEpochChanged,
    DocumentChanged,
}

pub(crate) async fn lock_project_collaboration_document(
    connection: &mut PgConnection,
    project_id: Uuid,
    document_id: Uuid,
    collaboration_revision: i64,
) -> Result<bool, sqlx::Error> {
    documents_persistence::lock_by_collaboration_identity(
        connection,
        project_id,
        document_id,
        collaboration_revision,
    )
    .await
    .map(|document| document.is_some())
}

#[derive(Clone, Copy, Debug)]
enum CollaborationProjectionStage {
    LockContentEpoch,
    LockDocument,
    UpdateDocument,
    MarkProjectDirty,
}

#[derive(Debug, Error)]
#[error("collaboration projection failed during {stage:?} for project {project_id} and document {document_id}")]
pub(crate) struct CollaborationProjectionError {
    stage: CollaborationProjectionStage,
    project_id: Uuid,
    document_id: Uuid,
    #[source]
    source: sqlx::Error,
}

impl CollaborationProjectionError {
    fn new(
        stage: CollaborationProjectionStage,
        document: &ProjectCollaborationDocument<'_>,
        source: sqlx::Error,
    ) -> Self {
        Self {
            stage,
            project_id: document.project_id,
            document_id: document.document_id,
            source,
        }
    }
}

pub(crate) async fn project_collaboration_document(
    connection: &mut PgConnection,
    document: &ProjectCollaborationDocument<'_>,
) -> Result<CollaborationProjectionOutcome, CollaborationProjectionError> {
    match lock_project_content_epoch(connection, document.project_id, document.content_epoch)
        .await
        .map_err(|source| {
            CollaborationProjectionError::new(
                CollaborationProjectionStage::LockContentEpoch,
                document,
                source,
            )
        })? {
        ProjectContentEpochMatch::Current => {}
        ProjectContentEpochMatch::Changed | ProjectContentEpochMatch::ProjectNotFound => {
            return Ok(CollaborationProjectionOutcome::ContentEpochChanged)
        }
    }

    let Some(current) = documents_persistence::lock_by_collaboration_identity(
        connection,
        document.project_id,
        document.document_id,
        document.collaboration_revision,
    )
    .await
    .map_err(|source| {
        CollaborationProjectionError::new(
            CollaborationProjectionStage::LockDocument,
            document,
            source,
        )
    })?
    else {
        return Ok(CollaborationProjectionOutcome::DocumentChanged);
    };
    if current.content == document.text {
        return Ok(CollaborationProjectionOutcome::Unchanged);
    }

    let Some(updated) = documents_persistence::update_projected_content(
        connection,
        document.project_id,
        document.document_id,
        document.collaboration_revision,
        document.text,
        Utc::now(),
    )
    .await
    .map_err(|source| {
        CollaborationProjectionError::new(
            CollaborationProjectionStage::UpdateDocument,
            document,
            source,
        )
    })?
    else {
        return Ok(CollaborationProjectionOutcome::DocumentChanged);
    };

    record_collaborative_document_activity(connection, document.project_id, document.contributors)
        .await
        .map_err(|source| {
            CollaborationProjectionError::new(
                CollaborationProjectionStage::MarkProjectDirty,
                document,
                source,
            )
        })?;

    Ok(CollaborationProjectionOutcome::Projected(
        ProjectedCollaborationDocument {
            path: updated.path,
            document_id: updated.id,
            collaboration_revision: updated.collaboration_revision,
            change_sequence: updated.change_sequence,
        },
    ))
}
