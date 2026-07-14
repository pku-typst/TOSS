mod forge;
mod github;
mod gitlab;
mod http_session;
mod model;
mod oauth2;

use sqlx::PgPool;
use std::collections::BTreeMap;
use std::sync::Arc;
use thiserror::Error;
use uuid::Uuid;

use model::CreateRemoteRepository;
#[cfg(test)]
pub(crate) use model::InvalidProviderInstanceId;
pub(crate) use model::{
    ExternalGitProviderCapabilities, ExternalGitRepositoryVisibility, GitHttpAuthorization,
    ProviderAuthorizationError, ProviderAuthorizationGrant, ProviderAuthorizationRejection,
    ProviderBrand, ProviderIdentity, ProviderIdentityError, ProviderIdentityResource,
    ProviderInstanceId, ProviderKind, ProviderListQuery, ProviderLoginProfile, ProviderPage,
    RefreshTokenError, RefreshedToken, RemoteBranch, RemoteRepository, RemoteRepositoryDetails,
    RepositoryAccess, RepositoryOwner, RepositoryOwnerKind,
};

use super::connection::{
    mark_provider_reauth_required, provider_access_token, ProviderAccessTokenError,
};
use oauth2::{OAuth2Client, OAuth2ClientConfig, OAuth2Dialect};

#[derive(Debug, Error)]
pub(crate) enum ExternalGitProviderError {
    #[error("external Git provider is not configured")]
    NotConfigured,
    #[error("external Git credentials are unavailable")]
    Credential {
        #[from]
        source: ProviderAccessTokenError,
    },
    #[error("external Git provider authorization must be renewed")]
    ReauthorizationRequired,
    #[error("external Git provider denied the operation")]
    Forbidden,
    #[error("external Git provider resource was not found")]
    NotFound,
    #[error("external Git repository request is invalid")]
    InvalidRequest,
    #[error("external Git provider reported a conflict")]
    Conflict,
    #[error("external Git provider request failed")]
    Transport {
        #[source]
        source: reqwest::Error,
    },
    #[error("external Git provider is unavailable with status {status}")]
    Unavailable { status: reqwest::StatusCode },
    #[error("external Git provider returned unexpected status {status}")]
    UnexpectedStatus { status: reqwest::StatusCode },
    #[error("external Git provider response was invalid")]
    InvalidResponse {
        #[source]
        source: reqwest::Error,
    },
    #[error("external Git provider response contains malformed resource data")]
    MalformedResponse,
}

#[derive(Clone, Copy)]
pub(crate) enum ForgeDialect {
    Gitea,
    Forgejo,
}

#[derive(Clone, Copy)]
pub(crate) enum RepositoryApiDialect {
    GitLab,
    Forge(ForgeDialect),
}

impl RepositoryApiDialect {
    const fn kind(self) -> ProviderKind {
        match self {
            Self::GitLab => ProviderKind::GitLab,
            Self::Forge(ForgeDialect::Gitea) => ProviderKind::Gitea,
            Self::Forge(ForgeDialect::Forgejo) => ProviderKind::Forgejo,
        }
    }
}

#[derive(Clone)]
pub(crate) struct OAuth2GitProvider {
    base_url: String,
    api_url: String,
    api: RepositoryApiDialect,
    oauth: OAuth2Client,
    token_encryption_key: Arc<[u8; 32]>,
    http_client: reqwest::Client,
}

pub(crate) struct OAuth2GitProviderConfig {
    pub base_url: String,
    pub api_url: String,
    pub api: RepositoryApiDialect,
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
    pub token_encryption_key: Arc<[u8; 32]>,
    pub http_client: reqwest::Client,
}

impl OAuth2GitProvider {
    pub(crate) fn new(config: OAuth2GitProviderConfig) -> Self {
        let (authorization_path, token_path, scopes, oauth_dialect) = match config.api {
            RepositoryApiDialect::GitLab => (
                "/oauth/authorize",
                "/oauth/token",
                "api write_repository",
                OAuth2Dialect::GitLab,
            ),
            RepositoryApiDialect::Forge(_) => (
                "/login/oauth/authorize",
                "/login/oauth/access_token",
                "openid profile email write:user write:repository write:organization",
                OAuth2Dialect::Forge,
            ),
        };
        let oauth = OAuth2Client::new(OAuth2ClientConfig {
            authorization_endpoint: format!("{}{authorization_path}", config.base_url),
            token_endpoint: format!("{}{token_path}", config.base_url),
            client_id: config.client_id,
            client_secret: config.client_secret,
            redirect_uri: config.redirect_uri,
            scopes: scopes.to_string(),
            dialect: oauth_dialect,
            http_client: config.http_client.clone(),
        });
        Self {
            base_url: config.base_url,
            api_url: config.api_url,
            api: config.api,
            oauth,
            token_encryption_key: config.token_encryption_key,
            http_client: config.http_client,
        }
    }

