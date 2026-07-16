use super::connection_http::external_git_gateway_for_provider;
use super::http_support::external_git_provider_error;
use super::linking::{
    ensure_external_git_link_available, persist_external_git_repository_link,
    unlink_repository_link, ExternalRepositoryProjectStatusError, PersistRepositoryLinkError,
    RepositoryLinkAvailabilityError, UnlinkRepositoryError,
};
use super::provider::{
    ExternalGitProviderError, ProviderInstanceId, RemoteRepository, RepositoryOwnerKind,
};
use super::{ExternalGitLinkStatus, ExternalGitRepositoryVisibility};
use crate::access::{ensure_project_access, AccessNeed};
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use uuid::Uuid;

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct CreateExternalGitRepositoryInput {
    provider: ProviderInstanceId,
    name: String,
    path: String,
    owner_id: String,
    owner_kind: RepositoryOwnerKind,
    visibility: Option<ExternalGitRepositoryVisibility>,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct LinkExternalGitRepositoryInput {
    provider: ProviderInstanceId,
    repository_id: String,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ExternalGitProjectLinkMutationResponse {
    project_id: Uuid,
    provider: ProviderInstanceId,
    repository_id: String,
    full_path: String,
    web_url: String,
    state: ExternalGitLinkStatus,
}

fn link_mutation_response(
    project_id: Uuid,
    provider_id: ProviderInstanceId,
    repository: &RemoteRepository,
) -> ExternalGitProjectLinkMutationResponse {
    ExternalGitProjectLinkMutationResponse {
        project_id,
        provider: provider_id,
        repository_id: repository.id.clone(),
        full_path: repository.full_path.clone(),
        web_url: repository.web_url.clone(),
        state: ExternalGitLinkStatus::Linking,
    }
}

fn persist_link_error(source: PersistRepositoryLinkError) -> ApiError {
    match source {
        PersistRepositoryLinkError::NotConfigured => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorCode::ExternalGitNotConfigured,
            "External Git is not configured",
        ),
        PersistRepositoryLinkError::InvalidProviderResponse => ApiError::new(
            StatusCode::BAD_GATEWAY,
            ApiErrorCode::ExternalGitProviderUnavailable,
            "The external Git provider returned an invalid repository",
        ),
        PersistRepositoryLinkError::Conflict => ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::ExternalGitRepositoryConflict,
            "The external Git repository is already linked",
        ),
        failure @ PersistRepositoryLinkError::Persistence { .. } => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "Failed to save external Git repository link",
        )
        .with_diagnostic("external repository link persistence failed", failure),
    }
}

pub(crate) async fn create_external_git_repository(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<CreateExternalGitRepositoryInput>,
) -> axum::response::Response {
    let principal =
        match ensure_project_access(&state.db, &headers, project_id, AccessNeed::Manage).await {
            Ok(value) => value,
            Err(status) => return status.into_response(),
        };
    let Some(actor_user_id) = principal.user_id else {
        return ApiError::new(
            StatusCode::UNAUTHORIZED,
            ApiErrorCode::AuthRequired,
            "Authentication required",
        )
        .into_response();
    };
    if let Err(error) = ensure_external_git_link_available(&state.db, project_id).await {
        return match error {
            RepositoryLinkAvailabilityError::AlreadyLinked { .. } => ApiError::new(
                StatusCode::CONFLICT,
                ApiErrorCode::ExternalGitRepositoryConflict,
                "An external Git repository is already linked",
            )
            .into_response(),
            failure @ RepositoryLinkAvailabilityError::Persistence { .. } => ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to inspect external Git repository link",
            )
            .with_diagnostic(
                "external repository link availability lookup failed",
                failure,
            )
            .into_response(),
        };
    }
    let visibility = input
        .visibility
        .unwrap_or(ExternalGitRepositoryVisibility::Private);
    let gateway = match external_git_gateway_for_provider(&state, &input.provider) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let details = match gateway
        .create_repository(
            actor_user_id,
            &input.name,
            &input.path,
            &input.owner_id,
            input.owner_kind,
            visibility,
        )
        .await
    {
        Ok(value) => value,
        Err(error) => return external_git_provider_error(error).into_response(),
    };
    let repository = &details.repository;
    let Some(provider_id) = gateway.provider_id() else {
        return external_git_provider_error(ExternalGitProviderError::NotConfigured)
            .into_response();
    };
    if let Err(error) = persist_external_git_repository_link(
        &state.db,
        &gateway,
        &state.distribution.git.checkpoint_branch_prefix,
        project_id,
        actor_user_id,
        &details,
    )
    .await
    {
        record_event(
            &state.db,
            Some(actor_user_id),
            "external_git.repository.create.link_failed",
            serde_json::json!({
                "project_id": project_id,
                "provider": provider_id,
                "repository_id": &repository.id,
                "repository_full_path": &repository.full_path,
            }),
        )
        .await;
        return persist_link_error(error).into_response();
    }
    record_event(
        &state.db,
        Some(actor_user_id),
        "external_git.repository.create",
        serde_json::json!({
            "project_id": project_id,
            "provider": provider_id,
            "repository_id": &repository.id,
            "repository_full_path": &repository.full_path,
        }),
    )
    .await;
    (
        StatusCode::CREATED,
        Json(link_mutation_response(project_id, provider_id, repository)),
    )
        .into_response()
}

