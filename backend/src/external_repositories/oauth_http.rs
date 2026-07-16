//! HTTP boundary for external Git OAuth sign-in and repository connection.

use super::connection::{complete_external_git_authorization, ExternalGitAuthorizationError};
use super::login::{complete_external_git_login, ExternalGitLoginError};
use super::oauth::{
    begin_external_git_oauth, consume_external_git_oauth, ExternalGitOAuthError,
    ExternalGitOAuthIntent,
};
use super::provider::{
    ProviderAuthorizationError, ProviderAuthorizationRejection, ProviderIdentityError,
    ProviderIdentityResource, ProviderInstanceId,
};
use crate::access::{
    auth_cookie_secure, issue_session_for_request, required_request_user_id, session_cookie,
};
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};

const OAUTH_STATE_COOKIE_PREFIX: &str = "typst_external_git_oauth_state_";

#[derive(Default, serde::Deserialize)]
pub(crate) struct ExternalGitOAuthStartQuery {
    return_to: Option<String>,
}

#[derive(serde::Deserialize)]
pub(crate) struct ExternalGitOAuthCallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

fn oauth_error(error: ExternalGitOAuthError) -> ApiError {
    match &error {
        ExternalGitOAuthError::NotConfigured => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorCode::ExternalGitNotConfigured,
            "External Git is not configured",
        ),
        ExternalGitOAuthError::NotSupported => ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::AuthorizationUnavailable,
            "This external Git provider does not support the requested authorization",
        ),
        ExternalGitOAuthError::InvalidState => ApiError::new(
            StatusCode::UNAUTHORIZED,
            ApiErrorCode::Unauthorized,
            "External Git authorization state is invalid or expired",
        ),
        ExternalGitOAuthError::Provider { .. } => ApiError::new(
            StatusCode::BAD_GATEWAY,
            ApiErrorCode::ExternalGitProviderUnavailable,
            "The external Git provider could not start authorization",
        )
        .with_warning("external Git provider authorization URL failed", error),
        ExternalGitOAuthError::InvalidPersistedIntent
        | ExternalGitOAuthError::Persistence { .. } => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "External Git authorization could not be completed",
        )
        .with_diagnostic("external Git OAuth attempt persistence failed", error),
    }
}

fn login_error(error: ExternalGitLoginError) -> ApiError {
    match &error {
        ExternalGitLoginError::VerifiedEmailUnavailable => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            ApiErrorCode::AuthEmailRequired,
            "A verified primary email is required to sign in",
        ),
        ExternalGitLoginError::EmailConflict => ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::AuthEmailConflict,
            "This email belongs to an existing platform account; sign in to that account and connect the provider from settings",
        ),
        ExternalGitLoginError::ProviderAccountMismatch => ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::AuthProviderAccountConflict,
            "The signed-in provider account does not match this platform account's repository binding",
        ),
        ExternalGitLoginError::ProviderRejected {
            reason:
                Some(
                    ProviderAuthorizationRejection::InvalidClient
                    | ProviderAuthorizationRejection::RedirectUriMismatch,
                ),
        } => ApiError::new(
            StatusCode::BAD_GATEWAY,
            ApiErrorCode::AuthServiceUnavailable,
            "External Git login provider configuration was rejected",
        )
        .with_warning("external Git provider rejected login configuration", error),
        ExternalGitLoginError::ProviderRejected { .. } => ApiError::new(
            StatusCode::UNAUTHORIZED,
            ApiErrorCode::Unauthorized,
            "External Git login was rejected",
        )
        .with_warning("external Git provider rejected login", error),
        ExternalGitLoginError::IdentityRejected {
            resource: ProviderIdentityResource::VerifiedEmails,
            ..
        } => ApiError::new(
            StatusCode::BAD_GATEWAY,
            ApiErrorCode::AuthServiceUnavailable,
            "External Git login requires permission to read verified email addresses",
        )
        .with_warning("external Git provider rejected verified email lookup", error),
        ExternalGitLoginError::IdentityRejected { .. } => ApiError::new(
            StatusCode::UNAUTHORIZED,
            ApiErrorCode::Unauthorized,
            "External Git login identity was rejected",
        )
        .with_warning("external Git provider rejected identity lookup", error),
        ExternalGitLoginError::Authorization { .. }
        | ExternalGitLoginError::Identity { .. } => ApiError::new(
            StatusCode::BAD_GATEWAY,
            ApiErrorCode::AuthServiceUnavailable,
            "External Git login provider is unavailable",
        )
        .with_warning("external Git provider login exchange failed", error),
        ExternalGitLoginError::AccountLookup { .. }
        | ExternalGitLoginError::GrantLookup { .. }
        | ExternalGitLoginError::UsernameExhausted
        | ExternalGitLoginError::AccountPersistence { .. }
        | ExternalGitLoginError::GrantPersistence { .. } => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "External Git login could not be completed",
        )
        .with_diagnostic("external Git login persistence failed", error),
    }
}