    pub(crate) fn base_url(&self) -> &str {
        &self.base_url
    }

    pub(super) fn api_url(&self) -> &str {
        &self.api_url
    }

    pub(crate) const fn api(&self) -> RepositoryApiDialect {
        self.api
    }

    fn oauth(&self) -> &OAuth2Client {
        &self.oauth
    }

    pub(super) fn token_encryption_key(&self) -> &[u8; 32] {
        self.token_encryption_key.as_ref()
    }

    pub(super) fn http_client(&self) -> &reqwest::Client {
        &self.http_client
    }
}

#[derive(Clone)]
pub(crate) struct GitHubProvider {
    base_url: String,
    api_url: String,
    app_slug: String,
    client_id: String,
    client_secret: String,
    redirect_uri: String,
    token_encryption_key: Arc<[u8; 32]>,
    http_client: reqwest::Client,
}

pub(crate) struct GitHubProviderConfig {
    pub base_url: String,
    pub api_url: String,
    pub app_slug: String,
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
    pub token_encryption_key: Arc<[u8; 32]>,
    pub http_client: reqwest::Client,
}

pub(crate) struct ExternalGitProviderLogin {
    pub protocol: &'static str,
    pub path: String,
}

impl GitHubProvider {
    pub(crate) fn new(config: GitHubProviderConfig) -> Self {
        Self {
            base_url: config.base_url,
            api_url: config.api_url,
            app_slug: config.app_slug,
            client_id: config.client_id,
            client_secret: config.client_secret,
            redirect_uri: config.redirect_uri,
            token_encryption_key: config.token_encryption_key,
            http_client: config.http_client,
        }
    }

    pub(crate) fn base_url(&self) -> &str {
        &self.base_url
    }

    pub(super) fn api_url(&self) -> &str {
        &self.api_url
    }

    pub(crate) fn app_slug(&self) -> &str {
        &self.app_slug
    }

    pub(super) fn client_id(&self) -> &str {
        &self.client_id
    }

    pub(super) fn client_secret(&self) -> &str {
        &self.client_secret
    }

    pub(super) fn redirect_uri(&self) -> &str {
        &self.redirect_uri
    }

    pub(super) fn token_encryption_key(&self) -> &[u8; 32] {
        self.token_encryption_key.as_ref()
    }

    pub(super) fn http_client(&self) -> &reqwest::Client {
        &self.http_client
    }
}

#[derive(Clone)]
enum ExternalGitAdapter {
    GitHub(GitHubProvider),
    OAuth2(OAuth2GitProvider),
}

#[derive(Clone)]
pub(crate) struct ExternalGitProvider {
    instance_id: ProviderInstanceId,
    display_name: String,
    brand: ProviderBrand,
    login_enabled: bool,
    adapter: ExternalGitAdapter,
}

impl ExternalGitProvider {
    pub(crate) fn oauth2(
        instance_id: ProviderInstanceId,
        display_name: String,
        brand: ProviderBrand,
        login_enabled: bool,
        provider: OAuth2GitProvider,
    ) -> Self {
        Self {
            instance_id,
            display_name,
            brand,
            login_enabled,
            adapter: ExternalGitAdapter::OAuth2(provider),
        }
    }

    pub(crate) fn github(
        instance_id: ProviderInstanceId,
        display_name: String,
        brand: ProviderBrand,
        login_enabled: bool,
        provider: GitHubProvider,
    ) -> Self {
        Self {
            instance_id,
            display_name,
            brand,
            login_enabled,
            adapter: ExternalGitAdapter::GitHub(provider),
        }
    }

    pub(crate) fn instance_id(&self) -> &ProviderInstanceId {
        &self.instance_id
    }

    pub(crate) fn display_name(&self) -> &str {
        &self.display_name
    }

    pub(crate) const fn brand(&self) -> ProviderBrand {
        self.brand
    }

