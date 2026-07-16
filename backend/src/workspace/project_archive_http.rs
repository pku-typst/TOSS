//! HTTP transport for downloading a Workspace project ZIP archive.

use super::http_error::project_service_unavailable;
use super::project_archive::{capture_current_project_archive, CaptureCurrentProjectArchiveError};
use crate::access::{ensure_project_access, AccessNeed};
use crate::app_state::AppState;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use uuid::Uuid;

pub(crate) async fn download_project_archive(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<impl IntoResponse, ApiError> {
    ensure_project_access(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let bytes = capture_current_project_archive(
        &state.db,
        state.storage.as_ref(),
        &state.collaboration,
        project_id,
    )
    .await?;
    let mut response = axum::http::Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/zip"),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        header::HeaderValue::from_str(&format!(
            "attachment; filename=\"project-{project_id}.zip\""
        ))
        .unwrap_or_else(|_| header::HeaderValue::from_static("attachment")),
    );
    Ok(response)
}

impl From<CaptureCurrentProjectArchiveError> for ApiError {
    fn from(source: CaptureCurrentProjectArchiveError) -> Self {
        match source {
            CaptureCurrentProjectArchiveError::ProjectNotFound => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::ProjectNotFound,
                "Project was not found",
            ),
            failure @ (CaptureCurrentProjectArchiveError::Collaboration { .. }
            | CaptureCurrentProjectArchiveError::Persistence { .. }
            | CaptureCurrentProjectArchiveError::Asset(_)
            | CaptureCurrentProjectArchiveError::Worker { .. }
            | CaptureCurrentProjectArchiveError::Archive { .. }) => {
                project_service_unavailable(failure)
            }
        }
    }
}
