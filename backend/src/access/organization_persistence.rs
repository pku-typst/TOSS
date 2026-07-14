//! Organization catalog and membership persistence.

use super::organization_model::{Organization, OrganizationMembership};
use super::OrganizationRole;
use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

pub(crate) async fn list_memberships(
    db: &PgPool,
    user_id: Uuid,
) -> Result<Vec<OrganizationMembership>, sqlx::Error> {
    let rows = sqlx::query(
        "select o.id as organization_id, o.name as organization_name,
                om.role as membership_role,
                coalesce(om.joined_at, o.created_at) as joined_at
         from organizations o
         join organization_memberships om
           on om.organization_id = o.id and om.user_id = $1
         order by o.name asc",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| OrganizationMembership {
            organization_id: row.get("organization_id"),
            organization_name: row.get("organization_name"),
            membership_role: row.get("membership_role"),
            joined_at: row.get("joined_at"),
        })
        .collect())
}

pub(crate) async fn list_all(db: &PgPool) -> Result<Vec<Organization>, sqlx::Error> {
    let rows = sqlx::query("select id, name, created_at from organizations order by name asc")
        .fetch_all(db)
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| Organization {
            id: row.get("id"),
            name: row.get("name"),
            created_at: row.get("created_at"),
        })
        .collect())
}

pub(crate) async fn insert(
    connection: &mut PgConnection,
    id: Uuid,
    name: &str,
    created_at: DateTime<Utc>,
) -> Result<Organization, sqlx::Error> {
    let row = sqlx::query(
        "insert into organizations (id, name, created_at)
         values ($1, $2, $3)
         returning id, name, created_at",
    )
    .bind(id)
    .bind(name)
    .bind(created_at)
    .fetch_one(connection)
    .await?;
    Ok(Organization {
        id: row.get("id"),
        name: row.get("name"),
        created_at: row.get("created_at"),
    })
}

pub(crate) async fn organization_user_is_member(
    connection: &mut PgConnection,
    user_id: Uuid,
    organization_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let row = sqlx::query(
        "select 1
         from organization_memberships
         where user_id = $1 and organization_id = $2
         limit 1",
    )
    .bind(user_id)
    .bind(organization_id)
    .fetch_optional(connection)
    .await?;
    Ok(row.is_some())
}

pub(crate) async fn list_organization_membership_roles(
    connection: &mut PgConnection,
    user_id: Uuid,
) -> Result<Vec<(Uuid, OrganizationRole)>, sqlx::Error> {
    let rows = sqlx::query(
        "select organization_id, role
         from organization_memberships
         where user_id = $1",
    )
    .bind(user_id)
    .fetch_all(connection)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| (row.get("organization_id"), row.get("role")))
        .collect())
}

/// Upserts a membership while preventing implicit demotion of an existing owner.
pub(crate) async fn upsert_organization_membership_role(
    connection: &mut PgConnection,
    organization_id: Uuid,
    user_id: Uuid,
    role: OrganizationRole,
    joined_at: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into organization_memberships (organization_id, user_id, joined_at, role)
         values ($1, $2, $3, $4)
         on conflict (organization_id, user_id) do update
         set role = case
           when organization_memberships.role = 'owner' then organization_memberships.role
           else excluded.role
         end",
    )
    .bind(organization_id)
    .bind(user_id)
    .bind(joined_at)
    .bind(role)
    .execute(connection)
    .await?;
    Ok(())
}

pub(crate) async fn delete_non_owner_organization_membership(
    connection: &mut PgConnection,
    organization_id: Uuid,
    user_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "delete from organization_memberships
         where organization_id = $1 and user_id = $2 and role != 'owner'",
    )
    .bind(organization_id)
    .bind(user_id)
    .execute(connection)
    .await?;
    Ok(())
}

pub(crate) async fn user_is_owner(
    db: &PgPool,
    organization_id: Uuid,
    user_id: Uuid,
) -> Result<bool, sqlx::Error> {
    Ok(sqlx::query(
        "select 1
         from organization_memberships
         where organization_id = $1 and user_id = $2 and role = 'owner'
         limit 1",
    )
    .bind(organization_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .is_some())
}
