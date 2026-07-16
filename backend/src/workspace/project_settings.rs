//! Workspace project-settings lifecycle.

use super::{
    lock_project_content_exclusively, mark_project_dirty, settings_persistence, LatexEngine,
    ProjectType,
};
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ProjectSettings {
    pub project_id: Uuid,
    pub project_type: ProjectType,
    pub entry_file_path: String,
    #[schema(required)]
    pub latex_engine: Option<LatexEngine>,
    pub settings_revision: i64,
    pub updated_at: DateTime<Utc>,
}

pub(super) enum ProjectSettingChange {
    EntryFilePath(String),
    LatexEngine(LatexEngine),
}

pub(super) struct ChangeProjectSetting {
    pub project_id: Uuid,
    pub change: ProjectSettingChange,
    pub actor_user_id: Uuid,
}

#[derive(Clone, Copy, Debug)]
enum ProjectSettingsPersistenceStage {
    Begin,
    LockProjectContent,
    FindProjectType,
    FindEntryDocument,
    EnsureSettings,
    UpdateEntryFile,
    UpdateLatexEngine,
    MarkProjectDirty,
    Commit,
}

#[derive(Debug, Error)]
#[error("project settings persistence failed during {stage:?} for project {project_id}")]
pub(super) struct ProjectSettingsPersistenceError {
    stage: ProjectSettingsPersistenceStage,
    project_id: Uuid,
    #[source]
    source: sqlx::Error,
}

impl ProjectSettingsPersistenceError {
    fn new(stage: ProjectSettingsPersistenceStage, project_id: Uuid, source: sqlx::Error) -> Self {
        Self {
            stage,
            project_id,
            source,
        }
    }
}

