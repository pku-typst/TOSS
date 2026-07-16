//! Persistence for accounts authenticated by external identity authorities.

use super::federated_account::{LoginAuthorityKind, RemoveFederatedIdentityOutcome};
use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

pub(super) struct FederatedUserWrite<'value> {
    pub id: Uuid,
    pub email: &'value str,
    pub username: &'value str,
    pub display_name: &'value str,
    pub created_at: DateTime<Utc>,
    pub authority_kind: LoginAuthorityKind,
    pub authority_id: &'value str,
    pub subject: &'value str,
}

pub(super) async fn insert_user_with_identity(
    connection: &mut PgConnection,
    user: &FederatedUserWrite<'_>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into users (id, email, username, display_name, created_at)
         values ($1, $2, $3, $4, $5)",
    )
    .bind(user.id)
    .bind(user.email)
    .bind(user.username)
    .bind(user.display_name)
    .bind(user.created_at)
    .execute(&mut *connection)
    .await?;
    sqlx::query(
        "insert into user_login_identities (
             user_id, authority_kind, authority_id, subject,
             created_at, last_authenticated_at
         ) values ($1, $2, $3, $4, $5, $5)",
    )
    .bind(user.id)
    .bind(user.authority_kind)
    .bind(user.authority_id)
    .bind(user.subject)
    .bind(user.created_at)
    .execute(connection)
    .await?;
    Ok(())
}

pub(super) async fn user_id(
    db: &PgPool,
    authority_kind: LoginAuthorityKind,
    authority_id: &str,
    subject: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar(
        "select user_id from user_login_identities
         where authority_kind = $1 and authority_id = $2 and subject = $3",
    )
    .bind(authority_kind)
    .bind(authority_id)
    .bind(subject)
    .fetch_optional(db)
    .await
}

pub(super) async fn touch_identity(
    db: &PgPool,
    user_id: Uuid,
    authority_kind: LoginAuthorityKind,
    authority_id: &str,
    subject: &str,
    authenticated_at: DateTime<Utc>,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "update user_login_identities
         set last_authenticated_at = $5
         where user_id = $1 and authority_kind = $2
           and authority_id = $3 and subject = $4",
    )
    .bind(user_id)
    .bind(authority_kind)
    .bind(authority_id)
    .bind(subject)
    .bind(authenticated_at)
    .execute(db)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub(super) async fn bind_identity(
    connection: &mut PgConnection,
    user_id: Uuid,
    authority_kind: LoginAuthorityKind,
    authority_id: &str,
    subject: &str,
    now: DateTime<Utc>,
) -> Result<bool, sqlx::Error> {
    let _: Uuid = sqlx::query_scalar("select id from users where id = $1 for update")
        .bind(user_id)
        .fetch_one(&mut *connection)
        .await?;
    let result = sqlx::query(
        "insert into user_login_identities (
             user_id, authority_kind, authority_id, subject,
             created_at, last_authenticated_at
         ) values ($1, $2, $3, $4, $5, $5)
         on conflict (authority_kind, authority_id, subject) do update
         set last_authenticated_at = excluded.last_authenticated_at
         where user_login_identities.user_id = excluded.user_id",
    )
    .bind(user_id)
    .bind(authority_kind)
    .bind(authority_id)
    .bind(subject)
    .bind(now)
    .execute(connection)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub(super) async fn remove_identity_if_redundant(
    connection: &mut PgConnection,
    user_id: Uuid,
    authority_kind: LoginAuthorityKind,
    authority_id: &str,
    subject: &str,
) -> Result<RemoveFederatedIdentityOutcome, sqlx::Error> {
    let _: Uuid = sqlx::query_scalar("select id from users where id = $1 for update")
        .bind(user_id)
        .fetch_one(&mut *connection)
        .await?;
    let identity_exists: bool = sqlx::query_scalar(
        "select exists(
             select 1 from user_login_identities
             where user_id = $1 and authority_kind = $2
               and authority_id = $3 and subject = $4
         )",
    )
    .bind(user_id)
    .bind(authority_kind)
    .bind(authority_id)
    .bind(subject)
    .fetch_one(&mut *connection)
    .await?;
    if !identity_exists {
        return Ok(RemoveFederatedIdentityOutcome::NotBound);
    }
    let other_login_methods: i64 = sqlx::query_scalar(
        "select
             (select count(*) from user_login_identities
              where user_id = $1
                and not (authority_kind = $2 and authority_id = $3 and subject = $4))
           + (select count(*) from local_accounts where user_id = $1)",
    )
    .bind(user_id)
    .bind(authority_kind)
    .bind(authority_id)
    .bind(subject)
    .fetch_one(&mut *connection)
    .await?;
    if other_login_methods == 0 {
        return Ok(RemoveFederatedIdentityOutcome::LastLoginMethod);
    }
    sqlx::query(
        "delete from user_login_identities
         where user_id = $1 and authority_kind = $2
           and authority_id = $3 and subject = $4",
    )
    .bind(user_id)
    .bind(authority_kind)
    .bind(authority_id)
    .bind(subject)
    .execute(connection)
    .await?;
    Ok(RemoveFederatedIdentityOutcome::Removed)
}
