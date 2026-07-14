use super::authenticated_user_id;
use super::session::{self, IssueSessionCommand, IssueSessionError};
use crate::app_state::AppState;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use chrono::Utc;
use sqlx::PgPool;
use std::env;
use uuid::Uuid;

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct SessionResponse {
    pub session_token: String,
    pub user_id: Uuid,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct AuthMeResponse {
    pub user_id: Uuid,
    pub email: String,
    pub username: String,
    pub display_name: String,
    pub session_expires_at: chrono::DateTime<Utc>,
}

pub(crate) async fn auth_me(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
) -> Result<Json<AuthMeResponse>, ApiError> {
    let user_id = authenticated_user_id(&state.db, &headers, &jar).await?;
    let user = match session::authenticated_user(&state.db, user_id).await {
        Ok(Some(user)) => user,
        Ok(None) => {
            return Err(ApiError::new(
                StatusCode::UNAUTHORIZED,
                ApiErrorCode::AuthRequired,
                "Authentication required",
            ));
        }
        Err(database_error) => {
            return Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to load the authenticated user",
            )
            .with_diagnostic("authenticated user lookup failed", database_error));
        }
    };
    Ok(Json(AuthMeResponse {
        user_id: user.id,
        email: user.email,
        username: user.username,
        display_name: user.display_name,
        session_expires_at: Utc::now() + chrono::Duration::hours(12),
    }))
}

pub(crate) async fn auth_logout(
    State(state): State<AppState>,
    jar: CookieJar,
) -> axum::response::Response {
    if let Some(token) = jar
        .get("typst_session")
        .map(|cookie| cookie.value().to_string())
    {
        if let Err(database_error) = session::revoke_session(&state.db, &token).await {
            tracing::error!(%database_error, "session revocation failed");
        }
    }
    let jar = jar.remove(Cookie::from("typst_session"));
    (jar, StatusCode::NO_CONTENT).into_response()
}

pub(crate) async fn issue_session_response(
    db: &PgPool,
    headers: &HeaderMap,
    user_id: Uuid,
) -> Result<axum::response::Response, IssueSessionError> {
    let token = issue_session_for_request(db, headers, user_id).await?;
    let session_cookie = session_cookie(token.clone());
    let mut jar = CookieJar::new();
    jar = jar.add(session_cookie);
    Ok((
        jar,
        Json(SessionResponse {
            session_token: token,
            user_id,
        }),
    )
        .into_response())
}

pub(crate) async fn issue_session_for_request(
    db: &PgPool,
    headers: &HeaderMap,
    user_id: Uuid,
) -> Result<String, IssueSessionError> {
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|header| header.to_str().ok())
        .unwrap_or("unknown");
    let ip_address = headers
        .get("x-forwarded-for")
        .and_then(|header| header.to_str().ok())
        .unwrap_or("unknown");
    session::issue_session(
        db,
        IssueSessionCommand {
            user_id,
            user_agent,
            ip_address,
        },
    )
    .await
}

pub(crate) fn session_cookie(token: String) -> Cookie<'static> {
    Cookie::build(("typst_session", token))
        .path("/")
        .http_only(true)
        .secure(auth_cookie_secure())
        .same_site(SameSite::Lax)
        .build()
}

pub(crate) fn auth_cookie_secure() -> bool {
    env::var("COOKIE_SECURE")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}
