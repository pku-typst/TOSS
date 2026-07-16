use super::{
    ProviderAuthorizationError, ProviderAuthorizationGrant, ProviderAuthorizationRejection,
    RefreshTokenError, RefreshedToken,
};
use serde::Deserialize;

#[derive(Clone, Copy)]
pub(super) enum OAuth2Dialect {
    GitLab,
    Forge,
}

pub(super) struct OAuth2ClientConfig {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
    pub scopes: String,
    pub dialect: OAuth2Dialect,
    pub http_client: reqwest::Client,
}

#[derive(Clone)]
pub(super) struct OAuth2Client {
    authorization_endpoint: String,
    token_endpoint: String,
    client_id: String,
    client_secret: String,
    redirect_uri: String,
    scopes: String,
    dialect: OAuth2Dialect,
    http_client: reqwest::Client,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    scope: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

impl OAuth2Dialect {
    const fn includes_redirect_uri_on_refresh(self) -> bool {
        matches!(self, Self::GitLab)
    }

    fn rejection(
        self,
        error: Option<&str>,
        description: Option<&str>,
    ) -> ProviderAuthorizationRejection {
        if description.is_some_and(|value| value.to_ascii_lowercase().contains("redirect_uri")) {
            return ProviderAuthorizationRejection::RedirectUriMismatch;
        }
        match (self, error) {
            (_, Some("access_denied")) => ProviderAuthorizationRejection::AccessDenied,
            (_, Some("invalid_client")) | (Self::GitLab, Some("unauthorized_client")) => {
                ProviderAuthorizationRejection::InvalidClient
            }
            (_, Some("invalid_grant")) | (Self::Forge, Some("unauthorized_client")) => {
                ProviderAuthorizationRejection::InvalidGrant
            }
            (_, Some("redirect_uri_mismatch")) => {
                ProviderAuthorizationRejection::RedirectUriMismatch
            }
            (_, Some(_) | None) => ProviderAuthorizationRejection::Unclassified,
        }
    }
}

impl OAuth2Client {
    pub(super) fn new(config: OAuth2ClientConfig) -> Self {
        Self {
            authorization_endpoint: config.authorization_endpoint,
            token_endpoint: config.token_endpoint,
            client_id: config.client_id,
            client_secret: config.client_secret,
            redirect_uri: config.redirect_uri,
            scopes: config.scopes,
            dialect: config.dialect,
            http_client: config.http_client,
        }
    }

