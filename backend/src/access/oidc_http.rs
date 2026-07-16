//! HTTP transport for the Access context's OpenID Connect flow.

use super::federated_account::{
    provision_federated_account, LoginAuthorityKind, ProvisionFederatedAccountCommand,
    ProvisionFederatedAccountError,
};
use super::oidc_group::sync_oidc_identity_groups;
use super::oidc_policy::safe_return_path;
use super::oidc_protocol::{
    authenticate_callback, authorization_url, AuthenticatedOidcIdentity, OidcConfiguration,
    OidcProtocolError,
};
use super::oidc_state;
use super::{
    auth_cookie_secure, effective_auth_settings, issue_session_for_request, session_cookie,
};
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use rand::distr::{Alphanumeric, SampleString};
use tracing::error;
use uuid::Uuid;

#[derive(serde::Deserialize)]
pub(crate) struct OidcCallbackQuery {
    pub code: String,
    pub state: Option<String>,
}

#[derive(Default, serde::Deserialize)]
pub(crate) struct OidcLoginQuery {
    pub return_to: Option<String>,
}

fn oidc_protocol_error(protocol_error: OidcProtocolError) -> ApiError {
    let (status, code, message, log_failure) = match &protocol_error {
        OidcProtocolError::Disabled => (
            StatusCode::FORBIDDEN,
            ApiErrorCode::Forbidden,
            "OIDC login is disabled by the administrator",
            false,
        ),
        OidcProtocolError::IncompleteConfiguration => (
            StatusCode::BAD_REQUEST,
            ApiErrorCode::BadRequest,
            "OIDC is not configured yet. Contact an administrator",
            false,
        ),
        OidcProtocolError::InvalidIssuer { .. } => (
            StatusCode::BAD_REQUEST,
            ApiErrorCode::BadRequest,
            "OIDC issuer URL is invalid",
            false,
        ),
        OidcProtocolError::InvalidRedirectUri { .. } => (
            StatusCode::BAD_REQUEST,
            ApiErrorCode::BadRequest,
            "OIDC redirect URI is invalid",
            false,
        ),
        OidcProtocolError::ClientInitialization { .. } => (
            StatusCode::BAD_GATEWAY,
            ApiErrorCode::AuthServiceUnavailable,
            "Failed to initialize OIDC client",
            true,
        ),
        OidcProtocolError::ProviderUnavailable { .. } => (
            StatusCode::BAD_GATEWAY,
            ApiErrorCode::AuthServiceUnavailable,
            "OIDC provider is unavailable",
            true,
        ),
        OidcProtocolError::TokenRequestConfiguration { .. } => (
            StatusCode::BAD_GATEWAY,
            ApiErrorCode::AuthServiceUnavailable,
            "OIDC token endpoint is unavailable",
            true,
        ),
        OidcProtocolError::TokenExchangeFailed { .. } => (
            StatusCode::UNAUTHORIZED,
            ApiErrorCode::Unauthorized,
            "OIDC token exchange failed",
            true,
        ),
        OidcProtocolError::MissingIdToken => (
            StatusCode::UNAUTHORIZED,
            ApiErrorCode::Unauthorized,
            "OIDC ID token is missing",
            true,
        ),
        OidcProtocolError::IdTokenVerificationFailed { .. } => (
            StatusCode::UNAUTHORIZED,
            ApiErrorCode::Unauthorized,
            "OIDC ID token verification failed",
            true,
        ),
    };
    let response = ApiError::new(status, code, message);
    if log_failure {
        response.with_warning("OIDC protocol exchange failed", protocol_error)
    } else {
        response
    }
}

async fn load_oidc_configuration(state: &AppState) -> Result<OidcConfiguration, ApiError> {
    let settings = effective_auth_settings(&state.db, &state.oidc_defaults)
        .await
        .map_err(|database_error| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::AuthServiceUnavailable,
                "Authentication settings are unavailable",
            )
            .with_diagnostic("authentication settings lookup failed", database_error)
        })?;
    OidcConfiguration::from_auth_settings(settings).map_err(oidc_protocol_error)
}

pub(crate) async fn oidc_login(
    State(state): State<AppState>,
    Query(query): Query<OidcLoginQuery>,
) -> Response {
    let configuration = match load_oidc_configuration(&state).await {
        Ok(configuration) => configuration,
        Err(error) => return error.into_response(),
    };
    let state_token = Alphanumeric.sample_string(&mut rand::rng(), 32);
    let nonce_token = Alphanumeric.sample_string(&mut rand::rng(), 32);
    let authorize_url = match authorization_url(&configuration, &state_token, &nonce_token).await {
        Ok(authorize_url) => authorize_url,
        Err(protocol_error) => return oidc_protocol_error(protocol_error).into_response(),
    };
    if let Err(state_error) =
        oidc_state::create_oidc_state(&state.db, &state_token, &nonce_token).await
    {
        return ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "Failed to initialize OIDC login",
        )
        .with_diagnostic("OIDC login state creation failed", state_error)
        .into_response();
    }

    let mut jar = CookieJar::new().add(oidc_state_cookie(state_token));
    if let Some(return_to) = query.return_to.as_deref().and_then(safe_return_path) {
        jar = jar.add(oidc_return_to_cookie(return_to.to_string()));
    }
    (jar, Redirect::to(&authorize_url)).into_response()
}

