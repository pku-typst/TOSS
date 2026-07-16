use super::organization::{self, CreateOrganizationError};
use super::organization_model::{Organization, OrganizationMembership};
use super::organization_persistence;
use super::{ensure_site_admin, required_request_user_id};
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct OrganizationListResponse {
    pub organizations: Vec<Organization>,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct OrganizationMembershipListResponse {
    pub organizations: Vec<OrganizationMembership>,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct CreateOrganizationInput {
    pub name: String,
}

pub(crate) async fn list_my_organizations(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<OrganizationMembershipListResponse>, ApiError> {
    let actor = required_request_user_id(&state.db, &headers).await?;
    let organizations = organization_persistence::list_memberships(&state.db, actor)
        .await
        .map_err(|database_error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to load organization memberships",
            )
            .with_diagnostic("organization membership lookup failed", database_error)
        })?;
    Ok(Json(OrganizationMembershipListResponse { organizations }))
}

pub(crate) async fn list_organizations(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<OrganizationListResponse>, ApiError> {
    required_request_user_id(&state.db, &headers).await?;
    let organizations = organization_persistence::list_all(&state.db)
        .await
        .map_err(|database_error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to load organizations",
            )
            .with_diagnostic("organization list lookup failed", database_error)
        })?;
    Ok(Json(OrganizationListResponse { organizations }))
}

pub(crate) async fn create_organization(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateOrganizationInput>,
) -> Result<Json<Organization>, ApiError> {
    let actor = ensure_site_admin(&state.db, &headers).await?;
    let organization = organization::create_organization(&state.db, &input.name)
        .await
        .map_err(|error| match error {
            CreateOrganizationError::EmptyName => ApiError::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::BadRequest,
                "Organization name is required",
            ),
            failure @ CreateOrganizationError::Persistence { .. } => ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to create organization",
            )
            .with_diagnostic("organization creation failed", failure),
        })?;
    record_event(
        &state.db,
        Some(actor),
        "organization.create",
        serde_json::json!({"organization_id": organization.id, "name": organization.name}),
    )
    .await;
    Ok(Json(organization))
}
