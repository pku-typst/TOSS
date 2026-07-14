//! Project share-link and anonymous guest-session persistence.

use super::sharing_model::{ProjectShareLink, ResolvedProjectShareLink};
use super::ProjectPermission;
use chrono::{DateTime, Utc};
use sqlx::postgres::PgRow;
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

fn share_link_from_row(row: &PgRow) -> Result<ProjectShareLink, sqlx::Error> {
    Ok(ProjectShareLink {
        id: row.try_get("id")?,
        project_id: row.try_get("project_id")?,
        token_prefix: row.try_get("token_prefix")?,
        token_value: row.try_get("token_value")?,
        permission: row.try_get("permission")?,
        created_by: row.try_get("created_by")?,
        created_at: row.try_get("created_at")?,
        expires_at: row.try_get("expires_at")?,
        revoked_at: row.try_get("revoked_at")?,
    })
}

pub(crate) async fn share_link_permission(
    db: &PgPool,
    project_id: Uuid,
    token_value: &str,
) -> Result<Option<ProjectPermission>, sqlx::Error> {
    sqlx::query_scalar(
        "select permission
         from project_share_links
         where project_id = $1
           and token_value = $2
           and revoked_at is null
           and (expires_at is null or expires_at > now())
         limit 1",
    )
    .bind(project_id)
    .bind(token_value)
    .fetch_optional(db)
    .await
}

pub(crate) struct GuestSessionAccess {
    pub session_id: Uuid,
    pub display_name: String,
    pub permission: ProjectPermission,
}

pub(crate) async fn guest_session_access(
    db: &PgPool,
    project_id: Uuid,
    session_token_fingerprint: &[u8],
) -> Result<Option<GuestSessionAccess>, sqlx::Error> {
    let row = sqlx::query(
        "select session.id, session.display_name, session.permission
         from anonymous_share_sessions session
         join project_share_links link on link.id = session.share_link_id
         where session.project_id = $1
           and session.session_token_fingerprint = $2
           and (session.expires_at is null or session.expires_at > now())
           and link.revoked_at is null
           and (link.expires_at is null or link.expires_at > now())
         limit 1",
    )
    .bind(project_id)
    .bind(session_token_fingerprint)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|value| GuestSessionAccess {
        session_id: value.get("id"),
        display_name: value.get("display_name"),
        permission: value.get("permission"),
    }))
}

pub(crate) async fn touch_guest_session(
    db: &PgPool,
    session_id: Uuid,
    last_used_at: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update anonymous_share_sessions
         set last_used_at = $2
         where id = $1",
    )
    .bind(session_id)
    .bind(last_used_at)
    .execute(db)
    .await?;
    Ok(())
}

pub(crate) async fn list_active(
    db: &PgPool,
    project_id: Uuid,
    include_write_links: bool,
) -> Result<Vec<ProjectShareLink>, sqlx::Error> {
    let rows = sqlx::query(
        "select id, project_id, token_prefix, token_value, permission, created_by,
                created_at, expires_at, revoked_at
         from project_share_links
         where project_id = $1
           and revoked_at is null
           and ($2::boolean = true or permission = 'read')
         order by permission asc",
    )
    .bind(project_id)
    .bind(include_write_links)
    .fetch_all(db)
    .await?;
    rows.iter().map(share_link_from_row).collect()
}

pub(crate) struct ShareLinkWrite<'value> {
    pub id: Uuid,
    pub project_id: Uuid,
    pub token_prefix: &'value str,
    pub token_value: &'value str,
    pub permission: ProjectPermission,
    pub created_by: Uuid,
    pub created_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
}

pub(crate) struct UpsertedShareLink {
    pub link: ProjectShareLink,
    pub inserted: bool,
}

pub(crate) async fn upsert_active(
    connection: &mut PgConnection,
    value: &ShareLinkWrite<'_>,
) -> Result<UpsertedShareLink, sqlx::Error> {
    let row = sqlx::query(
        "insert into project_share_links
           (id, project_id, token_prefix, token_value, permission, created_by,
            created_at, expires_at, revoked_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, null)
         on conflict (project_id, permission) where revoked_at is null do update
         set created_by = excluded.created_by,
             created_at = excluded.created_at,
             expires_at = excluded.expires_at
         returning id, project_id, token_prefix, token_value, permission, created_by,
                   created_at, expires_at, revoked_at, (xmax = 0) as inserted",
    )
    .bind(value.id)
    .bind(value.project_id)
    .bind(value.token_prefix)
    .bind(value.token_value)
    .bind(value.permission)
    .bind(value.created_by)
    .bind(value.created_at)
    .bind(value.expires_at)
    .fetch_one(connection)
    .await?;
    Ok(UpsertedShareLink {
        link: share_link_from_row(&row)?,
        inserted: row.try_get("inserted")?,
    })
}

