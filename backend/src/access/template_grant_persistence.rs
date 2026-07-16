//! Template organization-grant persistence.

use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

pub(crate) struct TemplateOrganizationGrantRecord {
    pub project_id: Uuid,
    pub organization_id: Uuid,
    pub organization_name: String,
    pub granted_by: Option<Uuid>,
    pub granted_at: DateTime<Utc>,
}

pub(crate) async fn list(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Vec<TemplateOrganizationGrantRecord>, sqlx::Error> {
    let rows = sqlx::query(
        "select grant.project_id, grant.organization_id,
                organization.name as organization_name,
                grant.granted_by, grant.granted_at
         from project_template_organization_access grant
         join organizations organization on organization.id = grant.organization_id
         where grant.project_id = $1
         order by organization.name asc",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| TemplateOrganizationGrantRecord {
            project_id: row.get("project_id"),
            organization_id: row.get("organization_id"),
            organization_name: row.get("organization_name"),
            granted_by: row.get("granted_by"),
            granted_at: row.get("granted_at"),
        })
        .collect())
}

pub(crate) async fn upsert(
    connection: &mut PgConnection,
    project_id: Uuid,
    organization_id: Uuid,
    granted_by: Uuid,
    granted_at: DateTime<Utc>,
) -> Result<TemplateOrganizationGrantRecord, sqlx::Error> {
    let row = sqlx::query(
        "with granted as (
           insert into project_template_organization_access
             (project_id, organization_id, granted_by, granted_at)
           values ($1, $2, $3, $4)
           on conflict (project_id, organization_id) do update
           set granted_by = excluded.granted_by, granted_at = excluded.granted_at
           returning project_id, organization_id, granted_by, granted_at
         )
         select granted.project_id, granted.organization_id,
                organization.name as organization_name,
                granted.granted_by, granted.granted_at
         from granted
         join organizations organization on organization.id = granted.organization_id",
    )
    .bind(project_id)
    .bind(organization_id)
    .bind(granted_by)
    .bind(granted_at)
    .fetch_one(connection)
    .await?;
    Ok(TemplateOrganizationGrantRecord {
        project_id: row.get("project_id"),
        organization_id: row.get("organization_id"),
        organization_name: row.get("organization_name"),
        granted_by: row.get("granted_by"),
        granted_at: row.get("granted_at"),
    })
}

pub(crate) async fn delete(
    db: &PgPool,
    project_id: Uuid,
    organization_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "delete from project_template_organization_access
         where project_id = $1 and organization_id = $2",
    )
    .bind(project_id)
    .bind(organization_id)
    .execute(db)
    .await?;
    Ok(result.rows_affected() > 0)
}

pub(crate) async fn delete_all(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("delete from project_template_organization_access where project_id = $1")
        .bind(project_id)
        .execute(connection)
        .await?;
    Ok(())
}
