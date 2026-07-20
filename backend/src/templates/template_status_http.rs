//! HTTP transport for the personal-template status lifecycle.

use super::template_status::{self, TemplateStatus};
use crate::access::{ensure_project_role, AccessNeed};
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::http_response::ApiError;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use uuid::Uuid;

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct UpdateProjectTemplateInput {
    pub is_template: bool,
}

pub(crate) async fn update_project_template(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UpdateProjectTemplateInput>,
) -> Result<Json<TemplateStatus>, ApiError> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let revokes_temporary_access = input.is_template;
    let status =
        template_status::update_project_template(&state.db, project_id, input.is_template).await?;
    if revokes_temporary_access {
        state.collaboration.access_changed(project_id).await;
    }
    record_event(
        &state.db,
        Some(actor),
        "project.template.update",
        serde_json::json!({
            "project_id": project_id,
            "is_template": status.is_template
        }),
    )
    .await;
    Ok(Json(status))
}
