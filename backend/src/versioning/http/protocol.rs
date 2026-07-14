//! Git smart-HTTP CGI parsing and personal-access-token authentication.

use crate::access::authenticate_personal_access_token;
use axum::http::{header, HeaderMap, StatusCode};
use base64::engine::general_purpose::STANDARD;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

pub(super) const CGI_RESPONSE_PREFIX_BYTES: usize = 64 * 1024 + 4;

#[derive(Debug, Eq, Error, PartialEq)]
pub(super) enum CgiResponseParseError {
    #[error("CGI response headers exceed 64 KiB")]
    HeadersTooLarge,
    #[error("CGI response body offset is invalid")]
    InvalidBodyOffset,
}

pub(super) struct CgiResponseHead {
    pub status: StatusCode,
    pub headers: Vec<(String, String)>,
    pub body_offset: u64,
}

pub(super) fn parse_cgi_http_backend_prefix(
    prefix: &[u8],
    total_len: u64,
) -> Result<CgiResponseHead, CgiResponseParseError> {
    let split = prefix
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| (index, 4usize))
        .or_else(|| {
            prefix
                .windows(2)
                .position(|window| window == b"\n\n")
                .map(|index| (index, 2usize))
        });
    let Some((index, separator_len)) = split else {
        if total_len > prefix.len() as u64 {
            return Err(CgiResponseParseError::HeadersTooLarge);
        }
        return Ok(CgiResponseHead {
            status: StatusCode::OK,
            headers: Vec::new(),
            body_offset: 0,
        });
    };
    if index > 64 * 1024 {
        return Err(CgiResponseParseError::HeadersTooLarge);
    }
    let Some(body_start) = index.checked_add(separator_len) else {
        return Err(CgiResponseParseError::InvalidBodyOffset);
    };
    let Some(head) = prefix.get(..index) else {
        return Err(CgiResponseParseError::InvalidBodyOffset);
    };
    let mut status = StatusCode::OK;
    let mut headers = Vec::new();
    for line in String::from_utf8_lossy(head).lines() {
        if let Some(rest) = line.strip_prefix("Status:") {
            let code = rest.split_whitespace().next().unwrap_or("200");
            if let Ok(code) = code.parse::<u16>() {
                status = StatusCode::from_u16(code).unwrap_or(StatusCode::OK);
            }
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            headers.push((key.trim().to_string(), value.trim().to_string()));
        }
    }
    let body_offset =
        u64::try_from(body_start).map_err(|_| CgiResponseParseError::InvalidBodyOffset)?;
    if body_offset > total_len {
        return Err(CgiResponseParseError::InvalidBodyOffset);
    }
    Ok(CgiResponseHead {
        status,
        headers,
        body_offset,
    })
}

pub(super) async fn git_http_user(
    db: &PgPool,
    headers: &HeaderMap,
) -> Result<Option<Uuid>, sqlx::Error> {
    let Some(token) = git_basic_auth_token(headers) else {
        return Ok(None);
    };
    authenticate_personal_access_token(db, &token).await
}

fn git_basic_auth_token(headers: &HeaderMap) -> Option<String> {
    let auth = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let basic = auth.strip_prefix("Basic ")?;
    let decoded = base64::Engine::decode(&STANDARD, basic).ok()?;
    let credentials = String::from_utf8(decoded).ok()?;
    let (_, token) = credentials.split_once(':')?;
    Some(token.to_string())
}

#[cfg(test)]
mod tests {
    use super::{parse_cgi_http_backend_prefix, CgiResponseParseError, CGI_RESPONSE_PREFIX_BYTES};
    use axum::http::StatusCode;

    #[test]
    fn cgi_response_parser_handles_crlf_lf_and_missing_headers() -> Result<(), CgiResponseParseError>
    {
        let raw = b"Status: 201 Created\r\nContent-Type: text/plain\r\n\r\nok";
        let response = parse_cgi_http_backend_prefix(raw, raw.len() as u64)?;
        assert_eq!(response.status, StatusCode::CREATED);
        assert_eq!(
            response.headers,
            vec![("Content-Type".to_string(), "text/plain".to_string())]
        );
        assert_eq!(response.body_offset, 49);

        let raw = b"Content-Type: text/plain\n\nhello";
        let response = parse_cgi_http_backend_prefix(raw, raw.len() as u64)?;
        assert_eq!(response.status, StatusCode::OK);
        assert_eq!(
            response.headers,
            vec![("Content-Type".to_string(), "text/plain".to_string())]
        );
        assert_eq!(response.body_offset, 26);

        let raw = b"body without CGI headers";
        let response = parse_cgi_http_backend_prefix(raw, raw.len() as u64)?;
        assert_eq!(response.status, StatusCode::OK);
        assert!(response.headers.is_empty());
        assert_eq!(response.body_offset, 0);
        Ok(())
    }

    #[test]
    fn cgi_response_parser_rejects_unbounded_headers() {
        let prefix = vec![b'a'; CGI_RESPONSE_PREFIX_BYTES];

        assert_eq!(
            parse_cgi_http_backend_prefix(&prefix, CGI_RESPONSE_PREFIX_BYTES as u64 + 1)
                .map(|response| response.body_offset),
            Err(CgiResponseParseError::HeadersTooLarge)
        );
    }
}
