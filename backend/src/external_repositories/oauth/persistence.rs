//! Persistence for one-time external Git OAuth attempts.

use super::ExternalGitOAuthPurpose;
use crate::external_repositories::provider::ProviderInstanceId;
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};
use uuid::Uuid;

pub(super) struct ConsumedOAuthAttempt {
    pub provider_instance_id: ProviderInstanceId,
    pub purpose: ExternalGitOAuthPurpose,
    pub user_id: Option<Uuid>,
    pub return_to: String,
}

pub(super) struct NewOAuthAttempt<'a> {
    pub state: &'a str,
    pub provider_instance_id: &'a ProviderInstanceId,
    pub purpose: ExternalGitOAuthPurpose,
    pub user_id: Option<Uuid>,
    pub return_to: &'a str,
    pub now: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

pub(super) async fn create_oauth_attempt(
    db: &PgPool,
    attempt: NewOAuthAttempt<'_>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "with expired as (
             delete from external_git_oauth_attempts where expires_at <= $1
         )
         insert into external_git_oauth_attempts (
             state, provider_instance_id, purpose, user_id, return_to, expires_at, created_at
         ) values ($2, $3, $4, $5, $6, $7, $1)",
    )
    .bind(attempt.now)
    .bind(attempt.state)
    .bind(attempt.provider_instance_id)
    .bind(attempt.purpose)
    .bind(attempt.user_id)
    .bind(attempt.return_to)
    .bind(attempt.expires_at)
    .execute(db)
    .await?;
    Ok(())
}

pub(super) async fn consume_oauth_attempt(
    db: &PgPool,
    state: &str,
    now: DateTime<Utc>,
) -> Result<Option<ConsumedOAuthAttempt>, sqlx::Error> {
    let row = sqlx::query(
        "delete from external_git_oauth_attempts
         where state = $1 and expires_at > $2
         returning provider_instance_id, purpose, user_id, return_to",
    )
    .bind(state)
    .bind(now)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| ConsumedOAuthAttempt {
        provider_instance_id: row.get("provider_instance_id"),
        purpose: row.get("purpose"),
        user_id: row.get("user_id"),
        return_to: row.get("return_to"),
    }))
}
