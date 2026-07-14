//! Minimal Workspace entry-point projection consumed by compilation workflows.

use super::{settings_persistence, ProjectType};
use sqlx::{PgConnection, PgPool};
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProjectEntryPoint {
    pub project_type: ProjectType,
    pub entry_file_path: String,
}

#[derive(Debug, Error)]
pub(crate) enum LoadProjectEntryPointError {
    #[error("project was not found")]
    ProjectNotFound,
    #[error("project entry-point lookup failed for project {project_id}")]
    Persistence {
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

pub(crate) async fn load_project_entry_point(
    db: &PgPool,
    project_id: Uuid,
) -> Result<ProjectEntryPoint, LoadProjectEntryPointError> {
    let settings = settings_persistence::find_entry_settings(db, project_id)
        .await
        .map_err(|source| LoadProjectEntryPointError::Persistence { project_id, source })?
        .ok_or(LoadProjectEntryPointError::ProjectNotFound)?;

    Ok(project_entry_point_from_settings(settings))
}

pub(super) async fn find_project_entry_point_in_transaction(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<Option<ProjectEntryPoint>, sqlx::Error> {
    Ok(
        settings_persistence::find_entry_settings_in_transaction(connection, project_id)
            .await?
            .map(project_entry_point_from_settings),
    )
}

fn project_entry_point_from_settings(
    settings: settings_persistence::ProjectEntrySettingsRecord,
) -> ProjectEntryPoint {
    ProjectEntryPoint {
        project_type: settings.project_type,
        entry_file_path: settings
            .entry_file_path
            .unwrap_or_else(|| settings.project_type.default_entry_file_path().to_string()),
    }
}