fn connection_error(error: ExternalGitAuthorizationError) -> ApiError {
    match &error {
        ExternalGitAuthorizationError::NotSupported => ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::AuthorizationUnavailable,
            "This external Git provider does not support repository authorization",
        ),
        ExternalGitAuthorizationError::Provider {
            source: ProviderAuthorizationError::Rejected { .. },
        }
        | ExternalGitAuthorizationError::Identity {
            source: ProviderIdentityError::Rejected { .. },
        } => ApiError::new(
            StatusCode::UNAUTHORIZED,
            ApiErrorCode::ExternalGitAuthorizationRequired,
            "External Git authorization was rejected",
        )
        .with_warning("external Git authorization was rejected", error),
        ExternalGitAuthorizationError::Provider { .. }
        | ExternalGitAuthorizationError::Identity { .. } => ApiError::new(
            StatusCode::BAD_GATEWAY,
            ApiErrorCode::ExternalGitProviderUnavailable,
            "The external Git provider could not complete authorization",
        )
        .with_warning("external Git authorization provider exchange failed", error),
        ExternalGitAuthorizationError::Grant { .. } => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "External Git authorization could not be completed",
        )
        .with_diagnostic("external Git authorization grant persistence failed", error),
    }
}

fn oauth_state_cookie_name(state: &str) -> String {
    format!("{OAUTH_STATE_COOKIE_PREFIX}{state}")
}

fn oauth_state_cookie(state: String) -> Cookie<'static> {
    Cookie::build((oauth_state_cookie_name(&state), state))
        .path("/")
        .http_only(true)
        .secure(auth_cookie_secure())
        .same_site(SameSite::Lax)
        .build()
}

fn account_link_sign_in_path(provider_id: &ProviderInstanceId, final_return_to: &str) -> String {
    let profile_return_to = format!(
        "/profile?{}",
        url::form_urlencoded::Serializer::new(String::new())
            .append_pair("connect_provider", provider_id.as_str())
            .append_pair("return_to", final_return_to)
            .finish()
    );
    format!(
        "/signin?{}",
        url::form_urlencoded::Serializer::new(String::new())
            .append_pair("link_provider", provider_id.as_str())
            .append_pair("returnTo", &profile_return_to)
            .finish()
    )
}

pub(crate) async fn external_git_login(
    State(state): State<AppState>,
    Path(provider_id): Path<ProviderInstanceId>,
    jar: CookieJar,
    Query(query): Query<ExternalGitOAuthStartQuery>,
) -> Response {
    match begin_external_git_oauth(
        &state.db,
        state.external_git_providers.get(&provider_id),
        ExternalGitOAuthIntent::SignIn,
        query.return_to.as_deref(),
    )
    .await
    {
        Ok(start) => (
            jar.add(oauth_state_cookie(start.state)),
            Redirect::to(&start.authorization_url),
        )
            .into_response(),
        Err(error) => oauth_error(error).into_response(),
    }
}

pub(crate) async fn authorize_external_git(
    State(state): State<AppState>,
    Path(provider_id): Path<ProviderInstanceId>,
    headers: HeaderMap,
    jar: CookieJar,
    Query(query): Query<ExternalGitOAuthStartQuery>,
) -> Response {
    let user_id = match required_request_user_id(&state.db, &headers).await {
        Ok(user_id) => user_id,
        Err(error) => return ApiError::from(error).into_response(),
    };
    match begin_external_git_oauth(
        &state.db,
        state.external_git_providers.get(&provider_id),
        ExternalGitOAuthIntent::Connect { user_id },
        query.return_to.as_deref(),
    )
    .await
    {
        Ok(start) => (
            jar.add(oauth_state_cookie(start.state)),
            Redirect::to(&start.authorization_url),
        )
            .into_response(),
        Err(error) => oauth_error(error).into_response(),
    }
}

