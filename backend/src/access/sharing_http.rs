use super::sharing::{
    self, CreateTemporaryShareLoginError, EnableProjectShareLinkError, JoinProjectShareLinkError,
    ResolveProjectShareLinkError, RevokeProjectShareLinkError,
};
use super::sharing_persistence;
use super::{
    effective_auth_settings, ensure_project_access, ensure_project_role, required_request_user_id,
    AccessNeed, AnonymousMode, ProjectPermission, ProjectRole, ProjectShareLink,
};
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use crate::workspace::{project_descriptor, ProjectDescriptor};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize, utoipa::ToSchema)]
pub(crate) struct CreateProjectShareLinkInput {
    pub permission: ProjectPermission,
    pub expires_at: Option<String>,
}

#[derive(Serialize, utoipa::ToSchema)]
pub(crate) struct CreateProjectShareLinkResponse {
    pub link: ProjectShareLink,
    pub token: String,
}

#[derive(Serialize, utoipa::ToSchema)]
pub(crate) struct JoinProjectShareLinkResponse {
    pub project_id: Uuid,
    pub role: ProjectRole,
}

#[derive(Serialize, utoipa::ToSchema)]
pub(crate) struct ResolveProjectShareLinkResponse {
    pub project_id: Uuid,
    pub project_name: String,
    pub permission: ProjectPermission,
    pub is_template: bool,
    pub anonymous_mode: AnonymousMode,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub(crate) struct TemporaryShareLoginInput {
    pub display_name: String,
}

#[derive(Serialize, utoipa::ToSchema)]
pub(crate) struct TemporaryShareLoginResponse {
    pub project_id: Uuid,
    pub session_token: String,
    pub session_id: Uuid,
    pub display_name: String,
    pub permission: ProjectPermission,
}

pub(crate) async fn list_project_share_links(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<Vec<ProjectShareLink>>, ApiError> {
    let principal =
        ensure_project_access(&state.db, &headers, project_id, AccessNeed::Read).await?;
    sharing_persistence::list_active(&state.db, project_id, principal.can_write)
        .await
        .map(Json)
        .map_err(|database_error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to load project share links",
            )
            .with_diagnostic("project share-link list failed", database_error)
        })
}

pub(crate) async fn create_project_share_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<CreateProjectShareLinkInput>,
) -> Result<Json<CreateProjectShareLinkResponse>, ApiError> {
    let actor_user_id =
        ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let expires_at = input
        .expires_at
        .map(|raw| {
            DateTime::parse_from_rfc3339(&raw)
                .map(|value| value.with_timezone(&Utc))
                .map_err(|_| {
                    ApiError::new(
                        StatusCode::BAD_REQUEST,
                        ApiErrorCode::BadRequest,
                        "Share-link expiration must be an RFC 3339 timestamp",
                    )
                })
        })
        .transpose()?;
    let mutation = sharing::enable_project_share_link(
        &state.db,
        project_id,
        input.permission,
        expires_at,
        actor_user_id,
    )
    .await
    .map_err(|error| match error {
        EnableProjectShareLinkError::ExpirationNotFuture => ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::BadRequest,
            "Share-link expiration must be in the future",
        ),
        failure => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "Failed to update project share link",
        )
        .with_diagnostic("project share-link update failed", failure),
    })?;
    state.collaboration.access_changed(project_id).await;
    let action = if mutation.inserted {
        "project.share_link.create"
    } else {
        "project.share_link.enable"
    };
    record_event(
        &state.db,
        Some(actor_user_id),
        action,
        serde_json::json!({
            "project_id": project_id,
            "share_link_id": mutation.link.id,
            "permission": mutation.link.permission,
            "expires_at": mutation.link.expires_at
        }),
    )
    .await;
    Ok(Json(CreateProjectShareLinkResponse {
        link: mutation.link,
        token: mutation.token,
    }))
}

