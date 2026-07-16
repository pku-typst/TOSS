mod oauth;

pub(super) use oauth::{
    authorization_url, exchange_authorization_code, fetch_identity, fetch_login_profile,
    login_authorization_url, refresh_access_token,
};

use super::{
    ExternalGitGateway, ExternalGitProviderError, ExternalGitRepositoryVisibility, GitHubProvider,
    ProviderListQuery, ProviderPage, RemoteBranch, RemoteRepository, RemoteRepositoryDetails,
    RepositoryAccess, RepositoryOwner, RepositoryOwnerKind,
};
use crate::external_repositories::config::external_git_url_has_same_origin;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use uuid::Uuid;

const GITHUB_API_VERSION: &str = "2026-03-10";

#[derive(Clone, Deserialize)]
struct GitHubAccount {
    id: u64,
    login: String,
    html_url: String,
    #[serde(rename = "type")]
    kind: String,
}

impl From<GitHubAccount> for RepositoryOwner {
    fn from(value: GitHubAccount) -> Self {
        let kind = if value.kind.eq_ignore_ascii_case("organization") {
            RepositoryOwnerKind::Organization
        } else {
            RepositoryOwnerKind::User
        };
        Self {
            id: value.id.to_string(),
            name: value.login.clone(),
            path: value.login.clone(),
            kind,
            full_path: value.login,
            web_url: value.html_url,
        }
    }
}

#[derive(Deserialize)]
struct GitHubInstallation {
    account: GitHubAccount,
}

#[derive(Deserialize)]
struct GitHubInstallations {
    total_count: u64,
    installations: Vec<GitHubInstallation>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
struct GitHubRepositoryPermissions {
    admin: bool,
    maintain: bool,
    push: bool,
    triage: bool,
    pull: bool,
}

impl GitHubRepositoryPermissions {
    fn access(&self) -> RepositoryAccess {
        if self.admin {
            RepositoryAccess::Admin
        } else if self.maintain {
            RepositoryAccess::Maintain
        } else if self.push {
            RepositoryAccess::Write
        } else if self.triage || self.pull {
            RepositoryAccess::Read
        } else {
            RepositoryAccess::None
        }
    }
}

#[derive(Clone, Deserialize)]
struct GitHubRepository {
    id: u64,
    name: String,
    full_name: String,
    default_branch: Option<String>,
    visibility: ExternalGitRepositoryVisibility,
    html_url: String,
    clone_url: String,
    archived: bool,
    #[serde(default)]
    permissions: GitHubRepositoryPermissions,
}

impl GitHubRepository {
    fn path(&self) -> String {
        self.full_name
            .rsplit_once('/')
            .map(|(_, path)| path)
            .unwrap_or(&self.name)
            .to_string()
    }