pub(crate) async fn external_git_oauth_callback(
    State(state): State<AppState>,
    Path(provider_id): Path<ProviderInstanceId>,
    headers: HeaderMap,
    jar: CookieJar,
    Query(query): Query<ExternalGitOAuthCallbackQuery>,
) -> Response {
    let callback_state = query.state.as_deref().unwrap_or_default();
    let state_cookie_name = oauth_state_cookie_name(callback_state);
    let cookie_state = jar
        .get(&state_cookie_name)
        .map(|cookie| cookie.value())
        .unwrap_or_default();
    if callback_state.is_empty() || callback_state != cookie_state {
        let callback_host = headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("unknown");
        tracing::warn!(
            provider_instance_id = %provider_id,
            callback_host,
            callback_state_present = !callback_state.is_empty(),
            state_cookie_present = !cookie_state.is_empty(),
            state_matches_cookie = !callback_state.is_empty() && callback_state == cookie_state,
            "external Git OAuth callback state binding failed"
        );
        return oauth_error(ExternalGitOAuthError::InvalidState).into_response();
    }
    let provider = match state.external_git_providers.get(&provider_id) {
        Some(provider) => provider,
        None => return oauth_error(ExternalGitOAuthError::NotConfigured).into_response(),
    };
    let attempt = match consume_external_git_oauth(&state.db, &provider_id, callback_state).await {
        Ok(attempt) => attempt,
        Err(error) => return oauth_error(error).into_response(),
    };
    let code = match (query.code.as_deref(), query.error.as_deref()) {
        (Some(code), None) => Some(code),
        (_, Some(_)) => None,
        (None, None) => return oauth_error(ExternalGitOAuthError::InvalidState).into_response(),
    };
    let jar = jar.remove(
        Cookie::build((state_cookie_name, String::new()))
            .path("/")
            .build(),
    );

    match attempt.intent {
        ExternalGitOAuthIntent::SignIn => {
            let completion =
                match complete_external_git_login(&state.db, provider, code.unwrap_or_default())
                    .await
                {
                    Ok(completion) => completion,
                    Err(ExternalGitLoginError::EmailConflict) => {
                        let path =
                            account_link_sign_in_path(provider.instance_id(), &attempt.return_to);
                        return (jar, Redirect::to(&path)).into_response();
                    }
                    Err(error) => return (jar, login_error(error).into_response()).into_response(),
                };
            let session_token =
                match issue_session_for_request(&state.db, &headers, completion.user_id).await {
                    Ok(token) => token,
                    Err(error) => {
                        return (
                            jar,
                            ApiError::new(
                                StatusCode::INTERNAL_SERVER_ERROR,
                                ApiErrorCode::InternalError,
                                "Failed to issue session",
                            )
                            .with_diagnostic("external Git login session issuance failed", error)
                            .into_response(),
                        )
                            .into_response();
                    }
                };
            record_event(
                &state.db,
                Some(completion.user_id),
                "auth.external_git.callback",
                serde_json::json!({
                    "provider_instance_id": completion.provider_instance_id,
                    "provider_account_id": completion.provider_account_id,
                    "provider_username": completion.provider_username
                }),
            )
            .await;
            (
                jar.add(session_cookie(session_token)),
                Redirect::to(&attempt.return_to),
            )
                .into_response()
        }
        ExternalGitOAuthIntent::Connect { user_id } => {
            let request_user_id = match required_request_user_id(&state.db, &headers).await {
                Ok(value) if value == user_id => value,
                Ok(_) => {
                    return (
                        jar,
                        oauth_error(ExternalGitOAuthError::InvalidState).into_response(),
                    )
                        .into_response();
                }
                Err(error) => return (jar, ApiError::from(error).into_response()).into_response(),
            };
            let Some(code) = code else {
                return (jar, Redirect::to(&attempt.return_to)).into_response();
            };
            match complete_external_git_authorization(&state.db, provider, request_user_id, code)
                .await
            {
                Ok(()) => (jar, Redirect::to(&attempt.return_to)).into_response(),
                Err(error) => (jar, connection_error(error).into_response()).into_response(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_conflict_returns_through_existing_account_verification() {
        let provider = "codeberg".parse::<ProviderInstanceId>();
        assert!(provider.is_ok());
        let Ok(provider) = provider else {
            return;
        };
        assert_eq!(
            account_link_sign_in_path(&provider, "/projects?view=active"),
            "/signin?link_provider=codeberg&returnTo=%2Fprofile%3Fconnect_provider%3Dcodeberg%26return_to%3D%252Fprojects%253Fview%253Dactive"
        );
    }

    #[test]
    fn concurrent_oauth_attempts_have_independent_browser_bindings() {
        let first_state = "A".repeat(48);
        let second_state = "B".repeat(48);
        let first = oauth_state_cookie(first_state.clone());
        let second = oauth_state_cookie(second_state.clone());

        assert_ne!(first.name(), second.name());
        let jar = CookieJar::new().add(first).add(second);
        assert_eq!(
            jar.get(&oauth_state_cookie_name(&first_state))
                .map(Cookie::value),
            Some(first_state.as_str())
        );
        assert_eq!(
            jar.get(&oauth_state_cookie_name(&second_state))
                .map(Cookie::value),
            Some(second_state.as_str())
        );
    }
}
