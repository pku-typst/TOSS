use super::ApiErrorResponse;
use crate::collaboration::RealtimeAuthResponse;

#[utoipa::path(
    get,
    path = "/v1/realtime/auth/{project_id}",
    tag = "collaboration",
    responses(
        (status = 200, description = "Successful response", body = RealtimeAuthResponse),
        (status = "default", description = "Error response", body = ApiErrorResponse)
    )
)]
#[allow(dead_code, reason = "contract marker consumed by the OpenAPI derive")]
pub(super) fn realtime_auth() {}

#[utoipa::path(
    get,
    path = "/v1/realtime/ws/{doc_id}",
    tag = "collaboration",
    responses(
        (status = 101, description = "Successful response"),
        (status = "default", description = "Error response", body = ApiErrorResponse)
    )
)]
#[allow(dead_code, reason = "contract marker consumed by the OpenAPI derive")]
pub(super) fn realtime_websocket() {}

#[utoipa::path(
    get,
    path = "/v1/realtime/projects/{project_id}",
    tag = "collaboration",
    responses(
        (status = 101, description = "Successful response"),
        (status = "default", description = "Error response", body = ApiErrorResponse)
    )
)]
#[allow(dead_code, reason = "contract marker consumed by the OpenAPI derive")]
pub(super) fn project_realtime_websocket() {}
