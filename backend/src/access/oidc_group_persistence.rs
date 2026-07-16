//! OIDC group and organization-role mapping persistence.

use super::oidc_group_model::OrgGroupRoleMapping;
use super::OrganizationRole;
use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

pub(crate) struct OrganizationGroupMapping {
    pub organization_id: Uuid,
    pub group_name: String,
    pub role: OrganizationRole,
}

pub(crate) async fn replace_user_groups(
    connection: &mut PgConnection,
    user_id: Uuid,
    groups: &[String],
    synced_at: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query("delete from user_oidc_groups where user_id = $1")
        .bind(user_id)
        .execute(&mut *connection)
        .await?;
    for group_name in groups {
        sqlx::query(
            "insert into user_oidc_groups (user_id, group_name, synced_at)
             values ($1, $2, $3)",
        )
        .bind(user_id)
        .bind(group_name)
        .bind(synced_at)
        .execute(&mut *connection)
        .await?;
    }
    Ok(())
}

pub(crate) async fn list_group_mappings(
    connection: &mut PgConnection,
) -> Result<Vec<OrganizationGroupMapping>, sqlx::Error> {
    let rows = sqlx::query(
        "select organization_id, group_name, role
         from org_oidc_group_role_mappings",
    )
    .fetch_all(connection)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| OrganizationGroupMapping {
            organization_id: row.get("organization_id"),
            group_name: row.get("group_name"),
            role: row.get("role"),
        })
        .collect())
}

pub(crate) async fn list_organization_mappings(
    db: &PgPool,
    organization_id: Uuid,
) -> Result<Vec<OrgGroupRoleMapping>, sqlx::Error> {
    let rows = sqlx::query(
        "select organization_id, group_name, role, granted_at
         from org_oidc_group_role_mappings
         where organization_id = $1
         order by group_name asc",
    )
    .bind(organization_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| OrgGroupRoleMapping {
            organization_id: row.get("organization_id"),
            group_name: row.get("group_name"),
            role: row.get("role"),
            granted_at: row.get("granted_at"),
        })
        .collect())
}

pub(crate) async fn upsert_organization_mapping(
    connection: &mut PgConnection,
    organization_id: Uuid,
    group_name: &str,
    role: OrganizationRole,
    granted_at: DateTime<Utc>,
) -> Result<OrgGroupRoleMapping, sqlx::Error> {
    let row = sqlx::query(
        "insert into org_oidc_group_role_mappings
           (organization_id, group_name, role, granted_at)
         values ($1, $2, $3, $4)
         on conflict (organization_id, group_name) do update
         set role = excluded.role, granted_at = excluded.granted_at
         returning organization_id, group_name, role, granted_at",
    )
    .bind(organization_id)
    .bind(group_name)
    .bind(role)
    .bind(granted_at)
    .fetch_one(connection)
    .await?;
    Ok(OrgGroupRoleMapping {
        organization_id: row.get("organization_id"),
        group_name: row.get("group_name"),
        role: row.get("role"),
        granted_at: row.get("granted_at"),
    })
}

pub(crate) async fn delete_organization_mapping(
    connection: &mut PgConnection,
    organization_id: Uuid,
    group_name: &str,
) -> Result<bool, sqlx::Error> {
    Ok(sqlx::query(
        "delete from org_oidc_group_role_mappings
         where organization_id = $1 and group_name = $2",
    )
    .bind(organization_id)
    .bind(group_name)
    .execute(connection)
    .await?
    .rows_affected()
        > 0)
}
