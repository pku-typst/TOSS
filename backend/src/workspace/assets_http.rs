//! HTTP transport for Workspace assets.

use super::file_policy::sanitize_project_path;
use super::http_error::project_service_unavailable;
use super::project_asset_deletion::{self, DeleteProjectAssetError};
use super::project_asset_upload::{self, UploadProjectAssetError};
use super::project_assets::{self, LoadProjectAssetError, ProjectAssetQueryError};
use super::ProjectAsset;
use crate::access::{ensure_project_access, AccessNeed};
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::collaboration::WorkspaceChange;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use base64::Engine;
use uuid::Uuid;

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ProjectAssetListResponse {
    pub assets: Vec<ProjectAsset>,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct UploadAssetInput {
    pub path: String,
    pub content_base64: String,
    pub content_type: Option<String>,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ProjectAssetContentResponse {
    pub asset: ProjectAsset,
    pub content_base64: String,
}

pub(crate) async fn list_project_assets(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<ProjectAssetListResponse>, ApiError> {
    ensure_project_access(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let assets = project_assets::list_project_assets(&state.db, project_id).await?;
    Ok(Json(ProjectAssetListResponse { assets }))
}

pub(crate) async fn upload_project_asset(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UploadAssetInput>,
) -> Result<Json<ProjectAsset>, ApiError> {
    let principal =
        ensure_project_access(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let actor = principal.user_id;
    let path = sanitize_project_path(&input.path)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(input.content_base64)
        .map_err(|_| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::ProjectAssetInvalid,
                "Project asset input is invalid",
            )
        })?;
    let record = project_asset_upload::upload_project_asset(
        &state.db,
        state.storage.as_ref(),
        project_asset_upload::UploadProjectAssetCommand {
            project_id,
            path,
            content_type: input
                .content_type
                .unwrap_or_else(|| "application/octet-stream".to_string()),
            bytes,
            actor_user_id: actor,
            guest_display_name: principal.guest_display_name,
        },
    )
    .await?;
    state
        .collaboration
        .workspace_changed(
            project_id,
            WorkspaceChange::Assets {
                path: Some(record.path.clone()),
            },
        )
        .await;
    record_event(
        &state.db,
        actor,
        "project.asset.upload",
        serde_json::json!({"project_id": project_id, "asset_id": record.id}),
    )
    .await;
    Ok(Json(record))
}

pub(crate) async fn get_project_asset(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, asset_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<ProjectAssetContentResponse>, ApiError> {
    ensure_project_access(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let loaded =
        project_assets::load_project_asset(&state.db, state.storage.as_ref(), project_id, asset_id)
            .await?;
    Ok(Json(ProjectAssetContentResponse {
        asset: loaded.asset,
        content_base64: base64::engine::general_purpose::STANDARD.encode(loaded.bytes),
    }))
}

pub(crate) async fn delete_project_asset(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, asset_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    let principal =
        ensure_project_access(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let actor = principal.user_id;
    project_asset_deletion::delete_project_asset(
        &state.db,
        state.storage.as_ref(),
        project_asset_deletion::DeleteProjectAssetCommand {
            project_id,
            asset_id,
            actor_user_id: actor,
            guest_display_name: principal.guest_display_name,
        },
    )
    .await?;
    state
        .collaboration
        .workspace_changed(project_id, WorkspaceChange::Assets { path: None })
        .await;
    record_event(
        &state.db,
        actor,
        "project.asset.delete",
        serde_json::json!({"project_id": project_id, "asset_id": asset_id}),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn get_project_asset_raw(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, asset_id)): Path<(Uuid, Uuid)>,
) -> Result<impl IntoResponse, ApiError> {
    ensure_project_access(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let loaded =
        project_assets::load_project_asset(&state.db, state.storage.as_ref(), project_id, asset_id)
            .await?;
    let mut response = axum::http::Response::new(Body::from(loaded.bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_str(&loaded.asset.content_type)
            .unwrap_or_else(|_| header::HeaderValue::from_static("application/octet-stream")),
    );
    Ok(response)
}

impl From<ProjectAssetQueryError> for ApiError {
    fn from(source: ProjectAssetQueryError) -> Self {
        project_service_unavailable(source)
    }
}

impl From<LoadProjectAssetError> for ApiError {
    fn from(source: LoadProjectAssetError) -> Self {
        match source {
            LoadProjectAssetError::AssetNotFound => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::ProjectAssetNotFound,
                "Project asset was not found",
            ),
            failure @ (LoadProjectAssetError::StorageUnavailable { .. }
            | LoadProjectAssetError::Storage { .. }
            | LoadProjectAssetError::Query(_)) => project_service_unavailable(failure),
        }
    }
}

impl From<UploadProjectAssetError> for ApiError {
    fn from(source: UploadProjectAssetError) -> Self {
        match source {
            UploadProjectAssetError::PayloadTooLarge => ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                ApiErrorCode::ProjectAssetTooLarge,
                "Project asset is too large",
            ),
            failure @ (UploadProjectAssetError::Storage { .. }
            | UploadProjectAssetError::Persistence(_)) => project_service_unavailable(failure),
        }
    }
}

impl From<DeleteProjectAssetError> for ApiError {
    fn from(source: DeleteProjectAssetError) -> Self {
        match source {
            DeleteProjectAssetError::AssetNotFound => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::ProjectAssetNotFound,
                "Project asset was not found",
            ),
            failure @ DeleteProjectAssetError::Persistence { .. } => {
                project_service_unavailable(failure)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_project_assets_have_a_semantic_not_found_response() {
        let error = ApiError::from(LoadProjectAssetError::AssetNotFound);

        assert_eq!(error.status(), StatusCode::NOT_FOUND);
        assert_eq!(error.code(), ApiErrorCode::ProjectAssetNotFound);
    }
}
