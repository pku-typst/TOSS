//! Workspace-owned project identity and classification exposed to context workflows.

use super::ProjectType;
use chrono::{DateTime, Utc};
use sqlx::postgres::PgRow;
use sqlx::{FromRow, PgConnection, PgPool, Row};
use uuid::Uuid;

pub(crate) struct ProjectDescriptor {
    pub id: Uuid,
    pub name: String,
    pub is_template: bool,
}

pub(crate) async fn project_descriptor(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Option<ProjectDescriptor>, sqlx::Error> {
    let row = sqlx::query(
        "select id, name, is_template
         from projects
         where id = $1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    row.map(|value| {
        Ok(ProjectDescriptor {
            id: value.try_get("id")?,
            name: value.try_get("name")?,
            is_template: value.try_get("is_template")?,
        })
    })
    .transpose()
}

pub(crate) struct ProjectTemplateSource {
    pub id: Uuid,
    pub name: String,
    pub description: String,
    pub project_type: ProjectType,
    pub owner_user_id: Option<Uuid>,
    pub updated_at: DateTime<Utc>,
}

impl<'row> FromRow<'row, PgRow> for ProjectTemplateSource {
    fn from_row(row: &'row PgRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            description: row.try_get("description")?,
            project_type: row.try_get("project_type")?,
            owner_user_id: row.try_get("owner_user_id")?,
            updated_at: row.try_get("updated_at")?,
        })
    }
}

pub(crate) async fn list_project_template_sources(
    db: &PgPool,
    actor_user_id: Uuid,
    accessible_project_ids: &[Uuid],
) -> Result<Vec<ProjectTemplateSource>, sqlx::Error> {
    sqlx::query_as(
        "select project.id,
                project.name,
                coalesce(project.description, '') as description,
                project.project_type,
                project.owner_user_id,
                greatest(
                  project.created_at,
                  coalesce(
                    (select max(document.updated_at)
                     from documents document
                     where document.project_id = project.id),
                    project.created_at
                  ),
                  coalesce(
                    (select max(asset.created_at)
                     from project_assets asset
                     where asset.project_id = project.id),
                    project.created_at
                  )
                ) as updated_at
         from projects project
         where project.is_template = true
           and (project.owner_user_id = $1 or project.id = any($2))
         order by updated_at desc",
    )
    .bind(actor_user_id)
    .bind(accessible_project_ids)
    .fetch_all(db)
    .await
}

pub(crate) async fn set_project_template_status(
    connection: &mut PgConnection,
    project_id: Uuid,
    is_template: bool,
) -> Result<Option<bool>, sqlx::Error> {
    sqlx::query_scalar(
        "update projects
         set is_template = $2
         where id = $1
         returning is_template",
    )
    .bind(project_id)
    .bind(is_template)
    .fetch_optional(connection)
    .await
}

pub(crate) async fn lock_project_template_status(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<Option<bool>, sqlx::Error> {
    sqlx::query_scalar("select is_template from projects where id = $1 for update")
        .bind(project_id)
        .fetch_optional(connection)
        .await
}

pub(crate) async fn project_template_status(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Option<bool>, sqlx::Error> {
    sqlx::query_scalar("select is_template from projects where id = $1")
        .bind(project_id)
        .fetch_optional(db)
        .await
}
