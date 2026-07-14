use super::super::{
    GitHubProvider, ProviderAuthorizationError, ProviderAuthorizationGrant,
    ProviderAuthorizationRejection, ProviderIdentity, ProviderIdentityError,
    ProviderIdentityResource, ProviderLoginProfile, RefreshTokenError, RefreshedToken,
};
use super::GITHUB_API_VERSION;
use serde::Deserialize;

#[derive(Deserialize)]
struct GitHubUser {
    id: u64,
    login: String,
    name: Option<String>,
    email: Option<String>,
}

#[derive(Deserialize)]
struct GitHubRefreshResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    scope: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct GitHubEmail {
    email: String,
    primary: bool,
    verified: bool,
}

fn scopes(raw: Option<String>) -> Vec<String> {
    raw.map(|value| {
        value
            .split(|character: char| character == ',' || character.is_whitespace())
            .filter(|scope| !scope.is_empty())
            .map(str::to_string)
            .collect()
    })
    .unwrap_or_default()
}

fn authorization_rejection(error: Option<&str>) -> ProviderAuthorizationRejection {
    match error {
        Some("access_denied") => ProviderAuthorizationRejection::AccessDenied,
        Some("incorrect_client_credentials") => ProviderAuthorizationRejection::InvalidClient,
        Some("bad_verification_code" | "expired_token" | "expired_user_token") => {
            ProviderAuthorizationRejection::InvalidGrant
        }
        Some("redirect_uri_mismatch") => ProviderAuthorizationRejection::RedirectUriMismatch,
        Some(_) | None => ProviderAuthorizationRejection::Unclassified,
    }
}

pub(crate) fn authorization_url(
    provider: &GitHubProvider,
    state: &str,
) -> Result<String, ProviderAuthorizationError> {
    let installation_root = if provider.base_url() == "https://github.com" {
        "apps"
    } else {
        "github-apps"
    };
    let mut url = reqwest::Url::parse(&format!(
        "{}/{}/{}/installations/new",
        provider.base_url(),
        installation_root,
        provider.app_slug()
    ))
    .map_err(|source| ProviderAuthorizationError::InvalidEndpoint { source })?;
    url.query_pairs_mut().append_pair("state", state);
    Ok(url.to_string())
}

pub(crate) fn login_authorization_url(
    provider: &GitHubProvider,
    state: &str,
) -> Result<String, ProviderAuthorizationError> {
    let mut url = reqwest::Url::parse(&format!("{}/login/oauth/authorize", provider.base_url()))
        .map_err(|source| ProviderAuthorizationError::InvalidEndpoint { source })?;
    url.query_pairs_mut()
        .append_pair("client_id", provider.client_id())
        .append_pair("redirect_uri", provider.redirect_uri())
        .append_pair("state", state);
    Ok(url.to_string())
}

pub(crate) async fn exchange_authorization_code(
    provider: &GitHubProvider,
    code: &str,
) -> Result<ProviderAuthorizationGrant, ProviderAuthorizationError> {
    exchange_code(provider, code, provider.redirect_uri()).await
}

async fn exchange_code(
    provider: &GitHubProvider,
    code: &str,
    redirect_uri: &str,
) -> Result<ProviderAuthorizationGrant, ProviderAuthorizationError> {
    let response = provider
        .http_client()
        .post(format!("{}/login/oauth/access_token", provider.base_url()))
        .header("Accept", "application/json")
        .form(&[
            ("client_id", provider.client_id()),
            ("client_secret", provider.client_secret()),
            ("code", code),
            ("redirect_uri", redirect_uri),
        ])
        .send()
        .await
        .map_err(|source| ProviderAuthorizationError::Transport { source })?;
    let status = response.status();
    if !status.is_success()
        && !matches!(
            status,
            reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::UNAUTHORIZED
        )
    {
        return Err(ProviderAuthorizationError::UnexpectedStatus { status });
    }
    let token_response = response.json::<GitHubRefreshResponse>().await;
    if matches!(
        status,
        reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::UNAUTHORIZED
    ) {
        let reason = token_response
            .ok()
            .and_then(|token| token.error)
            .as_deref()
            .map_or(ProviderAuthorizationRejection::Unclassified, |error| {
                authorization_rejection(Some(error))
            });
        return Err(ProviderAuthorizationError::Rejected { status, reason });
    }
    let token =
        token_response.map_err(|source| ProviderAuthorizationError::InvalidResponse { source })?;
    if token.error.is_some() {
        return Err(ProviderAuthorizationError::Rejected {
            status: reqwest::StatusCode::BAD_REQUEST,
            reason: authorization_rejection(token.error.as_deref()),
        });
    }
    let Some(access_token) = token.access_token else {
        return Err(ProviderAuthorizationError::Rejected {
            status: reqwest::StatusCode::BAD_REQUEST,
            reason: ProviderAuthorizationRejection::Unclassified,
        });
    };
    Ok(ProviderAuthorizationGrant {
        access_token,
        refresh_token: token.refresh_token,
        refresh_redirect_uri: redirect_uri.to_string(),
        expires_in: token.expires_in,
        scopes: scopes(token.scope),
    })
}

