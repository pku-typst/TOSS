//! HTTP transport for Workspace project thumbnails.

use super::project_thumbnail::{
    load_project_thumbnail, project_thumbnail_is_readable, store_project_thumbnail,
    CheckProjectThumbnailReadabilityError, LoadProjectThumbnailError, StoreProjectThumbnailError,
};
use crate::access::{ensure_project_role, required_request_user_id, AccessNeed};
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use chrono::Utc;
use uuid::Uuid;

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct UploadProjectThumbnailInput {
    pub content_base64: String,
    pub content_type: Option<String>,
}

pub(crate) async fn upload_project_thumbnail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UploadProjectThumbnailInput>,
) -> Result<StatusCode, ApiError> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        input.content_base64,
    )
    .map_err(|_| thumbnail_invalid())?;
    if bytes.is_empty() {
        return Err(thumbnail_invalid());
    }
    let content_type = input
        .content_type
        .unwrap_or_else(|| "image/png".to_string())
        .trim()
        .parse::<mime::Mime>()
        .ok()
        .filter(|content_type| content_type.type_() == mime::IMAGE)
        .ok_or_else(thumbnail_invalid)?
        .to_string();
    store_project_thumbnail(
        &state.db,
        &state.data_dir,
        project_id,
        &content_type,
        actor,
        Utc::now(),
        &bytes,
    )
    .await?;
    record_event(
        &state.db,
        Some(actor),
        "project.thumbnail.upload",
        serde_json::json!({ "project_id": project_id }),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn get_project_thumbnail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<impl IntoResponse, ApiError> {
    let actor = required_request_user_id(&state.db, &headers).await?;
    if !project_thumbnail_is_readable(&state.db, actor, project_id).await? {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            ApiErrorCode::ProjectAccessForbidden,
            "Project access is forbidden",
        ));
    }
    let thumbnail = load_project_thumbnail(&state.db, &state.data_dir, project_id)
        .await?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::ProjectThumbnailNotFound,
                "Project thumbnail was not found",
            )
        })?;
    image_response(
        thumbnail.bytes,
        &thumbnail.content_type,
        "private, max-age=60",
    )
}

fn thumbnail_invalid() -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        ApiErrorCode::ProjectThumbnailInvalid,
        "Project thumbnail input is invalid",
    )
}

fn image_response(
    bytes: Vec<u8>,
    content_type: &str,
    cache_control: &'static str,
) -> Result<axum::http::Response<Body>, ApiError> {
    let mut response = axum::http::Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_str(content_type).map_err(|source| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::ProjectThumbnailUnavailable,
                "Project thumbnail is unavailable",
            )
            .with_diagnostic("project thumbnail content type is invalid", source)
        })?,
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static(cache_control),
    );
    response.headers_mut().insert(
        header::VARY,
        header::HeaderValue::from_static("cookie, authorization"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        header::HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}

impl From<CheckProjectThumbnailReadabilityError> for ApiError {
    fn from(source: CheckProjectThumbnailReadabilityError) -> Self {
        thumbnail_unavailable(source)
    }
}

impl From<LoadProjectThumbnailError> for ApiError {
    fn from(source: LoadProjectThumbnailError) -> Self {
        thumbnail_unavailable(source)
    }
}

impl From<StoreProjectThumbnailError> for ApiError {
    fn from(source: StoreProjectThumbnailError) -> Self {
        thumbnail_unavailable(source)
    }
}

fn thumbnail_unavailable(source: impl std::fmt::Debug + Send + Sync + 'static) -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        ApiErrorCode::ProjectThumbnailUnavailable,
        "Project thumbnail service is unavailable",
    )
    .with_diagnostic("project thumbnail service failed", source)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_project_thumbnails_have_a_workspace_owned_error_code() {
        let error = thumbnail_invalid();

        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
        assert_eq!(error.code(), ApiErrorCode::ProjectThumbnailInvalid);
    }
}
