use super::super::connection_http::{
    external_git_branches_for_user, external_git_gateway_for_provider, ExternalGitListQuery,
};
use super::super::http_support::external_git_provider_error;
use super::super::linking::linked_repository;
use super::super::provider::{ExternalGitProviderError, ProviderInstanceId};
use super::branch::SourceBranch;
use super::import_creation::{create_import_project, CreateImportError, CreateImportProject};
use super::job_queries::{job_by_id, JobLookupError};
use super::sync_enqueue::{enqueue_sync, EnqueueInboundSync, EnqueueSyncError};
use crate::access::{
    ensure_project_access, ensure_project_role, required_request_user_id, AccessNeed,
};
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use crate::workspace::{LatexEngine, ProjectName, ProjectType};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use uuid::Uuid;

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct CreateExternalGitImportInput {
    provider: ProviderInstanceId,
    repository_id: String,
    branch: String,
    name: String,
    project_type: Option<ProjectType>,
    latex_engine: Option<LatexEngine>,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct RequestExternalGitInboundSyncInput {
    branch: String,
}

pub(crate) async fn list_linked_external_git_repository_branches(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Query(input): Query<ExternalGitListQuery>,
) -> axum::response::Response {
    if let Err(status) =
        ensure_project_access(&state.db, &headers, project_id, AccessNeed::Manage).await
    {
        return status.into_response();
    }
    let link = match linked_repository(&state.db, project_id).await {
        Ok(Some(value)) => value,
        Ok(None) => {
            return ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::NotFound,
                "External Git link not found",
            )
            .into_response()
        }
        Err(database_error) => {
            return ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to read external Git link",
            )
            .with_diagnostic("external Git link lookup failed", database_error)
            .into_response();
        }
    };
    let gateway = state.external_git_gateway(&link.provider);
    match external_git_branches_for_user(
        &gateway,
        link.linked_by_user_id,
        &link.repository_id,
        &input,
    )
    .await
    {
        Ok(response) => Json(response).into_response(),
        Err(error) => external_git_provider_error(error).into_response(),
    }
}

pub(crate) async fn create_external_git_import(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateExternalGitImportInput>,
) -> axum::response::Response {
    let actor = match required_request_user_id(&state.db, &headers).await {
        Ok(actor) => actor,
        Err(error) => return ApiError::from(error).into_response(),
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
    let Ok(branch) = SourceBranch::parse(&input.branch) else {
        return ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            ApiErrorCode::UnprocessableEntity,
            "Branch name is invalid",
        )
        .into_response();
    };
    let name = match ProjectName::parse(&input.name) {
        Ok(value) => value,
        Err(_) => {
            return ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                ApiErrorCode::ProjectNameInvalid,
                "Project name is invalid",
            )
            .into_response()
        }
    };
    let project_type = input.project_type.unwrap_or(ProjectType::Typst);
    if !state.distribution.supports_project_type(project_type) {
        return ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            ApiErrorCode::ProjectTypeDisabled,
            "This project type is disabled in the current deployment",
        )
        .into_response();
    }
    let latex_engine = if project_type == ProjectType::Latex {
        input.latex_engine.unwrap_or(LatexEngine::Xetex)
    } else {
        LatexEngine::Xetex
    };
    let gateway = match external_git_gateway_for_provider(&state, &input.provider) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let details = match gateway.repository_details(actor, repository_id).await {
        Ok(value) => value,
        Err(error) => return external_git_provider_error(error).into_response(),
    };
    if details.repository.archived
        || !details.access.can_write()
        || !gateway.validate_repository(&details)
    {
        return ApiError::new(
            StatusCode::FORBIDDEN,
            ApiErrorCode::ExternalGitRepositoryForbidden,
            "The external Git repository cannot be imported",
        )
        .into_response();
    }
    if let Err(error) = gateway
        .find_repository_branch(actor, repository_id, branch.as_str())
        .await
    {
        return external_git_provider_error(error).into_response();
    }

    let provider = match gateway.provider_id() {
        Some(provider) => provider,
        None => {
            return external_git_provider_error(ExternalGitProviderError::NotConfigured)
                .into_response()
        }
    };
    let default_branch = details
        .repository
        .default_branch
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("main")
        .to_string();
    let response = match create_import_project(
        &state.db,
        CreateImportProject {
            actor_user_id: actor,
            name,
            project_type,
            latex_engine,
            provider: provider.clone(),
            repository_id: repository_id.to_string(),
            full_path: details.repository.full_path,
            web_url: details.repository.web_url,
            clone_url: details.clone_url,
            default_branch,
            checkpoint_branch_prefix: state.distribution.git.checkpoint_branch_prefix.clone(),
            source_branch: branch.clone(),
        },
    )
    .await
    {
        Ok(value) => value,
        Err(CreateImportError::RepositoryConflict) => {
            return ApiError::new(
                StatusCode::CONFLICT,
                ApiErrorCode::ExternalGitRepositoryConflict,
                "The external Git repository is already linked",
            )
            .into_response();
        }
        Err(failure @ CreateImportError::Persistence { .. }) => {
            return ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to create repository import",
            )
            .with_diagnostic("external repository import creation failed", failure)
            .into_response();
        }
    };
    record_event(
        &state.db,
        Some(actor),
        "external_git.import.request",
        serde_json::json!({
            "job_id": response.id,
            "project_id": response.project_id,
            "provider": provider,
            "repository_id": repository_id,
            "branch": branch.as_str(),
        }),
    )
    .await;
    (StatusCode::ACCEPTED, Json(response)).into_response()
}