    pub(crate) const fn login_enabled(&self) -> bool {
        self.login_enabled
    }

    pub(crate) const fn kind(&self) -> ProviderKind {
        match &self.adapter {
            ExternalGitAdapter::GitHub(_) => ProviderKind::GitHub,
            ExternalGitAdapter::OAuth2(provider) => provider.api().kind(),
        }
    }

    pub(crate) fn base_url(&self) -> &str {
        match &self.adapter {
            ExternalGitAdapter::GitHub(provider) => provider.base_url(),
            ExternalGitAdapter::OAuth2(provider) => provider.base_url(),
        }
    }

    pub(crate) fn token_encryption_key(&self) -> &[u8; 32] {
        match &self.adapter {
            ExternalGitAdapter::GitHub(provider) => provider.token_encryption_key(),
            ExternalGitAdapter::OAuth2(provider) => provider.token_encryption_key(),
        }
    }

    pub(crate) fn capabilities(&self) -> ExternalGitProviderCapabilities {
        match &self.adapter {
            ExternalGitAdapter::GitHub(_) => ExternalGitProviderCapabilities {
                repository_creation: false,
                supported_visibilities: vec![
                    ExternalGitRepositoryVisibility::Private,
                    ExternalGitRepositoryVisibility::Public,
                ],
            },
            ExternalGitAdapter::OAuth2(provider) => match provider.api() {
                RepositoryApiDialect::GitLab => ExternalGitProviderCapabilities {
                    repository_creation: true,
                    supported_visibilities: vec![
                        ExternalGitRepositoryVisibility::Private,
                        ExternalGitRepositoryVisibility::Internal,
                        ExternalGitRepositoryVisibility::Public,
                    ],
                },
                RepositoryApiDialect::Forge(_) => ExternalGitProviderCapabilities {
                    repository_creation: true,
                    supported_visibilities: vec![
                        ExternalGitRepositoryVisibility::Private,
                        ExternalGitRepositoryVisibility::Public,
                    ],
                },
            },
        }
    }

    pub(crate) fn git_http_authorization(&self, access_token: String) -> GitHttpAuthorization {
        match &self.adapter {
            ExternalGitAdapter::GitHub(_) => GitHttpAuthorization {
                username: "x-access-token".to_string(),
                access_token,
            },
            ExternalGitAdapter::OAuth2(_) => GitHttpAuthorization {
                username: "oauth2".to_string(),
                access_token,
            },
        }
    }

    pub(crate) fn authorization_path(&self) -> Option<String> {
        Some(format!(
            "/v1/external-git/providers/{}/authorize",
            self.instance_id
        ))
    }

    pub(crate) fn login(&self) -> Option<ExternalGitProviderLogin> {
        self.login_enabled().then(|| ExternalGitProviderLogin {
            protocol: match &self.adapter {
                ExternalGitAdapter::GitHub(_) => "github_app",
                ExternalGitAdapter::OAuth2(_) => "oauth",
            },
            path: format!("/v1/auth/external-git/{}/login", self.instance_id),
        })
    }

    pub(crate) fn authorization_url(
        &self,
        state: &str,
    ) -> Result<String, ProviderAuthorizationError> {
        match &self.adapter {
            ExternalGitAdapter::GitHub(provider) => github::authorization_url(provider, state),
            ExternalGitAdapter::OAuth2(provider) => provider.oauth().authorization_url(state),
        }
    }

    pub(crate) async fn exchange_authorization_code(
        &self,
        code: &str,
    ) -> Result<ProviderAuthorizationGrant, ProviderAuthorizationError> {
        match &self.adapter {
            ExternalGitAdapter::GitHub(provider) => {
                github::exchange_authorization_code(provider, code).await
            }
            ExternalGitAdapter::OAuth2(provider) => {
                provider.oauth().exchange_authorization_code(code).await
            }
        }
    }

    pub(crate) fn login_authorization_url(
        &self,
        state: &str,
    ) -> Result<String, ProviderAuthorizationError> {
        if !self.login_enabled {
            return Err(ProviderAuthorizationError::NotSupported);
        }
        match &self.adapter {
            ExternalGitAdapter::GitHub(provider) => {
                github::login_authorization_url(provider, state)
            }
            ExternalGitAdapter::OAuth2(provider) => provider.oauth().authorization_url(state),
        }
    }

