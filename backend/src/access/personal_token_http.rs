use super::personal_token::{self, CreatePersonalAccessTokenError, RevokePersonalAccessTokenError};
use super::{authenticated_user_id, PersonalAccessTokenInfo};
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Serialize, utoipa::ToSchema)]
pub(crate) struct PersonalAccessTokenListResponse {
    pub tokens: Vec<PersonalAccessTokenInfo>,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub(crate) struct CreatePatInput {
    pub label: String,
    pub expires_at: Option<String>,
}

#[derive(Serialize, utoipa::ToSchema)]
pub(crate) struct CreatePatResponse {
    pub id: Uuid,
    pub label: String,
    pub token: String,
    pub token_prefix: String,
    pub created_at: DateTime<Utc>,
    #[schema(required)]
    pub expires_at: Option<DateTime<Utc>>,
}

pub(crate) async fn list_personal_access_tokens(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
) -> Result<Json<PersonalAccessTokenListResponse>, ApiError> {
    let user_id = authenticated_user_id(&state.db, &headers, &jar).await?;
    let tokens = personal_token::list_personal_access_tokens(&state.db, user_id)
        .await
        .map_err(|database_error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to load personal access tokens",
            )
            .with_diagnostic("personal access token lookup failed", database_error)
        })?;
    Ok(Json(PersonalAccessTokenListResponse { tokens }))
}

pub(crate) async fn create_personal_access_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(input): Json<CreatePatInput>,
) -> Result<Json<CreatePatResponse>, ApiError> {
    let user_id = authenticated_user_id(&state.db, &headers, &jar).await?;
    let expires_at = if let Some(raw) = input.expires_at.as_deref() {
        let parsed = DateTime::parse_from_rfc3339(raw)
            .map(|value| value.with_timezone(&Utc))
            .map_err(|_| {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    ApiErrorCode::BadRequest,
                    "Invalid expiry time format. Use an RFC 3339 timestamp",
                )
            })?;
        Some(parsed)
    } else {
        None
    };
    let response =
        personal_token::create_personal_access_token(&state.db, user_id, &input.label, expires_at)
            .await
            .map_err(|error| match error {
                CreatePersonalAccessTokenError::EmptyLabel => ApiError::new(
                    StatusCode::BAD_REQUEST,
                    ApiErrorCode::BadRequest,
                    "Token label is required",
                ),
                CreatePersonalAccessTokenError::ExpirationNotFuture => ApiError::new(
                    StatusCode::BAD_REQUEST,
                    ApiErrorCode::BadRequest,
                    "Token expiration must be in the future",
                ),
                failure @ CreatePersonalAccessTokenError::Persistence { .. } => ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    ApiErrorCode::InternalError,
                    "Failed to create personal access token",
                )
                .with_diagnostic("personal access token creation failed", failure),
            })?;

    record_event(
        &state.db,
        Some(user_id),
        "security.token.create",
        serde_json::json!({"token_id": response.id, "label": response.label}),
    )
    .await;

    Ok(Json(CreatePatResponse {
        id: response.id,
        label: response.label,
        token: response.token,
        token_prefix: response.token_prefix,
        created_at: response.created_at,
        expires_at: response.expires_at,
    }))
}

pub(crate) async fn revoke_personal_access_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Path(token_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let user_id = authenticated_user_id(&state.db, &headers, &jar).await?;
    personal_token::revoke_personal_access_token(&state.db, user_id, token_id)
        .await
        .map_err(|error| match error {
            RevokePersonalAccessTokenError::NotFound { .. } => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::NotFound,
                "Token not found or already revoked",
            ),
            failure @ RevokePersonalAccessTokenError::Persistence { .. } => ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to revoke personal access token",
            )
            .with_diagnostic("personal access token revocation failed", failure),
        })?;
    record_event(
        &state.db,
        Some(user_id),
        "security.token.revoke",
        serde_json::json!({"token_id": token_id}),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}
