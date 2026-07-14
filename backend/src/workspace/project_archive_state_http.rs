//! HTTP transport for per-user project archive state.

use super::http_error::project_service_unavailable;
use super::project_archive_state::set_project_archived;
use crate::access::{ensure_project_role, AccessNeed};
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::http_response::ApiError;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use uuid::Uuid;

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct UpdateProjectArchivedInput {
    pub archived: bool,
}

pub(crate) async fn update_project_archived(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UpdateProjectArchivedInput>,
) -> Result<StatusCode, ApiError> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    set_project_archived(&state.db, project_id, actor, input.archived)
        .await
        .map_err(project_service_unavailable)?;
    record_event(
        &state.db,
        Some(actor),
        if input.archived {
            "project.archive"
        } else {
            "project.unarchive"
        },
        serde_json::json!({
            "project_id": project_id,
            "archived": input.archived
        }),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}
