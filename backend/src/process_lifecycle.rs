//! Process drain notification and admission fencing.

use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use tokio::sync::watch;

const RETRY_AFTER_SECONDS: HeaderValue = HeaderValue::from_static("1");

#[derive(Clone)]
pub(crate) struct DrainSignal {
    draining: watch::Sender<bool>,
}

impl DrainSignal {
    pub(crate) fn is_triggered(&self) -> bool {
        *self.draining.borrow()
    }

    pub(crate) async fn triggered(&self) {
        let mut receiver = self.draining.subscribe();
        while !*receiver.borrow() {
            if receiver.changed().await.is_err() {
                return;
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn idle() -> Self {
        let (draining, _) = watch::channel(false);
        Self { draining }
    }

    #[cfg(test)]
    pub(crate) fn trigger_for_test(&self) {
        self.draining.send_replace(true);
    }
}

pub(super) struct DrainTrigger {
    signal: DrainSignal,
}

impl DrainTrigger {
    pub(super) fn new() -> Self {
        let (draining, _) = watch::channel(false);
        Self {
            signal: DrainSignal { draining },
        }
    }

    pub(super) fn signal(&self) -> DrainSignal {
        self.signal.clone()
    }

    pub(super) fn trigger(&self) -> bool {
        self.signal.draining.send_if_modified(|draining| {
            if *draining {
                return false;
            }
            *draining = true;
            true
        })
    }
}

fn is_probe_path(path: &str) -> bool {
    matches!(path, "/ready" | "/health")
}

pub(crate) fn unavailable_response() -> Response {
    let mut response = ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        ApiErrorCode::ServiceUnavailable,
        "Service is temporarily unavailable",
    )
    .into_response();
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, RETRY_AFTER_SECONDS);
    response
}

pub(super) async fn admission_fence(
    State(drain): State<DrainSignal>,
    request: Request,
    next: Next,
) -> Response {
    if !drain.is_triggered() || is_probe_path(request.uri().path()) {
        next.run(request).await
    } else {
        unavailable_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt;

    #[test]
    fn drain_is_monotonic() {
        let trigger = DrainTrigger::new();
        let drain = trigger.signal();

        assert!(!drain.is_triggered());
        assert!(trigger.trigger());
        assert!(!trigger.trigger());
        assert!(drain.is_triggered());
    }

    #[tokio::test]
    async fn draining_rejects_ordinary_admission_but_keeps_probes_available(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let trigger = DrainTrigger::new();
        let app = Router::new()
            .route("/work", get(|| async { StatusCode::NO_CONTENT }))
            .route("/health", get(|| async { StatusCode::OK }))
            .layer(axum::middleware::from_fn_with_state(
                trigger.signal(),
                admission_fence,
            ));

        let admitted = app
            .clone()
            .oneshot(Request::builder().uri("/work").body(Body::empty())?)
            .await?;
        assert_eq!(admitted.status(), StatusCode::NO_CONTENT);

        assert!(trigger.trigger());
        let rejected = app
            .clone()
            .oneshot(Request::builder().uri("/work").body(Body::empty())?)
            .await?;
        assert_eq!(rejected.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            rejected.headers().get(header::RETRY_AFTER),
            Some(&RETRY_AFTER_SECONDS)
        );
        let health = app
            .oneshot(Request::builder().uri("/health").body(Body::empty())?)
            .await?;
        assert_eq!(health.status(), StatusCode::OK);
        Ok(())
    }
}
