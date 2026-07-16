//! Loading and refreshing a user's credential for repository operations.

use super::super::provider::{ExternalGitProvider, RefreshTokenError};
use super::cipher::{decrypt_token, encrypt_token, TokenCipherError};
use super::{persistence, ExternalGitGrantStatus};
use chrono::Utc;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
pub(crate) enum AccessTokenPersistenceStage {
    LoadGrant,
    MarkMissingRefreshToken,
    MarkRejectedRefresh,
    StoreRefreshedGrant,
    ReloadConcurrentGrant,
}

#[derive(Debug, Error)]
pub(crate) enum ProviderAccessTokenError {
    #[error("external Git provider is not configured")]
    NotConfigured,
    #[error("external Git account is not connected")]
    NotConnected,
    #[error("external Git authorization must be renewed")]
    ReauthorizationRequired,
    #[error("external Git credential persistence failed during {stage:?}")]
    Persistence {
        stage: AccessTokenPersistenceStage,
        #[source]
        source: sqlx::Error,
    },
    #[error("external Git credential decryption or encryption failed")]
    Cipher {
        #[source]
        source: TokenCipherError,
    },
    #[error("external Git token refresh endpoint is unavailable")]
    RefreshUnavailable {
        #[source]
        source: RefreshTokenError,
    },
    #[error("external Git token refresh response is invalid")]
    InvalidRefreshResponse {
        #[source]
        source: RefreshTokenError,
    },
    #[error("concurrent external Git token refresh did not produce a usable credential")]
    ConcurrentRefreshUnavailable,
}

pub(crate) async fn provider_access_token(
    db: &PgPool,
    provider: Option<&ExternalGitProvider>,
    user_id: Uuid,
    force_refresh: bool,
) -> Result<String, ProviderAccessTokenError> {
    let provider = provider.ok_or(ProviderAccessTokenError::NotConfigured)?;
    let provider_id = provider.instance_id().clone();
    let grant = persistence::oauth_grant(db, user_id, &provider_id)
        .await
        .map_err(|source| ProviderAccessTokenError::Persistence {
            stage: AccessTokenPersistenceStage::LoadGrant,
            source,
        })?
        .ok_or(ProviderAccessTokenError::NotConnected)?;
    if grant.status != ExternalGitGrantStatus::Active {
        return Err(ProviderAccessTokenError::ReauthorizationRequired);
    }
    if !force_refresh
        && grant
            .expires_at
            .map(|value| value > Utc::now() + chrono::Duration::seconds(90))
            .unwrap_or(true)
    {
        return decrypt_token(provider, user_id, &grant.encrypted_access_token)
            .map_err(|source| ProviderAccessTokenError::Cipher { source });
    }

    let Some(encrypted_refresh_token) = grant.encrypted_refresh_token.as_deref() else {
        let marked = persistence::mark_grant_reauthorization_required_if_current(
            db,
            user_id,
            &provider_id,
            &grant.encrypted_access_token,
            None,
            "refresh_token_missing",
            Utc::now(),
        )
        .await
        .map_err(|source| ProviderAccessTokenError::Persistence {
            stage: AccessTokenPersistenceStage::MarkMissingRefreshToken,
            source,
        })?;
        return if marked {
            Err(ProviderAccessTokenError::ReauthorizationRequired)
        } else {
            access_token_after_concurrent_grant_update(db, provider, user_id).await
        };
    };
    let refresh_token = decrypt_token(provider, user_id, encrypted_refresh_token)
        .map_err(|source| ProviderAccessTokenError::Cipher { source })?;
    let refreshed = provider
        .refresh_access_token(&refresh_token, &grant.refresh_redirect_uri)
        .await;
    let refreshed = match refreshed {
        Ok(refreshed) => refreshed,
        Err(RefreshTokenError::Rejected { .. }) => {
            let marked = persistence::mark_grant_reauthorization_required_if_current(
                db,
                user_id,
                &provider_id,
                &grant.encrypted_access_token,
                grant.encrypted_refresh_token.as_deref(),
                "token_refresh_rejected",
                Utc::now(),
            )
            .await
            .map_err(|source| ProviderAccessTokenError::Persistence {
                stage: AccessTokenPersistenceStage::MarkRejectedRefresh,
                source,
            })?;
            return if marked {
                Err(ProviderAccessTokenError::ReauthorizationRequired)
            } else {
                access_token_after_concurrent_grant_update(db, provider, user_id).await
            };
        }
        Err(source @ RefreshTokenError::Transport { .. })
        | Err(source @ RefreshTokenError::UnexpectedStatus { .. }) => {
            return Err(ProviderAccessTokenError::RefreshUnavailable { source });
        }
        Err(source @ RefreshTokenError::InvalidResponse { .. }) => {
            return Err(ProviderAccessTokenError::InvalidRefreshResponse { source });
        }
    };
    let encrypted_access_token = encrypt_token(provider, user_id, &refreshed.access_token)
        .map_err(|source| ProviderAccessTokenError::Cipher { source })?;
    let rotated_refresh_token = refreshed.refresh_token.unwrap_or(refresh_token);
    let encrypted_refresh_token = encrypt_token(provider, user_id, &rotated_refresh_token)
        .map_err(|source| ProviderAccessTokenError::Cipher { source })?;
    let expires_at = refreshed
        .expires_in
        .map(|seconds| Utc::now() + chrono::Duration::seconds(seconds.max(0)));
    let updated = persistence::update_refreshed_oauth_grant(
        db,
        persistence::RefreshedOAuthGrantRecord {
            user_id,
            provider_instance_id: &provider_id,
            previous_encrypted_access_token: &grant.encrypted_access_token,
            previous_encrypted_refresh_token: grant.encrypted_refresh_token.as_deref(),
            encrypted_access_token,
            encrypted_refresh_token,
            expires_at,
            scopes: refreshed.scopes,
            now: Utc::now(),
        },
    )
    .await
    .map_err(|source| ProviderAccessTokenError::Persistence {
        stage: AccessTokenPersistenceStage::StoreRefreshedGrant,
        source,
    })?;
    if updated {
        Ok(refreshed.access_token)
    } else {
        access_token_after_concurrent_grant_update(db, provider, user_id).await
    }
}

