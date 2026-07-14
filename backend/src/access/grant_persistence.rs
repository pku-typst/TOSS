//! Project role and organization/group grant persistence.

use super::grant_model::{
    ProjectGroupRoleBinding, ProjectOrganizationAccess, ProjectRoleBinding, ProjectRoleSource,
};
use super::{ProjectPermission, ProjectRole};
use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

pub(crate) struct DirectAccessUser {
    pub user_id: Uuid,
    pub email: String,
    pub display_name: String,
    pub role: ProjectRole,
    pub source: ProjectRoleSource,
}

pub(crate) struct OrganizationAccessUser {
    pub user_id: Uuid,
    pub email: String,
    pub display_name: String,
    pub permission: ProjectPermission,
    pub organization_name: String,
}

pub(super) async fn lock_project_access_epoch_for_write(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "select pg_advisory_xact_lock(
           hashtextextended('project-access:' || $1::text, 0)
         )",
    )
    .bind(project_id)
    .execute(connection)
    .await?;
    Ok(())
}

pub(super) async fn project_access_epoch(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Option<i64>, sqlx::Error> {
    sqlx::query_scalar("select access_epoch from projects where id = $1")
        .bind(project_id)
        .fetch_optional(db)
        .await
}

pub(super) async fn lock_project_access_epoch_for_read(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<Option<i64>, sqlx::Error> {
    sqlx::query(
        "select pg_advisory_xact_lock_shared(
           hashtextextended('project-access:' || $1::text, 0)
         )",
    )
    .bind(project_id)
    .execute(&mut *connection)
    .await?;
    sqlx::query_scalar("select access_epoch from projects where id = $1")
        .bind(project_id)
        .fetch_optional(connection)
        .await
}

pub(crate) async fn advance_project_access_epoch(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<i64, sqlx::Error> {
    lock_project_access_epoch_for_write(connection, project_id).await?;
    sqlx::query_scalar(
        "update projects
         set access_epoch = access_epoch + 1
         where id = $1
         returning access_epoch",
    )
    .bind(project_id)
    .fetch_one(connection)
    .await
}

pub(crate) async fn advance_organization_project_access_epochs(
    connection: &mut PgConnection,
    organization_ids: &[Uuid],
) -> Result<Vec<Uuid>, sqlx::Error> {
    if organization_ids.is_empty() {
        return Ok(Vec::new());
    }
    let project_ids = sqlx::query_scalar::<_, Uuid>(
        "select distinct project_id
         from project_organization_access
         where organization_id = any($1)
         order by project_id",
    )
    .bind(organization_ids)
    .fetch_all(&mut *connection)
    .await?;
    for project_id in &project_ids {
        lock_project_access_epoch_for_write(&mut *connection, *project_id).await?;
    }
    if project_ids.is_empty() {
        return Ok(project_ids);
    }
    sqlx::query_scalar(
        "update projects project
         set access_epoch = project.access_epoch + 1
         where project.id = any($1)
         returning project.id",
    )
    .bind(&project_ids)
    .fetch_all(connection)
    .await
}

pub(crate) async fn list_roles(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Vec<ProjectRoleBinding>, sqlx::Error> {
    let rows = sqlx::query(
        "select project_id, user_id, role, granted_at
         from project_roles
         where project_id = $1
         order by granted_at desc",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| ProjectRoleBinding {
            project_id: row.get("project_id"),
            user_id: row.get("user_id"),
            role: row.get("role"),
            granted_at: row.get("granted_at"),
        })
        .collect())
}

pub(crate) async fn upsert_role(
    connection: &mut PgConnection,
    project_id: Uuid,
    user_id: Uuid,
    role: ProjectRole,
    granted_at: DateTime<Utc>,
) -> Result<ProjectRoleBinding, sqlx::Error> {
    let row = sqlx::query(
        "insert into project_roles (project_id, user_id, role, granted_at, source)
         values ($1, $2, $3, $4, $5)
         on conflict (project_id, user_id) do update
         set role = excluded.role,
             granted_at = excluded.granted_at,
             source = excluded.source
         returning project_id, user_id, role, granted_at",
    )
    .bind(project_id)
    .bind(user_id)
    .bind(role)
    .bind(granted_at)
    .bind(ProjectRoleSource::DirectRole)
    .fetch_one(connection)
    .await?;
    Ok(ProjectRoleBinding {
        project_id: row.get("project_id"),
        user_id: row.get("user_id"),
        role: row.get("role"),
        granted_at: row.get("granted_at"),
    })
}

pub(crate) async fn grant_project_share_link_role_at_least(
    connection: &mut PgConnection,
    project_id: Uuid,
    user_id: Uuid,
    requested_role: ProjectRole,
    granted_at: DateTime<Utc>,
) -> Result<ProjectRole, sqlx::Error> {
    sqlx::query_scalar(
        "insert into project_roles (project_id, user_id, role, granted_at, source)
         values ($1, $2, $3, $4, $5)
         on conflict (project_id, user_id) do update
         set role = case
               when project_roles.role = 'Owner' then project_roles.role
               when project_roles.role = 'ReadWrite' and excluded.role = 'ReadOnly'
                 then project_roles.role
               else excluded.role
             end,
             granted_at = case
               when project_roles.role = 'Owner' then project_roles.granted_at
               when project_roles.role = 'ReadWrite' and excluded.role = 'ReadOnly'
                 then project_roles.granted_at
               else excluded.granted_at
             end,
             source = case
               when project_roles.role = 'Owner' then project_roles.source
               when project_roles.role = 'ReadWrite'
                 and excluded.role in ('ReadWrite', 'ReadOnly')
                 then project_roles.source
               when project_roles.role = 'ReadOnly' and excluded.role = 'ReadOnly'
                 then project_roles.source
               else excluded.source
             end
         returning role",
    )
    .bind(project_id)
    .bind(user_id)
    .bind(requested_role)
    .bind(granted_at)
    .bind(ProjectRoleSource::ShareLinkInvite)
    .fetch_one(connection)
    .await
}

pub(crate) async fn list_organization_access(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Vec<ProjectOrganizationAccess>, sqlx::Error> {
    let rows = sqlx::query(
        "select poa.project_id, poa.organization_id, o.name as organization_name,
                poa.permission, poa.granted_by, poa.granted_at
         from project_organization_access poa
         join organizations o on o.id = poa.organization_id
         where poa.project_id = $1
         order by o.name asc",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| ProjectOrganizationAccess {
            project_id: row.get("project_id"),
            organization_id: row.get("organization_id"),
            organization_name: row.get("organization_name"),
            permission: row.get("permission"),
            granted_by: row.get("granted_by"),
            granted_at: row.get("granted_at"),
        })
        .collect())
}