    pub(crate) async fn fetch_login_profile(
        &self,
        access_token: &str,
    ) -> Result<ProviderLoginProfile, ProviderIdentityError> {
        match &self.adapter {
            ExternalGitAdapter::GitHub(provider) => {
                github::fetch_login_profile(provider, access_token).await
            }
            ExternalGitAdapter::OAuth2(provider) => match provider.api() {
                RepositoryApiDialect::GitLab => {
                    gitlab::fetch_login_profile(provider, access_token).await
                }
                RepositoryApiDialect::Forge(_) => {
                    forge::fetch_login_profile(provider, access_token).await
                }
            },
        }
    }

    pub(crate) fn credential_aad(&self, user_id: Uuid) -> String {
        format!("external-git:{}:oauth:v1:{user_id}", self.instance_id)
    }

    fn prepare_repository_creation(
        &self,
        name: &str,
        path: &str,
        owner_id: &str,
        owner_kind: RepositoryOwnerKind,
        visibility: ExternalGitRepositoryVisibility,
    ) -> Result<CreateRemoteRepository, ExternalGitProviderError> {
        let name = name.trim();
        let path = path.trim();
        let owner_id = owner_id.trim();
        let path_is_valid = match &self.adapter {
            ExternalGitAdapter::GitHub(_) => false,
            ExternalGitAdapter::OAuth2(provider) => match provider.api() {
                RepositoryApiDialect::GitLab => gitlab::validate_repository_path(path),
                RepositoryApiDialect::Forge(_) => forge::validate_repository_path(path),
            },
        };
        if name.is_empty()
            || name.len() > 255
            || owner_id.is_empty()
            || !path_is_valid
            || !self
                .capabilities()
                .supported_visibilities
                .contains(&visibility)
        {
            return Err(ExternalGitProviderError::InvalidRequest);
        }
        Ok(CreateRemoteRepository {
            name: name.to_string(),
            path: path.to_string(),
            owner_id: owner_id.to_string(),
            owner_kind,
            visibility,
            initialize: true,
        })
    }

    pub(crate) async fn fetch_identity(
        &self,
        access_token: &str,
    ) -> Result<ProviderIdentity, ProviderIdentityError> {
        match &self.adapter {
            ExternalGitAdapter::GitHub(provider) => {
                github::fetch_identity(provider, access_token).await
            }
            ExternalGitAdapter::OAuth2(provider) => match provider.api() {
                RepositoryApiDialect::GitLab => {
                    gitlab::fetch_identity(provider, access_token).await
                }
                RepositoryApiDialect::Forge(_) => {
                    forge::fetch_identity(provider, access_token).await
                }
            },
        }
    }

    pub(crate) async fn refresh_access_token(
        &self,
        refresh_token: &str,
        redirect_uri: &str,
    ) -> Result<RefreshedToken, RefreshTokenError> {
        match &self.adapter {
            ExternalGitAdapter::GitHub(provider) => {
                github::refresh_access_token(provider, refresh_token).await
            }
            ExternalGitAdapter::OAuth2(provider) => {
                provider
                    .oauth()
                    .refresh_access_token(refresh_token, redirect_uri)
                    .await
            }
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct ExternalGitProviderRegistry {
    providers: BTreeMap<ProviderInstanceId, ExternalGitProvider>,
}

impl ExternalGitProviderRegistry {
    pub(crate) fn from_providers(
        providers: impl IntoIterator<Item = ExternalGitProvider>,
    ) -> Result<Self, ProviderInstanceId> {
        let mut registry = BTreeMap::new();
        for provider in providers {
            let instance_id = provider.instance_id().clone();
            if registry.insert(instance_id.clone(), provider).is_some() {
                return Err(instance_id);
            }
        }
        Ok(Self {
            providers: registry,
        })
    }

    pub(crate) fn get(&self, instance_id: &ProviderInstanceId) -> Option<&ExternalGitProvider> {
        self.providers.get(instance_id)
    }

    pub(crate) fn len(&self) -> usize {
        self.providers.len()
    }

    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.providers.is_empty()
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = &ExternalGitProvider> {
        self.providers.values()
    }

    pub(crate) fn instance_ids(&self) -> impl Iterator<Item = ProviderInstanceId> + '_ {
        self.providers.keys().cloned()
    }
}

pub(crate) struct ExternalGitGateway<'runtime> {
    db: &'runtime PgPool,
    provider: Option<&'runtime ExternalGitProvider>,
}

impl<'runtime> ExternalGitGateway<'runtime> {
    pub(crate) const fn new(
        db: &'runtime PgPool,
        provider: Option<&'runtime ExternalGitProvider>,
    ) -> Self {
        Self { db, provider }
    }

