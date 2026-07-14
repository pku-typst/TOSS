//! Shared HTTP representation for Workspace-wide policy and unexpected failures.

use super::{InvalidProjectName, InvalidProjectPath};
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::http::StatusCode;

impl From<InvalidProjectPath> for ApiError {
    fn from(_source: InvalidProjectPath) -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::ProjectPathInvalid,
            "Project path is invalid",
        )
    }
}

impl From<InvalidProjectName> for ApiError {
    fn from(_source: InvalidProjectName) -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::ProjectNameInvalid,
            "Project name is invalid",
        )
    }
}

pub(super) fn project_service_unavailable(
    source: impl std::fmt::Debug + Send + Sync + 'static,
) -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        ApiErrorCode::ProjectServiceUnavailable,
        "Project service is unavailable",
    )
    .with_diagnostic("workspace project service failed", source)
}
