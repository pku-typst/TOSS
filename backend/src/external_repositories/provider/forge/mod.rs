use super::http_session::AuthenticatedProviderClient;
use super::{
    CreateRemoteRepository, ExternalGitGateway, ExternalGitProviderError,
    ExternalGitRepositoryVisibility, OAuth2GitProvider, ProviderIdentity, ProviderIdentityError,
    ProviderIdentityResource, ProviderListQuery, ProviderLoginProfile, ProviderPage, RemoteBranch,
    RemoteRepository, RemoteRepositoryDetails, RepositoryAccess, RepositoryOwner,
    RepositoryOwnerKind,
};
use crate::external_repositories::config::external_git_url_has_same_origin;
use chrono::{DateTime, Utc};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Deserialize)]
struct ForgeUser {
    id: i64,
    login: String,
    full_name: Option<String>,
    email: Option<String>,
    html_url: String,
}

#[derive(Deserialize)]
struct ForgeEmail {
    email: String,
    primary: bool,
    verified: bool,
}

impl ForgeUser {
    fn into_identity(self) -> ProviderIdentity {
        ProviderIdentity {
            account_id: self.id.to_string(),
            username: self.login,
            name: self.full_name.filter(|name| !name.trim().is_empty()),
            email: self.email.filter(|email| !email.trim().is_empty()),
        }
    }

    fn into_owner(self) -> RepositoryOwner {
        let display_name = self
            .full_name
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| self.login.clone());
        RepositoryOwner {
            id: self.login.clone(),
            name: display_name,
            path: self.login.clone(),
            kind: RepositoryOwnerKind::User,
            full_path: self.login,
            web_url: self.html_url,
        }
    }
}

async fn fetch_user(
    provider: &OAuth2GitProvider,
    access_token: &str,
) -> Result<ForgeUser, ProviderIdentityError> {
    let response = provider
        .http_client()
        .get(format!("{}/user", provider.api_url()))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|source| ProviderIdentityError::Transport { source })?;
    if !response.status().is_success() {
        return Err(ProviderIdentityError::Rejected {
            resource: ProviderIdentityResource::Profile,
            status: response.status(),
        });
    }
    response
        .json::<ForgeUser>()
        .await
        .map_err(|source| ProviderIdentityError::InvalidResponse { source })
}

pub(super) async fn fetch_identity(
    provider: &OAuth2GitProvider,
    access_token: &str,
) -> Result<ProviderIdentity, ProviderIdentityError> {
    Ok(fetch_user(provider, access_token).await?.into_identity())
}

pub(super) async fn fetch_login_profile(
    provider: &OAuth2GitProvider,
    access_token: &str,
) -> Result<ProviderLoginProfile, ProviderIdentityError> {
    let identity = fetch_user(provider, access_token).await?.into_identity();
    let response = provider
        .http_client()
        .get(format!("{}/user/emails", provider.api_url()))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|source| ProviderIdentityError::Transport { source })?;
    if !response.status().is_success() {
        return Err(ProviderIdentityError::Rejected {
            resource: ProviderIdentityResource::VerifiedEmails,
            status: response.status(),
        });
    }
    let emails = response
        .json::<Vec<ForgeEmail>>()
        .await
        .map_err(|source| ProviderIdentityError::InvalidResponse { source })?;
    let verified_email = emails
        .into_iter()
        .find(|email| email.primary && email.verified)
        .map(|email| email.email)
        .filter(|email| !email.trim().is_empty())
        .ok_or(ProviderIdentityError::VerifiedEmailUnavailable)?;
    Ok(ProviderLoginProfile {
        identity,
        verified_email,
    })
}