    pub(crate) fn provider_id(&self) -> Option<ProviderInstanceId> {
        self.provider.map(|provider| provider.instance_id().clone())
    }

    pub(in crate::external_repositories) async fn git_http_authorization(
        &self,
        user_id: Uuid,
        force_refresh: bool,
    ) -> Result<GitHttpAuthorization, ProviderAccessTokenError> {
        let provider = self
            .provider
            .ok_or(ProviderAccessTokenError::NotConfigured)?;
        let access_token = self.access_token(user_id, force_refresh).await?;
        Ok(provider.git_http_authorization(access_token))
    }

    fn configured_provider(&self) -> Result<&ExternalGitProvider, ExternalGitProviderError> {
        self.provider.ok_or(ExternalGitProviderError::NotConfigured)
    }

    pub(in crate::external_repositories) async fn access_token(
        &self,
        user_id: Uuid,
        force_refresh: bool,
    ) -> Result<String, ProviderAccessTokenError> {
        provider_access_token(self.db, self.provider, user_id, force_refresh).await
    }

    pub(in crate::external_repositories) async fn mark_reauthorization_required(
        &self,
        user_id: Uuid,
        reason: &'static str,
    ) {
        mark_provider_reauth_required(self.db, self.provider, user_id, reason).await;
    }

    pub(crate) async fn list_repository_owners(
        &self,
        user_id: Uuid,
        query: &ProviderListQuery,
    ) -> Result<ProviderPage<RepositoryOwner>, ExternalGitProviderError> {
        match &self.configured_provider()?.adapter {
            ExternalGitAdapter::GitHub(provider) => {
                github::list_repository_owners(self, provider, user_id, query).await
            }
            ExternalGitAdapter::OAuth2(provider) => match provider.api() {
                RepositoryApiDialect::GitLab => {
                    gitlab::list_repository_owners(self, provider, user_id, query).await
                }
                RepositoryApiDialect::Forge(_) => {
                    forge::list_repository_owners(self, provider, user_id, query).await
                }
            },
        }
    }

    pub(crate) async fn list_repositories(
        &self,
        user_id: Uuid,
        query: &ProviderListQuery,
    ) -> Result<ProviderPage<RemoteRepository>, ExternalGitProviderError> {
        match &self.configured_provider()?.adapter {
            ExternalGitAdapter::GitHub(provider) => {
                github::list_repositories(self, provider, user_id, query).await
            }
            ExternalGitAdapter::OAuth2(provider) => match provider.api() {
                RepositoryApiDialect::GitLab => {
                    gitlab::list_repositories(self, provider, user_id, query).await
                }
                RepositoryApiDialect::Forge(_) => {
                    forge::list_repositories(self, provider, user_id, query).await
                }
            },
        }
    }

    pub(crate) async fn repository_details(
        &self,
        user_id: Uuid,
        repository_id: &str,
    ) -> Result<RemoteRepositoryDetails, ExternalGitProviderError> {
        match &self.configured_provider()?.adapter {
            ExternalGitAdapter::GitHub(provider) => {
                github::repository_details(self, provider, user_id, repository_id).await
            }
            ExternalGitAdapter::OAuth2(provider) => match provider.api() {
                RepositoryApiDialect::GitLab => {
                    gitlab::repository_details(self, provider, user_id, repository_id).await
                }
                RepositoryApiDialect::Forge(_) => {
                    forge::repository_details(self, provider, user_id, repository_id).await
                }
            },
        }
    }

    pub(crate) async fn list_repository_branches(
        &self,
        user_id: Uuid,
        repository_id: &str,
        query: &ProviderListQuery,
    ) -> Result<ProviderPage<RemoteBranch>, ExternalGitProviderError> {
        match &self.configured_provider()?.adapter {
            ExternalGitAdapter::GitHub(provider) => {
                github::list_repository_branches(self, provider, user_id, repository_id, query)
                    .await
            }
            ExternalGitAdapter::OAuth2(provider) => match provider.api() {
                RepositoryApiDialect::GitLab => {
                    gitlab::list_repository_branches(self, provider, user_id, repository_id, query)
                        .await
                }
                RepositoryApiDialect::Forge(_) => {
                    forge::list_repository_branches(self, provider, user_id, repository_id, query)
                        .await
                }
            },
        }
    }

