//! HTTP transport for local account login and registration.

use super::super::auth_settings::effective_auth_settings;
use super::super::auth_settings_model::AuthSettings;
use super::super::session_http::issue_session_response;
use super::authentication::{
    self, AuthenticateLocalAccountError, LocalLoginCommand, LocalLoginPolicyError,
};
use super::registration::{
    self, LocalRegistrationCommand, LocalRegistrationPolicyError, RegisterLocalAccountError,
};
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct LocalLoginInput {
    pub email: String,
    pub password: String,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct LocalRegisterInput {
    pub email: String,
    pub username: String,
    pub password: String,
    pub display_name: Option<String>,
}

async fn load_auth_settings(state: &AppState) -> Result<AuthSettings, ApiError> {
    effective_auth_settings(&state.db, &state.oidc_defaults)
        .await
        .map_err(|database_error| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::AuthServiceUnavailable,
                "Authentication settings are unavailable",
            )
            .with_diagnostic("authentication settings lookup failed", database_error)
        })
}

pub(crate) async fn local_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<LocalLoginInput>,
) -> Result<axum::response::Response, ApiError> {
    let settings = load_auth_settings(&state).await?;
    let user_id = authentication::authenticate(
        &state.db,
        settings.allow_local_login,
        LocalLoginCommand {
            email: input.email,
            password: input.password,
        },
    )
    .await
    .map_err(local_login_api_error)?;
    issue_session_response(&state.db, &headers, user_id)
        .await
        .map_err(session_issue_api_error)
}

pub(crate) async fn local_register(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<LocalRegisterInput>,
) -> Result<axum::response::Response, ApiError> {
    let settings = load_auth_settings(&state).await?;
    let account = registration::register(
        &state.db,
        settings.allow_local_registration,
        LocalRegistrationCommand {
            email: input.email,
            username: input.username,
            password: input.password,
            display_name: input.display_name,
        },
    )
    .await
    .map_err(local_registration_api_error)?;
    record_event(
        &state.db,
        Some(account.user_id),
        "auth.local.register",
        serde_json::json!({"email": account.email, "username": account.username}),
    )
    .await;
    issue_session_response(&state.db, &headers, account.user_id)
        .await
        .map_err(session_issue_api_error)
}

fn local_login_api_error(error: AuthenticateLocalAccountError) -> ApiError {
    match error {
        AuthenticateLocalAccountError::Policy(LocalLoginPolicyError::Disabled) => ApiError::new(
            StatusCode::FORBIDDEN,
            ApiErrorCode::AuthLocalLoginDisabled,
            "Local account login is disabled by the administrator",
        ),
        AuthenticateLocalAccountError::Policy(LocalLoginPolicyError::MissingCredentials) => {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::AuthCredentialsRequired,
                "Email and password are required",
            )
        }
        AuthenticateLocalAccountError::IncorrectCredentials => ApiError::new(
            StatusCode::UNAUTHORIZED,
            ApiErrorCode::AuthCredentialsInvalid,
            "Incorrect email or password",
        ),
        failure @ AuthenticateLocalAccountError::CredentialStoreUnavailable(_) => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorCode::AuthServiceUnavailable,
            "Authentication service is unavailable",
        )
        .with_diagnostic("local account authentication is unavailable", failure),
        failure @ AuthenticateLocalAccountError::PasswordVerification(_) => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "Authentication failed unexpectedly",
        )
        .with_diagnostic("local account password verification failed", failure),
    }
}

fn local_registration_api_error(error: RegisterLocalAccountError) -> ApiError {
    match error {
        RegisterLocalAccountError::Policy(LocalRegistrationPolicyError::Disabled) => ApiError::new(
            StatusCode::FORBIDDEN,
            ApiErrorCode::AuthLocalRegistrationDisabled,
            "Self-registration is disabled by the administrator",
        ),
        RegisterLocalAccountError::Policy(LocalRegistrationPolicyError::EmailRequired) => {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::AuthEmailRequired,
                "Email is required",
            )
        }
        RegisterLocalAccountError::Policy(LocalRegistrationPolicyError::InvalidEmail) => {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::AuthEmailInvalid,
                "Email format is invalid",
            )
        }
        RegisterLocalAccountError::Policy(LocalRegistrationPolicyError::UsernameRequired) => {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::AuthUsernameRequired,
                "Username is required",
            )
        }
        RegisterLocalAccountError::Policy(LocalRegistrationPolicyError::InvalidUsername) => {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::AuthUsernameInvalid,
                "Username must be 2-64 chars, start/end with letters or numbers, and use only letters, numbers, ., _, -",
            )
        }
        RegisterLocalAccountError::Policy(LocalRegistrationPolicyError::PasswordRequired) => {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::AuthPasswordRequired,
                "Password is required",
            )
        }
        RegisterLocalAccountError::Policy(LocalRegistrationPolicyError::PasswordTooShort) => {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::AuthPasswordTooShort,
                "Password must be at least 8 characters long",
            )
        }
        RegisterLocalAccountError::EmailConflict => ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::AuthEmailConflict,
            "An account with this email already exists",
        ),
        RegisterLocalAccountError::UsernameConflict => ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::AuthUsernameConflict,
            "This username is already taken",
        ),
        failure @ (RegisterLocalAccountError::PasswordHash(_)
        | RegisterLocalAccountError::Persistence(_)) => {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to create the account",
            )
            .with_diagnostic("local account registration failed", failure)
        }
    }
}

fn session_issue_api_error(error: super::super::session::IssueSessionError) -> ApiError {
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        ApiErrorCode::InternalError,
        "Failed to issue session",
    )
    .with_diagnostic("local account session issuance failed", error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_credentials_have_a_stable_semantic_code() {
        let error = local_login_api_error(AuthenticateLocalAccountError::IncorrectCredentials);
        assert_eq!(error.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(error.code(), ApiErrorCode::AuthCredentialsInvalid);
    }

    #[test]
    fn registration_policy_errors_keep_their_field_semantics() {
        let error = local_registration_api_error(RegisterLocalAccountError::Policy(
            LocalRegistrationPolicyError::InvalidUsername,
        ));
        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
        assert_eq!(error.code(), ApiErrorCode::AuthUsernameInvalid);
    }
}
