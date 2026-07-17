//! Connecting an identity-provider grant to external repository access.

use super::super::provider::{
    ExternalGitProvider, ProviderAuthorizationError, ProviderIdentity, ProviderIdentityError,
};
use super::cipher::{encrypt_token, TokenCipherError};
use super::persistence;
use crate::access::{bind_federated_identity, BindFederatedIdentityError, LoginAuthorityKind};
use crate::database_error::is_unique_constraint_violation;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
pub(crate) enum PersistGrantStage {
    Begin,
    UpsertGrant,
    ResumeWork,
    Commit,
}

#[derive(Debug, Error)]
pub(crate) enum PersistExternalGitGrantError {
    #[error("external Git account does not match the user's existing binding")]
    AccountMismatch,
    #[error("external Git grant token encryption failed")]
    Cipher {
        #[source]
        source: TokenCipherError,
    },
    #[error("external Git login identity binding failed")]
    IdentityBinding {
        #[source]
        source: BindFederatedIdentityError,
    },
    #[error("external Git grant persistence failed during {stage:?}")]
    Persistence {
        stage: PersistGrantStage,
        #[source]
        source: sqlx::Error,
    },
}

pub(crate) struct ExternalGitGrantInput {
    pub identity: ProviderIdentity,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub refresh_redirect_uri: String,
    pub scopes: Vec<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub bind_login_identity: bool,
}

#[derive(Debug, Error)]
pub(crate) enum ExternalGitAuthorizationError {
    #[error("external Git provider does not support repository authorization")]
    NotSupported,
    #[error("external Git provider authorization failed")]
    Provider {
        #[source]
        source: ProviderAuthorizationError,
    },
    #[error("external Git provider identity lookup failed")]
    Identity {
        #[source]
        source: ProviderIdentityError,
    },
    #[error("external Git authorization grant could not be stored")]
    Grant {
        #[source]
        source: PersistExternalGitGrantError,
    },
}

pub(crate) async fn complete_external_git_authorization(
    db: &PgPool,
    provider: &ExternalGitProvider,
    user_id: Uuid,
    code: &str,
) -> Result<(), ExternalGitAuthorizationError> {
    let tokens =
        provider
            .exchange_authorization_code(code)
            .await
            .map_err(|source| match source {
                ProviderAuthorizationError::NotSupported => {
                    ExternalGitAuthorizationError::NotSupported
                }
                source => ExternalGitAuthorizationError::Provider { source },
            })?;
    let identity = provider
        .fetch_identity(&tokens.access_token)
        .await
        .map_err(|source| ExternalGitAuthorizationError::Identity { source })?;
    let expires_at = tokens
        .expires_in
        .map(|seconds| Utc::now() + chrono::Duration::seconds(seconds.max(0)));
    persist_external_git_grant(
        db,
        provider,
        user_id,
        ExternalGitGrantInput {
            identity,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            refresh_redirect_uri: tokens.refresh_redirect_uri,
            scopes: tokens.scopes,
            expires_at,
            bind_login_identity: provider.login_enabled(),
        },
    )
    .await
    .map_err(|source| ExternalGitAuthorizationError::Grant { source })?;
    Ok(())
}