    pub(super) fn authorization_url(
        &self,
        state: &str,
    ) -> Result<String, ProviderAuthorizationError> {
        let mut url = reqwest::Url::parse(&self.authorization_endpoint)
            .map_err(|source| ProviderAuthorizationError::InvalidEndpoint { source })?;
        url.query_pairs_mut()
            .append_pair("client_id", &self.client_id)
            .append_pair("redirect_uri", &self.redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("scope", &self.scopes)
            .append_pair("state", state);
        Ok(url.to_string())
    }

    pub(super) async fn exchange_authorization_code(
        &self,
        code: &str,
    ) -> Result<ProviderAuthorizationGrant, ProviderAuthorizationError> {
        let response = self
            .http_client
            .post(&self.token_endpoint)
            .header("Accept", "application/json")
            .form(&[
                ("client_id", self.client_id.as_str()),
                ("client_secret", self.client_secret.as_str()),
                ("code", code),
                ("grant_type", "authorization_code"),
                ("redirect_uri", self.redirect_uri.as_str()),
            ])
            .send()
            .await
            .map_err(|source| ProviderAuthorizationError::Transport { source })?;
        let token = self.authorization_response(response).await?;
        let access_token = token
            .access_token
            .ok_or(ProviderAuthorizationError::Rejected {
                status: reqwest::StatusCode::BAD_REQUEST,
                reason: ProviderAuthorizationRejection::Unclassified,
            })?;
        let scopes = token
            .scope
            .as_deref()
            .map(split_scopes)
            .unwrap_or_else(|| split_scopes(&self.scopes));
        Ok(ProviderAuthorizationGrant {
            access_token,
            refresh_token: token.refresh_token,
            refresh_redirect_uri: self.redirect_uri.clone(),
            expires_in: token.expires_in,
            scopes,
        })
    }

    async fn authorization_response(
        &self,
        response: reqwest::Response,
    ) -> Result<TokenResponse, ProviderAuthorizationError> {
        let status = response.status();
        if !status.is_success()
            && !matches!(
                status,
                reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::UNAUTHORIZED
            )
        {
            return Err(ProviderAuthorizationError::UnexpectedStatus { status });
        }
        let token = response.json::<TokenResponse>().await;
        if matches!(
            status,
            reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::UNAUTHORIZED
        ) {
            let reason = token
                .ok()
                .map(|response| {
                    self.dialect.rejection(
                        response.error.as_deref(),
                        response.error_description.as_deref(),
                    )
                })
                .unwrap_or(ProviderAuthorizationRejection::Unclassified);
            return Err(ProviderAuthorizationError::Rejected { status, reason });
        }
        let token =
            token.map_err(|source| ProviderAuthorizationError::InvalidResponse { source })?;
        if token.error.is_some() {
            return Err(ProviderAuthorizationError::Rejected {
                status: reqwest::StatusCode::BAD_REQUEST,
                reason: self
                    .dialect
                    .rejection(token.error.as_deref(), token.error_description.as_deref()),
            });
        }
        Ok(token)
    }

    pub(super) async fn refresh_access_token(
        &self,
        refresh_token: &str,
        original_redirect_uri: &str,
    ) -> Result<RefreshedToken, RefreshTokenError> {
        let mut form = vec![
            ("client_id", self.client_id.as_str()),
            ("client_secret", self.client_secret.as_str()),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ];
        if self.dialect.includes_redirect_uri_on_refresh() {
            form.push(("redirect_uri", original_redirect_uri));
        }
        let response = self
            .http_client
            .post(&self.token_endpoint)
            .header("Accept", "application/json")
            .form(&form)
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
            .json::<TokenResponse>()
            .await
            .map_err(|source| RefreshTokenError::InvalidResponse { source })?;
        if refreshed.error.is_some() {
            return Err(RefreshTokenError::Rejected {
                status: reqwest::StatusCode::BAD_REQUEST,
            });
        }
        let access_token = refreshed.access_token.ok_or(RefreshTokenError::Rejected {
            status: reqwest::StatusCode::BAD_REQUEST,
        })?;
        Ok(RefreshedToken {
            access_token,
            refresh_token: refreshed.refresh_token,
            expires_in: refreshed.expires_in,
            scopes: parse_scopes(refreshed.scope),
        })
    }
}

fn parse_scopes(raw: Option<String>) -> Vec<String> {
    raw.as_deref().map(split_scopes).unwrap_or_default()
}

fn split_scopes(value: &str) -> Vec<String> {
    value
        .split(|character: char| character == ',' || character.is_whitespace())
        .filter(|scope| !scope.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::{Form, State};
    use axum::routing::post;
    use axum::{Json, Router};
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::Arc;

    #[derive(Clone, Default)]
    struct RecordedForms(Arc<tokio::sync::Mutex<Vec<HashMap<String, String>>>>);

    async fn token_response(
        State(forms): State<RecordedForms>,
        Form(form): Form<HashMap<String, String>>,
    ) -> Json<serde_json::Value> {
        let refresh = form
            .get("grant_type")
            .is_some_and(|value| value == "refresh_token");
        let forge = form
            .get("client_id")
            .is_some_and(|value| value == "forge-client");
        forms.0.lock().await.push(form);
        if refresh && !forge {
            Json(json!({
                "access_token": "refreshed",
                "refresh_token": "rotated",
                "expires_in": 3600,
                "scope": "read:user,write:repository"
            }))
        } else if refresh {
            Json(json!({
                "access_token": "refreshed",
                "refresh_token": "rotated",
                "expires_in": 3600
            }))
        } else {
            Json(json!({
                "access_token": "initial",
                "refresh_token": "refresh",
                "expires_in": 3600
            }))
        }
    }

    fn client(base_url: &str, dialect: OAuth2Dialect) -> OAuth2Client {
        let client_id = match dialect {
            OAuth2Dialect::GitLab => "gitlab-client",
            OAuth2Dialect::Forge => "forge-client",
        };
        OAuth2Client::new(OAuth2ClientConfig {
            authorization_endpoint: format!("{base_url}/authorize"),
            token_endpoint: format!("{base_url}/token"),
            client_id: client_id.to_string(),
            client_secret: "client-secret".to_string(),
            redirect_uri: "https://collab.example.test/callback".to_string(),
            scopes: "openid profile email".to_string(),
            dialect,
            http_client: reqwest::Client::new(),
        })
    }

    #[tokio::test]
    async fn exchange_and_refresh_share_the_protocol_but_preserve_refresh_differences(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let forms = RecordedForms::default();
        let router = Router::new()
            .route("/token", post(token_response))
            .with_state(forms.clone());
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let address = listener.local_addr()?;
        let server = tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, router).await {
                tracing::error!(%error, "test OAuth2 server stopped unexpectedly");
            }
        });
        let base_url = format!("http://{address}");
        let gitlab = client(&base_url, OAuth2Dialect::GitLab);
        let forge = client(&base_url, OAuth2Dialect::Forge);

        let grant = gitlab.exchange_authorization_code("code").await?;
        assert_eq!(grant.access_token, "initial");
        assert_eq!(grant.scopes, ["openid", "profile", "email"]);
        let gitlab_refresh = gitlab
            .refresh_access_token("refresh", &grant.refresh_redirect_uri)
            .await?;
        assert_eq!(gitlab_refresh.scopes, ["read:user", "write:repository"]);
        let forge_grant = forge.exchange_authorization_code("code").await?;
        assert_eq!(forge_grant.scopes, ["openid", "profile", "email"]);
        let forge_refresh = forge
            .refresh_access_token("refresh", "https://ignored.example.test")
            .await?;
        assert!(forge_refresh.scopes.is_empty());

        let recorded = forms.0.lock().await;
        assert_eq!(recorded.len(), 4);
        assert_eq!(
            recorded
                .get(1)
                .and_then(|form| form.get("redirect_uri"))
                .map(String::as_str),
            Some("https://collab.example.test/callback")
        );
        assert!(recorded
            .get(3)
            .is_some_and(|form| !form.contains_key("redirect_uri")));
        drop(recorded);
        server.abort();
        Ok(())
    }

    #[test]
    fn dialects_classify_the_same_server_error_explicitly() {
        assert_eq!(
            OAuth2Dialect::GitLab.rejection(Some("unauthorized_client"), None),
            ProviderAuthorizationRejection::InvalidClient
        );
        assert_eq!(
            OAuth2Dialect::Forge.rejection(Some("unauthorized_client"), None),
            ProviderAuthorizationRejection::InvalidGrant
        );
        assert_eq!(
            OAuth2Dialect::Forge.rejection(
                Some("unauthorized_client"),
                Some("redirect_uri does not match the authorization request")
            ),
            ProviderAuthorizationRejection::RedirectUriMismatch
        );
    }
}
