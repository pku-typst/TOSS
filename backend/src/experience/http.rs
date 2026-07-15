use super::content::{load_experience, load_help_content, Experience, HelpContent};
use crate::access::request_user_id;
use crate::app_state::AppState;
use crate::distribution::ProductAsset;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use axum::Json;

fn request_variant_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        header::VARY,
        HeaderValue::from_static("cookie, authorization"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers
}

fn product_asset_response(asset: &ProductAsset) -> (HeaderMap, Vec<u8>) {
    let mut headers = HeaderMap::new();
    if let Ok(content_type) = HeaderValue::from_str(&asset.content_type) {
        headers.insert(header::CONTENT_TYPE, content_type);
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    (headers, asset.bytes.as_ref().to_vec())
}

pub(crate) async fn experience_config(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<Experience>), ApiError> {
    let authenticated = request_user_id(&state.db, &headers).await?.is_some();
    Ok((
        request_variant_headers(),
        Json(load_experience(&state.distribution, authenticated)),
    ))
}

pub(crate) async fn help_content(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<HelpContent>), ApiError> {
    let authenticated = request_user_id(&state.db, &headers).await?.is_some();
    let configured_processing_operations = state.processing.configured_operations();
    Ok((
        request_variant_headers(),
        Json(load_help_content(
            &state.distribution,
            &state.frontend_features,
            &configured_processing_operations,
            authenticated,
        )),
    ))
}

pub(crate) async fn product_favicon(State(state): State<AppState>) -> impl IntoResponse {
    product_asset_response(&state.distribution.product.favicon)
}

pub(crate) async fn product_touch_icon(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .distribution
        .product
        .touch_icon
        .as_ref()
        .map(product_asset_response)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::NotFound,
                "Touch icon is not configured",
            )
        })
}

pub(crate) async fn spa_index(State(state): State<AppState>) -> impl IntoResponse {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    (headers, state.spa_index_html.as_ref().to_vec())
}
