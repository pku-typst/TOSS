//! Transport-owned HTTP errors and framework-level API error normalization.

use crate::protocol::{ApiErrorCode, ApiErrorResponse};
use axum::body::{to_bytes, Body};
use axum::extract::Request;
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::IntoResponse;
use axum::Json;
use std::sync::Arc;
use tracing::{error, warn};

#[derive(Clone, Copy, Debug)]
enum HttpDiagnosticLevel {
    Error,
    Warn,
}

#[derive(Clone, Debug)]
struct HttpErrorDiagnostic {
    level: HttpDiagnosticLevel,
    context: &'static str,
    source: Arc<dyn std::fmt::Debug + Send + Sync>,
}

#[derive(Debug)]
pub(crate) struct ApiError {
    status: StatusCode,
    payload: ApiErrorResponse,
    diagnostic: Option<HttpErrorDiagnostic>,
}

impl ApiError {
    pub(crate) fn new(status: StatusCode, code: ApiErrorCode, message: impl Into<String>) -> Self {
        Self {
            status,
            payload: ApiErrorResponse {
                code,
                message: message.into(),
                request_id: None,
            },
            diagnostic: None,
        }
    }

    pub(crate) fn with_diagnostic(
        mut self,
        context: &'static str,
        source: impl std::fmt::Debug + Send + Sync + 'static,
    ) -> Self {
        self.diagnostic = Some(HttpErrorDiagnostic {
            level: HttpDiagnosticLevel::Error,
            context,
            source: Arc::new(source),
        });
        self
    }

    pub(crate) fn with_warning(
        mut self,
        context: &'static str,
        source: impl std::fmt::Debug + Send + Sync + 'static,
    ) -> Self {
        self.diagnostic = Some(HttpErrorDiagnostic {
            level: HttpDiagnosticLevel::Warn,
            context,
            source: Arc::new(source),
        });
        self
    }

    fn with_request_id(mut self, request_id: Option<&str>) -> Self {
        self.payload.request_id = request_id.map(str::to_string);
        self
    }

    #[cfg(test)]
    pub(crate) fn status(&self) -> StatusCode {
        self.status
    }

    #[cfg(test)]
    pub(crate) fn code(&self) -> ApiErrorCode {
        self.payload.code
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let Self {
            status,
            payload,
            diagnostic,
        } = self;
        let mut response = (status, Json(payload)).into_response();
        if let Some(diagnostic) = diagnostic {
            response.extensions_mut().insert(diagnostic);
        }
        response
    }
}

fn status_error_code(status: StatusCode) -> ApiErrorCode {
    match status {
        StatusCode::BAD_REQUEST => ApiErrorCode::BadRequest,
        StatusCode::UNAUTHORIZED => ApiErrorCode::Unauthorized,
        StatusCode::FORBIDDEN => ApiErrorCode::Forbidden,
        StatusCode::NOT_FOUND => ApiErrorCode::NotFound,
        StatusCode::CONFLICT => ApiErrorCode::Conflict,
        StatusCode::PAYLOAD_TOO_LARGE => ApiErrorCode::PayloadTooLarge,
        StatusCode::UNPROCESSABLE_ENTITY => ApiErrorCode::UnprocessableEntity,
        StatusCode::PRECONDITION_REQUIRED => ApiErrorCode::PreconditionRequired,
        StatusCode::TOO_MANY_REQUESTS => ApiErrorCode::TooManyRequests,
        StatusCode::BAD_GATEWAY => ApiErrorCode::BadGateway,
        StatusCode::SERVICE_UNAVAILABLE => ApiErrorCode::ServiceUnavailable,
        _ if status.is_server_error() => ApiErrorCode::InternalError,
        _ => ApiErrorCode::RequestFailed,
    }
}

pub(crate) async fn normalize_api_error_response(
    request: Request,
    next: Next,
) -> axum::response::Response {
    let path = request.uri().path().to_string();
    let method = request.method().clone();
    let request_id = request
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() <= 128)
        .map(str::to_string);
    let response = next.run(request).await;
    if let Some(diagnostic) = response.extensions().get::<HttpErrorDiagnostic>() {
        match diagnostic.level {
            HttpDiagnosticLevel::Error => error!(
                request_id = request_id.as_deref().unwrap_or("unknown"),
                method = %method,
                path = %path,
                status = %response.status(),
                context = diagnostic.context,
                error = ?diagnostic.source,
                "HTTP request failed unexpectedly"
            ),
            HttpDiagnosticLevel::Warn => warn!(
                request_id = request_id.as_deref().unwrap_or("unknown"),
                method = %method,
                path = %path,
                status = %response.status(),
                context = diagnostic.context,
                error = ?diagnostic.source,
                "HTTP request failed"
            ),
        }
    }
    if !path.starts_with("/v1/")
        || path.starts_with("/v1/git/repo/")
        || (!response.status().is_client_error() && !response.status().is_server_error())
    {
        return response;
    }

    let status = response.status();
    let (mut parts, body) = response.into_parts();
    let is_json = parts
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"));
    let bytes = match to_bytes(body, 64 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return normalized_error_response(
                status,
                status_message(status),
                request_id.as_deref(),
                &parts.headers,
            );
        }
    };
    if is_json {
        let body =
            correlated_error_body(&bytes, request_id.as_deref()).unwrap_or_else(|| bytes.to_vec());
        parts.headers.remove(header::CONTENT_LENGTH);
        return axum::response::Response::from_parts(parts, Body::from(body));
    }
    normalized_error_response(
        status,
        response_message(status, &bytes),
        request_id.as_deref(),
        &parts.headers,
    )
}