pub(crate) async fn fetch_identity(
    provider: &GitHubProvider,
    access_token: &str,
) -> Result<ProviderIdentity, ProviderIdentityError> {
    let response = provider
        .http_client()
        .get(format!("{}/user", provider.api_url()))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
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
    let user = response
        .json::<GitHubUser>()
        .await
        .map_err(|source| ProviderIdentityError::InvalidResponse { source })?;
    Ok(ProviderIdentity {
        account_id: user.id.to_string(),
        username: user.login,
        name: user.name,
        email: user.email,
    })
}

pub(crate) async fn fetch_login_profile(
    provider: &GitHubProvider,
    access_token: &str,
) -> Result<ProviderLoginProfile, ProviderIdentityError> {
    let identity = fetch_identity(provider, access_token).await?;
    let response = provider
        .http_client()
        .get(format!("{}/user/emails", provider.api_url()))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
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
        .json::<Vec<GitHubEmail>>()
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

pub(crate) async fn refresh_access_token(
    provider: &GitHubProvider,
    refresh_token: &str,
) -> Result<RefreshedToken, RefreshTokenError> {
    let response = provider
        .http_client()
        .post(format!("{}/login/oauth/access_token", provider.base_url()))
        .header("Accept", "application/json")
        .form(&[
            ("client_id", provider.client_id()),
            ("client_secret", provider.client_secret()),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|source| RefreshTokenError::Transport { source })?;
    if matches!(
        response.status(),
        reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::UNAUTHORIZED
    ) {
        return Err(RefreshTokenError::Rejected {
            status: response.status(),
        });
    }
    if !response.status().is_success() {
        return Err(RefreshTokenError::UnexpectedStatus {
            status: response.status(),
        });
    }
    let refreshed = response
        .json::<GitHubRefreshResponse>()
        .await
        .map_err(|source| RefreshTokenError::InvalidResponse { source })?;
    let Some(access_token) = refreshed.access_token else {
        return Err(RefreshTokenError::Rejected {
            status: reqwest::StatusCode::BAD_REQUEST,
        });
    };
    if refreshed.error.is_some() {
        return Err(RefreshTokenError::Rejected {
            status: reqwest::StatusCode::BAD_REQUEST,
        });
    }
    Ok(RefreshedToken {
        access_token,
        refresh_token: refreshed.refresh_token,
        expires_in: refreshed.expires_in,
        scopes: scopes(refreshed.scope),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::external_repositories::provider::GitHubProviderConfig;
    use std::sync::Arc;

    fn provider(base_url: &str) -> GitHubProvider {
        GitHubProvider::new(GitHubProviderConfig {
            base_url: base_url.to_string(),
            api_url: format!("{base_url}/api/v3"),
            app_slug: "typst-collab".to_string(),
            client_id: "client-id".to_string(),
            client_secret: "client-secret".to_string(),
            redirect_uri: "https://collab.example.test/v1/external-git/providers/github/callback"
                .to_string(),
            token_encryption_key: Arc::new([0_u8; 32]),
            http_client: reqwest::Client::new(),
        })
    }

    #[test]
    fn installation_url_uses_the_github_com_route() -> Result<(), ProviderAuthorizationError> {
        let url = authorization_url(&provider("https://github.com"), "state-value")?;
        assert_eq!(
            url,
            "https://github.com/apps/typst-collab/installations/new?state=state-value"
        );
        Ok(())
    }

    #[test]
    fn installation_url_uses_the_enterprise_server_route() -> Result<(), ProviderAuthorizationError>
    {
        let url = authorization_url(&provider("https://github.example.test"), "state-value")?;
        assert_eq!(
            url,
            "https://github.example.test/github-apps/typst-collab/installations/new?state=state-value"
        );
        Ok(())
    }

    #[test]
    fn login_uses_the_web_application_flow_and_provider_callback(
    ) -> Result<(), ProviderAuthorizationError> {
        let url = login_authorization_url(&provider("https://github.com"), "state-value")?;
        let parsed = reqwest::Url::parse(&url)
            .map_err(|source| ProviderAuthorizationError::InvalidEndpoint { source })?;
        assert_eq!(parsed.path(), "/login/oauth/authorize");
        let query = parsed
            .query_pairs()
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(
            query.get("client_id").map(|value| value.as_ref()),
            Some("client-id")
        );
        assert_eq!(
            query.get("state").map(|value| value.as_ref()),
            Some("state-value")
        );
        assert_eq!(
            query.get("redirect_uri").map(|value| value.as_ref()),
            Some("https://collab.example.test/v1/external-git/providers/github/callback")
        );
        Ok(())
    }

    #[test]
    fn token_error_codes_map_to_closed_rejection_reasons() {
        assert_eq!(
            authorization_rejection(Some("incorrect_client_credentials")),
            ProviderAuthorizationRejection::InvalidClient
        );
        assert_eq!(
            authorization_rejection(Some("bad_verification_code")),
            ProviderAuthorizationRejection::InvalidGrant
        );
        assert_eq!(
            authorization_rejection(Some("redirect_uri_mismatch")),
            ProviderAuthorizationRejection::RedirectUriMismatch
        );
        assert_eq!(
            authorization_rejection(Some("future_provider_error")),
            ProviderAuthorizationRejection::Unclassified
        );
    }
}
