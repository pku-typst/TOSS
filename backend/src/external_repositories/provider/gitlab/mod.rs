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

#[derive(Deserialize)]
struct GitLabUser {
    id: i64,
    username: String,
    name: Option<String>,
    email: Option<String>,
    confirmed_at: Option<String>,
}

impl GitLabUser {
    fn into_identity(self) -> ProviderIdentity {
        ProviderIdentity {
            account_id: self.id.to_string(),
            username: self.username,
            name: self.name,
            email: self.email,
        }
    }
}

async fn fetch_user(
    provider: &OAuth2GitProvider,
    access_token: &str,
) -> Result<GitLabUser, ProviderIdentityError> {
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
        .json::<GitLabUser>()
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
    let user = fetch_user(provider, access_token).await?;
    let verified_email = user
        .email
        .as_ref()
        .map(|email| email.trim())
        .filter(|email| !email.is_empty())
        .map(str::to_string)
        .filter(|_| user.confirmed_at.is_some())
        .ok_or(ProviderIdentityError::VerifiedEmailUnavailable)?;
    Ok(ProviderLoginProfile {
        identity: user.into_identity(),
        verified_email,
    })
}

#[derive(Clone, Deserialize)]
struct GitLabNamespace {
    id: i64,
    name: String,
    path: String,
    kind: String,
    full_path: String,
    web_url: String,
}