#[derive(Deserialize)]
struct ForgeOrganization {
    name: String,
    full_name: Option<String>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
struct ForgeRepositoryPermissions {
    admin: bool,
    pull: bool,
    push: bool,
}

impl ForgeRepositoryPermissions {
    fn access(&self) -> RepositoryAccess {
        if self.admin {
            RepositoryAccess::Admin
        } else if self.push {
            RepositoryAccess::Write
        } else if self.pull {
            RepositoryAccess::Read
        } else {
            RepositoryAccess::None
        }
    }
}

#[derive(Clone, Deserialize)]
struct ForgeRepository {
    id: i64,
    name: String,
    full_name: String,
    default_branch: Option<String>,
    private: bool,
    internal: bool,
    html_url: String,
    clone_url: String,
    #[serde(default)]
    archived: bool,
    #[serde(default)]
    permissions: ForgeRepositoryPermissions,
}

impl ForgeRepository {
    fn visibility(&self) -> ExternalGitRepositoryVisibility {
        if self.private {
            ExternalGitRepositoryVisibility::Private
        } else if self.internal {
            ExternalGitRepositoryVisibility::Internal
        } else {
            ExternalGitRepositoryVisibility::Public
        }
    }

    fn into_remote(self) -> RemoteRepositoryDetails {
        let access = self.permissions.access();
        let visibility = self.visibility();
        let clone_url = self.clone_url;
        let repository = RemoteRepository {
            id: self.id.to_string(),
            name: self.name.clone(),
            path: self.name,
            full_path: self.full_name,
            default_branch: self.default_branch,
            visibility,
            web_url: self.html_url,
            archived: self.archived,
        };
        RemoteRepositoryDetails {
            repository,
            clone_url,
            access,
        }
    }
}

#[derive(Deserialize)]
struct ForgeRepositorySearchResults {
    ok: bool,
    data: Vec<ForgeRepository>,
}

#[derive(Deserialize)]
struct ForgeBranchCommit {
    id: String,
    timestamp: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
struct ForgeBranch {
    name: String,
    protected: bool,
    commit: ForgeBranchCommit,
}

#[derive(Serialize)]
struct ForgeCreateRepositoryRequest<'input> {
    name: &'input str,
    private: bool,
    auto_init: bool,
}

fn parse_repository_id(raw: &str) -> Result<i64, ExternalGitProviderError> {
    raw.parse::<i64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or(ExternalGitProviderError::InvalidRequest)
}

fn forge_api_url(
    provider: &OAuth2GitProvider,
    segments: &[&str],
) -> Result<reqwest::Url, ExternalGitProviderError> {
    let mut url = reqwest::Url::parse(provider.api_url())
        .map_err(|_| ExternalGitProviderError::InvalidRequest)?;
    url.path_segments_mut()
        .map_err(|_| ExternalGitProviderError::InvalidRequest)?
        .pop_if_empty()
        .extend(segments);
    Ok(url)
}

fn forge_web_url(
    provider: &OAuth2GitProvider,
    segments: &[&str],
) -> Result<String, ExternalGitProviderError> {
    let mut url = reqwest::Url::parse(provider.base_url())
        .map_err(|_| ExternalGitProviderError::InvalidRequest)?;
    url.path_segments_mut()
        .map_err(|_| ExternalGitProviderError::InvalidRequest)?
        .pop_if_empty()
        .extend(segments);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

async fn forge_get<T: DeserializeOwned>(
    gateway: &ExternalGitGateway<'_>,
    provider: &OAuth2GitProvider,
    user_id: Uuid,
    segments: &[&str],
    query: &[(String, String)],
) -> Result<T, ExternalGitProviderError> {
    let url = forge_api_url(provider, segments)?;
    let session = AuthenticatedProviderClient::new(gateway, provider.http_client(), user_id);
    session
        .send(|client| client.get(url.clone()).query(query))
        .await?
        .json::<T>()
        .await
        .map_err(|source| ExternalGitProviderError::InvalidResponse { source })
}

async fn forge_get_page<T: DeserializeOwned>(
    gateway: &ExternalGitGateway<'_>,
    provider: &OAuth2GitProvider,
    user_id: Uuid,
    segments: &[&str],
    input: &ProviderListQuery,
) -> Result<ProviderPage<T>, ExternalGitProviderError> {
    let query = [
        ("page".to_string(), input.page.to_string()),
        ("limit".to_string(), input.per_page.to_string()),
    ];
    let url = forge_api_url(provider, segments)?;
    let session = AuthenticatedProviderClient::new(gateway, provider.http_client(), user_id);
    let response = session
        .send(|client| client.get(url.clone()).query(&query))
        .await?;
    let total_count = response
        .headers()
        .get("x-total-count")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let items = response
        .json::<Vec<T>>()
        .await
        .map_err(|source| ExternalGitProviderError::InvalidResponse { source })?;
    let consumed = u64::from(input.page).saturating_mul(u64::from(input.per_page));
    let has_more = total_count
        .map(|total| consumed < total)
        .unwrap_or(items.len() == input.per_page as usize);
    Ok(ProviderPage {
        items,
        next_page: has_more.then(|| input.page.saturating_add(1)),
    })
}

async fn forge_post<T: DeserializeOwned, B: Serialize + ?Sized>(
    gateway: &ExternalGitGateway<'_>,
    provider: &OAuth2GitProvider,
    user_id: Uuid,
    segments: &[&str],
    body: &B,
) -> Result<T, ExternalGitProviderError> {
    let url = forge_api_url(provider, segments)?;
    let session = AuthenticatedProviderClient::new(gateway, provider.http_client(), user_id);
    session
        .send(|client| client.post(url.clone()).json(body))
        .await?
        .json::<T>()
        .await
        .map_err(|source| ExternalGitProviderError::InvalidResponse { source })
}

async fn current_user(
    gateway: &ExternalGitGateway<'_>,
    provider: &OAuth2GitProvider,
    user_id: Uuid,
) -> Result<ForgeUser, ExternalGitProviderError> {
    forge_get(gateway, provider, user_id, &["user"], &[]).await
}

pub(super) async fn list_repository_owners(
    gateway: &ExternalGitGateway<'_>,
    provider: &OAuth2GitProvider,
    user_id: Uuid,
    input: &ProviderListQuery,
) -> Result<ProviderPage<RepositoryOwner>, ExternalGitProviderError> {
    let user = current_user(gateway, provider, user_id).await?;
    let organizations =
        forge_get_page::<ForgeOrganization>(gateway, provider, user_id, &["user", "orgs"], input)
            .await?;
    let mut owners = Vec::with_capacity(
        organizations
            .items
            .len()
            .saturating_add(usize::from(input.page == 1)),
    );
    if input.page == 1 {
        owners.push(user.into_owner());
    }
    for organization in organizations.items {
        if organization.name.trim().is_empty() {
            return Err(ExternalGitProviderError::MalformedResponse);
        }
        let display_name = organization
            .full_name
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| organization.name.clone());
        owners.push(RepositoryOwner {
            id: organization.name.clone(),
            name: display_name,
            path: organization.name.clone(),
            kind: RepositoryOwnerKind::Organization,
            full_path: organization.name.clone(),
            web_url: forge_web_url(provider, &[&organization.name])?,
        });
    }
    let search = input.search.as_ref().map(|value| value.to_lowercase());
    owners.retain(|owner| {
        search
            .as_ref()
            .is_none_or(|search| owner.full_path.to_lowercase().contains(search))
    });
    owners.sort_by(|left, right| left.full_path.cmp(&right.full_path));
    owners.dedup_by(|left, right| left.id == right.id);
    Ok(ProviderPage {
        items: owners,
        next_page: organizations.next_page,
    })
}

pub(super) async fn list_repositories(
    gateway: &ExternalGitGateway<'_>,
    provider: &OAuth2GitProvider,
    user_id: Uuid,
    input: &ProviderListQuery,
) -> Result<ProviderPage<RemoteRepository>, ExternalGitProviderError> {
    let user = current_user(gateway, provider, user_id).await?;
    let mut query = vec![
        ("uid".to_string(), user.id.to_string()),
        ("private".to_string(), "true".to_string()),
        ("archived".to_string(), "false".to_string()),
        ("sort".to_string(), "updated".to_string()),
        ("order".to_string(), "desc".to_string()),
        ("page".to_string(), input.page.to_string()),
        ("limit".to_string(), input.per_page.to_string()),
    ];
    if let Some(search) = input.search.as_ref() {
        query.push(("q".to_string(), search.clone()));
    }
    let response: ForgeRepositorySearchResults =
        forge_get(gateway, provider, user_id, &["repos", "search"], &query).await?;
    if !response.ok {
        return Err(ExternalGitProviderError::MalformedResponse);
    }
    let result_count = response.data.len();
    let items = response
        .data
        .into_iter()
        .filter(|repository| !repository.archived && repository.permissions.access().can_write())
        .map(|repository| repository.into_remote().repository)
        .collect();
    Ok(ProviderPage {
        items,
        next_page: (result_count == input.per_page as usize).then(|| input.page.saturating_add(1)),
    })
}

async fn forge_repository(
    gateway: &ExternalGitGateway<'_>,
    provider: &OAuth2GitProvider,
    user_id: Uuid,
    repository_id: i64,
) -> Result<ForgeRepository, ExternalGitProviderError> {
    let repository_id = repository_id.to_string();
    forge_get(
        gateway,
        provider,
        user_id,
        &["repositories", &repository_id],
        &[],
    )
    .await
}

pub(super) async fn repository_details(
    gateway: &ExternalGitGateway<'_>,
    provider: &OAuth2GitProvider,
    user_id: Uuid,
    repository_id: &str,
) -> Result<RemoteRepositoryDetails, ExternalGitProviderError> {
    forge_repository(
        gateway,
        provider,
        user_id,
        parse_repository_id(repository_id)?,
    )
    .await
    .map(ForgeRepository::into_remote)
}

pub(super) async fn list_repository_branches(
    gateway: &ExternalGitGateway<'_>,
    provider: &OAuth2GitProvider,
    user_id: Uuid,
    repository_id: &str,
    input: &ProviderListQuery,
) -> Result<ProviderPage<RemoteBranch>, ExternalGitProviderError> {
    let details = forge_repository(
        gateway,
        provider,
        user_id,
        parse_repository_id(repository_id)?,
    )
    .await?;
    if details.archived || !details.permissions.access().can_write() {
        return Err(ExternalGitProviderError::Forbidden);
    }
    let Some((owner, repository)) = details.full_name.split_once('/') else {
        return Err(ExternalGitProviderError::MalformedResponse);
    };
    if owner.is_empty() || repository.is_empty() || repository.contains('/') {
        return Err(ExternalGitProviderError::MalformedResponse);
    }
    let page = forge_get_page::<ForgeBranch>(
        gateway,
        provider,
        user_id,
        &["repos", owner, repository, "branches"],
        input,
    )
    .await?;
    let search = input.search.as_ref().map(|value| value.to_lowercase());
    let default_branch = details.default_branch.as_deref();
    Ok(ProviderPage {
        items: page
            .items
            .into_iter()
            .filter(|branch| {
                search
                    .as_ref()
                    .is_none_or(|search| branch.name.to_lowercase().contains(search))
            })
            .map(|branch| RemoteBranch {
                default: default_branch == Some(branch.name.as_str()),
                name: branch.name,
                protected: branch.protected,
                commit_sha: branch.commit.id,
                committed_at: branch.commit.timestamp,
            })
            .collect(),
        next_page: page.next_page,
    })
}

fn create_repository_segments(input: &CreateRemoteRepository) -> Vec<&str> {
    match input.owner_kind {
        RepositoryOwnerKind::User => vec!["user", "repos"],
        RepositoryOwnerKind::Organization => vec!["orgs", input.owner_id.as_str(), "repos"],
    }
}

pub(super) async fn create_repository(
    gateway: &ExternalGitGateway<'_>,
    provider: &OAuth2GitProvider,
    user_id: Uuid,
    input: &CreateRemoteRepository,
) -> Result<RemoteRepositoryDetails, ExternalGitProviderError> {
    let request = ForgeCreateRepositoryRequest {
        name: &input.path,
        private: input.visibility == ExternalGitRepositoryVisibility::Private,
        auto_init: input.initialize,
    };
    forge_post::<ForgeRepository, _>(
        gateway,
        provider,
        user_id,
        &create_repository_segments(input),
        &request,
    )
    .await
    .map(ForgeRepository::into_remote)
}

pub(super) fn validate_repository_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 100
        || !bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.'))
    {
        return false;
    }
    let normalized = path.to_ascii_lowercase();
    !matches!(normalized.as_str(), "." | ".." | "-")
        && ![".git", ".wiki", ".rss", ".atom"]
            .iter()
            .any(|suffix| normalized.ends_with(suffix))
}

