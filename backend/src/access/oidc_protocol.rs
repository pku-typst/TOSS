//! OpenID Connect protocol exchange and identity normalization.

use super::auth_settings_model::AuthSettings;
use super::oidc_claims::extract_groups_from_id_token;
use super::oidc_policy::discovery_issuer;
use openidconnect::core::{
    CoreAuthenticationFlow, CoreClient, CoreIdTokenClaims, CoreProviderMetadata,
    CoreRequestTokenError,
};
use openidconnect::{
    AuthorizationCode, ClientId, ClientSecret, CsrfToken, Nonce, RedirectUrl, Scope, TokenResponse,
};
use reqwest::redirect::Policy;
use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Error)]
pub(crate) enum OidcProtocolError {
    #[error("OIDC is disabled")]
    Disabled,
    #[error("OIDC configuration is incomplete")]
    IncompleteConfiguration,
    #[error("OIDC issuer URL is invalid")]
    InvalidIssuer {
        #[source]
        source: url::ParseError,
    },
    #[error("OIDC redirect URI is invalid")]
    InvalidRedirectUri {
        #[source]
        source: url::ParseError,
    },
    #[error("could not initialize OIDC HTTP client")]
    ClientInitialization {
        #[source]
        source: reqwest::Error,
    },
    #[error("OIDC provider discovery failed")]
    ProviderUnavailable {
        #[source]
        source: openidconnect::DiscoveryError<openidconnect::HttpClientError<reqwest::Error>>,
    },
    #[error("OIDC token request could not be configured")]
    TokenRequestConfiguration {
        #[source]
        source: openidconnect::ConfigurationError,
    },
    #[error("OIDC token exchange failed")]
    TokenExchangeFailed {
        #[source]
        source: CoreRequestTokenError<openidconnect::HttpClientError<reqwest::Error>>,
    },
    #[error("OIDC token response did not include an ID token")]
    MissingIdToken,
    #[error("OIDC ID token verification failed")]
    IdTokenVerificationFailed {
        #[source]
        source: openidconnect::ClaimsVerificationError,
    },
}

pub(crate) struct OidcConfiguration {
    issuer: String,
    client_id: String,
    client_secret: String,
    redirect_uri: String,
    groups_claim: String,
}

impl OidcConfiguration {
    pub(crate) fn from_auth_settings(settings: AuthSettings) -> Result<Self, OidcProtocolError> {
        if !settings.allow_oidc {
            return Err(OidcProtocolError::Disabled);
        }
        let issuer = settings.oidc_issuer.unwrap_or_default();
        let client_id = settings.oidc_client_id.unwrap_or_default();
        let client_secret = settings.oidc_client_secret.unwrap_or_default();
        let redirect_uri = settings.oidc_redirect_uri.unwrap_or_default();
        if issuer.trim().is_empty() || client_id.trim().is_empty() || redirect_uri.trim().is_empty()
        {
            return Err(OidcProtocolError::IncompleteConfiguration);
        }
        Ok(Self {
            issuer,
            client_id,
            client_secret,
            redirect_uri,
            groups_claim: settings.oidc_groups_claim,
        })
    }
}

pub(crate) struct AuthenticatedOidcIdentity {
    pub email: String,
    pub display_name: String,
    pub subject: String,
    pub issuer: String,
    pub username_seed: String,
    pub groups: Vec<String>,
}

struct VerifiedOidcTokens {
    claims: CoreIdTokenClaims,
    raw_id_token: String,
}

struct IdentityProfile {
    email: String,
    display_name: String,
    username_seed: String,
}

pub(crate) async fn validate_provider_discovery(
    discovery_url: &str,
) -> Result<(), OidcProtocolError> {
    let issuer = discovery_issuer(discovery_url)
        .map_err(|source| OidcProtocolError::InvalidIssuer { source })?;
    let http_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(Policy::none())
        .build()
        .map_err(|source| OidcProtocolError::ClientInitialization { source })?;
    CoreProviderMetadata::discover_async(issuer, &http_client)
        .await
        .map_err(|source| OidcProtocolError::ProviderUnavailable { source })?;
    Ok(())
}

pub(crate) async fn authorization_url(
    configuration: &OidcConfiguration,
    state_token: &str,
    nonce_token: &str,
) -> Result<String, OidcProtocolError> {
    let (provider_metadata, _http_client, redirect_uri) = discover_provider(configuration).await?;
    let client = CoreClient::from_provider_metadata(
        provider_metadata,
        ClientId::new(configuration.client_id.clone()),
        Some(ClientSecret::new(configuration.client_secret.clone())),
    )
    .set_redirect_uri(redirect_uri);
    let csrf_secret = state_token.to_string();
    let nonce_secret = nonce_token.to_string();
    let (authorize_url, _csrf, _nonce) = client
        .authorize_url(
            CoreAuthenticationFlow::AuthorizationCode,
            move || CsrfToken::new(csrf_secret),
            move || Nonce::new(nonce_secret),
        )
        .add_scope(Scope::new("openid".to_string()))
        .add_scope(Scope::new("profile".to_string()))
        .add_scope(Scope::new("email".to_string()))
        .url();
    Ok(authorize_url.to_string())
}