pub(crate) async fn link_external_git_repository(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<LinkExternalGitRepositoryInput>,
) -> axum::response::Response {
    let principal =
        match ensure_project_access(&state.db, &headers, project_id, AccessNeed::Manage).await {
            Ok(value) => value,
            Err(status) => return status.into_response(),
        };
    let Some(actor_user_id) = principal.user_id else {
        return ApiError::new(
            StatusCode::UNAUTHORIZED,
            ApiErrorCode::AuthRequired,
            "Authentication required",
        )
        .into_response();
    };
    let repository_id = input.repository_id.trim();
    if repository_id.is_empty() {
        return ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            ApiErrorCode::UnprocessableEntity,
            "Repository identifier is required",
        )
        .into_response();
    }
    let gateway = match external_git_gateway_for_provider(&state, &input.provider) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let details = match gateway
        .repository_details(actor_user_id, repository_id)
        .await
    {
        Ok(value) => value,
        Err(error) => return external_git_provider_error(error).into_response(),
    };
    let Some(provider_id) = gateway.provider_id() else {
        return external_git_provider_error(ExternalGitProviderError::NotConfigured)
            .into_response();
    };
    if details.repository.archived || !details.access.can_write() {
        return ApiError::new(
            StatusCode::FORBIDDEN,
            ApiErrorCode::ExternalGitRepositoryForbidden,
            "The external Git repository cannot be linked",
        )
        .into_response();
    }
    if let Err(error) = persist_external_git_repository_link(
        &state.db,
        &gateway,
        &state.distribution.git.checkpoint_branch_prefix,
        project_id,
        actor_user_id,
        &details,
    )
    .await
    {
        return persist_link_error(error).into_response();
    }
    record_event(
        &state.db,
        Some(actor_user_id),
        "external_git.repository.link",
        serde_json::json!({
            "project_id": project_id,
            "provider": provider_id,
            "repository_id": &details.repository.id,
            "repository_full_path": &details.repository.full_path,
        }),
    )
    .await;
    Json(link_mutation_response(
        project_id,
        provider_id,
        &details.repository,
    ))
    .into_response()
}

pub(crate) async fn unlink_external_git_repository(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> axum::response::Response {
    let principal =
        match ensure_project_access(&state.db, &headers, project_id, AccessNeed::Manage).await {
            Ok(value) => value,
            Err(status) => return status.into_response(),
        };
    let Some(actor_user_id) = principal.user_id else {
        return ApiError::new(
            StatusCode::UNAUTHORIZED,
            ApiErrorCode::AuthRequired,
            "Authentication required",
        )
        .into_response();
    };
    let deleted = match unlink_repository_link(&state.db, project_id).await {
        Ok(value) => value,
        Err(UnlinkRepositoryError::ActiveOperation { .. }) => {
            return ApiError::new(
                StatusCode::CONFLICT,
                ApiErrorCode::ExternalGitOperationConflict,
                "Finish the active repository operation before unlinking",
            )
            .into_response()
        }
        Err(UnlinkRepositoryError::ProjectNotFound { .. }) => {
            return ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::ProjectNotFound,
                "Project not found",
            )
            .into_response()
        }
        Err(failure @ UnlinkRepositoryError::Persistence { .. }) => {
            return ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to unlink external Git repository",
            )
            .with_diagnostic("external repository unlink failed", failure)
            .into_response();
        }
    };
    if let Some(deleted) = deleted {
        record_event(
            &state.db,
            Some(actor_user_id),
            "external_git.repository.unlink",
            serde_json::json!({
                "project_id": project_id,
                "provider": deleted.provider,
                "repository_id": deleted.repository_id,
                "repository_full_path": deleted.full_path,
            }),
        )
        .await;
    }
    StatusCode::NO_CONTENT.into_response()
}

pub(crate) async fn external_git_project_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> axum::response::Response {
    if let Err(status) =
        ensure_project_access(&state.db, &headers, project_id, AccessNeed::Read).await
    {
        return status.into_response();
    }
    match super::linking::external_git_project_status(&state.db, project_id).await {
        Ok(status) => Json(status).into_response(),
        Err(ExternalRepositoryProjectStatusError::ProjectNotFound { .. }) => ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::ProjectNotFound,
            "Project not found",
        )
        .into_response(),
        Err(failure @ ExternalRepositoryProjectStatusError::Persistence { .. }) => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "Failed to read external Git project status",
        )
        .with_diagnostic("external repository project status lookup failed", failure)
        .into_response(),
    }
}
