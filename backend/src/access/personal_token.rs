//! Personal access token lifecycle and authentication.

use super::personal_token_model::{CreatedPersonalAccessToken, PersonalAccessTokenInfo};
use super::personal_token_persistence;
use chrono::{DateTime, Utc};
use rand::distr::{Alphanumeric, SampleString};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

pub(crate) async fn list_personal_access_tokens(
    db: &PgPool,
    user_id: Uuid,
) -> Result<Vec<PersonalAccessTokenInfo>, sqlx::Error> {
    personal_token_persistence::list(db, user_id).await
}

#[derive(Debug, Error)]
pub(crate) enum CreatePersonalAccessTokenError {
    #[error("personal access token label is empty")]
    EmptyLabel,
    #[error("personal access token expiration must be in the future")]
    ExpirationNotFuture,
    #[error("personal access token {token_id} could not be persisted for user {user_id}")]
    Persistence {
        token_id: Uuid,
        user_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

pub(crate) async fn create_personal_access_token(
    db: &PgPool,
    user_id: Uuid,
    label: &str,
    expires_at: Option<DateTime<Utc>>,
) -> Result<CreatedPersonalAccessToken, CreatePersonalAccessTokenError> {
    let created_at = Utc::now();
    let label = validate_creation(label, expires_at, created_at)?;
    let id = Uuid::new_v4();
    let token = format!("tpat_{}", Alphanumeric.sample_string(&mut rand::rng(), 40));
    let token_prefix = token.chars().take(12).collect::<String>();
    let token_fingerprint = Sha256::digest(token.as_bytes());
    personal_token_persistence::insert(
        db,
        personal_token_persistence::InsertPersonalAccessTokenRecord {
            id,
            user_id,
            label,
            token_prefix: &token_prefix,
            token_fingerprint: token_fingerprint.as_ref(),
            created_at,
            expires_at,
        },
    )
    .await
    .map_err(|source| CreatePersonalAccessTokenError::Persistence {
        token_id: id,
        user_id,
        source,
    })?;
    Ok(CreatedPersonalAccessToken {
        id,
        label: label.to_string(),
        token,
        token_prefix,
        created_at,
        expires_at,
    })
}

fn validate_creation(
    label: &str,
    expires_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
) -> Result<&str, CreatePersonalAccessTokenError> {
    let label = label.trim();
    if label.is_empty() {
        return Err(CreatePersonalAccessTokenError::EmptyLabel);
    }
    if expires_at.is_some_and(|value| value <= created_at) {
        return Err(CreatePersonalAccessTokenError::ExpirationNotFuture);
    }
    Ok(label)
}

#[derive(Debug, Error)]
pub(crate) enum RevokePersonalAccessTokenError {
    #[error("personal access token {token_id} was not found for user {user_id}")]
    NotFound { token_id: Uuid, user_id: Uuid },
    #[error("personal access token {token_id} could not be revoked for user {user_id}")]
    Persistence {
        token_id: Uuid,
        user_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

pub(crate) async fn revoke_personal_access_token(
    db: &PgPool,
    user_id: Uuid,
    token_id: Uuid,
) -> Result<(), RevokePersonalAccessTokenError> {
    let revoked = personal_token_persistence::revoke(db, token_id, user_id, Utc::now())
        .await
        .map_err(|source| RevokePersonalAccessTokenError::Persistence {
            token_id,
            user_id,
            source,
        })?;
    if revoked {
        Ok(())
    } else {
        Err(RevokePersonalAccessTokenError::NotFound { token_id, user_id })
    }
}

pub(crate) async fn authenticate_personal_access_token(
    db: &PgPool,
    token: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    let token_fingerprint = Sha256::digest(token.as_bytes());
    personal_token_persistence::authenticate_and_touch(db, token_fingerprint.as_ref(), Utc::now())
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    #[test]
    fn token_creation_trims_labels_and_requires_future_expiration() {
        let created_at = Utc::now();
        assert_eq!(
            validate_creation(
                "  workstation  ",
                Some(created_at + Duration::hours(1)),
                created_at,
            )
            .ok(),
            Some("workstation")
        );
        assert!(matches!(
            validate_creation("  ", None, created_at),
            Err(CreatePersonalAccessTokenError::EmptyLabel)
        ));
        assert!(matches!(
            validate_creation("workstation", Some(created_at), created_at),
            Err(CreatePersonalAccessTokenError::ExpirationNotFuture)
        ));
    }
}
