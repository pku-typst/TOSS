//! Workspace live-path snapshot used by Versioning revision transfer.

use super::revision_paths_persistence;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

pub(crate) struct RevisionPathSnapshot {
    pub changed_document_paths: Vec<String>,
    pub changed_asset_paths: Vec<String>,
    pub live_document_paths: Vec<String>,
    pub live_asset_paths: Vec<String>,
}

#[derive(Debug, Error)]
#[error("live revision path lookup failed for project {project_id}")]
pub(crate) struct RevisionPathSnapshotError {
    project_id: Uuid,
    #[source]
    source: sqlx::Error,
}

pub(crate) async fn revision_path_snapshot(
    db: &PgPool,
    project_id: Uuid,
    changed_after: DateTime<Utc>,
) -> Result<RevisionPathSnapshot, RevisionPathSnapshotError> {
    let (changed_document_paths, changed_asset_paths, live_document_paths, live_asset_paths) =
        tokio::try_join!(
            revision_paths_persistence::document_paths_updated_since(db, project_id, changed_after),
            revision_paths_persistence::asset_paths_created_since(db, project_id, changed_after),
            revision_paths_persistence::document_paths(db, project_id),
            revision_paths_persistence::asset_paths(db, project_id),
        )
        .map_err(|source| RevisionPathSnapshotError { project_id, source })?;
    Ok(RevisionPathSnapshot {
        changed_document_paths,
        changed_asset_paths,
        live_document_paths,
        live_asset_paths,
    })
}