fn normalized_error_response(
    status: StatusCode,
    message: String,
    request_id: Option<&str>,
    original_headers: &HeaderMap,
) -> axum::response::Response {
    let mut normalized = ApiError::new(status, status_error_code(status), message)
        .with_request_id(request_id)
        .into_response();
    copy_preserved_headers(original_headers, normalized.headers_mut());
    normalized
}

fn correlated_error_body(bytes: &[u8], request_id: Option<&str>) -> Option<Vec<u8>> {
    let request_id = request_id?;
    let mut value = serde_json::from_slice::<serde_json::Value>(bytes).ok()?;
    let object = value.as_object_mut()?;
    if !object.get("code").is_some_and(serde_json::Value::is_string)
        || !object
            .get("message")
            .is_some_and(serde_json::Value::is_string)
    {
        return None;
    }
    object.insert(
        "request_id".to_string(),
        serde_json::Value::String(request_id.to_string()),
    );
    serde_json::to_vec(&value).ok()
}

fn copy_preserved_headers(source: &HeaderMap, destination: &mut HeaderMap) {
    for (name, value) in source {
        if name != header::CONTENT_TYPE
            && name != header::CONTENT_LENGTH
            && name != header::CONTENT_ENCODING
            && name != header::TRANSFER_ENCODING
        {
            destination.append(name, value.clone());
        }
    }
}

fn response_message(status: StatusCode, bytes: &[u8]) -> String {
    std::str::from_utf8(bytes)
        .ok()
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| status_message(status))
}

fn status_message(status: StatusCode) -> String {
    status
        .canonical_reason()
        .unwrap_or("Request failed")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt;
    use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};

    #[test]
    fn semantic_error_code_is_independent_from_http_status() {
        let error = ApiError::new(
            StatusCode::UNAUTHORIZED,
            ApiErrorCode::AuthCredentialsInvalid,
            "Incorrect email or password",
        );
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);
        assert!(matches!(
            error.payload.code,
            ApiErrorCode::AuthCredentialsInvalid
        ));
    }

    #[test]
    fn empty_error_body_uses_canonical_status_message() {
        assert_eq!(response_message(StatusCode::NOT_FOUND, &[]), "Not Found");
    }

    #[test]
    fn text_error_body_is_preserved_as_protocol_message() {
        assert_eq!(
            response_message(StatusCode::UNAUTHORIZED, b"No session"),
            "No session"
        );
    }

    #[test]
    fn semantic_error_body_receives_the_request_id() -> Result<(), serde_json::Error> {
        let bytes = correlated_error_body(
            br#"{"code":"project_not_found","message":"Project was not found"}"#,
            Some("request-123"),
        )
        .ok_or_else(|| serde_json::Error::io(std::io::Error::other("missing error body")))?;
        let value: serde_json::Value = serde_json::from_slice(&bytes)?;
        assert_eq!(
            value.get("request_id").and_then(serde_json::Value::as_str),
            Some("request-123")
        );
        Ok(())
    }

    #[test]
    fn unrelated_json_error_body_is_not_rewritten() {
        assert!(correlated_error_body(br#"{"error":"upstream"}"#, Some("request-123")).is_none());
    }

    #[tokio::test]
    async fn request_id_is_shared_by_header_and_error_envelope(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let app = Router::new()
            .route(
                "/v1/failure",
                get(|| async {
                    ApiError::new(
                        StatusCode::NOT_FOUND,
                        ApiErrorCode::ProjectNotFound,
                        "Project was not found",
                    )
                }),
            )
            .layer(axum::middleware::from_fn(normalize_api_error_response))
            .layer(PropagateRequestIdLayer::x_request_id())
            .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid));
        let response = app
            .oneshot(Request::builder().uri("/v1/failure").body(Body::empty())?)
            .await?;
        let header_request_id = response
            .headers()
            .get("x-request-id")
            .ok_or_else(|| std::io::Error::other("response request ID is missing"))?
            .to_str()?
            .to_string();
        let bytes = to_bytes(response.into_body(), 64 * 1024).await?;
        let payload: serde_json::Value = serde_json::from_slice(&bytes)?;
        assert_eq!(
            payload
                .get("request_id")
                .and_then(serde_json::Value::as_str),
            Some(header_request_id.as_str())
        );
        Ok(())
    }
}
