use super::session_persistence;
use axum::http::{header, HeaderMap};
use axum_extra::extract::cookie::CookieJar;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::env;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub(crate) enum RequestAuthenticationError {
    #[error("authentication is required")]
    Required,
    #[error("request principal lookup failed")]
    Store(#[source] sqlx::Error),
}

fn actor_user_id(headers: &HeaderMap) -> Option<Uuid> {
    let allow_dev_header = env::var("AUTH_DEV_HEADER_ENABLED")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if !allow_dev_header {
        return None;
    }
    headers
        .get("x-user-id")
        .and_then(|header| header.to_str().ok())
        .and_then(|value| Uuid::parse_str(value).ok())
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|header| header.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|value| value.trim().to_string())
}

pub(super) fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let cookie_header = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in cookie_header.split(';') {
        let part = part.trim();
        if let Some((key, value)) = part.split_once('=') {
            if key.trim() == name {
                return Some(value.trim().to_string());
            }
        }
    }
    None
}

pub(super) fn header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|header| header.to_str().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

async fn session_user_id(
    db: &PgPool,
    token: &str,
) -> Result<Option<Uuid>, RequestAuthenticationError> {
    let token_fingerprint = Sha256::digest(token.as_bytes());
    session_persistence::session_user_id(db, token_fingerprint.as_ref())
        .await
        .map_err(RequestAuthenticationError::Store)
}

pub(crate) async fn request_user_id(
    db: &PgPool,
    headers: &HeaderMap,
) -> Result<Option<Uuid>, RequestAuthenticationError> {
    if let Some(user_id) = actor_user_id(headers) {
        return Ok(Some(user_id));
    }
    if let Some(token) = bearer_token(headers) {
        if let Some(user_id) = session_user_id(db, &token).await? {
            return Ok(Some(user_id));
        }
    }
    if let Some(token) = cookie_value(headers, "typst_session") {
        if let Some(user_id) = session_user_id(db, &token).await? {
            return Ok(Some(user_id));
        }
    }
    Ok(None)
}

pub(crate) async fn required_request_user_id(
    db: &PgPool,
    headers: &HeaderMap,
) -> Result<Uuid, RequestAuthenticationError> {
    request_user_id(db, headers)
        .await?
        .ok_or(RequestAuthenticationError::Required)
}

pub(crate) async fn authenticated_user_id(
    db: &PgPool,
    headers: &HeaderMap,
    jar: &CookieJar,
) -> Result<Uuid, RequestAuthenticationError> {
    if let Some(user_id) = request_user_id(db, headers).await? {
        return Ok(user_id);
    }
    if let Some(token) = jar
        .get("typst_session")
        .map(|cookie| cookie.value().to_string())
    {
        if let Some(user_id) = session_user_id(db, &token).await? {
            return Ok(user_id);
        }
    }
    Err(RequestAuthenticationError::Required)
}