    pub(crate) async fn find_repository_branch(
        &self,
        user_id: Uuid,
        repository_id: &str,
        branch: &str,
    ) -> Result<RemoteBranch, ExternalGitProviderError> {
        let query = ProviderListQuery {
            search: Some(branch.to_string()),
            page: 1,
            per_page: 100,
        };
        self.list_repository_branches(user_id, repository_id, &query)
            .await?
            .items
            .into_iter()
            .find(|candidate| candidate.name == branch)
            .ok_or(ExternalGitProviderError::NotFound)
    }

    pub(crate) async fn create_repository(
        &self,
        user_id: Uuid,
        name: &str,
        path: &str,
        owner_id: &str,
        owner_kind: RepositoryOwnerKind,
        visibility: ExternalGitRepositoryVisibility,
    ) -> Result<RemoteRepositoryDetails, ExternalGitProviderError> {
        let provider = self.configured_provider()?;
        let input =
            provider.prepare_repository_creation(name, path, owner_id, owner_kind, visibility)?;
        match &provider.adapter {
            ExternalGitAdapter::GitHub(_) => Err(ExternalGitProviderError::InvalidRequest),
            ExternalGitAdapter::OAuth2(provider) => match provider.api() {
                RepositoryApiDialect::GitLab => {
                    gitlab::create_repository(self, provider, user_id, &input).await
                }
                RepositoryApiDialect::Forge(_) => {
                    forge::create_repository(self, provider, user_id, &input).await
                }
            },
        }
    }

    pub(crate) fn validate_repository(&self, details: &RemoteRepositoryDetails) -> bool {
        match self.provider.map(|provider| &provider.adapter) {
            Some(ExternalGitAdapter::GitHub(provider)) => {
                github::validate_repository(provider, details)
            }
            Some(ExternalGitAdapter::OAuth2(provider)) => match provider.api() {
                RepositoryApiDialect::GitLab => gitlab::validate_repository(provider, details),
                RepositoryApiDialect::Forge(_) => forge::validate_repository(provider, details),
            },
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider() -> Result<ExternalGitProvider, InvalidProviderInstanceId> {
        Ok(ExternalGitProvider::oauth2(
            "gitlab".parse()?,
            "GitLab".to_string(),
            ProviderBrand::GitLab,
            false,
            OAuth2GitProvider::new(OAuth2GitProviderConfig {
                base_url: "https://gitlab.example.com".to_string(),
                api_url: "https://gitlab.example.com/api/v4".to_string(),
                api: RepositoryApiDialect::GitLab,
                client_id: "client-id".to_string(),
                client_secret: "client-secret".to_string(),
                redirect_uri:
                    "https://collab.example.test/v1/external-git/providers/gitlab/callback"
                        .to_string(),
                token_encryption_key: Arc::new([0_u8; 32]),
                http_client: reqwest::Client::new(),
            }),
        ))
    }

    #[test]
    fn repository_creation_is_normalized_before_reaching_an_adapter(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let request = provider()?.prepare_repository_creation(
            "  Quarterly Slides  ",
            "  quarterly-slides  ",
            "  42  ",
            RepositoryOwnerKind::Organization,
            ExternalGitRepositoryVisibility::Private,
        )?;

        assert_eq!(request.name, "Quarterly Slides");
        assert_eq!(request.path, "quarterly-slides");
        assert_eq!(request.owner_id, "42");
        assert_eq!(request.owner_kind, RepositoryOwnerKind::Organization);
        assert!(request.initialize);
        Ok(())
    }

    #[test]
    fn repository_creation_rejects_invalid_generic_and_provider_fields(
    ) -> Result<(), InvalidProviderInstanceId> {
        let provider = provider()?;
        for (name, path, owner_id) in [
            ("", "slides", "42"),
            ("Slides", "../slides", "42"),
            ("Slides", "slides", ""),
        ] {
            assert!(matches!(
                provider.prepare_repository_creation(
                    name,
                    path,
                    owner_id,
                    RepositoryOwnerKind::User,
                    ExternalGitRepositoryVisibility::Private,
                ),
                Err(ExternalGitProviderError::InvalidRequest)
            ));
        }
        Ok(())
    }
}
