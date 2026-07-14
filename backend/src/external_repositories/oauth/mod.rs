//! One-time OAuth authorization attempts shared by sign-in and repository connection.

mod persistence;

use super::provider::{ExternalGitProvider, ProviderAuthorizationError, ProviderInstanceId};
use chrono::Utc;
use rand::distr::{Alphanumeric, SampleString};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Eq, PartialEq, sqlx::Type)]
#[sqlx(type_name = "text")]
pub(super) enum ExternalGitOAuthPurpose {
    #[sqlx(rename = "sign_in")]
    SignIn,
    #[sqlx(rename = "connect")]
    Connect,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ExternalGitOAuthIntent {
    SignIn,
    Connect { user_id: Uuid },
}

impl ExternalGitOAuthIntent {
    const fn persistence_fields(self) -> (ExternalGitOAuthPurpose, Option<Uuid>) {
        match self {
            Self::SignIn => (ExternalGitOAuthPurpose::SignIn, None),
            Self::Connect { user_id } => (ExternalGitOAuthPurpose::Connect, Some(user_id)),
        }
    }

    fn from_persistence(
        purpose: ExternalGitOAuthPurpose,
        user_id: Option<Uuid>,
    ) -> Result<Self, ExternalGitOAuthError> {
        match (purpose, user_id) {
            (ExternalGitOAuthPurpose::SignIn, None) => Ok(Self::SignIn),
            (ExternalGitOAuthPurpose::Connect, Some(user_id)) => Ok(Self::Connect { user_id }),
            _ => Err(ExternalGitOAuthError::InvalidPersistedIntent),
        }
    }
}

pub(crate) struct ExternalGitOAuthStart {
    pub state: String,
    pub authorization_url: String,
}

pub(crate) struct ExternalGitOAuthAttempt {
    pub intent: ExternalGitOAuthIntent,
    pub return_to: String,
}

#[derive(Debug, Error)]
pub(crate) enum ExternalGitOAuthError {
    #[error("external Git provider is not configured")]
    NotConfigured,
    #[error("external Git provider does not support the requested OAuth intent")]
    NotSupported,
    #[error("external Git OAuth state is invalid or expired")]
    InvalidState,
    #[error("external Git OAuth state contains an invalid persisted intent")]
    InvalidPersistedIntent,
    #[error("external Git OAuth state persistence failed")]
    Persistence {
        #[source]
        source: sqlx::Error,
    },
    #[error("external Git provider authorization failed")]
    Provider {
        #[source]
        source: ProviderAuthorizationError,
    },
}

pub(crate) fn safe_external_git_return_path(input: Option<&str>) -> String {
    let value = input.unwrap_or("/").trim();
    if value.is_empty()
        || value.len() > 2048
        || !value.starts_with('/')
        || value.starts_with("//")
        || value.contains('\\')
        || value.chars().any(char::is_control)
    {
        "/".to_string()
    } else {
        value.to_string()
    }
}

pub(crate) async fn begin_external_git_oauth(
    db: &PgPool,
    provider: Option<&ExternalGitProvider>,
    intent: ExternalGitOAuthIntent,
    return_to: Option<&str>,
) -> Result<ExternalGitOAuthStart, ExternalGitOAuthError> {
    let provider = provider.ok_or(ExternalGitOAuthError::NotConfigured)?;
    if matches!(intent, ExternalGitOAuthIntent::SignIn) && !provider.login_enabled() {
        return Err(ExternalGitOAuthError::NotSupported);
    }
    let state = Alphanumeric.sample_string(&mut rand::rng(), 48);
    let authorization_url = match intent {
        ExternalGitOAuthIntent::SignIn => provider.login_authorization_url(&state),
        ExternalGitOAuthIntent::Connect { .. } => provider.authorization_url(&state),
    }
    .map_err(|source| match source {
        ProviderAuthorizationError::NotSupported => ExternalGitOAuthError::NotSupported,
        source => ExternalGitOAuthError::Provider { source },
    })?;
    let now = Utc::now();
    let (purpose, user_id) = intent.persistence_fields();
    let return_to = safe_external_git_return_path(return_to);
    persistence::create_oauth_attempt(
        db,
        persistence::NewOAuthAttempt {
            state: &state,
            provider_instance_id: provider.instance_id(),
            purpose,
            user_id,
            return_to: &return_to,
            now,
            expires_at: now + chrono::Duration::minutes(10),
        },
    )
    .await
    .map_err(|source| ExternalGitOAuthError::Persistence { source })?;
    Ok(ExternalGitOAuthStart {
        state,
        authorization_url,
    })
}

pub(crate) async fn consume_external_git_oauth(
    db: &PgPool,
    provider_instance_id: &ProviderInstanceId,
    state: &str,
) -> Result<ExternalGitOAuthAttempt, ExternalGitOAuthError> {
    if state.trim().is_empty() {
        return Err(ExternalGitOAuthError::InvalidState);
    }
    let consumed = persistence::consume_oauth_attempt(db, state, Utc::now())
        .await
        .map_err(|source| ExternalGitOAuthError::Persistence { source })?
        .ok_or(ExternalGitOAuthError::InvalidState)?;
    if consumed.provider_instance_id != *provider_instance_id {
        return Err(ExternalGitOAuthError::InvalidState);
    }
    Ok(ExternalGitOAuthAttempt {
        intent: ExternalGitOAuthIntent::from_persistence(consumed.purpose, consumed.user_id)?,
        return_to: consumed.return_to,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persisted_oauth_intent_requires_a_user_only_for_connection() {
        let user_id = Uuid::new_v4();
        assert!(matches!(
            ExternalGitOAuthIntent::from_persistence(
                ExternalGitOAuthPurpose::Connect,
                Some(user_id)
            ),
            Ok(ExternalGitOAuthIntent::Connect { user_id: value }) if value == user_id
        ));
        assert!(matches!(
            ExternalGitOAuthIntent::from_persistence(
                ExternalGitOAuthPurpose::SignIn,
                Some(user_id)
            ),
            Err(ExternalGitOAuthError::InvalidPersistedIntent)
        ));
        assert!(matches!(
            ExternalGitOAuthIntent::from_persistence(ExternalGitOAuthPurpose::Connect, None),
            Err(ExternalGitOAuthError::InvalidPersistedIntent)
        ));
    }
}
