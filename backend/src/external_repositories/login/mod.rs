//! External-provider platform login completion.

use super::connection::{
    external_git_user_id_for_provider_account, ExternalGitGrantInput, PersistExternalGitGrantError,
};
use super::provider::{
    ExternalGitProvider, ProviderAuthorizationError, ProviderAuthorizationRejection,
    ProviderIdentityError, ProviderIdentityResource, ProviderInstanceId,
};
use crate::access::{
    federated_identity_user_id, provision_federated_account, LoginAuthorityKind,
    ProvisionFederatedAccountCommand, ProvisionFederatedAccountError,
};
use chrono::Utc;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub(crate) enum ExternalGitLoginError {
    #[error("external Git provider login authorization failed")]
    Authorization {
        #[source]
        source: ProviderAuthorizationError,
    },
    #[error("external Git provider rejected login: {reason:?}")]
    ProviderRejected {
        reason: Option<ProviderAuthorizationRejection>,
    },
    #[error("external Git provider login identity is unavailable")]
    Identity {
        #[source]
        source: ProviderIdentityError,
    },
    #[error(
        "external Git provider rejected the {resource:?} identity request with status {status}"
    )]
    IdentityRejected {
        resource: ProviderIdentityResource,
        status: reqwest::StatusCode,
    },
    #[error("external Git provider account has no verified primary email")]
    VerifiedEmailUnavailable,
    #[error("external Git login identity lookup failed")]
    AccountLookup {
        #[source]
        source: sqlx::Error,
    },
    #[error("external Git login repository binding lookup failed")]
    GrantLookup {
        #[source]
        source: sqlx::Error,
    },
    #[error("external Git login email belongs to another platform account")]
    EmailConflict,
    #[error("external Git login username allocation was exhausted")]
    UsernameExhausted,
    #[error("external Git login account persistence failed")]
    AccountPersistence {
        #[source]
        source: ProvisionFederatedAccountError,
    },
    #[error("external Git login account does not match the existing repository binding")]
    ProviderAccountMismatch,
    #[error("external Git login grant persistence failed")]
    GrantPersistence {
        #[source]
        source: PersistExternalGitGrantError,
    },
}

pub(crate) struct ExternalGitLoginCompletion {
    pub user_id: Uuid,
    pub provider_instance_id: ProviderInstanceId,
    pub provider_account_id: String,
    pub provider_username: String,
}

fn login_authorization_error(source: ProviderAuthorizationError) -> ExternalGitLoginError {
    match source {
        ProviderAuthorizationError::Rejected { reason, .. } => {
            ExternalGitLoginError::ProviderRejected {
                reason: Some(reason),
            }
        }
        source => ExternalGitLoginError::Authorization { source },
    }
}

fn login_identity_error(source: ProviderIdentityError) -> ExternalGitLoginError {
    match source {
        ProviderIdentityError::Rejected { resource, status } => {
            ExternalGitLoginError::IdentityRejected { resource, status }
        }
        ProviderIdentityError::VerifiedEmailUnavailable => {
            ExternalGitLoginError::VerifiedEmailUnavailable
        }
        source => ExternalGitLoginError::Identity { source },
    }
}

