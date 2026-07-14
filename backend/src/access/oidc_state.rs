//! One-time OIDC callback state lifecycle.

use super::oidc_persistence;
use chrono::Utc;
use sqlx::PgPool;
use thiserror::Error;

#[derive(Clone, Copy, Debug)]
pub(crate) enum OidcStateOperation {
    Create,
    Consume,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum OidcStateStage {
    Begin,
    DeleteExpired,
    Write,
    Commit,
}

#[derive(Debug, Error)]
#[error("OIDC state {operation:?} failed during {stage:?}")]
pub(crate) struct OidcStateStoreError {
    operation: OidcStateOperation,
    stage: OidcStateStage,
    #[source]
    source: sqlx::Error,
}

pub(crate) async fn create_oidc_state(
    db: &PgPool,
    state: &str,
    nonce: &str,
) -> Result<(), OidcStateStoreError> {
    let mut transaction = db.begin().await.map_err(|source| OidcStateStoreError {
        operation: OidcStateOperation::Create,
        stage: OidcStateStage::Begin,
        source,
    })?;
    oidc_persistence::delete_expired_states(&mut transaction)
        .await
        .map_err(|source| OidcStateStoreError {
            operation: OidcStateOperation::Create,
            stage: OidcStateStage::DeleteExpired,
            source,
        })?;
    oidc_persistence::upsert_state(&mut transaction, state, nonce, Utc::now())
        .await
        .map_err(|source| OidcStateStoreError {
            operation: OidcStateOperation::Create,
            stage: OidcStateStage::Write,
            source,
        })?;
    transaction
        .commit()
        .await
        .map_err(|source| OidcStateStoreError {
            operation: OidcStateOperation::Create,
            stage: OidcStateStage::Commit,
            source,
        })
}

pub(crate) async fn consume_oidc_state(
    db: &PgPool,
    state: &str,
) -> Result<Option<String>, OidcStateStoreError> {
    let mut transaction = db.begin().await.map_err(|source| OidcStateStoreError {
        operation: OidcStateOperation::Consume,
        stage: OidcStateStage::Begin,
        source,
    })?;
    let nonce = oidc_persistence::consume_state(&mut transaction, state)
        .await
        .map_err(|source| OidcStateStoreError {
            operation: OidcStateOperation::Consume,
            stage: OidcStateStage::Write,
            source,
        })?;
    transaction
        .commit()
        .await
        .map_err(|source| OidcStateStoreError {
            operation: OidcStateOperation::Consume,
            stage: OidcStateStage::Commit,
            source,
        })?;
    Ok(nonce)
}