pub(crate) async fn request_external_git_inbound_sync(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<RequestExternalGitInboundSyncInput>,
) -> axum::response::Response {
    let actor = match ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await
    {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let Ok(branch) = SourceBranch::parse(&input.branch) else {
        return ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            ApiErrorCode::UnprocessableEntity,
            "Branch name is invalid",
        )
        .into_response();
    };
    let link = match linked_repository(&state.db, project_id).await {
        Ok(Some(value)) => value,
        Ok(None) => {
            return ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::NotFound,
                "External Git link not found",
            )
            .into_response()
        }
        Err(database_error) => {
            return ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to read external Git link",
            )
            .with_diagnostic("external Git link lookup failed", database_error)
            .into_response();
        }
    };
    let gateway = state.external_git_gateway(&link.provider);
    if let Err(error) = gateway
        .find_repository_branch(link.linked_by_user_id, &link.repository_id, branch.as_str())
        .await
    {
        return external_git_provider_error(error).into_response();
    }
    let response = match enqueue_sync(
        &state.db,
        EnqueueInboundSync {
            project_id,
            actor_user_id: actor,
            provider: link.provider,
            source_branch: branch.clone(),
        },
    )
    .await
    {
        Ok(value) => value,
        Err(EnqueueSyncError::ProjectNotFound) => {
            return ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::ProjectNotFound,
                "Project not found",
            )
            .into_response()
        }
        Err(EnqueueSyncError::OutboundCheckpointActive) => {
            return ApiError::new(
                StatusCode::CONFLICT,
                ApiErrorCode::ExternalGitOperationConflict,
                "Finish the pending outbound checkpoint before importing a branch",
            )
            .into_response()
        }
        Err(EnqueueSyncError::InboundJobActive) => {
            return ApiError::new(
                StatusCode::CONFLICT,
                ApiErrorCode::ExternalGitOperationConflict,
                "A repository import is already active for this project",
            )
            .into_response()
        }
        Err(failure @ EnqueueSyncError::Persistence { .. }) => {
            return ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to request repository sync",
            )
            .with_diagnostic("external repository sync enqueue failed", failure)
            .into_response();
        }
    };
    record_event(
        &state.db,
        Some(actor),
        "external_git.inbound_sync.request",
        serde_json::json!({
            "job_id": response.id,
            "project_id": project_id,
            "branch": branch.as_str(),
        }),
    )
    .await;
    (StatusCode::ACCEPTED, Json(response)).into_response()
}

pub(crate) async fn get_external_git_inbound_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<Uuid>,
) -> axum::response::Response {
    let job = match job_by_id(&state.db, job_id).await {
        Ok(value) => value,
        Err(JobLookupError::NotFound) => {
            return ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::NotFound,
                "Import job not found",
            )
            .into_response()
        }
        Err(failure @ JobLookupError::Persistence { .. }) => {
            return ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Failed to read import job",
            )
            .with_diagnostic("external Git inbound job lookup failed", failure)
            .into_response();
        }
    };
    if let Err(status) =
        ensure_project_access(&state.db, &headers, job.project_id, AccessNeed::Read).await
    {
        return status.into_response();
    }
    Json(job).into_response()
}