pub(crate) async fn complete_external_git_login(
    db: &PgPool,
    provider: &ExternalGitProvider,
    code: &str,
) -> Result<ExternalGitLoginCompletion, ExternalGitLoginError> {
    let code = code.trim();
    if code.is_empty() {
        return Err(ExternalGitLoginError::ProviderRejected { reason: None });
    }
    let tokens = provider
        .exchange_authorization_code(code)
        .await
        .map_err(login_authorization_error)?;
    let profile = provider
        .fetch_login_profile(&tokens.access_token)
        .await
        .map_err(login_identity_error)?;
    let display_name = profile
        .identity
        .name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(&profile.identity.username);
    let existing_identity_user = federated_identity_user_id(
        db,
        LoginAuthorityKind::ExternalGit,
        provider.instance_id().as_str(),
        &profile.identity.account_id,
    )
    .await
    .map_err(|source| ExternalGitLoginError::AccountLookup { source })?;
    let existing_binding_user = external_git_user_id_for_provider_account(
        db,
        provider.instance_id(),
        &profile.identity.account_id,
    )
    .await
    .map_err(|source| ExternalGitLoginError::GrantLookup { source })?;
    if existing_binding_user.is_some() && existing_binding_user != existing_identity_user {
        return Err(ExternalGitLoginError::ProviderAccountMismatch);
    }
    let user_id = provision_federated_account(
        db,
        ProvisionFederatedAccountCommand {
            email: &profile.verified_email,
            display_name,
            authority_kind: LoginAuthorityKind::ExternalGit,
            authority_id: provider.instance_id().as_str(),
            subject: &profile.identity.account_id,
            username_seed: &profile.identity.username,
        },
    )
    .await
    .map_err(|source| match source {
        ProvisionFederatedAccountError::EmailConflict => ExternalGitLoginError::EmailConflict,
        ProvisionFederatedAccountError::UsernameExhausted => {
            ExternalGitLoginError::UsernameExhausted
        }
        source @ ProvisionFederatedAccountError::Persistence { .. } => {
            ExternalGitLoginError::AccountPersistence { source }
        }
    })?;
    let expires_at = tokens
        .expires_in
        .map(|seconds| Utc::now() + chrono::Duration::seconds(seconds.max(0)));
    let provider_account_id = profile.identity.account_id.clone();
    let provider_username = profile.identity.username.clone();
    super::connection::persist_external_git_grant(
        db,
        provider,
        user_id,
        ExternalGitGrantInput {
            identity: profile.identity,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            refresh_redirect_uri: tokens.refresh_redirect_uri,
            scopes: tokens.scopes,
            expires_at,
            bind_login_identity: false,
        },
    )
    .await
    .map_err(|source| match source {
        PersistExternalGitGrantError::AccountMismatch => {
            ExternalGitLoginError::ProviderAccountMismatch
        }
        source @ (PersistExternalGitGrantError::Cipher { .. }
        | PersistExternalGitGrantError::IdentityBinding { .. }
        | PersistExternalGitGrantError::Persistence { .. }) => {
            ExternalGitLoginError::GrantPersistence { source }
        }
    })?;
    Ok(ExternalGitLoginCompletion {
        user_id,
        provider_instance_id: provider.instance_id().clone(),
        provider_account_id,
        provider_username,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::external_repositories::oauth::{
        begin_external_git_oauth, consume_external_git_oauth, ExternalGitOAuthError,
        ExternalGitOAuthIntent,
    };
    use crate::external_repositories::provider::{
        GitHubProvider, GitHubProviderConfig, ProviderBrand, ProviderIdentity,
    };
    use axum::extract::State;
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use serde_json::json;
    use sqlx::Row;
    use std::sync::Arc;

    #[test]
    fn provider_protocol_outcomes_become_login_workflow_semantics() {
        assert!(matches!(
            login_authorization_error(ProviderAuthorizationError::Rejected {
                status: reqwest::StatusCode::UNAUTHORIZED,
                reason: ProviderAuthorizationRejection::AccessDenied,
            }),
            ExternalGitLoginError::ProviderRejected {
                reason: Some(ProviderAuthorizationRejection::AccessDenied)
            }
        ));
        assert!(matches!(
            login_identity_error(ProviderIdentityError::VerifiedEmailUnavailable),
            ExternalGitLoginError::VerifiedEmailUnavailable
        ));
        assert!(matches!(
            login_identity_error(ProviderIdentityError::Rejected {
                resource: ProviderIdentityResource::VerifiedEmails,
                status: reqwest::StatusCode::FORBIDDEN,
            }),
            ExternalGitLoginError::IdentityRejected {
                resource: ProviderIdentityResource::VerifiedEmails,
                status: reqwest::StatusCode::FORBIDDEN,
            }
        ));
    }

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

    async fn token_response() -> Json<serde_json::Value> {
        Json(json!({
            "access_token": "github-login-access-token",
            "refresh_token": "github-login-refresh-token",
            "expires_in": 28_800,
            "scope": ""
        }))
    }

    #[derive(Clone)]
    struct TestAccount {
        id: u64,
        email: String,
    }

    async fn user_response(State(account): State<TestAccount>) -> Json<serde_json::Value> {
        Json(json!({
            "id": account.id,
            "login": "github-login-user",
            "name": "GitHub Login User",
            "email": null
        }))
    }

    async fn emails_response(State(account): State<TestAccount>) -> Json<serde_json::Value> {
        Json(json!([{
            "email": account.email,
            "primary": true,
            "verified": true,
            "visibility": null
        }]))
    }

    async fn github_provider() -> Result<
        (ExternalGitProvider, u64, tokio::task::JoinHandle<()>),
        Box<dyn std::error::Error + Send + Sync>,
    > {
        let account_id = Uuid::new_v4().as_u128() as u64;
        let account = TestAccount {
            id: account_id,
            email: format!("github-login-{account_id}@example.test"),
        };
        let router = Router::new()
            .route("/login/oauth/access_token", post(token_response))
            .route("/user", get(user_response))
            .route("/user/emails", get(emails_response))
            .with_state(account);
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let address = listener.local_addr()?;
        let server = tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, router).await {
                tracing::error!(%error, "test GitHub login provider stopped unexpectedly");
            }
        });
        let base_url = format!("http://{address}");
        let provider = GitHubProvider::new(GitHubProviderConfig {
            base_url: base_url.clone(),
            api_url: base_url.clone(),
            app_slug: "typst-collab-login-test".to_string(),
            client_id: "github-login-client-id".to_string(),
            client_secret: "github-login-client-secret".to_string(),
            redirect_uri: format!("{base_url}/v1/external-git/providers/github/callback"),
            token_encryption_key: Arc::new([11_u8; 32]),
            http_client: reqwest::Client::new(),
        });
        Ok((
            ExternalGitProvider::github(
                "github".parse()?,
                "GitHub".to_string(),
                ProviderBrand::GitHub,
                true,
                provider,
            ),
            account_id,
            server,
        ))
    }

    #[tokio::test]
    async fn github_login_persists_one_matching_login_identity_and_repository_binding(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let (provider, account_id, server) = github_provider().await?;
        let start = begin_external_git_oauth(
            &pool,
            Some(&provider),
            ExternalGitOAuthIntent::SignIn,
            Some("/projects"),
        )
        .await?;
        let url = reqwest::Url::parse(&start.authorization_url)?;
        assert_eq!(url.path(), "/login/oauth/authorize");
        assert_eq!(
            url.query_pairs()
                .find_map(|(name, value)| (name == "state").then(|| value.into_owned())),
            Some(start.state.clone())
        );

        let attempt =
            consume_external_git_oauth(&pool, provider.instance_id(), &start.state).await?;
        assert_eq!(attempt.intent, ExternalGitOAuthIntent::SignIn);
        assert_eq!(attempt.return_to, "/projects");
        let completion = complete_external_git_login(&pool, &provider, "github-login-code").await?;
        assert_eq!(completion.provider_account_id, account_id.to_string());
        let row = sqlx::query(
            "select i.authority_kind, i.authority_id, i.subject,
                    g.provider_instance_id, g.provider_account_id
             from users u
             join user_login_identities i on i.user_id = u.id
             join external_git_oauth_grants g on g.user_id = u.id
             where u.id = $1",
        )
        .bind(completion.user_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(row.get::<String, _>("authority_kind"), "external_git");
        assert_eq!(row.get::<String, _>("authority_id"), "github");
        assert_eq!(row.get::<String, _>("subject"), account_id.to_string());
        assert_eq!(row.get::<String, _>("provider_instance_id"), "github");
        assert_eq!(
            row.get::<String, _>("provider_account_id"),
            account_id.to_string()
        );
        assert!(matches!(
            consume_external_git_oauth(&pool, provider.instance_id(), &start.state).await,
            Err(ExternalGitOAuthError::InvalidState)
        ));
        server.abort();
        Ok(())
    }

    #[tokio::test]
    async fn github_login_does_not_merge_an_existing_local_account_binding(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let (provider, account_id, server) = github_provider().await?;
        let local_user_id = Uuid::new_v4();
        let suffix = local_user_id.simple().to_string();
        sqlx::query(
            "insert into users (id, email, username, display_name, created_at)
             values ($1, $2, $3, 'Local User', $4)",
        )
        .bind(local_user_id)
        .bind(format!("local-{suffix}@local.example.test"))
        .bind(format!("local-{suffix}"))
        .bind(Utc::now())
        .execute(&pool)
        .await?;
        super::super::connection::persist_external_git_grant(
            &pool,
            &provider,
            local_user_id,
            ExternalGitGrantInput {
                identity: ProviderIdentity {
                    account_id: account_id.to_string(),
                    username: "github-login-user".to_string(),
                    name: Some("GitHub Login User".to_string()),
                    email: None,
                },
                access_token: "existing-local-binding-token".to_string(),
                refresh_token: None,
                refresh_redirect_uri:
                    "https://collab.example.test/v1/external-git/providers/github/callback"
                        .to_string(),
                scopes: Vec::new(),
                expires_at: None,
                bind_login_identity: false,
            },
        )
        .await?;

        let result = complete_external_git_login(&pool, &provider, "github-login-code").await;

        assert!(matches!(
            result,
            Err(ExternalGitLoginError::ProviderAccountMismatch)
        ));
        let federated_users: i64 = sqlx::query_scalar(
            "select count(*) from user_login_identities
             where authority_kind = 'external_git'
               and authority_id = 'github'
               and subject = $1",
        )
        .bind(account_id.to_string())
        .fetch_one(&pool)
        .await?;
        assert_eq!(federated_users, 0);
        server.abort();
        Ok(())
    }
}