pub(crate) async fn revoke(
    connection: &mut PgConnection,
    project_id: Uuid,
    share_link_id: Uuid,
    revoked_at: DateTime<Utc>,
) -> Result<bool, sqlx::Error> {
    Ok(sqlx::query(
        "update project_share_links
         set revoked_at = $3
         where id = $1 and project_id = $2 and revoked_at is null",
    )
    .bind(share_link_id)
    .bind(project_id)
    .bind(revoked_at)
    .execute(connection)
    .await?
    .rows_affected()
        > 0)
}

pub(crate) struct ShareLinkGrant {
    pub project_id: Uuid,
    pub permission: ProjectPermission,
}

pub(crate) async fn find_valid_grant_for_update(
    connection: &mut PgConnection,
    token_value: &str,
) -> Result<Option<ShareLinkGrant>, sqlx::Error> {
    let row = sqlx::query(
        "select project_id, permission
         from project_share_links
         where token_value = $1
           and revoked_at is null
           and (expires_at is null or expires_at > now())
         for share",
    )
    .bind(token_value)
    .fetch_optional(connection)
    .await?;
    row.map(|value| {
        Ok(ShareLinkGrant {
            project_id: value.try_get("project_id")?,
            permission: value.try_get("permission")?,
        })
    })
    .transpose()
}

pub(crate) async fn resolve_valid(
    db: &PgPool,
    token_value: &str,
) -> Result<Option<ResolvedProjectShareLink>, sqlx::Error> {
    let row = sqlx::query(
        "select project_id, permission
         from project_share_links
         where token_value = $1
           and revoked_at is null
           and (expires_at is null or expires_at > now())",
    )
    .bind(token_value)
    .fetch_optional(db)
    .await?;
    row.map(|value| {
        Ok(ResolvedProjectShareLink {
            project_id: value.try_get("project_id")?,
            permission: value.try_get("permission")?,
        })
    })
    .transpose()
}

pub(crate) async fn temporary_share_project_id(
    connection: &mut PgConnection,
    token_value: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar(
        "select project_id
         from project_share_links
         where token_value = $1
           and revoked_at is null
           and (expires_at is null or expires_at > now())",
    )
    .bind(token_value)
    .fetch_optional(connection)
    .await
}

pub(crate) struct TemporaryShareTarget {
    pub share_link_id: Uuid,
    pub permission: ProjectPermission,
}

pub(crate) async fn lock_temporary_share_target(
    connection: &mut PgConnection,
    token_value: &str,
    project_id: Uuid,
) -> Result<Option<TemporaryShareTarget>, sqlx::Error> {
    let row = sqlx::query(
        "select id, permission
         from project_share_links
         where token_value = $1
           and project_id = $2
           and revoked_at is null
           and (expires_at is null or expires_at > now())
         for share",
    )
    .bind(token_value)
    .bind(project_id)
    .fetch_optional(connection)
    .await?;
    row.map(|value| {
        Ok(TemporaryShareTarget {
            share_link_id: value.try_get("id")?,
            permission: value.try_get("permission")?,
        })
    })
    .transpose()
}

pub(super) async fn revoke_project_temporary_sessions(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("delete from anonymous_share_sessions where project_id = $1")
        .bind(project_id)
        .execute(connection)
        .await?;
    Ok(())
}

pub(crate) struct AnonymousShareSessionWrite<'value> {
    pub id: Uuid,
    pub project_id: Uuid,
    pub share_link_id: Uuid,
    pub session_token_fingerprint: &'value [u8],
    pub display_name: &'value str,
    pub permission: ProjectPermission,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

