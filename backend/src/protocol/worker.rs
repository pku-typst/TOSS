//! Separately generated service contract for processing workers.

use crate::document_processing::worker_protocol::*;
use utoipa::openapi::security::{ApiKey, ApiKeyValue, Http, HttpAuthScheme, SecurityScheme};
use utoipa::OpenApi;

macro_rules! worker_json_operation {
    ($name:ident, $method:ident, $path:literal, $request:ty, $status:literal, $response:ty) => {
        #[utoipa::path(
            $method,
            path = $path,
            tag = "worker-lifecycle",
            request_body = $request,
            security(("worker_bearer" = [])),
            responses(
                (status = $status, description = "Successful response", body = $response),
                (status = "default", description = "Worker protocol error", body = WorkerApiErrorResponse)
            )
        )]
        #[allow(dead_code, reason = "contract marker consumed by the OpenAPI derive")]
        fn $name() {}
    };
}

macro_rules! worker_path_json_operation {
    ($name:ident, $method:ident, $path:literal, $parameter:literal, $request:ty, $status:literal, $response:ty) => {
        #[utoipa::path(
            $method,
            path = $path,
            tag = "worker-lifecycle",
            params(($parameter = uuid::Uuid, Path)),
            request_body = $request,
            security(("worker_bearer" = [])),
            responses(
                (status = $status, description = "Successful response", body = $response),
                (status = "default", description = "Worker protocol error", body = WorkerApiErrorResponse)
            )
        )]
        #[allow(dead_code, reason = "contract marker consumed by the OpenAPI derive")]
        fn $name() {}
    };
}

worker_json_operation!(
    create_worker_session,
    post,
    "/internal/v1/processing/worker-sessions",
    CreateWorkerSessionInput,
    201,
    WorkerSessionResponse
);
worker_path_json_operation!(
    heartbeat_worker_session,
    post,
    "/internal/v1/processing/worker-sessions/{session_id}/heartbeat",
    "session_id",
    WorkerSessionHeartbeatInput,
    200,
    WorkerSessionHeartbeatResponse
);

#[utoipa::path(
    delete,
    path = "/internal/v1/processing/worker-sessions/{session_id}",
    tag = "worker-lifecycle",
    params(("session_id" = uuid::Uuid, Path)),
    request_body = DrainWorkerSessionInput,
    security(("worker_bearer" = [])),
    responses(
        (status = 204, description = "Session is draining"),
        (status = "default", description = "Worker protocol error", body = WorkerApiErrorResponse)
    )
)]
#[allow(dead_code, reason = "contract marker consumed by the OpenAPI derive")]
fn drain_worker_session() {}

worker_json_operation!(
    acquire_worker_claims,
    post,
    "/internal/v1/processing/claims:acquire",
    AcquireClaimsInput,
    200,
    WorkerClaimsResponse
);
worker_path_json_operation!(
    heartbeat_worker_claim,
    post,
    "/internal/v1/processing/claims/{claim_id}/heartbeat",
    "claim_id",
    ClaimHeartbeatInput,
    200,
    ClaimHeartbeatResponse
);
worker_path_json_operation!(
    create_worker_artifact_ticket,
    post,
    "/internal/v1/processing/claims/{claim_id}/artifacts",
    "claim_id",
    CreateArtifactTicketInput,
    201,
    ArtifactTicketResponse
);
worker_path_json_operation!(
    complete_worker_claim,
    post,
    "/internal/v1/processing/claims/{claim_id}/complete",
    "claim_id",
    CompleteClaimInput,
    200,
    CompleteClaimResponse
);
worker_path_json_operation!(
    fail_worker_claim,
    post,
    "/internal/v1/processing/claims/{claim_id}/fail",
    "claim_id",
    FailClaimInput,
    200,
    ClaimMutationResponse
);
worker_path_json_operation!(
    release_worker_claim,
    post,
    "/internal/v1/processing/claims/{claim_id}/release",
    "claim_id",
    ReleaseClaimInput,
    200,
    ClaimMutationResponse
);

#[utoipa::path(
    get,
    path = "/internal/v1/processing/transfers/{transfer_id}",
    tag = "worker-transfers",
    params(("transfer_id" = uuid::Uuid, Path)),
    security(("transfer_capability" = [])),
    responses(
        (status = 200, description = "Transfer bytes", body = [u8], content_type = "application/octet-stream"),
        (status = "default", description = "Worker protocol error", body = WorkerApiErrorResponse)
    )
)]
#[allow(dead_code, reason = "contract marker consumed by the OpenAPI derive")]
fn download_worker_transfer() {}

#[utoipa::path(
    put,
    path = "/internal/v1/processing/transfers/{transfer_id}",
    tag = "worker-transfers",
    params(("transfer_id" = uuid::Uuid, Path)),
    request_body(content = Vec<u8>, content_type = "application/octet-stream"),
    security(("transfer_capability" = [])),
    responses(
        (status = 204, description = "Transfer accepted"),
        (status = "default", description = "Worker protocol error", body = WorkerApiErrorResponse)
    )
)]
#[allow(dead_code, reason = "contract marker consumed by the OpenAPI derive")]
fn upload_worker_transfer() {}

#[derive(OpenApi)]
#[openapi(
    info(
        title = "TOSS Document Processing Worker API",
        version = "1.0.0",
        description = "Authenticated pull, lease, and capability-transfer protocol for isolated document processors."
    ),
    paths(
        create_worker_session,
        heartbeat_worker_session,
        drain_worker_session,
        acquire_worker_claims,
        heartbeat_worker_claim,
        create_worker_artifact_ticket,
        complete_worker_claim,
        fail_worker_claim,
        release_worker_claim,
        download_worker_transfer,
        upload_worker_transfer
    ),
    components(schemas(
        WorkerApiErrorResponse,
        CreateWorkerSessionInput,
        WorkerProcessorAdvertisement,
        WorkerSessionResponse,
        WorkerSessionHeartbeatInput,
        WorkerProcessorHealth,
        WorkerSessionHeartbeatResponse,
        DrainWorkerSessionInput,
        AcquireClaimsInput,
        WorkerProcessorOffer,
        WorkerClaimsResponse,
        WorkerClaim,
        WorkerClaimInput,
        WorkerClaimLimits,
        ClaimHeartbeatInput,
        ClaimHeartbeatState,
        ClaimHeartbeatResponse,
        CreateArtifactTicketInput,
        ArtifactTicketResponse,
        CompleteClaimInput,
        CompletedArtifactInput,
        CompleteClaimResponse,
        WorkerFailureClass,
        FailClaimInput,
        ReleaseClaimInput,
        ClaimMutationResponse
    )),
    tags(
        (name = "worker-lifecycle"),
        (name = "worker-transfers")
    )
)]
struct WorkerApiDocument;

pub fn worker_openapi_document() -> utoipa::openapi::OpenApi {
    let mut document = WorkerApiDocument::openapi();
    if let Some(components) = document.components.as_mut() {
        components.add_security_scheme(
            "worker_bearer",
            SecurityScheme::Http(Http::new(HttpAuthScheme::Bearer)),
        );
        components.add_security_scheme(
            "transfer_capability",
            SecurityScheme::ApiKey(ApiKey::Header(ApiKeyValue::with_description(
                "Authorization",
                "ProcessingTransfer capability; never place it in a URL or log.",
            ))),
        );
    }
    document
}