pub(crate) async fn upsert_organization_access(
    connection: &mut PgConnection,
    project_id: Uuid,
    organization_id: Uuid,
    permission: ProjectPermission,
    granted_by: Uuid,
    granted_at: DateTime<Utc>,
) -> Result<ProjectOrganizationAccess, sqlx::Error> {
    let row = sqlx::query(
        "with granted as (
           insert into project_organization_access
             (project_id, organization_id, permission, granted_by, granted_at)
           values ($1, $2, $3, $4, $5)
           on conflict (project_id, organization_id) do update
           set permission = excluded.permission,
               granted_by = excluded.granted_by,
               granted_at = excluded.granted_at
           returning project_id, organization_id, permission, granted_by, granted_at
         )
         select granted.project_id, granted.organization_id, o.name as organization_name,
                granted.permission, granted.granted_by, granted.granted_at
         from granted
         join organizations o on o.id = granted.organization_id",
    )
    .bind(project_id)
    .bind(organization_id)
    .bind(permission)
    .bind(granted_by)
    .bind(granted_at)
    .fetch_one(connection)
    .await?;
    Ok(ProjectOrganizationAccess {
        project_id: row.get("project_id"),
        organization_id: row.get("organization_id"),
        organization_name: row.get("organization_name"),
        permission: row.get("permission"),
        granted_by: row.get("granted_by"),
        granted_at: row.get("granted_at"),
    })
}

pub(crate) async fn delete_organization_access(
    connection: &mut PgConnection,
    project_id: Uuid,
    organization_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "delete from project_organization_access
         where project_id = $1 and organization_id = $2",
    )
    .bind(project_id)
    .bind(organization_id)
    .execute(connection)
    .await?;
    Ok(result.rows_affected() > 0)
}

pub(crate) async fn direct_access_users(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Vec<DirectAccessUser>, sqlx::Error> {
    let rows = sqlx::query(
        "select u.id as user_id, u.email, u.display_name, pr.role, pr.source
         from project_roles pr
         join users u on u.id = pr.user_id
         where pr.project_id = $1",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| DirectAccessUser {
            user_id: row.get("user_id"),
            email: row.get("email"),
            display_name: row.get("display_name"),
            role: row.get("role"),
            source: row.get("source"),
        })
        .collect())
}

pub(crate) async fn organization_access_users(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Vec<OrganizationAccessUser>, sqlx::Error> {
    let rows = sqlx::query(
        "select distinct u.id as user_id, u.email, u.display_name,
                poa.permission, o.name as organization_name
         from project_organization_access poa
         join organizations o on o.id = poa.organization_id
         join organization_memberships members on members.organization_id = poa.organization_id
         join users u on u.id = members.user_id
         where poa.project_id = $1",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| OrganizationAccessUser {
            user_id: row.get("user_id"),
            email: row.get("email"),
            display_name: row.get("display_name"),
            permission: row.get("permission"),
            organization_name: row.get("organization_name"),
        })
        .collect())
}

pub(crate) async fn list_group_roles(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Vec<ProjectGroupRoleBinding>, sqlx::Error> {
    let rows = sqlx::query(
        "select project_id, group_name, role, granted_at
         from project_group_roles
         where project_id = $1
         order by group_name asc",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| ProjectGroupRoleBinding {
            project_id: row.get("project_id"),
            group_name: row.get("group_name"),
            role: row.get("role"),
            granted_at: row.get("granted_at"),
        })
        .collect())
}

pub(crate) async fn upsert_group_role(
    connection: &mut PgConnection,
    project_id: Uuid,
    group_name: &str,
    role: ProjectRole,
    granted_at: DateTime<Utc>,
) -> Result<ProjectGroupRoleBinding, sqlx::Error> {
    let row = sqlx::query(
        "insert into project_group_roles (project_id, group_name, role, granted_at)
         values ($1, $2, $3, $4)
         on conflict (project_id, group_name) do update
         set role = excluded.role, granted_at = excluded.granted_at
         returning project_id, group_name, role, granted_at",
    )
    .bind(project_id)
    .bind(group_name)
    .bind(role)
    .bind(granted_at)
    .fetch_one(connection)
    .await?;
    Ok(ProjectGroupRoleBinding {
        project_id: row.get("project_id"),
        group_name: row.get("group_name"),
        role: row.get("role"),
        granted_at: row.get("granted_at"),
    })
}

pub(crate) async fn delete_group_role(
    connection: &mut PgConnection,
    project_id: Uuid,
    group_name: &str,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "delete from project_group_roles
         where project_id = $1 and group_name = $2",
    )
    .bind(project_id)
    .bind(group_name)
    .execute(connection)
    .await?;
    Ok(result.rows_affected() > 0)
}
