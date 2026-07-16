use super::grant::{
    self, DeleteGroupRoleError, DeleteOrganizationAccessError, UpsertGroupRoleError,
    UpsertOrganizationAccessError,
};
use super::grant_persistence;
use super::{
    ensure_project_role, AccessNeed, ProjectAccessUser, ProjectGroupRoleBinding,
    ProjectOrganizationAccess, ProjectPermission, ProjectRole, ProjectRoleBinding,
};
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize, utoipa::ToSchema)]
pub(crate) struct UpsertRoleInput {
    pub user_id: Uuid,
    pub role: ProjectRole,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub(crate) struct UpsertProjectGroupRoleInput {
    pub group_name: String,
    pub role: ProjectRole,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub(crate) struct UpsertProjectOrganizationAccessInput {
    pub permission: ProjectPermission,
}

#[derive(Serialize, utoipa::ToSchema)]
pub(crate) struct ProjectAccessUserListResponse {
    pub users: Vec<ProjectAccessUser>,
}

pub(crate) async fn list_roles(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<Vec<ProjectRoleBinding>>, ApiError> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let roles = grant_persistence::list_roles(&state.db, project_id)
        .await
        .map_err(|database_error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to load project roles",
            )
            .with_diagnostic("project role list lookup failed", database_error)
        })?;
    Ok(Json(roles))
}

pub(crate) async fn upsert_role(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UpsertRoleInput>,
) -> Result<Json<ProjectRoleBinding>, ApiError> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let binding = grant::upsert_project_role(&state.db, project_id, input.user_id, input.role)
        .await
        .map_err(|database_error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to update project role",
            )
            .with_diagnostic("project role update failed", database_error)
        })?;
    state.collaboration.access_changed(project_id).await;
    record_event(
        &state.db,
        Some(actor),
        "project.role.upsert",
        serde_json::json!({
            "project_id": project_id,
            "target_user_id": input.user_id,
            "role": input.role
        }),
    )
    .await;
    Ok(Json(binding))
}

pub(crate) async fn list_project_organization_access(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<Vec<ProjectOrganizationAccess>>, ApiError> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let access = grant_persistence::list_organization_access(&state.db, project_id)
        .await
        .map_err(|database_error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to load organization access",
            )
            .with_diagnostic("project organization access lookup failed", database_error)
        })?;
    Ok(Json(access))
}

pub(crate) async fn upsert_project_organization_access(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, organization_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<UpsertProjectOrganizationAccessInput>,
) -> Result<Json<ProjectOrganizationAccess>, ApiError> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let access = grant::upsert_project_organization_access(
        &state.db,
        project_id,
        organization_id,
        input.permission,
        actor,
    )
    .await
    .map_err(|error| match error {
        UpsertOrganizationAccessError::ActorNotMember { .. } => ApiError::new(
            StatusCode::FORBIDDEN,
            ApiErrorCode::Forbidden,
            "Organization membership is required",
        ),
        failure @ UpsertOrganizationAccessError::Persistence { .. } => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "Failed to update organization access",
        )
        .with_diagnostic("project organization access update failed", failure),
    })?;
    state.collaboration.access_changed(project_id).await;
    record_event(
        &state.db,
        Some(actor),
        "project.organization_access.upsert",
        serde_json::json!({
            "project_id": project_id,
            "organization_id": organization_id,
            "permission": input.permission
        }),
    )
    .await;
    Ok(Json(access))
}

pub(crate) async fn delete_project_organization_access(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, organization_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    grant::delete_project_organization_access(&state.db, project_id, organization_id)
        .await
        .map_err(|error| match error {
            DeleteOrganizationAccessError::NotFound { .. } => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::NotFound,
                "Organization access grant not found",
            ),
            failure @ DeleteOrganizationAccessError::Persistence { .. } => ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to delete organization access",
            )
            .with_diagnostic("project organization access deletion failed", failure),
        })?;
    state.collaboration.access_changed(project_id).await;
    record_event(
        &state.db,
        Some(actor),
        "project.organization_access.delete",
        serde_json::json!({
            "project_id": project_id,
            "organization_id": organization_id
        }),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn list_project_access_users(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<ProjectAccessUserListResponse>, ApiError> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let users = grant::list_project_access_users(&state.db, project_id)
        .await
        .map_err(|database_error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to load project access users",
            )
            .with_diagnostic("project access user lookup failed", database_error)
        })?;
    Ok(Json(ProjectAccessUserListResponse { users }))
}

pub(crate) async fn list_group_roles(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<Vec<ProjectGroupRoleBinding>>, ApiError> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let roles = grant_persistence::list_group_roles(&state.db, project_id)
        .await
        .map_err(|database_error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to load project group roles",
            )
            .with_diagnostic("project group role list lookup failed", database_error)
        })?;
    Ok(Json(roles))
}

pub(crate) async fn upsert_group_role(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UpsertProjectGroupRoleInput>,
) -> Result<Json<ProjectGroupRoleBinding>, ApiError> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let binding =
        grant::upsert_project_group_role(&state.db, project_id, &input.group_name, input.role)
            .await
            .map_err(|error| match error {
                UpsertGroupRoleError::EmptyGroupName => ApiError::new(
                    StatusCode::BAD_REQUEST,
                    ApiErrorCode::BadRequest,
                    "Group name is required",
                ),
                failure @ UpsertGroupRoleError::Persistence { .. } => ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    ApiErrorCode::InternalError,
                    "Failed to update project group role",
                )
                .with_diagnostic("project group role update failed", failure),
            })?;
    state.collaboration.access_changed(project_id).await;
    record_event(
        &state.db,
        Some(actor),
        "project.group_role.upsert",
        serde_json::json!({
            "project_id": project_id,
            "group_name": binding.group_name,
            "role": input.role
        }),
    )
    .await;
    Ok(Json(binding))
}

pub(crate) async fn delete_group_role(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, group_name)): Path<(Uuid, String)>,
) -> Result<StatusCode, ApiError> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    grant::delete_project_group_role(&state.db, project_id, &group_name)
        .await
        .map_err(|error| match error {
            DeleteGroupRoleError::EmptyGroupName => ApiError::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::BadRequest,
                "Group name is required",
            ),
            DeleteGroupRoleError::NotFound { .. } => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::NotFound,
                "Project group role not found",
            ),
            failure @ DeleteGroupRoleError::Persistence { .. } => ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to delete project group role",
            )
            .with_diagnostic("project group role deletion failed", failure),
        })?;
    state.collaboration.access_changed(project_id).await;
    record_event(
        &state.db,
        Some(actor),
        "project.group_role.delete",
        serde_json::json!({"project_id": project_id, "group_name": group_name}),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}