    fn into_remote(self) -> RemoteRepositoryDetails {
        let access = self.permissions.access();
        let path = self.path();
        let clone_url = self.clone_url;
        let repository = RemoteRepository {
            id: self.id.to_string(),
            name: self.name,
            path,
            full_path: self.full_name,
            default_branch: self.default_branch,
            visibility: self.visibility,
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

#[derive(Clone, Deserialize)]
struct GitHubBranchCommit {
    sha: String,
}

#[derive(Clone, Deserialize)]
struct GitHubBranch {
    name: String,
    protected: bool,
    commit: GitHubBranchCommit,
}

fn parse_repository_id(raw: &str) -> Result<u64, ExternalGitProviderError> {
    raw.parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or(ExternalGitProviderError::InvalidRequest)
}

fn github_api_url(
    provider: &GitHubProvider,
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

fn classify_github_status(status: reqwest::StatusCode) -> ExternalGitProviderError {
    match status {
        reqwest::StatusCode::UNAUTHORIZED => ExternalGitProviderError::ReauthorizationRequired,
        reqwest::StatusCode::FORBIDDEN => ExternalGitProviderError::Forbidden,
        reqwest::StatusCode::NOT_FOUND => ExternalGitProviderError::NotFound,
        reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::UNPROCESSABLE_ENTITY => {
            ExternalGitProviderError::InvalidRequest
        }
        reqwest::StatusCode::CONFLICT => ExternalGitProviderError::Conflict,
        value if value == reqwest::StatusCode::TOO_MANY_REQUESTS || value.is_server_error() => {
            ExternalGitProviderError::Unavailable { status: value }
        }
        value => ExternalGitProviderError::UnexpectedStatus { status: value },
    }
}

async fn github_get<T: DeserializeOwned>(
    provider: &GitHubProvider,
    access_token: &str,
    segments: &[&str],
    query: &[(String, String)],
) -> Result<T, ExternalGitProviderError> {
    let response = provider
        .http_client()
        .get(github_api_url(provider, segments)?)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
        .bearer_auth(access_token)
        .query(query)
        .send()
        .await
        .map_err(|source| ExternalGitProviderError::Transport { source })?;
    if !response.status().is_success() {
        return Err(classify_github_status(response.status()));
    }
    response
        .json::<T>()
        .await
        .map_err(|source| ExternalGitProviderError::InvalidResponse { source })
}

async fn get_with_refresh<T: DeserializeOwned>(
    gateway: &ExternalGitGateway<'_>,
    provider: &GitHubProvider,
    user_id: Uuid,
    segments: &[&str],
    query: &[(String, String)],
) -> Result<T, ExternalGitProviderError> {
    let access_token = gateway.access_token(user_id, false).await?;
    match github_get(provider, &access_token, segments, query).await {
        Err(ExternalGitProviderError::ReauthorizationRequired) => {
            let refreshed = gateway.access_token(user_id, true).await?;
            let result = github_get(provider, &refreshed, segments, query).await;
            if matches!(
                &result,
                Err(ExternalGitProviderError::ReauthorizationRequired)
            ) {
                gateway
                    .mark_reauthorization_required(user_id, "api_rejected_refreshed_token")
                    .await;
            }
            result
        }
        result => result,
    }
}

fn next_page(input: &ProviderListQuery, item_count: usize) -> Option<u32> {
    (item_count == input.per_page as usize).then(|| input.page.saturating_add(1))
}

pub(super) async fn list_repository_owners(
    gateway: &ExternalGitGateway<'_>,
    provider: &GitHubProvider,
    user_id: Uuid,
    input: &ProviderListQuery,
) -> Result<ProviderPage<RepositoryOwner>, ExternalGitProviderError> {
    let query = vec![
        ("page".to_string(), input.page.to_string()),
        ("per_page".to_string(), input.per_page.to_string()),
    ];
    let response: GitHubInstallations = get_with_refresh(
        gateway,
        provider,
        user_id,
        &["user", "installations"],
        &query,
    )
    .await?;
    let has_more =
        u64::from(input.page).saturating_mul(u64::from(input.per_page)) < response.total_count;
    let search = input.search.as_ref().map(|value| value.to_lowercase());
    let mut owners = response
        .installations
        .into_iter()
        .map(|installation| RepositoryOwner::from(installation.account))
        .filter(|owner| {
            search
                .as_ref()
                .is_none_or(|search| owner.full_path.to_lowercase().contains(search))
        })
        .collect::<Vec<_>>();
    owners.sort_by(|left, right| left.full_path.cmp(&right.full_path));
    owners.dedup_by(|left, right| left.id == right.id);
    Ok(ProviderPage {
        next_page: has_more.then(|| input.page.saturating_add(1)),
        items: owners,
    })
}

pub(super) async fn list_repositories(
    gateway: &ExternalGitGateway<'_>,
    provider: &GitHubProvider,
    user_id: Uuid,
    input: &ProviderListQuery,
) -> Result<ProviderPage<RemoteRepository>, ExternalGitProviderError> {
    let query = vec![
        ("visibility".to_string(), "all".to_string()),
        (
            "affiliation".to_string(),
            "owner,collaborator,organization_member".to_string(),
        ),
        ("sort".to_string(), "pushed".to_string()),
        ("direction".to_string(), "desc".to_string()),
        ("page".to_string(), input.page.to_string()),
        ("per_page".to_string(), input.per_page.to_string()),
    ];
    let repositories: Vec<GitHubRepository> =
        get_with_refresh(gateway, provider, user_id, &["user", "repos"], &query).await?;
    let result_count = repositories.len();
    let search = input.search.as_ref().map(|value| value.to_lowercase());
    let items = repositories
        .into_iter()
        .filter(|repository| repository.permissions.access().can_write())
        .filter(|repository| {
            search
                .as_ref()
                .is_none_or(|search| repository.full_name.to_lowercase().contains(search))
        })
        .map(|repository| repository.into_remote().repository)
        .collect();
    Ok(ProviderPage {
        items,
        next_page: next_page(input, result_count),
    })
}

async fn github_repository(
    gateway: &ExternalGitGateway<'_>,
    provider: &GitHubProvider,
    user_id: Uuid,
    repository_id: u64,
) -> Result<GitHubRepository, ExternalGitProviderError> {
    let repository_id = repository_id.to_string();
    get_with_refresh(
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
    provider: &GitHubProvider,
    user_id: Uuid,
    repository_id: &str,
) -> Result<RemoteRepositoryDetails, ExternalGitProviderError> {
    github_repository(
        gateway,
        provider,
        user_id,
        parse_repository_id(repository_id)?,
    )
    .await
    .map(GitHubRepository::into_remote)
}

pub(super) async fn list_repository_branches(
    gateway: &ExternalGitGateway<'_>,
    provider: &GitHubProvider,
    user_id: Uuid,
    repository_id: &str,
    input: &ProviderListQuery,
) -> Result<ProviderPage<RemoteBranch>, ExternalGitProviderError> {
    let details = github_repository(
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
    let query = vec![
        ("page".to_string(), input.page.to_string()),
        ("per_page".to_string(), input.per_page.to_string()),
    ];
    let branches: Vec<GitHubBranch> = get_with_refresh(
        gateway,
        provider,
        user_id,
        &["repos", owner, repository, "branches"],
        &query,
    )
    .await?;
    let result_count = branches.len();
    let search = input.search.as_ref().map(|value| value.to_lowercase());
    let default_branch = details.default_branch.as_deref();
    let items = branches
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
            commit_sha: branch.commit.sha,
            committed_at: None,
        })
        .collect();
    Ok(ProviderPage {
        items,
        next_page: next_page(input, result_count),
    })
}

pub(super) fn validate_repository(
    provider: &GitHubProvider,
    details: &RemoteRepositoryDetails,
) -> bool {
    let repository = &details.repository;
    if repository
        .id
        .parse::<u64>()
        .ok()
        .is_none_or(|value| value == 0)
        || repository.full_path.split_once('/').is_none()
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
    use super::super::GitHubProviderConfig;
    use super::*;
    use std::sync::Arc;

    fn provider() -> GitHubProvider {
        GitHubProvider::new(GitHubProviderConfig {
            base_url: "https://github.com".to_string(),
            api_url: "https://api.github.com".to_string(),
            app_slug: "typst-collab".to_string(),
            client_id: "client-id".to_string(),
            client_secret: "client-secret".to_string(),
            redirect_uri: "https://example.test/v1/external-git/providers/github/callback"
                .to_string(),
            token_encryption_key: Arc::new([0_u8; 32]),
            http_client: reqwest::Client::new(),
        })
    }

    #[test]
    fn github_permissions_map_to_context_access() {
        assert_eq!(
            GitHubRepositoryPermissions {
                maintain: true,
                ..GitHubRepositoryPermissions::default()
            }
            .access(),
            RepositoryAccess::Maintain
        );
        assert_eq!(
            GitHubRepositoryPermissions {
                pull: true,
                ..GitHubRepositoryPermissions::default()
            }
            .access(),
            RepositoryAccess::Read
        );
    }

    #[test]
    fn github_repository_urls_are_limited_to_the_configured_web_origin(
    ) -> Result<(), serde_json::Error> {
        let repository: GitHubRepository = serde_json::from_value(serde_json::json!({
            "id": 42,
            "name": "slides",
            "full_name": "octocat/slides",
            "default_branch": "main",
            "visibility": "private",
            "html_url": "https://github.com/octocat/slides",
            "clone_url": "https://github.com/octocat/slides.git",
            "archived": false,
            "permissions": { "push": true }
        }))?;
        let details = repository.into_remote();
        assert!(validate_repository(&provider(), &details));

        let mut untrusted = details;
        untrusted.clone_url = "https://example.test/octocat/slides.git".to_string();
        assert!(!validate_repository(&provider(), &untrusted));
        Ok(())
    }
}
