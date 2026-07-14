use super::connection::{
    disconnect_external_git_account, DisconnectExternalGitError, ExternalGitProviderMetadata,
};
use super::http_support::external_git_provider_error;
use super::provider::{
    ExternalGitGateway, ExternalGitProviderError, ProviderListQuery, RemoteBranch,
    RemoteRepository, RepositoryOwner,
};
use crate::access::required_request_user_id;
use crate::app_state::AppState;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use uuid::Uuid;

#[derive(serde::Deserialize, Default, utoipa::ToSchema)]
pub(crate) struct ExternalGitListQuery {
    search: Option<String>,
    page: Option<u32>,
    per_page: Option<u32>,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ExternalGitRepositoryOwnerListResponse {
    owners: Vec<RepositoryOwner>,
    #[schema(required)]
    next_page: Option<u32>,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ExternalGitRepositoryListResponse {
    repositories: Vec<RemoteRepository>,
    #[schema(required)]
    next_page: Option<u32>,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ExternalGitBranchListResponse {
    branches: Vec<RemoteBranch>,
    #[schema(required)]
    next_page: Option<u32>,
}

fn provider_list_query(query: &ExternalGitListQuery) -> ProviderListQuery {
    ProviderListQuery {
        search: query
            .search
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        page: query.page.unwrap_or(1).max(1),
        per_page: query.per_page.unwrap_or(50).clamp(1, 100),
    }
}

pub(super) fn external_git_gateway_for_provider<'state>(
    state: &'state AppState,
    provider_id: &super::provider::ProviderInstanceId,
) -> Result<ExternalGitGateway<'state>, ApiError> {
    if state.external_git_providers.get(provider_id).is_none() {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::ExternalGitNotConfigured,
            "External Git provider is not configured",
        ));
    }
    Ok(state.external_git_gateway(provider_id))
}

pub(super) async fn external_git_branches_for_user(
    gateway: &ExternalGitGateway<'_>,
    user_id: Uuid,
    repository_id: &str,
    input: &ExternalGitListQuery,
) -> Result<ExternalGitBranchListResponse, ExternalGitProviderError> {
    let query = provider_list_query(input);
    let page = gateway
        .list_repository_branches(user_id, repository_id, &query)
        .await?;
    Ok(ExternalGitBranchListResponse {
        branches: page.items,
        next_page: page.next_page,
    })
}

pub(crate) async fn external_git_connection_status(
    State(state): State<AppState>,
    Path(provider_id): Path<super::provider::ProviderInstanceId>,
    headers: HeaderMap,
) -> axum::response::Response {
    let user_id = match required_request_user_id(&state.db, &headers).await {
        Ok(user_id) => user_id,
        Err(error) => return ApiError::from(error).into_response(),
    };
    let Some(provider) = state.external_git_providers.get(&provider_id) else {
        return ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::ExternalGitNotConfigured,
            "External Git provider is not configured",
        )
        .into_response();
    };
    match super::connection::external_git_connection_status(
        &state.db,
        user_id,
        ExternalGitProviderMetadata {
            provider_id,
            provider_name: provider.display_name().to_string(),
            base_url: provider.base_url().to_string(),
        },
    )
    .await
    {
        Ok(status) => Json(status).into_response(),
        Err(database_error) => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "Failed to read external Git connection",
        )
        .with_diagnostic("external Git grant lookup failed", database_error)
        .into_response(),
    }
}

pub(crate) async fn disconnect_external_git(
    State(state): State<AppState>,
    Path(provider_id): Path<super::provider::ProviderInstanceId>,
    headers: HeaderMap,
) -> axum::response::Response {
    let user_id = match required_request_user_id(&state.db, &headers).await {
        Ok(user_id) => user_id,
        Err(error) => return ApiError::from(error).into_response(),
    };
    match disconnect_external_git_account(&state.db, user_id, &provider_id).await {
        Ok(()) | Err(DisconnectExternalGitError::NotConnected) => {
            StatusCode::NO_CONTENT.into_response()
        }
        Err(DisconnectExternalGitError::LinkedProjects { .. }) => ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::ExternalGitConnectionInUse,
            "Unlink projects from this provider before disconnecting the account",
        )
        .into_response(),
        Err(DisconnectExternalGitError::LastLoginMethod) => ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::AuthLastLoginMethod,
            "Add another login method before disconnecting this provider",
        )
        .into_response(),
        Err(failure @ DisconnectExternalGitError::Persistence { .. }) => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "Failed to disconnect external Git account",
        )
        .with_diagnostic("external Git account disconnection failed", failure)
        .into_response(),
    }
}

pub(crate) async fn list_external_git_repository_owners(
    State(state): State<AppState>,
    Path(provider_id): Path<super::provider::ProviderInstanceId>,
    headers: HeaderMap,
    Query(input): Query<ExternalGitListQuery>,
) -> axum::response::Response {
    let user_id = match required_request_user_id(&state.db, &headers).await {
        Ok(user_id) => user_id,
        Err(error) => return ApiError::from(error).into_response(),
    };
    let query = provider_list_query(&input);
    let gateway = match external_git_gateway_for_provider(&state, &provider_id) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    match gateway.list_repository_owners(user_id, &query).await {
        Ok(page) => Json(ExternalGitRepositoryOwnerListResponse {
            owners: page.items,
            next_page: page.next_page,
        })
        .into_response(),
        Err(error) => external_git_provider_error(error).into_response(),
    }
}

pub(crate) async fn list_external_git_repositories(
    State(state): State<AppState>,
    Path(provider_id): Path<super::provider::ProviderInstanceId>,
    headers: HeaderMap,
    Query(input): Query<ExternalGitListQuery>,
) -> axum::response::Response {
    let user_id = match required_request_user_id(&state.db, &headers).await {
        Ok(user_id) => user_id,
        Err(error) => return ApiError::from(error).into_response(),
    };
    let query = provider_list_query(&input);
    let gateway = match external_git_gateway_for_provider(&state, &provider_id) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    match gateway.list_repositories(user_id, &query).await {
        Ok(page) => Json(ExternalGitRepositoryListResponse {
            repositories: page.items,
            next_page: page.next_page,
        })
        .into_response(),
        Err(error) => external_git_provider_error(error).into_response(),
    }
}

pub(crate) async fn list_external_git_repository_branches(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((provider_id, repository_id)): Path<(super::provider::ProviderInstanceId, String)>,
    Query(input): Query<ExternalGitListQuery>,
) -> axum::response::Response {
    let user_id = match required_request_user_id(&state.db, &headers).await {
        Ok(user_id) => user_id,
        Err(error) => return ApiError::from(error).into_response(),
    };
    let repository_id = repository_id.trim();
    if repository_id.is_empty() {
        return ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            ApiErrorCode::UnprocessableEntity,
            "Repository identifier is required",
        )
        .into_response();
    }
    let gateway = match external_git_gateway_for_provider(&state, &provider_id) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    match external_git_branches_for_user(&gateway, user_id, repository_id, &input).await {
        Ok(response) => Json(response).into_response(),
        Err(error) => external_git_provider_error(error).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_list_query_is_bounded() {
        let input = ExternalGitListQuery {
            page: Some(0),
            per_page: Some(500),
            search: None,
        };
        let query = provider_list_query(&input);
        assert_eq!(query.page, 1);
        assert_eq!(query.per_page, 100);
    }
}
