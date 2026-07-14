//! HTTP transport for template gallery discovery.

use super::gallery_listing::{self, TemplateGalleryItem};
use crate::access::required_request_user_id;
use crate::app_state::AppState;
use crate::http_response::ApiError;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct TemplateGalleryResponse {
    pub templates: Vec<TemplateGalleryItem>,
}

pub(crate) async fn list_template_gallery(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<TemplateGalleryResponse>, ApiError> {
    let actor = required_request_user_id(&state.db, &headers).await?;
    let templates =
        gallery_listing::list_template_gallery(&state.db, &state.distribution, actor).await?;
    Ok(Json(TemplateGalleryResponse { templates }))
}