#[derive(Debug, Error)]
pub(super) enum GetProjectSettingsError {
    #[error("project was not found")]
    ProjectNotFound,
    #[error(transparent)]
    Persistence(#[from] ProjectSettingsPersistenceError),
}

#[derive(Debug, Error)]
pub(super) enum ChangeProjectSettingError {
    #[error("project was not found")]
    ProjectNotFound,
    #[error("LaTeX engine does not apply to this project type")]
    LatexEngineNotApplicable,
    #[error("entry file does not apply to this project type")]
    EntryFileTypeMismatch,
    #[error("entry file was not found in the project")]
    EntryFileNotFound,
    #[error(transparent)]
    Persistence(#[from] ProjectSettingsPersistenceError),
}

pub(super) async fn get_or_create_project_settings(
    db: &PgPool,
    project_id: Uuid,
) -> Result<ProjectSettings, GetProjectSettingsError> {
    let mut transaction = db.begin().await.map_err(|source| {
        ProjectSettingsPersistenceError::new(
            ProjectSettingsPersistenceStage::Begin,
            project_id,
            source,
        )
    })?;
    let project_type = settings_persistence::find_project_type(&mut transaction, project_id)
        .await
        .map_err(|source| {
            ProjectSettingsPersistenceError::new(
                ProjectSettingsPersistenceStage::FindProjectType,
                project_id,
                source,
            )
        })?
        .ok_or(GetProjectSettingsError::ProjectNotFound)?;
    let settings = settings_persistence::ensure(
        &mut transaction,
        project_id,
        project_type.default_entry_file_path(),
        effective_latex_engine(project_type, None),
        Utc::now(),
    )
    .await
    .map_err(|source| {
        ProjectSettingsPersistenceError::new(
            ProjectSettingsPersistenceStage::EnsureSettings,
            project_id,
            source,
        )
    })?;
    transaction.commit().await.map_err(|source| {
        ProjectSettingsPersistenceError::new(
            ProjectSettingsPersistenceStage::Commit,
            project_id,
            source,
        )
    })?;

    Ok(settings_from_record(project_type, settings))
}

pub(super) async fn change_project_setting(
    db: &PgPool,
    command: ChangeProjectSetting,
) -> Result<ProjectSettings, ChangeProjectSettingError> {
    let mut transaction = db.begin().await.map_err(|source| {
        ProjectSettingsPersistenceError::new(
            ProjectSettingsPersistenceStage::Begin,
            command.project_id,
            source,
        )
    })?;
    lock_project_content_exclusively(&mut transaction, command.project_id)
        .await
        .map_err(|source| {
            ProjectSettingsPersistenceError::new(
                ProjectSettingsPersistenceStage::LockProjectContent,
                command.project_id,
                source,
            )
        })?;
    let project_type =
        settings_persistence::find_project_type(&mut transaction, command.project_id)
            .await
            .map_err(|source| {
                ProjectSettingsPersistenceError::new(
                    ProjectSettingsPersistenceStage::FindProjectType,
                    command.project_id,
                    source,
                )
            })?
            .ok_or(ChangeProjectSettingError::ProjectNotFound)?;
    if matches!(&command.change, ProjectSettingChange::LatexEngine(_))
        && project_type != ProjectType::Latex
    {
        return Err(ChangeProjectSettingError::LatexEngineNotApplicable);
    }
    if let ProjectSettingChange::EntryFilePath(entry_file_path) = &command.change {
        if !project_type.accepts_entry_file_path(entry_file_path) {
            return Err(ChangeProjectSettingError::EntryFileTypeMismatch);
        }
    }
    let now = Utc::now();
    settings_persistence::ensure(
        &mut transaction,
        command.project_id,
        project_type.default_entry_file_path(),
        effective_latex_engine(project_type, None),
        now,
    )
    .await
    .map_err(|source| {
        ProjectSettingsPersistenceError::new(
            ProjectSettingsPersistenceStage::EnsureSettings,
            command.project_id,
            source,
        )
    })?;
    if let ProjectSettingChange::EntryFilePath(entry_file_path) = &command.change {
        let entry_file_exists = settings_persistence::document_exists(
            &mut transaction,
            command.project_id,
            entry_file_path,
        )
        .await
        .map_err(|source| {
            ProjectSettingsPersistenceError::new(
                ProjectSettingsPersistenceStage::FindEntryDocument,
                command.project_id,
                source,
            )
        })?;
        if !entry_file_exists {
            return Err(ChangeProjectSettingError::EntryFileNotFound);
        }
    }
    let settings = match command.change {
        ProjectSettingChange::EntryFilePath(entry_file_path) => {
            settings_persistence::update_entry_file_path(
                &mut transaction,
                command.project_id,
                &entry_file_path,
                now,
            )
            .await
            .map_err(|source| {
                ProjectSettingsPersistenceError::new(
                    ProjectSettingsPersistenceStage::UpdateEntryFile,
                    command.project_id,
                    source,
                )
            })?
        }
        ProjectSettingChange::LatexEngine(latex_engine) => {
            settings_persistence::update_latex_engine(
                &mut transaction,
                command.project_id,
                latex_engine,
                now,
            )
            .await
            .map_err(|source| {
                ProjectSettingsPersistenceError::new(
                    ProjectSettingsPersistenceStage::UpdateLatexEngine,
                    command.project_id,
                    source,
                )
            })?
        }
    };
    mark_project_dirty(
        &mut transaction,
        command.project_id,
        Some(command.actor_user_id),
        None,
    )
    .await
    .map_err(|source| {
        ProjectSettingsPersistenceError::new(
            ProjectSettingsPersistenceStage::MarkProjectDirty,
            command.project_id,
            source,
        )
    })?;
    transaction.commit().await.map_err(|source| {
        ProjectSettingsPersistenceError::new(
            ProjectSettingsPersistenceStage::Commit,
            command.project_id,
            source,
        )
    })?;

    Ok(settings_from_record(project_type, settings))
}

fn effective_latex_engine(
    project_type: ProjectType,
    requested_engine: Option<LatexEngine>,
) -> Option<LatexEngine> {
    requested_engine
        .filter(|_| project_type == ProjectType::Latex)
        .or_else(|| project_type.default_latex_engine())
}

fn settings_from_record(
    project_type: ProjectType,
    settings: settings_persistence::ProjectSettingsRecord,
) -> ProjectSettings {
    ProjectSettings {
        project_id: settings.project_id,
        project_type,
        entry_file_path: settings.entry_file_path,
        latex_engine: settings.latex_engine,
        settings_revision: settings.settings_revision,
        updated_at: settings.updated_at,
    }
}

#[cfg(test)]
mod tests {
    use super::effective_latex_engine;
    use crate::workspace::{LatexEngine, ProjectType};

    #[test]
    fn latex_engine_is_owned_by_the_project_type_policy() {
        assert_eq!(
            effective_latex_engine(ProjectType::Latex, None),
            Some(LatexEngine::Xetex)
        );
        assert_eq!(
            effective_latex_engine(ProjectType::Latex, Some(LatexEngine::Pdftex)),
            Some(LatexEngine::Pdftex)
        );
        assert_eq!(
            effective_latex_engine(ProjectType::Typst, Some(LatexEngine::Pdftex)),
            None
        );
    }
}
