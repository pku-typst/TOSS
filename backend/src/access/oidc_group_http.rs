//! Administrative transport for OIDC group-to-organization mappings.

use super::oidc_group::{
    delete_organization_group_mapping, upsert_organization_group_mapping, DeleteGroupMappingError,
    UpsertGroupMappingError,
};
use super::oidc_group_persistence;
use super::{ensure_site_admin, OrgGroupRoleMapping, OrganizationRole};
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use uuid::Uuid;

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct UpsertOrgGroupRoleMappingInput {
    pub group_name: String,
    pub role: OrganizationRole,
}

pub(crate) async fn list_org_group_role_mappings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(organization_id): Path<Uuid>,
) -> Result<Json<Vec<OrgGroupRoleMapping>>, ApiError> {
    ensure_site_admin(&state.db, &headers).await?;
    oidc_group_persistence::list_organization_mappings(&state.db, organization_id)
        .await
        .map(Json)
        .map_err(|database_error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to load OIDC group mappings",
            )
            .with_diagnostic(
                "organization OIDC group mapping list failed",
                database_error,
            )
        })
}

pub(crate) async fn upsert_org_group_role_mapping(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(organization_id): Path<Uuid>,
    Json(input): Json<UpsertOrgGroupRoleMappingInput>,
) -> Result<Json<OrgGroupRoleMapping>, ApiError> {
    let actor = ensure_site_admin(&state.db, &headers).await?;
    let mapping = upsert_organization_group_mapping(
        &state.db,
        organization_id,
        &input.group_name,
        input.role,
    )
    .await
    .map_err(|error| match error {
        UpsertGroupMappingError::EmptyGroupName => ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::BadRequest,
            "OIDC group name is required",
        ),
        failure @ UpsertGroupMappingError::Persistence { .. } => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "Failed to update OIDC group mapping",
        )
        .with_diagnostic("organization OIDC group mapping update failed", failure),
    })?;
    record_event(
        &state.db,
        Some(actor),
        "admin.org_group_role.upsert",
        serde_json::json!({
            "organization_id": organization_id,
            "group_name": mapping.group_name,
            "role": mapping.role
        }),
    )
    .await;
    Ok(Json(mapping))
}

pub(crate) async fn delete_org_group_role_mapping(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((organization_id, group_name)): Path<(Uuid, String)>,
) -> Result<StatusCode, ApiError> {
    let actor = ensure_site_admin(&state.db, &headers).await?;
    delete_organization_group_mapping(&state.db, organization_id, &group_name)
        .await
        .map_err(|error| match error {
            DeleteGroupMappingError::NotFound { .. } => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::NotFound,
                "OIDC group mapping not found",
            ),
            failure @ DeleteGroupMappingError::Persistence { .. } => ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to delete OIDC group mapping",
            )
            .with_diagnostic("organization OIDC group mapping deletion failed", failure),
        })?;
    record_event(
        &state.db,
        Some(actor),
        "admin.org_group_role.delete",
        serde_json::json!({"organization_id": organization_id, "group_name": group_name}),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}
