//! Personal access token persistence.

use super::personal_token_model::PersonalAccessTokenInfo;
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};
use uuid::Uuid;

pub(crate) struct InsertPersonalAccessTokenRecord<'a> {
    pub id: Uuid,
    pub user_id: Uuid,
    pub label: &'a str,
    pub token_prefix: &'a str,
    pub token_fingerprint: &'a [u8],
    pub created_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
}

pub(crate) async fn list(
    db: &PgPool,
    user_id: Uuid,
) -> Result<Vec<PersonalAccessTokenInfo>, sqlx::Error> {
    let rows = sqlx::query(
        "select id, label, token_prefix, created_at, expires_at, last_used_at, revoked_at
         from personal_access_tokens
         where user_id = $1
         order by created_at desc",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| PersonalAccessTokenInfo {
            id: row.get("id"),
            label: row.get("label"),
            token_prefix: row.get("token_prefix"),
            created_at: row.get("created_at"),
            expires_at: row.get("expires_at"),
            last_used_at: row.get("last_used_at"),
            revoked_at: row.get("revoked_at"),
        })
        .collect())
}

pub(crate) async fn insert(
    db: &PgPool,
    record: InsertPersonalAccessTokenRecord<'_>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into personal_access_tokens (id, user_id, label, token_prefix, token_fingerprint, created_at, expires_at, last_used_at, revoked_at)
         values ($1, $2, $3, $4, $5, $6, $7, null, null)",
    )
    .bind(record.id)
    .bind(record.user_id)
    .bind(record.label)
    .bind(record.token_prefix)
    .bind(record.token_fingerprint)
    .bind(record.created_at)
    .bind(record.expires_at)
    .execute(db)
    .await?;
    Ok(())
}

pub(crate) async fn revoke(
    db: &PgPool,
    token_id: Uuid,
    user_id: Uuid,
    revoked_at: DateTime<Utc>,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "update personal_access_tokens
         set revoked_at = $3
         where id = $1 and user_id = $2 and revoked_at is null",
    )
    .bind(token_id)
    .bind(user_id)
    .bind(revoked_at)
    .execute(db)
    .await?;
    Ok(result.rows_affected() > 0)
}

pub(crate) async fn authenticate_and_touch(
    db: &PgPool,
    token_fingerprint: &[u8],
    used_at: DateTime<Utc>,
) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar(
        "update personal_access_tokens
         set last_used_at = $2
         where token_fingerprint = $1
           and revoked_at is null
           and (expires_at is null or expires_at > now())
         returning user_id",
    )
    .bind(token_fingerprint)
    .bind(used_at)
    .fetch_optional(db)
    .await
}
