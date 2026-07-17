//! Browser/Core compatibility fence for the coupled application release.

use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::extract::Request;
use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

pub(crate) const PROTOCOL_EPOCH: u32 = 1;
pub(crate) const PROTOCOL_INCOMPATIBLE_CLOSE_CODE: u16 = 4406;
pub(crate) const PROTOCOL_EPOCH_HEADER: HeaderName =
    HeaderName::from_static("x-toss-protocol-epoch");

pub(crate) fn protocol_epoch_matches(epoch: Option<&str>) -> bool {
    epoch.is_none_or(|epoch| {
        epoch
            .parse::<u32>()
            .is_ok_and(|epoch| epoch == PROTOCOL_EPOCH)
    })
}

fn protocol_epoch_value() -> HeaderValue {
    HeaderValue::from(PROTOCOL_EPOCH)
}

fn incompatible_response() -> Response {
    let mut response = ApiError::new(
        StatusCode::UPGRADE_REQUIRED,
        ApiErrorCode::ClientIncompatible,
        "This page must be reloaded to continue",
    )
    .into_response();
    response
        .headers_mut()
        .insert(PROTOCOL_EPOCH_HEADER, protocol_epoch_value());
    response
}

pub(super) async fn protocol_epoch_fence(request: Request, next: Next) -> Response {
    if !request.uri().path().starts_with("/v1/") {
        return next.run(request).await;
    }
    let browser_epoch = request.headers().get(&PROTOCOL_EPOCH_HEADER);
    let compatible = match browser_epoch {
        None => protocol_epoch_matches(None),
        Some(value) => value
            .to_str()
            .is_ok_and(|epoch| protocol_epoch_matches(Some(epoch))),
    };
    if !compatible {
        return incompatible_response();
    }

    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(PROTOCOL_EPOCH_HEADER, protocol_epoch_value());
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::middleware;
    use axum::routing::post;
    use axum::Router;
    use tower::ServiceExt;

    fn app() -> Router {
        Router::new()
            .route("/v1/work", post(|| async { StatusCode::NO_CONTENT }))
            .layer(middleware::from_fn(protocol_epoch_fence))
    }

    #[tokio::test]
    async fn missing_and_matching_epochs_are_admitted() -> Result<(), Box<dyn std::error::Error>> {
        for epoch in [None, Some(PROTOCOL_EPOCH.to_string())] {
            let mut request = Request::builder().method("POST").uri("/v1/work");
            if let Some(epoch) = epoch {
                request = request.header(&PROTOCOL_EPOCH_HEADER, epoch);
            }
            let response = app().oneshot(request.body(Body::empty())?).await?;
            assert_eq!(response.status(), StatusCode::NO_CONTENT);
            assert_eq!(
                response.headers().get(&PROTOCOL_EPOCH_HEADER),
                Some(&protocol_epoch_value())
            );
        }
        Ok(())
    }

    #[tokio::test]
    async fn mismatched_client_is_rejected_before_mutation(
    ) -> Result<(), Box<dyn std::error::Error>> {
        for epoch in ["2", "invalid"] {
            let response = app()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/v1/work")
                        .header(&PROTOCOL_EPOCH_HEADER, epoch)
                        .body(Body::empty())?,
                )
                .await?;
            assert_eq!(response.status(), StatusCode::UPGRADE_REQUIRED);
            assert_eq!(
                response.headers().get(&PROTOCOL_EPOCH_HEADER),
                Some(&protocol_epoch_value())
            );
            let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
            let body: serde_json::Value = serde_json::from_slice(&body)?;
            assert_eq!(
                body.get("code").and_then(serde_json::Value::as_str),
                Some("client_incompatible")
            );
        }
        Ok(())
    }
}