pub(crate) async fn persist_external_git_grant(
    db: &PgPool,
    provider: &ExternalGitProvider,
    user_id: Uuid,
    grant: ExternalGitGrantInput,
) -> Result<(), PersistExternalGitGrantError> {
    let provider_id = provider.instance_id().clone();
    let encrypted_access_token = encrypt_token(provider, user_id, &grant.access_token)
        .map_err(|source| PersistExternalGitGrantError::Cipher { source })?;
    let encrypted_refresh_token = grant
        .refresh_token
        .as_deref()
        .map(|token| encrypt_token(provider, user_id, token))
        .transpose()
        .map_err(|source| PersistExternalGitGrantError::Cipher { source })?;
    let now = Utc::now();
    let mut transaction =
        db.begin()
            .await
            .map_err(|source| PersistExternalGitGrantError::Persistence {
                stage: PersistGrantStage::Begin,
                source,
            })?;
    let stored = persistence::upsert_oauth_grant(
        &mut transaction,
        persistence::UpsertOAuthGrantRecord {
            user_id,
            provider_instance_id: &provider_id,
            provider_account_id: &grant.identity.account_id,
            provider_username: &grant.identity.username,
            encrypted_access_token,
            encrypted_refresh_token,
            refresh_redirect_uri: &grant.refresh_redirect_uri,
            scopes: grant.scopes,
            expires_at: grant.expires_at,
            now,
        },
    )
    .await
    .map_err(|source| {
        if is_unique_constraint_violation(&source, "external_git_oauth_grants_provider_account_key")
        {
            PersistExternalGitGrantError::AccountMismatch
        } else {
            PersistExternalGitGrantError::Persistence {
                stage: PersistGrantStage::UpsertGrant,
                source,
            }
        }
    })?;
    if !stored {
        return Err(PersistExternalGitGrantError::AccountMismatch);
    }
    if grant.bind_login_identity {
        bind_federated_identity(
            &mut transaction,
            user_id,
            LoginAuthorityKind::ExternalGit,
            provider_id.as_str(),
            &grant.identity.account_id,
            now,
        )
        .await
        .map_err(|source| match source {
            BindFederatedIdentityError::IdentityConflict
            | BindFederatedIdentityError::AuthorityConflict => {
                PersistExternalGitGrantError::AccountMismatch
            }
            source @ BindFederatedIdentityError::Persistence { .. } => {
                PersistExternalGitGrantError::IdentityBinding { source }
            }
        })?;
    }
    super::super::reauthorization::resume_work(&mut transaction, user_id, &provider_id, now)
        .await
        .map_err(|source| PersistExternalGitGrantError::Persistence {
            stage: PersistGrantStage::ResumeWork,
            source,
        })?;
    transaction
        .commit()
        .await
        .map_err(|source| PersistExternalGitGrantError::Persistence {
            stage: PersistGrantStage::Commit,
            source,
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
        GitHubProvider, GitHubProviderConfig, ProviderBrand,
    };
    use axum::extract::State;
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use serde_json::json;
    use sqlx::Row;
    use std::sync::Arc;

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
            "access_token": "github-user-access-token",
            "refresh_token": "github-user-refresh-token",
            "expires_in": 28_800,
            "refresh_token_expires_in": 15_552_000,
            "scope": ""
        }))
    }

    #[derive(Clone)]
    struct TestGitHubAccount {
        id: u64,
    }

    async fn user_response(State(account): State<TestGitHubAccount>) -> Json<serde_json::Value> {
        Json(json!({
            "id": account.id,
            "login": "github-owner",
            "name": "GitHub Owner",
            "email": null
        }))
    }

    async fn installations_response(
        State(account): State<TestGitHubAccount>,
    ) -> Json<serde_json::Value> {
        Json(json!({
            "total_count": 1,
            "installations": [{
                "id": 2468,
                "account": {
                    "id": account.id,
                    "login": "github-owner",
                    "html_url": "https://github.com/github-owner",
                    "type": "User"
                }
            }]
        }))
    }

    fn repository_json() -> serde_json::Value {
        json!({
            "id": 13579,
            "name": "typst-slides",
            "full_name": "github-owner/typst-slides",
            "default_branch": "main",
            "visibility": "private",
            "html_url": "https://github.com/github-owner/typst-slides",
            "clone_url": "https://github.com/github-owner/typst-slides.git",
            "archived": false,
            "permissions": {
                "admin": false,
                "maintain": false,
                "push": true,
                "triage": true,
                "pull": true
            }
        })
    }

    async fn repositories_response() -> Json<serde_json::Value> {
        Json(json!([repository_json()]))
    }

    async fn repository_response() -> Json<serde_json::Value> {
        Json(repository_json())
    }

    async fn branches_response() -> Json<serde_json::Value> {
        Json(json!([{
            "name": "main",
            "protected": true,
            "commit": { "sha": "0123456789abcdef0123456789abcdef01234567" }
        }]))
    }

    async fn github_provider() -> Result<
        (ExternalGitProvider, u64, tokio::task::JoinHandle<()>),
        Box<dyn std::error::Error + Send + Sync>,
    > {
        let account_id = Uuid::new_v4().as_u128() as u64;
        let router = Router::new()
            .route("/login/oauth/access_token", post(token_response))
            .route("/user", get(user_response))
            .route("/user/installations", get(installations_response))
            .route("/user/repos", get(repositories_response))
            .route("/repositories/13579", get(repository_response))
            .route(
                "/repos/github-owner/typst-slides/branches",
                get(branches_response),
            )
            .with_state(TestGitHubAccount { id: account_id });
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let address = listener.local_addr()?;
        let server = tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, router).await {
                tracing::error!(%error, "test GitHub provider stopped unexpectedly");
            }
        });
        let base_url = format!("http://{address}");
        let provider = GitHubProvider::new(GitHubProviderConfig {
            base_url: base_url.clone(),
            api_url: base_url.clone(),
            app_slug: "typst-collab-test".to_string(),
            client_id: "github-client-id".to_string(),
            client_secret: "github-client-secret".to_string(),
            redirect_uri: format!("{base_url}/v1/external-git/providers/github/callback"),
            token_encryption_key: Arc::new([7_u8; 32]),
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
    async fn github_app_connection_consumes_shared_oauth_attempt_and_persists_grant(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let user_id = Uuid::new_v4();
        let now = Utc::now();
        let test_user_suffix = user_id
            .simple()
            .to_string()
            .chars()
            .take(8)
            .collect::<String>();
        sqlx::query(
            "insert into users (id, email, username, display_name, created_at)
             values ($1, $2, $3, 'GitHub Tester', $4)",
        )
        .bind(user_id)
        .bind(format!("{user_id}@example.test"))
        .bind(format!("github-test-{test_user_suffix}"))
        .bind(now)
        .execute(&pool)
        .await?;
        let (provider, provider_account_id, server) = github_provider().await?;
        let start = begin_external_git_oauth(
            &pool,
            Some(&provider),
            ExternalGitOAuthIntent::Connect { user_id },
            Some("/projects?import=github"),
        )
        .await?;
        let url = reqwest::Url::parse(&start.authorization_url)?;
        assert!(url
            .path()
            .ends_with("/github-apps/typst-collab-test/installations/new"));
        assert_eq!(
            url.query_pairs()
                .find_map(|(name, value)| (name == "state").then(|| value.into_owned())),
            Some(start.state.clone())
        );
        let attempt =
            consume_external_git_oauth(&pool, provider.instance_id(), &start.state).await?;
        assert!(matches!(
            attempt.intent,
            ExternalGitOAuthIntent::Connect { user_id: value } if value == user_id
        ));
        assert_eq!(attempt.return_to, "/projects?import=github");

        complete_external_git_authorization(&pool, &provider, user_id, "github-code").await?;
        let grant = sqlx::query(
            "select provider_instance_id, provider_account_id, provider_username, status,
                    encrypted_access_token, encrypted_refresh_token
             from external_git_oauth_grants
             where user_id = $1 and provider_instance_id = 'github'",
        )
        .bind(user_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(grant.get::<String, _>("provider_instance_id"), "github");
        assert_eq!(
            grant.get::<String, _>("provider_account_id"),
            provider_account_id.to_string()
        );
        assert_eq!(grant.get::<String, _>("provider_username"), "github-owner");
        assert_eq!(grant.get::<String, _>("status"), "active");
        let login_identity: i64 = sqlx::query_scalar(
            "select count(*) from user_login_identities
             where user_id = $1 and authority_kind = 'external_git'
               and authority_id = 'github' and subject = $2",
        )
        .bind(user_id)
        .bind(provider_account_id.to_string())
        .fetch_one(&pool)
        .await?;
        assert_eq!(login_identity, 1);
        assert_ne!(
            grant.get::<Vec<u8>, _>("encrypted_access_token"),
            b"github-user-access-token"
        );
        assert!(grant
            .get::<Option<Vec<u8>>, _>("encrypted_refresh_token")
            .is_some());
        let mismatched_account = persist_external_git_grant(
            &pool,
            &provider,
            user_id,
            ExternalGitGrantInput {
                identity: ProviderIdentity {
                    account_id: provider_account_id.saturating_add(1).to_string(),
                    username: "different-github-user".to_string(),
                    name: None,
                    email: None,
                },
                access_token: "must-not-replace-existing-token".to_string(),
                refresh_token: None,
                refresh_redirect_uri:
                    "https://collab.example.test/v1/external-git/providers/github/callback"
                        .to_string(),
                scopes: Vec::new(),
                expires_at: None,
                bind_login_identity: false,
            },
        )
        .await;
        assert!(matches!(
            mismatched_account,
            Err(PersistExternalGitGrantError::AccountMismatch)
        ));
        let preserved_account = sqlx::query(
            "select provider_account_id, encrypted_access_token
             from external_git_oauth_grants
             where user_id = $1",
        )
        .bind(user_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(
            preserved_account.get::<String, _>("provider_account_id"),
            provider_account_id.to_string()
        );
        assert_ne!(
            preserved_account.get::<Vec<u8>, _>("encrypted_access_token"),
            b"must-not-replace-existing-token"
        );
        let gateway = crate::external_repositories::provider::ExternalGitGateway::new(
            &pool,
            Some(&provider),
            crate::process_lifecycle::DrainSignal::idle(),
        );
        assert_eq!(
            gateway.access_token(user_id, true).await?,
            "github-user-access-token"
        );
        let query = crate::external_repositories::provider::ProviderListQuery {
            search: None,
            page: 1,
            per_page: 100,
        };
        let owners = gateway.list_repository_owners(user_id, &query).await?;
        assert_eq!(owners.items.len(), 1);
        assert_eq!(
            owners.items.first().map(|owner| owner.full_path.as_str()),
            Some("github-owner")
        );
        let repositories = gateway.list_repositories(user_id, &query).await?;
        assert_eq!(repositories.items.len(), 1);
        assert_eq!(
            repositories
                .items
                .first()
                .map(|repository| repository.full_path.as_str()),
            Some("github-owner/typst-slides")
        );
        let details = gateway.repository_details(user_id, "13579").await?;
        assert_eq!(
            details.access,
            crate::external_repositories::provider::RepositoryAccess::Write
        );
        let branches = gateway
            .list_repository_branches(user_id, "13579", &query)
            .await?;
        assert_eq!(branches.items.len(), 1);
        assert!(branches.items.first().is_some_and(|branch| branch.default));
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "select count(*) from external_git_oauth_attempts where state = $1"
            )
            .bind(&start.state)
            .fetch_one(&pool)
            .await?,
            0
        );
        assert!(matches!(
            consume_external_git_oauth(&pool, provider.instance_id(), &start.state).await,
            Err(ExternalGitOAuthError::InvalidState)
        ));

        let declined_start = begin_external_git_oauth(
            &pool,
            Some(&provider),
            ExternalGitOAuthIntent::Connect { user_id },
            Some("/projects"),
        )
        .await?;
        let declined =
            consume_external_git_oauth(&pool, provider.instance_id(), &declined_start.state)
                .await?;
        assert!(matches!(
            declined.intent,
            ExternalGitOAuthIntent::Connect { user_id: value } if value == user_id
        ));
        assert_eq!(declined.return_to, "/projects");
        assert!(matches!(
            consume_external_git_oauth(&pool, provider.instance_id(), &declined_start.state).await,
            Err(ExternalGitOAuthError::InvalidState)
        ));
        server.abort();
        Ok(())
    }
}
