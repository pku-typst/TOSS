//! HTTP transport for organization grants on projects marked as templates.

use super::http_error::template_service_unavailable;
use super::organization_grants;
use crate::access::{ensure_project_role, AccessNeed, TemplateOrganizationGrant};
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::http_response::ApiError;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use uuid::Uuid;

pub(crate) async fn list_project_template_organization_access(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<Vec<TemplateOrganizationGrant>>, ApiError> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let access =
        organization_grants::list_project_template_organization_access(&state.db, project_id)
            .await
            .map_err(template_service_unavailable)?;
    Ok(Json(access))
}

pub(crate) async fn upsert_project_template_organization_access(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, organization_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<TemplateOrganizationGrant>, ApiError> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let access = organization_grants::upsert_project_template_organization_access(
        &state.db,
        project_id,
        organization_id,
        actor,
    )
    .await?;
    record_event(
        &state.db,
        Some(actor),
        "project.template.organization_access.upsert",
        serde_json::json!({
            "project_id": project_id,
            "organization_id": organization_id
        }),
    )
    .await;
    Ok(Json(access))
}

pub(crate) async fn delete_project_template_organization_access(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, organization_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    organization_grants::delete_project_template_organization_access(
        &state.db,
        project_id,
        organization_id,
    )
    .await?;
    record_event(
        &state.db,
        Some(actor),
        "project.template.organization_access.delete",
        serde_json::json!({
            "project_id": project_id,
            "organization_id": organization_id
        }),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}