async fn access_token_after_concurrent_grant_update(
    db: &PgPool,
    provider: &ExternalGitProvider,
    user_id: Uuid,
) -> Result<String, ProviderAccessTokenError> {
    let grant = persistence::oauth_grant(db, user_id, provider.instance_id())
        .await
        .map_err(|source| ProviderAccessTokenError::Persistence {
            stage: AccessTokenPersistenceStage::ReloadConcurrentGrant,
            source,
        })?
        .ok_or(ProviderAccessTokenError::NotConnected)?;
    if grant.status != ExternalGitGrantStatus::Active {
        return Err(ProviderAccessTokenError::ReauthorizationRequired);
    }
    if grant
        .expires_at
        .is_some_and(|expires_at| expires_at <= Utc::now() + chrono::Duration::seconds(30))
    {
        return Err(ProviderAccessTokenError::ConcurrentRefreshUnavailable);
    }
    decrypt_token(provider, user_id, &grant.encrypted_access_token)
        .map_err(|source| ProviderAccessTokenError::Cipher { source })
}

pub(crate) async fn mark_provider_reauth_required(
    db: &PgPool,
    provider: Option<&ExternalGitProvider>,
    user_id: Uuid,
    reason: &str,
) {
    let Some(provider_id) = provider.map(|provider| provider.instance_id().clone()) else {
        return;
    };
    if let Err(database_error) = persistence::mark_grant_reauthorization_required_in_pool(
        db,
        user_id,
        &provider_id,
        reason,
        Utc::now(),
    )
    .await
    {
        tracing::error!(
            %database_error,
            %user_id,
            provider = %provider_id,
            reason,
            "external Git reauthorization state update failed"
        );
    }
}