pub(crate) async fn insert_anonymous_session(
    connection: &mut PgConnection,
    value: &AnonymousShareSessionWrite<'_>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into anonymous_share_sessions
           (id, project_id, share_link_id, session_token_fingerprint, display_name, permission,
            created_at, expires_at, last_used_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $7)",
    )
    .bind(value.id)
    .bind(value.project_id)
    .bind(value.share_link_id)
    .bind(value.session_token_fingerprint)
    .bind(value.display_name)
    .bind(value.permission)
    .bind(value.created_at)
    .bind(value.expires_at)
    .execute(connection)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{upsert_active, ShareLinkWrite};
    use crate::access::grant_model::ProjectRoleSource;
    use crate::access::{ProjectPermission, ProjectRole};
    use chrono::Utc;
    use sqlx::PgPool;
    use uuid::Uuid;

    async fn migrated_test_pool() -> Result<Option<PgPool>, Box<dyn std::error::Error + Send + Sync>>
    {
        let database_url =
            std::env::var("TEST_DATABASE_URL").or_else(|_| std::env::var("DATABASE_URL"));
        let Ok(database_url) = database_url else {
            return Ok(None);
        };
        let pool = PgPool::connect(&database_url).await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Some(pool))
    }

    #[tokio::test]
    async fn active_link_upsert_preserves_token_and_role_grants_do_not_downgrade(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let owner_user_id = Uuid::new_v4();
        let member_user_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        let now = Utc::now();
        let mut transaction = pool.begin().await?;
        for (user_id, label) in [(owner_user_id, "owner"), (member_user_id, "member")] {
            let suffix = user_id
                .simple()
                .to_string()
                .chars()
                .take(8)
                .collect::<String>();
            sqlx::query(
                "insert into users (id, email, username, display_name, created_at)
                 values ($1, $2, $3, $4, $5)",
            )
            .bind(user_id)
            .bind(format!("{label}-{user_id}@example.test"))
            .bind(format!("{label}-{suffix}"))
            .bind(label)
            .bind(now)
            .execute(&mut *transaction)
            .await?;
        }
        sqlx::query(
            "insert into projects (id, owner_user_id, name, created_at, project_type)
             values ($1, $2, $3, $4, 'typst')",
        )
        .bind(project_id)
        .bind(owner_user_id)
        .bind("sharing integration test")
        .bind(now)
        .execute(&mut *transaction)
        .await?;

        let first_link_id = Uuid::new_v4();
        let first_token = format!("psh_{}", Uuid::new_v4().simple());
        let first_prefix = first_token.chars().take(12).collect::<String>();
        let first = upsert_active(
            &mut transaction,
            &ShareLinkWrite {
                id: first_link_id,
                project_id,
                token_prefix: &first_prefix,
                token_value: &first_token,
                permission: ProjectPermission::Write,
                created_by: owner_user_id,
                created_at: now,
                expires_at: None,
            },
        )
        .await?;
        assert!(first.inserted);
        assert_eq!(first.link.id, first_link_id);
        assert_eq!(first.link.token_value, first_token);

        let replacement_token = format!("psh_{}", Uuid::new_v4().simple());
        let replacement_prefix = replacement_token.chars().take(12).collect::<String>();
        let second = upsert_active(
            &mut transaction,
            &ShareLinkWrite {
                id: Uuid::new_v4(),
                project_id,
                token_prefix: &replacement_prefix,
                token_value: &replacement_token,
                permission: ProjectPermission::Write,
                created_by: owner_user_id,
                created_at: now,
                expires_at: None,
            },
        )
        .await?;
        assert!(!second.inserted);
        assert_eq!(second.link.id, first_link_id);
        assert_eq!(second.link.token_value, first_token);

        let granted = crate::access::grant_project_share_link_role_at_least(
            &mut transaction,
            project_id,
            member_user_id,
            ProjectRole::ReadWrite,
            now,
        )
        .await?;
        assert_eq!(granted, ProjectRole::ReadWrite);
        let retained = crate::access::grant_project_share_link_role_at_least(
            &mut transaction,
            project_id,
            member_user_id,
            ProjectRole::ReadOnly,
            now,
        )
        .await?;
        assert_eq!(retained, ProjectRole::ReadWrite);
        let member_source = sqlx::query_scalar::<_, ProjectRoleSource>(
            "select source from project_roles where project_id = $1 and user_id = $2",
        )
        .bind(project_id)
        .bind(member_user_id)
        .fetch_one(&mut *transaction)
        .await?;
        assert_eq!(member_source, ProjectRoleSource::ShareLinkInvite);

        crate::access::grant_initial_project_owner(
            &mut transaction,
            project_id,
            owner_user_id,
            now,
        )
        .await?;
        let retained_owner = crate::access::grant_project_share_link_role_at_least(
            &mut transaction,
            project_id,
            owner_user_id,
            ProjectRole::ReadWrite,
            now,
        )
        .await?;
        assert_eq!(retained_owner, ProjectRole::Owner);
        let owner_source = sqlx::query_scalar::<_, ProjectRoleSource>(
            "select source from project_roles where project_id = $1 and user_id = $2",
        )
        .bind(project_id)
        .bind(owner_user_id)
        .fetch_one(&mut *transaction)
        .await?;
        assert_eq!(owner_source, ProjectRoleSource::DirectRole);

        transaction.rollback().await?;
        Ok(())
    }
}
