//! Workspace project rename workflow.

use super::{projects_persistence, ProjectName};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
enum RenameProjectPersistenceStage {
    Begin,
    Rename,
    Commit,
}

#[derive(Debug, Error)]
#[error("project rename persistence failed during {stage:?} for project {project_id}")]
pub(super) struct RenameProjectPersistenceError {
    stage: RenameProjectPersistenceStage,
    project_id: Uuid,
    #[source]
    source: sqlx::Error,
}

impl RenameProjectPersistenceError {
    fn new(stage: RenameProjectPersistenceStage, project_id: Uuid, source: sqlx::Error) -> Self {
        Self {
            stage,
            project_id,
            source,
        }
    }
}

#[derive(Debug, Error)]
pub(super) enum RenameProjectError {
    #[error("project was not found")]
    ProjectNotFound,
    #[error(transparent)]
    Persistence(#[from] RenameProjectPersistenceError),
}

pub(super) async fn rename_project(
    db: &PgPool,
    project_id: Uuid,
    name: &ProjectName,
) -> Result<(), RenameProjectError> {
    let mut transaction = db.begin().await.map_err(|source| {
        RenameProjectPersistenceError::new(RenameProjectPersistenceStage::Begin, project_id, source)
    })?;
    let renamed = projects_persistence::rename(&mut transaction, project_id, name)
        .await
        .map_err(|source| {
            RenameProjectPersistenceError::new(
                RenameProjectPersistenceStage::Rename,
                project_id,
                source,
            )
        })?;
    if !renamed {
        return Err(RenameProjectError::ProjectNotFound);
    }
    transaction.commit().await.map_err(|source| {
        RenameProjectPersistenceError::new(
            RenameProjectPersistenceStage::Commit,
            project_id,
            source,
        )
    })?;

    Ok(())
}
