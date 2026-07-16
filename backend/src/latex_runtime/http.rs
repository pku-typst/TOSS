use super::config::{cache_limits, CACHE_NAMESPACE};
use super::request::{parse_texlive_request, TexliveRequest, TexliveRequestError};
use super::resolution::{resolve, AssetResolution, TexliveAssetError};
use crate::access::authenticated_user_id;
use crate::app_state::AppState;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use crate::workspace::ProjectType;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum_extra::extract::cookie::CookieJar;

pub(crate) async fn latex_texlive_proxy(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Path(path): Path<String>,
) -> impl IntoResponse {
    if !state.distribution.supports_project_type(ProjectType::Latex) {
        return ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::NotFound,
            "LaTeX is disabled for this deployment",
        )
        .into_response();
    }
    if let Err(error) = authenticated_user_id(&state.db, &headers, &jar).await {
        return ApiError::from(error).into_response();
    }
    let request = match parse_texlive_request(&path) {
        Ok(request) => request,
        Err(TexliveRequestError::InvalidPath) => {
            return ApiError::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::BadRequest,
                "Invalid TeXLive path",
            )
            .into_response()
        }
        Err(TexliveRequestError::UnsupportedShape) => {
            return ApiError::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::BadRequest,
                "Unsupported TeXLive request path",
            )
            .into_response()
        }
    };
    let root = state.data_dir.join("texlive").join(CACHE_NAMESPACE);
    match resolve(&root, &request, cache_limits()).await {
        Ok(AssetResolution::Found(asset)) => asset_response(&request, asset),
        Ok(AssetResolution::Missing) => StatusCode::NOT_FOUND.into_response(),
        Err(failure) => asset_error_response(failure),
    }
}

fn asset_response(request: &TexliveRequest, bytes: Vec<u8>) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    let id_header = HeaderName::from_static("fileid");
    if let Ok(value) = HeaderValue::from_str(&request.filename) {
        headers.insert(id_header, value);
    }
    headers.insert(
        HeaderName::from_static("access-control-expose-headers"),
        HeaderValue::from_static("fileid"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=86400, stale-if-error=604800"),
    );
    (StatusCode::OK, headers, bytes).into_response()
}

fn asset_error_response(failure: TexliveAssetError) -> Response {
    match failure {
        failure @ TexliveAssetError::UpstreamPayloadTooLarge(_) => ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            ApiErrorCode::PayloadTooLarge,
            "TeXLive upstream response exceeds the configured limit",
        )
        .with_warning(
            "TeXLive upstream payload exceeded its configured limit",
            failure,
        )
        .into_response(),
        failure @ TexliveAssetError::UpstreamUnavailable(_) => ApiError::new(
            StatusCode::BAD_GATEWAY,
            ApiErrorCode::BadGateway,
            "TeXLive upstream is unavailable",
        )
        .with_warning("TeXLive upstream resolution failed", failure)
        .into_response(),
        failure @ TexliveAssetError::InvalidConfiguration(_) => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "TeXLive upstream configuration is invalid",
        )
        .with_diagnostic("LaTeX upstream configuration is invalid", failure)
        .into_response(),
        failure @ (TexliveAssetError::CacheUnavailable(_)
        | TexliveAssetError::HttpClientUnavailable(_)) => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "TeXLive cache is unavailable",
        )
        .with_diagnostic("LaTeX asset resolution failed", failure)
        .into_response(),
    }
}
