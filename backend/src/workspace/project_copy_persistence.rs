//! Project-copy source projection persistence.

use super::{LatexEngine, ProjectType};
use sqlx::postgres::PgRow;
use sqlx::{FromRow, PgConnection, Row};
use uuid::Uuid;

pub(super) struct ProjectCopyMetadata {
    pub project_type: ProjectType,
    pub is_template: bool,
    pub entry_file_path: Option<String>,
    pub latex_engine: Option<LatexEngine>,
}

impl<'row> FromRow<'row, PgRow> for ProjectCopyMetadata {
    fn from_row(row: &'row PgRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            project_type: row.try_get("project_type")?,
            is_template: row.try_get("is_template")?,
            entry_file_path: row.try_get("entry_file_path")?,
            latex_engine: row.try_get("latex_engine")?,
        })
    }
}

pub(super) async fn find_metadata(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<Option<ProjectCopyMetadata>, sqlx::Error> {
    sqlx::query_as(
        "select project.project_type, project.is_template,
                settings.entry_file_path, settings.latex_engine
         from projects project
         left join project_settings settings on settings.project_id = project.id
         where project.id = $1",
    )
    .bind(project_id)
    .fetch_optional(connection)
    .await
}
