//! Request principals and effective project-access persistence.

use super::{ProjectPermission, ProjectRole};
use sqlx::postgres::PgRow;
use sqlx::{FromRow, PgPool, Row};
use uuid::Uuid;

pub(crate) struct ProjectUserAccess {
    pub direct_role: Option<ProjectRole>,
    pub organization_permission: Option<ProjectPermission>,
}

pub(crate) struct ProjectCatalogAccessRecord {
    pub project_id: Uuid,
    pub direct_role: Option<ProjectRole>,
    pub organization_permission: Option<ProjectPermission>,
    pub has_template_access: bool,
}

impl<'row> FromRow<'row, PgRow> for ProjectCatalogAccessRecord {
    fn from_row(row: &'row PgRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            project_id: row.try_get("project_id")?,
            direct_role: row.try_get("direct_role")?,
            organization_permission: row.try_get("organization_permission")?,
            has_template_access: row.try_get("has_template_access")?,
        })
    }
}

pub(crate) async fn project_user_access(
    db: &PgPool,
    user_id: Uuid,
    project_id: Uuid,
) -> Result<ProjectUserAccess, sqlx::Error> {
    let row = sqlx::query(
        "select (
           select role.role
           from project_roles role
           where role.project_id = $2 and role.user_id = $1
         ) as direct_role,
         (
           select organization_access.permission
           from project_organization_access organization_access
           join organization_memberships membership
             on membership.organization_id = organization_access.organization_id
           where membership.user_id = $1
             and organization_access.project_id = $2
           order by case organization_access.permission
             when 'write' then 2
             when 'read' then 1
             else 0
           end desc
           limit 1
         ) as organization_permission",
    )
    .bind(user_id)
    .bind(project_id)
    .fetch_one(db)
    .await?;
    Ok(ProjectUserAccess {
        direct_role: row.get("direct_role"),
        organization_permission: row.get("organization_permission"),
    })
}

pub(crate) async fn list_project_catalog_access(
    db: &PgPool,
    user_id: Uuid,
) -> Result<Vec<ProjectCatalogAccessRecord>, sqlx::Error> {
    sqlx::query_as(
        "with visible_projects as (
           select role.project_id
           from project_roles role
           where role.user_id = $1
           union
           select organization_access.project_id
           from project_organization_access organization_access
           join organization_memberships membership
             on membership.organization_id = organization_access.organization_id
           where membership.user_id = $1
           union
           select template_access.project_id
           from project_template_organization_access template_access
           join organization_memberships membership
             on membership.organization_id = template_access.organization_id
           where membership.user_id = $1
         )
         select visible.project_id,
           (
             select role.role
             from project_roles role
             where role.project_id = visible.project_id and role.user_id = $1
           ) as direct_role,
           (
             select organization_access.permission
             from project_organization_access organization_access
             join organization_memberships membership
               on membership.organization_id = organization_access.organization_id
             where membership.user_id = $1
               and organization_access.project_id = visible.project_id
             order by case organization_access.permission
               when 'write' then 2
               when 'read' then 1
               else 0
             end desc
             limit 1
           ) as organization_permission,
           exists(
             select 1
             from project_template_organization_access template_access
             join organization_memberships membership
               on membership.organization_id = template_access.organization_id
             where template_access.project_id = visible.project_id
               and membership.user_id = $1
           ) as has_template_access
         from visible_projects visible",
    )
    .bind(user_id)
    .fetch_all(db)
    .await
}

pub(crate) async fn project_user_has_catalog_access(
    db: &PgPool,
    user_id: Uuid,
    project_id: Uuid,
    include_template_access: bool,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "select exists(
           select 1
           from project_roles role
           where role.project_id = $2 and role.user_id = $1
         ) or exists(
           select 1
           from project_organization_access organization_access
           join organization_memberships membership
             on membership.organization_id = organization_access.organization_id
           where organization_access.project_id = $2 and membership.user_id = $1
         ) or ($3 and exists(
           select 1
           from project_template_organization_access template_access
           join organization_memberships membership
             on membership.organization_id = template_access.organization_id
           where template_access.project_id = $2 and membership.user_id = $1
         ))",
    )
    .bind(user_id)
    .bind(project_id)
    .bind(include_template_access)
    .fetch_one(db)
    .await
}
