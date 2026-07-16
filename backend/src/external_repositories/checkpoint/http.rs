use super::enqueue::{enqueue_checkpoint, EnqueueCheckpointResult};
use crate::access::{ensure_project_role, AccessNeed};
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::http_response::ApiError;
use crate::protocol::{ApiErrorCode, ExternalGitCheckpointResponse};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use uuid::Uuid;

pub(crate) async fn request_external_git_checkpoint(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> axum::response::Response {
    let actor = match ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await
    {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let target = match enqueue_checkpoint(&state.db, project_id).await {
        Ok(EnqueueCheckpointResult::Queued(value)) => value,
        Ok(EnqueueCheckpointResult::UpToDate(value)) => {
            return Json(ExternalGitCheckpointResponse {
                accepted: false,
                up_to_date: true,
                target_workspace_version: value,
            })
            .into_response()
        }
        Ok(EnqueueCheckpointResult::InboundActive) => {
            return ApiError::new(
                StatusCode::CONFLICT,
                ApiErrorCode::ExternalGitOperationConflict,
                "Finish the active repository import before creating an outbound checkpoint",
            )
            .into_response()
        }
        Ok(EnqueueCheckpointResult::NotLinked) => return StatusCode::NO_CONTENT.into_response(),
        Err(database_error) => {
            return ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to request external Git checkpoint",
            )
            .with_diagnostic("external Git checkpoint enqueue failed", database_error)
            .into_response();
        }
    };
    record_event(
        &state.db,
        Some(actor),
        "external_git.checkpoint.request",
        serde_json::json!({
            "project_id": project_id,
            "target_workspace_version": target,
        }),
    )
    .await;
    (
        StatusCode::ACCEPTED,
        Json(ExternalGitCheckpointResponse {
            accepted: true,
            up_to_date: false,
            target_workspace_version: target,
        }),
    )
        .into_response()
}
