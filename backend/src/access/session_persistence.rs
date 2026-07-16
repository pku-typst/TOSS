//! Authenticated account and session persistence.

use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

pub(crate) struct AuthenticatedUserRecord {
    pub id: Uuid,
    pub email: String,
    pub username: String,
    pub display_name: String,
}

pub(crate) async fn find_user(
    db: &PgPool,
    user_id: Uuid,
) -> Result<Option<AuthenticatedUserRecord>, sqlx::Error> {
    let row = sqlx::query(
        "select id, email, username, display_name
         from users
         where id = $1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|value| AuthenticatedUserRecord {
        id: value.get("id"),
        email: value.get("email"),
        username: value.get("username"),
        display_name: value.get("display_name"),
    }))
}

pub(crate) struct SessionWrite<'value> {
    pub token_fingerprint: &'value [u8],
    pub user_id: Uuid,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub user_agent: &'value str,
    pub ip_address: &'value str,
}

pub(crate) async fn insert_session(
    connection: &mut PgConnection,
    session: &SessionWrite<'_>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into auth_sessions
           (session_token_fingerprint, user_id, issued_at, expires_at, user_agent, ip_address)
         values ($1, $2, $3, $4, $5, $6)",
    )
    .bind(session.token_fingerprint)
    .bind(session.user_id)
    .bind(session.issued_at)
    .bind(session.expires_at)
    .bind(session.user_agent)
    .bind(session.ip_address)
    .execute(connection)
    .await?;
    Ok(())
}

pub(crate) async fn delete_session(
    connection: &mut PgConnection,
    token_fingerprint: &[u8],
) -> Result<(), sqlx::Error> {
    sqlx::query("delete from auth_sessions where session_token_fingerprint = $1")
        .bind(token_fingerprint)
        .execute(connection)
        .await?;
    Ok(())
}

pub(crate) async fn session_user_id(
    db: &PgPool,
    token_fingerprint: &[u8],
) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar(
        "select user_id
         from auth_sessions
         where session_token_fingerprint = $1 and expires_at > now()",
    )
    .bind(token_fingerprint)
    .fetch_optional(db)
    .await
}