pub(crate) async fn oidc_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Query(query): Query<OidcCallbackQuery>,
) -> Response {
    let configuration = match load_oidc_configuration(&state).await {
        Ok(configuration) => configuration,
        Err(error) => return error.into_response(),
    };
    let callback_state = query.state.as_deref().unwrap_or_default();
    let nonce = match consume_callback_nonce(&state, &jar, callback_state).await {
        Ok(nonce) => nonce,
        Err(error) => return error.into_response(),
    };
    let identity = match authenticate_callback(&configuration, &query.code, nonce).await {
        Ok(identity) => identity,
        Err(protocol_error) => return oidc_protocol_error(protocol_error).into_response(),
    };
    let user_id = match provision_account(&state, &identity).await {
        Ok(user_id) => user_id,
        Err(error) => return error.into_response(),
    };
    match sync_oidc_identity_groups(&state.db, user_id, &identity.groups).await {
        Ok(affected_projects) => {
            for project_id in affected_projects {
                state.collaboration.access_changed(project_id).await;
            }
        }
        Err(group_sync_error) => {
            error!(?group_sync_error, %user_id, "OIDC group synchronization failed");
        }
    }
    let session_token =
        match issue_oidc_session(&state, &headers, user_id, callback_state, &identity).await {
            Ok(session_token) => session_token,
            Err(error) => return error.into_response(),
        };
    callback_redirect(jar, session_token)
}

async fn consume_callback_nonce(
    state: &AppState,
    jar: &CookieJar,
    callback_state: &str,
) -> Result<String, ApiError> {
    let cookie_state = jar
        .get("typst_oidc_state")
        .map(|cookie| cookie.value())
        .unwrap_or_default();
    if callback_state.is_empty() || callback_state != cookie_state {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            ApiErrorCode::Unauthorized,
            "OIDC login state is invalid or expired",
        ));
    }
    match oidc_state::consume_oidc_state(&state.db, callback_state).await {
        Ok(Some(nonce)) => Ok(nonce),
        Ok(None) => Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            ApiErrorCode::Unauthorized,
            "OIDC login state is missing",
        )),
        Err(state_error) => Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "Failed to validate OIDC login state",
        )
        .with_diagnostic("OIDC login state consumption failed", state_error)),
    }
}

async fn provision_account(
    state: &AppState,
    identity: &AuthenticatedOidcIdentity,
) -> Result<Uuid, ApiError> {
    match provision_federated_account(
        &state.db,
        ProvisionFederatedAccountCommand {
            email: &identity.email,
            display_name: &identity.display_name,
            subject: &identity.subject,
            authority_kind: LoginAuthorityKind::Oidc,
            authority_id: &identity.issuer,
            username_seed: &identity.username_seed,
        },
    )
    .await
    {
        Ok(user_id) => Ok(user_id),
        Err(failure @ ProvisionFederatedAccountError::UsernameExhausted) => Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "Failed to allocate username for OIDC account",
        )
        .with_diagnostic("OIDC username allocation failed", failure)),
        Err(ProvisionFederatedAccountError::EmailConflict) => Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::AuthEmailConflict,
            "An account with this email already exists",
        )),
        Err(failure @ ProvisionFederatedAccountError::Persistence { .. }) => Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "Failed to provision user account",
        )
        .with_diagnostic("OIDC account provisioning failed", failure)),
    }
}

async fn issue_oidc_session(
    state: &AppState,
    headers: &HeaderMap,
    user_id: Uuid,
    callback_state: &str,
    identity: &AuthenticatedOidcIdentity,
) -> Result<String, ApiError> {
    let source = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown");
    let token = issue_session_for_request(&state.db, headers, user_id)
        .await
        .map_err(|session_error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to issue session",
            )
            .with_diagnostic("OIDC session issuance failed", session_error)
        })?;
    record_event(
        &state.db,
        Some(user_id),
        "auth.oidc.callback",
        serde_json::json!({
            "state": callback_state,
            "source": source,
            "email": identity.email,
            "groups": identity.groups,
            "identity_provider": state.oidc_defaults.provider_id.as_str()
        }),
    )
    .await;
    Ok(token)
}

fn oidc_state_cookie(state_token: String) -> Cookie<'static> {
    Cookie::build(("typst_oidc_state", state_token))
        .path("/")
        .http_only(true)
        .secure(auth_cookie_secure())
        .same_site(SameSite::Lax)
        .build()
}

fn oidc_return_to_cookie(return_to: String) -> Cookie<'static> {
    Cookie::build(("typst_oidc_return_to", return_to))
        .path("/")
        .http_only(true)
        .secure(auth_cookie_secure())
        .same_site(SameSite::Lax)
        .build()
}

fn callback_redirect(jar: CookieJar, session_token: String) -> Response {
    let return_to = jar
        .get("typst_oidc_return_to")
        .map(|cookie| cookie.value().to_string())
        .and_then(|value| safe_return_path(&value).map(str::to_string))
        .unwrap_or_else(|| "/".to_string());
    let session_cookie = session_cookie(session_token);
    let jar = jar
        .remove(Cookie::from("typst_oidc_state"))
        .remove(Cookie::from("typst_oidc_return_to"))
        .add(session_cookie);
    (jar, Redirect::to(&return_to)).into_response()
}
