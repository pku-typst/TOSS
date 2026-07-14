//! HTTP transport for built-in template assets and instantiation.

use super::builtin_instantiation::instantiate_builtin_template;
use crate::access::required_request_user_id;
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use crate::workspace::{Project, ProjectName};
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct CreateBuiltinTemplateProjectInput {
    pub name: String,
}

pub(crate) async fn get_builtin_template_thumbnail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(template_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    required_request_user_id(&state.db, &headers).await?;
    let template = state
        .distribution
        .builtin_template(&template_id)
        .ok_or_else(template_not_found)?;
    let thumbnail = template.thumbnail.as_ref().ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::TemplateThumbnailNotFound,
            "Template thumbnail was not found",
        )
    })?;
    image_response(
        thumbnail.bytes.to_vec(),
        &thumbnail.content_type,
        "private, max-age=86400",
    )
}

pub(crate) async fn create_project_from_builtin_template(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(template_id): Path<String>,
    Json(input): Json<CreateBuiltinTemplateProjectInput>,
) -> Result<Json<Project>, ApiError> {
    let actor = required_request_user_id(&state.db, &headers).await?;
    let name = ProjectName::parse(&input.name)?;
    let template = state
        .distribution
        .builtin_template(&template_id)
        .ok_or_else(template_not_found)?;
    if !state
        .distribution
        .supports_project_type(template.project_type)
    {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            ApiErrorCode::ProjectTypeDisabled,
            "This project type is disabled in the current deployment",
        ));
    }
    let project = instantiate_builtin_template(
        &state.db,
        state.storage.as_ref(),
        &state.data_dir,
        actor,
        &name,
        template,
    )
    .await?;
    record_event(
        &state.db,
        Some(actor),
        "project.create_from_builtin_template",
        serde_json::json!({
            "project_id": project.id,
            "template_id": template.id,
            "name": name.as_str()
        }),
    )
    .await;
    Ok(Json(project))
}

fn template_not_found() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        ApiErrorCode::TemplateNotFound,
        "Template was not found",
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
                ApiErrorCode::TemplateThumbnailUnavailable,
                "Template thumbnail is unavailable",
            )
            .with_diagnostic("template thumbnail content type is invalid", source)
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
