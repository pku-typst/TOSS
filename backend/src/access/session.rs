//! Authenticated session lookup, issuance, and revocation.

use super::session_persistence;
use chrono::Utc;
use rand::distr::{Alphanumeric, SampleString};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

pub(crate) struct AuthenticatedUser {
    pub id: Uuid,
    pub email: String,
    pub username: String,
    pub display_name: String,
}

pub(crate) async fn authenticated_user(
    db: &PgPool,
    user_id: Uuid,
) -> Result<Option<AuthenticatedUser>, sqlx::Error> {
    Ok(session_persistence::find_user(db, user_id)
        .await?
        .map(|user| AuthenticatedUser {
            id: user.id,
            email: user.email,
            username: user.username,
            display_name: user.display_name,
        }))
}

pub(crate) struct IssueSessionCommand<'value> {
    pub user_id: Uuid,
    pub user_agent: &'value str,
    pub ip_address: &'value str,
}

#[derive(Clone, Copy, Debug)]
enum IssueSessionStage {
    Begin,
    Insert,
    Commit,
}

#[derive(Debug, Error)]
#[error("session persistence failed during {stage:?} for user {user_id}")]
pub(crate) struct IssueSessionError {
    stage: IssueSessionStage,
    user_id: Uuid,
    #[source]
    source: sqlx::Error,
}

pub(crate) async fn issue_session(
    db: &PgPool,
    command: IssueSessionCommand<'_>,
) -> Result<String, IssueSessionError> {
    let token = Alphanumeric.sample_string(&mut rand::rng(), 48);
    let token_fingerprint = Sha256::digest(token.as_bytes());
    let issued_at = Utc::now();
    let expires_at = issued_at + chrono::Duration::hours(12);
    let mut transaction = db.begin().await.map_err(|source| IssueSessionError {
        stage: IssueSessionStage::Begin,
        user_id: command.user_id,
        source,
    })?;
    session_persistence::insert_session(
        &mut transaction,
        &session_persistence::SessionWrite {
            token_fingerprint: token_fingerprint.as_ref(),
            user_id: command.user_id,
            issued_at,
            expires_at,
            user_agent: command.user_agent,
            ip_address: command.ip_address,
        },
    )
    .await
    .map_err(|source| IssueSessionError {
        stage: IssueSessionStage::Insert,
        user_id: command.user_id,
        source,
    })?;
    transaction
        .commit()
        .await
        .map_err(|source| IssueSessionError {
            stage: IssueSessionStage::Commit,
            user_id: command.user_id,
            source,
        })?;
    Ok(token)
}

pub(crate) async fn revoke_session(db: &PgPool, token: &str) -> Result<(), sqlx::Error> {
    let token_fingerprint = Sha256::digest(token.as_bytes());
    let mut transaction = db.begin().await?;
    session_persistence::delete_session(&mut transaction, token_fingerprint.as_ref()).await?;
    transaction.commit().await
}