impl From<GitLabNamespace> for RepositoryOwner {
    fn from(value: GitLabNamespace) -> Self {
        let kind = if value.kind.eq_ignore_ascii_case("user") {
            RepositoryOwnerKind::User
        } else {
            RepositoryOwnerKind::Organization
        };
        Self {
            id: value.id.to_string(),
            name: value.name,
            path: value.path,
            kind,
            full_path: value.full_path,
            web_url: value.web_url,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct GitLabProjectSummary {
    id: i64,
    name: String,
    path: String,
    path_with_namespace: String,
    default_branch: Option<String>,
    visibility: ExternalGitRepositoryVisibility,
    web_url: String,
    http_url_to_repo: String,
    archived: bool,
}

impl GitLabProjectSummary {
    fn into_context_model(self) -> (RemoteRepository, String) {
        (
            RemoteRepository {
                id: self.id.to_string(),
                name: self.name,
                path: self.path,
                full_path: self.path_with_namespace,
                default_branch: self.default_branch,
                visibility: self.visibility,
                web_url: self.web_url,
                archived: self.archived,
            },
            self.http_url_to_repo,
        )
    }
}

impl From<GitLabProjectSummary> for RemoteRepository {
    fn from(value: GitLabProjectSummary) -> Self {
        value.into_context_model().0
    }
}

#[derive(Clone, Serialize)]
struct GitLabCreateProjectRequest {
    name: String,
    path: String,
    namespace_id: i64,
    visibility: ExternalGitRepositoryVisibility,
    initialize_with_readme: bool,
}

#[derive(Deserialize)]
struct GitLabProjectPermissions {
    project_access: Option<GitLabProjectAccess>,
    group_access: Option<GitLabProjectAccess>,
}

#[derive(Deserialize)]
struct GitLabProjectAccess {
    access_level: i32,
}

#[derive(Deserialize)]
struct GitLabProjectDetails {
    #[serde(flatten)]
    project: GitLabProjectSummary,
    permissions: Option<GitLabProjectPermissions>,
}

impl GitLabProjectDetails {
    fn effective_access_level(&self) -> i32 {
        self.permissions
            .as_ref()
            .map(|permissions| {
                permissions
                    .project_access
                    .as_ref()
                    .map(|access| access.access_level)
                    .unwrap_or(0)
                    .max(
                        permissions
                            .group_access
                            .as_ref()
                            .map(|access| access.access_level)
                            .unwrap_or(0),
                    )
            })
            .unwrap_or(0)
    }

    fn into_remote(self) -> RemoteRepositoryDetails {
        let access = gitlab_access(self.effective_access_level());
        let (repository, clone_url) = self.project.into_context_model();
        RemoteRepositoryDetails {
            repository,
            clone_url,
            access,
        }
    }
}

#[derive(Clone, Deserialize)]
struct GitLabBranchCommit {
    id: String,
    committed_date: Option<DateTime<Utc>>,
}

#[derive(Clone, Deserialize)]
struct GitLabBranch {
    name: String,
    default: bool,
    protected: bool,
    commit: GitLabBranchCommit,
}

impl From<GitLabBranch> for RemoteBranch {
    fn from(value: GitLabBranch) -> Self {
        Self {
            name: value.name,
            default: value.default,
            protected: value.protected,
            commit_sha: value.commit.id,
            committed_at: value.commit.committed_date,
        }
    }
}

fn gitlab_access(access_level: i32) -> RepositoryAccess {
    match access_level {
        ..=0 => RepositoryAccess::None,
        1..=29 => RepositoryAccess::Read,
        30..=39 => RepositoryAccess::Write,
        40..=49 => RepositoryAccess::Maintain,
        _ => RepositoryAccess::Admin,
    }
}

fn parse_repository_id(raw: &str) -> Result<i64, ExternalGitProviderError> {
    raw.parse::<i64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or(ExternalGitProviderError::InvalidRequest)
}

async fn gitlab_get_page<T: DeserializeOwned>(
    gateway: &ExternalGitGateway<'_>,
    provider: &OAuth2GitProvider,
    user_id: Uuid,
    path: &str,
    query: &[(String, String)],
) -> Result<ProviderPage<T>, ExternalGitProviderError> {
    let url = format!("{}/{}", provider.api_url(), path.trim_start_matches('/'));
    let session = AuthenticatedProviderClient::new(gateway, provider.http_client(), user_id);
    let response = session.send(|client| client.get(&url).query(query)).await?;
    let next_page = response
        .headers()
        .get("x-next-page")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<u32>().ok());
    let items = response
        .json::<Vec<T>>()
        .await
        .map_err(|source| ExternalGitProviderError::InvalidResponse { source })?;
    Ok(ProviderPage { items, next_page })
}

async fn gitlab_get_project(
    gateway: &ExternalGitGateway<'_>,
    provider: &OAuth2GitProvider,
    user_id: Uuid,
    project_id: i64,
) -> Result<GitLabProjectDetails, ExternalGitProviderError> {
    let url = format!("{}/projects/{project_id}", provider.api_url());
    let session = AuthenticatedProviderClient::new(gateway, provider.http_client(), user_id);
    session
        .send(|client| client.get(&url))
        .await?
        .json::<GitLabProjectDetails>()
        .await
        .map_err(|source| ExternalGitProviderError::InvalidResponse { source })
}

async fn gitlab_create_project(
    gateway: &ExternalGitGateway<'_>,
    provider: &OAuth2GitProvider,
    user_id: Uuid,
    input: &GitLabCreateProjectRequest,
) -> Result<GitLabProjectDetails, ExternalGitProviderError> {
    let url = format!("{}/projects", provider.api_url());
    let session = AuthenticatedProviderClient::new(gateway, provider.http_client(), user_id);
    session
        .send(|client| client.post(&url).json(input))
        .await?
        .json::<GitLabProjectDetails>()
        .await
        .map_err(|source| ExternalGitProviderError::InvalidResponse { source })
}

pub(super) async fn list_repository_owners(
    gateway: &ExternalGitGateway<'_>,
    provider: &OAuth2GitProvider,
    user_id: Uuid,
    input: &ProviderListQuery,
) -> Result<ProviderPage<RepositoryOwner>, ExternalGitProviderError> {
    let mut query = vec![
        ("owned_only".to_string(), "true".to_string()),
        ("page".to_string(), input.page.to_string()),
        ("per_page".to_string(), input.per_page.to_string()),
    ];
    if let Some(search) = input.search.as_ref() {
        query.push(("search".to_string(), search.clone()));
        query.push(("full_path_search".to_string(), "true".to_string()));
    }
    let page = gitlab_get_page::<GitLabNamespace>(gateway, provider, user_id, "namespaces", &query)
        .await?;
    Ok(ProviderPage {
        items: page.items.into_iter().map(RepositoryOwner::from).collect(),
        next_page: page.next_page,
    })
}

pub(super) async fn list_repositories(
    gateway: &ExternalGitGateway<'_>,
    provider: &OAuth2GitProvider,
    user_id: Uuid,
    input: &ProviderListQuery,
) -> Result<ProviderPage<RemoteRepository>, ExternalGitProviderError> {
    let mut query = vec![
        ("membership".to_string(), "true".to_string()),
        ("min_access_level".to_string(), "30".to_string()),
        ("simple".to_string(), "true".to_string()),
        ("active".to_string(), "true".to_string()),
        ("order_by".to_string(), "last_activity_at".to_string()),
        ("sort".to_string(), "desc".to_string()),
        ("page".to_string(), input.page.to_string()),
        ("per_page".to_string(), input.per_page.to_string()),
    ];
    if let Some(search) = input.search.as_ref() {
        query.push(("search".to_string(), search.clone()));
        query.push(("search_namespaces".to_string(), "true".to_string()));
    }
    let page =
        gitlab_get_page::<GitLabProjectSummary>(gateway, provider, user_id, "projects", &query)
            .await?;
    Ok(ProviderPage {
        items: page.items.into_iter().map(RemoteRepository::from).collect(),
        next_page: page.next_page,
    })
}

pub(super) async fn repository_details(
    gateway: &ExternalGitGateway<'_>,
    provider: &OAuth2GitProvider,
    user_id: Uuid,
    repository_id: &str,
) -> Result<RemoteRepositoryDetails, ExternalGitProviderError> {
    let project_id = parse_repository_id(repository_id)?;
    gitlab_get_project(gateway, provider, user_id, project_id)
        .await
        .map(GitLabProjectDetails::into_remote)
}

pub(super) async fn list_repository_branches(
    gateway: &ExternalGitGateway<'_>,
    provider: &OAuth2GitProvider,
    user_id: Uuid,
    repository_id: &str,
    input: &ProviderListQuery,
) -> Result<ProviderPage<RemoteBranch>, ExternalGitProviderError> {
    let project_id = parse_repository_id(repository_id)?;
    let details = gitlab_get_project(gateway, provider, user_id, project_id).await?;
    if details.project.archived || !gitlab_access(details.effective_access_level()).can_write() {
        return Err(ExternalGitProviderError::Forbidden);
    }
    let mut query = vec![
        ("page".to_string(), input.page.to_string()),
        ("per_page".to_string(), input.per_page.to_string()),
    ];
    if let Some(search) = input.search.as_ref() {
        query.push(("search".to_string(), search.clone()));
    }
    let path = format!("projects/{project_id}/repository/branches");
    let page = gitlab_get_page::<GitLabBranch>(gateway, provider, user_id, &path, &query).await?;
    Ok(ProviderPage {
        items: page.items.into_iter().map(RemoteBranch::from).collect(),
        next_page: page.next_page,
    })
}

pub(super) async fn create_repository(
    gateway: &ExternalGitGateway<'_>,
    provider: &OAuth2GitProvider,
    user_id: Uuid,
    input: &CreateRemoteRepository,
) -> Result<RemoteRepositoryDetails, ExternalGitProviderError> {
    let namespace_id = parse_repository_id(&input.owner_id)?;
    let request = GitLabCreateProjectRequest {
        name: input.name.clone(),
        path: input.path.clone(),
        namespace_id,
        visibility: input.visibility,
        initialize_with_readme: input.initialize,
    };
    gitlab_create_project(gateway, provider, user_id, &request)
        .await
        .map(GitLabProjectDetails::into_remote)
}

pub(super) fn validate_repository_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    if bytes.is_empty() || bytes.len() > 255 {
        return false;
    }
    let (Some(first), Some(last)) = (bytes.first(), bytes.last()) else {
        return false;
    };
    if !first.is_ascii_alphanumeric() || !last.is_ascii_alphanumeric() {
        return false;
    }
    let mut previous_special = false;
    for byte in bytes {
        if byte.is_ascii_alphanumeric() {
            previous_special = false;
        } else if matches!(*byte, b'-' | b'_' | b'.') && !previous_special {
            previous_special = true;
        } else {
            return false;
        }
    }
    true
}

pub(super) fn validate_repository(
    provider: &OAuth2GitProvider,
    details: &RemoteRepositoryDetails,
) -> bool {
    let repository = &details.repository;
    if repository
        .id
        .parse::<i64>()
        .ok()
        .is_none_or(|value| value <= 0)
        || repository.full_path.trim().is_empty()
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
    use super::super::{OAuth2GitProviderConfig, RepositoryApiDialect};
    use super::*;
    use axum::http::{header::AUTHORIZATION, HeaderMap, StatusCode};
    use axum::routing::get;
    use axum::{Json, Router};
    use serde_json::json;
    use std::sync::Arc;

    fn provider_at(base_url: &str) -> OAuth2GitProvider {
        OAuth2GitProvider::new(OAuth2GitProviderConfig {
            base_url: base_url.to_string(),
            api_url: format!("{base_url}/api/v4"),
            api: RepositoryApiDialect::GitLab,
            client_id: "client-id".to_string(),
            client_secret: "client-secret".to_string(),
            redirect_uri: "https://example.test/v1/external-git/providers/gitlab/callback"
                .to_string(),
            token_encryption_key: Arc::new([0_u8; 32]),
            http_client: reqwest::Client::new(),
        })
    }

    async fn user_response(headers: HeaderMap) -> Result<Json<serde_json::Value>, StatusCode> {
        let authorized = headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            == Some("Bearer gitlab-token");
        if !authorized {
            return Err(StatusCode::UNAUTHORIZED);
        }
        Ok(Json(json!({
            "id": 42,
            "username": "slide-author",
            "name": "Slide Author",
            "email": "verified@example.test",
            "confirmed_at": "2026-07-13T00:00:00Z"
        })))
    }

    #[test]
    fn project_path_validation_rejects_ambiguous_or_unsafe_paths() {
        assert!(validate_repository_path("quarterly-slides_2026"));
        assert!(!validate_repository_path(""));
        assert!(!validate_repository_path("幻灯片"));
        assert!(!validate_repository_path("../slides"));
        assert!(!validate_repository_path("slides--draft"));
        assert!(!validate_repository_path("-slides"));
        assert!(!validate_repository_path("slides/child"));
    }

    #[tokio::test]
    async fn gitlab_login_accepts_only_the_confirmed_profile_email(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let router = Router::new().route("/api/v4/user", get(user_response));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let address = listener.local_addr()?;
        let server = tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, router).await {
                tracing::error!(%error, "test GitLab API server stopped unexpectedly");
            }
        });
        let provider = provider_at(&format!("http://{address}"));

        let profile = fetch_login_profile(&provider, "gitlab-token").await?;

        assert_eq!(profile.identity.account_id, "42");
        assert_eq!(profile.identity.username, "slide-author");
        assert_eq!(profile.verified_email, "verified@example.test");
        server.abort();
        Ok(())
    }

    #[test]
    fn project_details_translate_gitlab_permissions() -> Result<(), serde_json::Error> {
        let details: GitLabProjectDetails = serde_json::from_value(serde_json::json!({
            "id": 42,
            "name": "Slides",
            "path": "slides",
            "path_with_namespace": "nv/slides",
            "default_branch": "main",
            "visibility": "private",
            "web_url": "https://gitlab.example.com/nv/slides",
            "http_url_to_repo": "https://gitlab.example.com/nv/slides.git",
            "archived": false,
            "last_activity_at": "2026-07-09T00:00:00Z",
            "permissions": {
                "project_access": null,
                "group_access": { "access_level": 40 }
            }
        }))?;
        let remote = details.into_remote();
        assert_eq!(remote.repository.id, "42");
        assert_eq!(remote.repository.full_path, "nv/slides");
        assert_eq!(remote.clone_url, "https://gitlab.example.com/nv/slides.git");
        assert_eq!(remote.access, RepositoryAccess::Maintain);
        Ok(())
    }
}