pub(super) fn validate_repository(
    provider: &OAuth2GitProvider,
    details: &RemoteRepositoryDetails,
) -> bool {
    let repository = &details.repository;
    let mut path = repository.full_path.split('/');
    let valid_full_path = matches!(
        (path.next(), path.next(), path.next()),
        (Some(owner), Some(name), None) if !owner.is_empty() && !name.is_empty()
    );
    if repository
        .id
        .parse::<i64>()
        .ok()
        .is_none_or(|value| value <= 0)
        || !valid_full_path
        || repository.web_url.trim().is_empty()
        || details.clone_url.trim().is_empty()
    {
        return false;
    }
    for raw in [&repository.web_url, &details.clone_url] {
        let Ok(url) = reqwest::Url::parse(raw) else {
            return false;
        };
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !external_git_url_has_same_origin(provider.base_url(), raw)
        {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::super::{ForgeDialect, OAuth2GitProviderConfig, ProviderKind, RepositoryApiDialect};
    use super::*;
    use axum::http::{header::AUTHORIZATION, HeaderMap, StatusCode};
    use axum::routing::get;
    use axum::{Json, Router};
    use serde_json::json;
    use std::sync::Arc;

    fn provider_at(base_url: &str, dialect: ForgeDialect) -> OAuth2GitProvider {
        OAuth2GitProvider::new(OAuth2GitProviderConfig {
            base_url: base_url.to_string(),
            api_url: format!("{base_url}/api/v1"),
            api: RepositoryApiDialect::Forge(dialect),
            client_id: "client-id".to_string(),
            client_secret: "client-secret".to_string(),
            redirect_uri: "https://example.test/v1/external-git/providers/codeberg/callback"
                .to_string(),
            token_encryption_key: Arc::new([0_u8; 32]),
            http_client: reqwest::Client::new(),
        })
    }

    fn provider() -> OAuth2GitProvider {
        provider_at("https://codeberg.org", ForgeDialect::Forgejo)
    }

    fn has_test_bearer(headers: &HeaderMap) -> bool {
        headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            == Some("Bearer forge-token")
    }

    async fn user_response(headers: HeaderMap) -> Result<Json<serde_json::Value>, StatusCode> {
        if !has_test_bearer(&headers) {
            return Err(StatusCode::UNAUTHORIZED);
        }
        Ok(Json(json!({
            "id": 42,
            "login": "slide-author",
            "full_name": "Slide Author",
            "email": "profile@example.test",
            "html_url": "https://codeberg.org/slide-author"
        })))
    }

    async fn email_response(headers: HeaderMap) -> Result<Json<serde_json::Value>, StatusCode> {
        if !has_test_bearer(&headers) {
            return Err(StatusCode::UNAUTHORIZED);
        }
        Ok(Json(json!([
            {
                "email": "unverified@example.test",
                "primary": true,
                "verified": false
            },
            {
                "email": "secondary@example.test",
                "primary": false,
                "verified": true
            },
            {
                "email": "verified@example.test",
                "primary": true,
                "verified": true
            }
        ])))
    }

    fn creation(owner_kind: RepositoryOwnerKind) -> CreateRemoteRepository {
        CreateRemoteRepository {
            name: "Quarterly Slides".to_string(),
            path: "quarterly-slides".to_string(),
            owner_id: "nv-docs".to_string(),
            owner_kind,
            visibility: ExternalGitRepositoryVisibility::Private,
            initialize: true,
        }
    }

    #[test]
    fn forge_owner_kind_selects_the_documented_creation_endpoint() {
        assert_eq!(
            create_repository_segments(&creation(RepositoryOwnerKind::User)),
            ["user", "repos"]
        );
        assert_eq!(
            create_repository_segments(&creation(RepositoryOwnerKind::Organization)),
            ["orgs", "nv-docs", "repos"]
        );
    }

    #[tokio::test]
    async fn gitea_and_forgejo_login_use_the_shared_verified_profile_contract(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let router = Router::new()
            .route("/api/v1/user", get(user_response))
            .route("/api/v1/user/emails", get(email_response));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let address = listener.local_addr()?;
        let server = tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, router).await {
                tracing::error!(%error, "test Forge API server stopped unexpectedly");
            }
        });
        let base_url = format!("http://{address}");
        for (dialect, expected_kind) in [
            (ForgeDialect::Gitea, ProviderKind::Gitea),
            (ForgeDialect::Forgejo, ProviderKind::Forgejo),
        ] {
            let provider = provider_at(&base_url, dialect);
            let profile = fetch_login_profile(&provider, "forge-token").await?;

            assert_eq!(provider.api().kind(), expected_kind);
            assert_eq!(profile.identity.account_id, "42");
            assert_eq!(profile.identity.username, "slide-author");
            assert_eq!(profile.verified_email, "verified@example.test");
        }
        server.abort();
        Ok(())
    }

    #[test]
    fn forge_repository_paths_follow_the_api_validation_contract() {
        assert!(validate_repository_path("quarterly-slides_2026.1"));
        assert!(!validate_repository_path(""));
        assert!(!validate_repository_path("slides/child"));
        assert!(!validate_repository_path("slides.git"));
        assert!(!validate_repository_path("幻灯片"));
        assert!(!validate_repository_path(&"a".repeat(101)));
    }

    #[test]
    fn forge_repository_fields_map_to_context_access_and_visibility(
    ) -> Result<(), serde_json::Error> {
        let repository: ForgeRepository = serde_json::from_value(serde_json::json!({
            "id": 42,
            "name": "slides",
            "full_name": "nv/slides",
            "default_branch": "main",
            "private": false,
            "internal": true,
            "html_url": "https://codeberg.org/nv/slides",
            "clone_url": "https://codeberg.org/nv/slides.git",
            "archived": false,
            "permissions": { "pull": true, "push": true, "admin": false }
        }))?;
        let details = repository.into_remote();

        assert_eq!(
            details.repository.visibility,
            ExternalGitRepositoryVisibility::Internal
        );
        assert_eq!(details.access, RepositoryAccess::Write);
        assert!(validate_repository(&provider(), &details));
        Ok(())
    }

    #[test]
    fn forge_repository_urls_are_limited_to_the_configured_origin() -> Result<(), serde_json::Error>
    {
        let repository: ForgeRepository = serde_json::from_value(serde_json::json!({
            "id": 42,
            "name": "slides",
            "full_name": "nv/slides",
            "default_branch": "main",
            "private": true,
            "internal": false,
            "html_url": "https://codeberg.org/nv/slides",
            "clone_url": "https://codeberg.org/nv/slides.git",
            "archived": false,
            "permissions": { "admin": true }
        }))?;
        let mut details = repository.into_remote();
        details.clone_url = "https://example.test/nv/slides.git".to_string();

        assert!(!validate_repository(&provider(), &details));
        Ok(())
    }
}