pub(crate) async fn revoke_project_share_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, share_link_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    let actor_user_id =
        ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    sharing::revoke_project_share_link(&state.db, project_id, share_link_id)
        .await
        .map_err(|error| match error {
            RevokeProjectShareLinkError::NotFound { .. } => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::NotFound,
                "Project share link not found",
            ),
            failure => ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to revoke project share link",
            )
            .with_diagnostic("project share-link revocation failed", failure),
        })?;
    state.collaboration.access_changed(project_id).await;
    record_event(
        &state.db,
        Some(actor_user_id),
        "project.share_link.revoke",
        serde_json::json!({"project_id": project_id, "share_link_id": share_link_id}),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn join_project_share_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(token): Path<String>,
) -> Result<Json<JoinProjectShareLinkResponse>, ApiError> {
    let actor_user_id = required_request_user_id(&state.db, &headers).await?;
    let joined = sharing::join_project_share_link(&state.db, actor_user_id, &token)
        .await
        .map_err(|error| match error {
            JoinProjectShareLinkError::EmptyToken => ApiError::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::BadRequest,
                "Share token is required",
            ),
            JoinProjectShareLinkError::NotFound => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::NotFound,
                "Project share link not found",
            ),
            failure => ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to join project share link",
            )
            .with_diagnostic("project share-link join failed", failure),
        })?;
    state.collaboration.access_changed(joined.project_id).await;
    record_event(
        &state.db,
        Some(actor_user_id),
        "project.share_link.join",
        serde_json::json!({
            "project_id": joined.project_id,
            "granted_role": joined.role,
            "permission": joined.permission
        }),
    )
    .await;
    Ok(Json(JoinProjectShareLinkResponse {
        project_id: joined.project_id,
        role: joined.role,
    }))
}

pub(crate) async fn resolve_project_share_link(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<ResolveProjectShareLinkResponse>, ApiError> {
    let resolved = sharing::resolve_project_share_link(&state.db, &token)
        .await
        .map_err(|error| match error {
            ResolveProjectShareLinkError::EmptyToken => ApiError::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::BadRequest,
                "Share token is required",
            ),
            ResolveProjectShareLinkError::NotFound => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::NotFound,
                "Project share link not found",
            ),
            failure @ ResolveProjectShareLinkError::Lookup { .. } => ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to resolve project share link",
            )
            .with_diagnostic("project share-link resolution failed", failure),
        })?;
    let ProjectDescriptor {
        id: project_id,
        name: project_name,
        is_template,
    } = project_descriptor(&state.db, resolved.project_id)
        .await
        .map_err(|database_error| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::ProjectServiceUnavailable,
                "Project details are unavailable",
            )
            .with_diagnostic("shared project descriptor lookup failed", database_error)
        })?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::ProjectNotFound,
                "Shared project not found",
            )
        })?;
    let settings = effective_auth_settings(&state.db, &state.oidc_defaults)
        .await
        .map_err(|database_error| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::AuthServiceUnavailable,
                "Authentication settings are unavailable",
            )
            .with_diagnostic("authentication settings lookup failed", database_error)
        })?;
    Ok(Json(ResolveProjectShareLinkResponse {
        project_id,
        project_name,
        permission: resolved.permission,
        is_template,
        anonymous_mode: settings.anonymous_mode,
    }))
}

pub(crate) async fn create_temporary_share_login(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Json(input): Json<TemporaryShareLoginInput>,
) -> Result<Json<TemporaryShareLoginResponse>, ApiError> {
    let settings = effective_auth_settings(&state.db, &state.oidc_defaults)
        .await
        .map_err(|database_error| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::AuthServiceUnavailable,
                "Authentication settings are unavailable",
            )
            .with_diagnostic("authentication settings lookup failed", database_error)
        })?;
    let session = sharing::create_temporary_share_login(
        &state.db,
        &token,
        &input.display_name,
        settings.anonymous_mode,
    )
    .await
    .map_err(|error| match error {
        CreateTemporaryShareLoginError::EmptyToken
        | CreateTemporaryShareLoginError::InvalidDisplayName => ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::BadRequest,
            "Share token or display name is invalid",
        ),
        CreateTemporaryShareLoginError::NotFound => ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::NotFound,
            "Project share link not found",
        ),
        CreateTemporaryShareLoginError::GuestWriteDisabled
        | CreateTemporaryShareLoginError::TemplateUnsupported { .. }
        | CreateTemporaryShareLoginError::WritePermissionRequired { .. } => ApiError::new(
            StatusCode::FORBIDDEN,
            ApiErrorCode::Forbidden,
            "Temporary editing is not available for this share link",
        ),
        failure => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "Failed to create temporary share session",
        )
        .with_diagnostic("temporary share login failed", failure),
    })?;
    Ok(Json(TemporaryShareLoginResponse {
        project_id: session.project_id,
        session_token: session.session_token,
        session_id: session.session_id,
        display_name: session.display_name,
        permission: session.permission,
    }))
}