pub(crate) async fn authenticate_callback(
    configuration: &OidcConfiguration,
    authorization_code: &str,
    nonce: String,
) -> Result<AuthenticatedOidcIdentity, OidcProtocolError> {
    let verified_tokens =
        exchange_verified_tokens(configuration, authorization_code, nonce).await?;
    Ok(resolve_identity(configuration, verified_tokens))
}

async fn exchange_verified_tokens(
    configuration: &OidcConfiguration,
    authorization_code: &str,
    nonce: String,
) -> Result<VerifiedOidcTokens, OidcProtocolError> {
    let (provider_metadata, http_client, redirect_uri) = discover_provider(configuration).await?;
    let client = CoreClient::from_provider_metadata(
        provider_metadata,
        ClientId::new(configuration.client_id.clone()),
        Some(ClientSecret::new(configuration.client_secret.clone())),
    )
    .set_redirect_uri(redirect_uri);
    let token_request = client
        .exchange_code(AuthorizationCode::new(authorization_code.to_string()))
        .map_err(|source| OidcProtocolError::TokenRequestConfiguration { source })?;
    let tokens = token_request
        .request_async(&http_client)
        .await
        .map_err(|source| OidcProtocolError::TokenExchangeFailed { source })?;
    let id_token = tokens.id_token().ok_or(OidcProtocolError::MissingIdToken)?;
    let claims: CoreIdTokenClaims = id_token
        .claims(&client.id_token_verifier(), &Nonce::new(nonce))
        .map_err(|source| OidcProtocolError::IdTokenVerificationFailed { source })?
        .clone();
    let raw_id_token = id_token.to_string();
    Ok(VerifiedOidcTokens {
        claims,
        raw_id_token,
    })
}

fn resolve_identity(
    configuration: &OidcConfiguration,
    verified_tokens: VerifiedOidcTokens,
) -> AuthenticatedOidcIdentity {
    let issuer = verified_tokens.claims.issuer().url().to_string();
    let subject = verified_tokens.claims.subject().as_str().to_string();
    let profile = identity_profile(&verified_tokens.claims, &subject);
    let groups =
        extract_groups_from_id_token(verified_tokens.raw_id_token, &configuration.groups_claim);
    AuthenticatedOidcIdentity {
        email: profile.email,
        display_name: profile.display_name,
        subject,
        issuer,
        username_seed: profile.username_seed,
        groups,
    }
}

fn identity_profile(claims: &CoreIdTokenClaims, subject: &str) -> IdentityProfile {
    let email = claims
        .email()
        .map(|value| value.to_string())
        .unwrap_or_else(|| format!("{subject}@oidc.local"));
    let display_name = claims
        .preferred_username()
        .map(|value| value.to_string())
        .unwrap_or_else(|| "OIDC User".to_string());
    let username_seed = claims
        .preferred_username()
        .map(|value| value.to_string())
        .unwrap_or_else(|| username_seed_from_email(&email));
    IdentityProfile {
        email,
        display_name,
        username_seed,
    }
}

async fn discover_provider(
    configuration: &OidcConfiguration,
) -> Result<(CoreProviderMetadata, reqwest::Client, RedirectUrl), OidcProtocolError> {
    let issuer = discovery_issuer(&configuration.issuer)
        .map_err(|source| OidcProtocolError::InvalidIssuer { source })?;
    let http_client = reqwest::Client::builder()
        .redirect(Policy::none())
        .build()
        .map_err(|source| OidcProtocolError::ClientInitialization { source })?;
    let provider_metadata = CoreProviderMetadata::discover_async(issuer, &http_client)
        .await
        .map_err(|source| OidcProtocolError::ProviderUnavailable { source })?;
    let redirect_uri = RedirectUrl::new(configuration.redirect_uri.clone())
        .map_err(|source| OidcProtocolError::InvalidRedirectUri { source })?;
    Ok((provider_metadata, http_client, redirect_uri))
}

fn username_seed_from_email(email: &str) -> String {
    email
        .split('@')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("oidc-user")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::username_seed_from_email;

    #[test]
    fn username_seed_prefers_the_email_local_part() {
        assert_eq!(username_seed_from_email("ada@example.com"), "ada");
        assert_eq!(username_seed_from_email("@example.com"), "oidc-user");
    }
}
