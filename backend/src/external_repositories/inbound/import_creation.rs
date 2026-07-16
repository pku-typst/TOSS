//! Creation of a new project whose initial content is imported from a repository.

use super::super::provider::ProviderInstanceId;
use super::branch::SourceBranch;
use super::persistence;
use super::{ExternalGitInboundOperation, ExternalRepositoryInboundJob};
use crate::database_error::is_unique_constraint_violation;
use crate::distribution::CheckpointBranchPrefix;
use crate::external_repositories::linking::{insert_repository_link, NewRepositoryLink};
use crate::workspace::{
    provision_project, CreateProjectGraph, LatexEngine, ProjectName, ProjectType,
};
use chrono::Utc;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
pub(super) enum CreateImportPersistenceStage {
    Begin,
    CreateProjectGraph,
    Commit,
}

#[derive(Debug, Error)]
pub(super) enum CreateImportError {
    #[error("external repository is already linked")]
    RepositoryConflict,
    #[error("repository import creation failed during {stage:?} for project {project_id}")]
    Persistence {
        stage: CreateImportPersistenceStage,
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

pub(super) struct CreateImportProject {
    pub actor_user_id: Uuid,
    pub name: ProjectName,
    pub project_type: ProjectType,
    pub latex_engine: LatexEngine,
    pub provider: ProviderInstanceId,
    pub repository_id: String,
    pub full_path: String,
    pub web_url: String,
    pub clone_url: String,
    pub default_branch: String,
    pub checkpoint_branch_prefix: CheckpointBranchPrefix,
    pub source_branch: SourceBranch,
}

pub(super) async fn create_import_project(
    db: &PgPool,
    command: CreateImportProject,
) -> Result<ExternalRepositoryInboundJob, CreateImportError> {
    let now = Utc::now();
    let project_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let checkpoint_branch = command.checkpoint_branch_prefix.branch_for(project_id);
    let project = CreateProjectGraph::empty(
        project_id,
        command.actor_user_id,
        &command.name,
        command.project_type,
        command.latex_engine,
        now,
    );
    let mut transaction = db
        .begin()
        .await
        .map_err(|source| CreateImportError::Persistence {
            stage: CreateImportPersistenceStage::Begin,
            project_id,
            source,
        })?;
    let result: Result<(), sqlx::Error> = async {
        provision_project(&mut transaction, &project).await?;
        insert_repository_link(
            &mut transaction,
            NewRepositoryLink {
                project_id,
                provider: command.provider.clone(),
                repository_id: &command.repository_id,
                full_path: &command.full_path,
                web_url: &command.web_url,
                clone_url: &command.clone_url,
                default_branch: &command.default_branch,
                checkpoint_branch: &checkpoint_branch,
                actor_user_id: command.actor_user_id,
                now,
            },
        )
        .await?;
        persistence::insert_inbound_job(
            &mut transaction,
            persistence::InsertInboundJobRecord {
                job_id,
                project_id,
                provider_instance_id: &command.provider,
                operation: ExternalGitInboundOperation::Import,
                source_branch: command.source_branch.as_str(),
                requested_by_user_id: command.actor_user_id,
                now,
            },
        )
        .await
    }
    .await;
    if let Err(database_error) = result {
        if is_unique_constraint_violation(
            &database_error,
            "external_git_project_links_provider_repository_key",
        ) {
            return Err(CreateImportError::RepositoryConflict);
        }
        return Err(CreateImportError::Persistence {
            stage: CreateImportPersistenceStage::CreateProjectGraph,
            project_id,
            source: database_error,
        });
    }
    transaction
        .commit()
        .await
        .map_err(|source| CreateImportError::Persistence {
            stage: CreateImportPersistenceStage::Commit,
            project_id,
            source,
        })?;
    Ok(ExternalRepositoryInboundJob::pending(
        job_id,
        project_id,
        command.provider,
        ExternalGitInboundOperation::Import,
        command.source_branch.into_string(),
        now,
    ))
}
