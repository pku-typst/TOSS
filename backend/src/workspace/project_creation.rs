//! Ordinary Workspace project creation and its cross-context transaction.

use super::{
    mark_project_dirty, provision_project, CreateProjectGraph, LatexEngine, Project, ProjectName,
    ProjectType, WorkspaceDocument,
};
use crate::access::{user_display_name, IdentityLookupError, ProjectRole};
use crate::distribution::DistributionConfig;
use chrono::Utc;
use sqlx::PgPool;
use thiserror::Error;
use tracing::warn;
use uuid::Uuid;

pub(super) struct CreateProject<'value> {
    pub actor_user_id: Uuid,
    pub name: &'value ProjectName,
    pub project_type: ProjectType,
    pub latex_engine: LatexEngine,
}

#[derive(Clone, Copy, Debug)]
enum CreateProjectPersistenceStage {
    Begin,
    Provision,
    Commit,
}

#[derive(Debug, Error)]
#[error("project creation persistence failed during {stage:?} for project {project_id}")]
pub(super) struct CreateProjectPersistenceError {
    stage: CreateProjectPersistenceStage,
    project_id: Uuid,
    #[source]
    source: sqlx::Error,
}

impl CreateProjectPersistenceError {
    fn new(stage: CreateProjectPersistenceStage, project_id: Uuid, source: sqlx::Error) -> Self {
        Self {
            stage,
            project_id,
            source,
        }
    }
}

#[derive(Debug, Error)]
pub(super) enum CreateProjectError {
    #[error("project type {project_type:?} is disabled")]
    ProjectTypeDisabled { project_type: ProjectType },
    #[error("starter content is missing for project type {project_type:?}")]
    StarterContentMissing { project_type: ProjectType },
    #[error(transparent)]
    Identity(#[from] IdentityLookupError),
    #[error(transparent)]
    Persistence(#[from] CreateProjectPersistenceError),
}

pub(super) async fn create_project(
    db: &PgPool,
    distribution: &DistributionConfig,
    command: CreateProject<'_>,
) -> Result<Project, CreateProjectError> {
    if !distribution.supports_project_type(command.project_type) {
        return Err(CreateProjectError::ProjectTypeDisabled {
            project_type: command.project_type,
        });
    }
    let default_content = distribution.starter_content(command.project_type).ok_or(
        CreateProjectError::StarterContentMissing {
            project_type: command.project_type,
        },
    )?;
    let entry_file_path = command.project_type.default_entry_file_path();
    let latex_engine = (command.project_type == ProjectType::Latex).then_some(command.latex_engine);
    let project_id = Uuid::new_v4();
    let created_at = Utc::now();
    let documents = vec![WorkspaceDocument {
        path: entry_file_path.to_string(),
        content: default_content.to_string(),
    }];
    let owner_display_name = user_display_name(db, command.actor_user_id)
        .await?
        .unwrap_or_else(|| "Unknown".to_string());
    let mut transaction = db.begin().await.map_err(|source| {
        CreateProjectPersistenceError::new(CreateProjectPersistenceStage::Begin, project_id, source)
    })?;
    let project = CreateProjectGraph {
        project_id,
        owner_user_id: command.actor_user_id,
        name: command.name,
        project_type: command.project_type,
        entry_file_path,
        latex_engine,
        directories: &[],
        documents: &documents,
        assets: &[],
        created_at,
    };
    let persistence = async {
        provision_project(&mut transaction, &project).await?;
        mark_project_dirty(
            &mut transaction,
            project_id,
            Some(command.actor_user_id),
            None,
        )
        .await?;
        Ok::<(), sqlx::Error>(())
    }
    .await;
    if let Err(source) = persistence {
        if let Err(rollback_error) = transaction.rollback().await {
            warn!(%rollback_error, %project_id, "project creation rollback failed");
        }
        return Err(CreateProjectPersistenceError::new(
            CreateProjectPersistenceStage::Provision,
            project_id,
            source,
        )
        .into());
    }
    transaction.commit().await.map_err(|source| {
        CreateProjectPersistenceError::new(
            CreateProjectPersistenceStage::Commit,
            project_id,
            source,
        )
    })?;

    Ok(Project {
        id: project_id,
        name: command.name.as_str().to_string(),
        project_type: command.project_type,
        latex_engine,
        owner_user_id: Some(command.actor_user_id),
        owner_display_name,
        my_role: ProjectRole::Owner,
        can_read: true,
        is_template: false,
        has_thumbnail: false,
        created_at,
        last_edited_at: created_at,
        archived: false,
        archived_at: None,
    })
}
