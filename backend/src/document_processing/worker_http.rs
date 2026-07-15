//! Authenticated internal HTTP edge for capability workers.

use super::config::AuthenticatedWorker;
use super::worker_idempotency::{
    begin_worker_request, StoredWorkerResponse, WorkerRequestError, WorkerRequestStart,
};
use super::worker_persistence::{
    complete_claim, create_artifact_transfer, download_transfer, drain_session, fail_claim,
    heartbeat_claim, heartbeat_session, register_session, release_claim, transfer_token, try_claim,
    upload_transfer, ArtifactTransferRequest, ClaimError, ClaimMutationOutcome,
    CompleteClaimOutcome, ProcessorCapacityOffer, TransferDownloadOutcome, TransferUploadOutcome,
    WorkerSessionError,
};
use super::worker_protocol::{
    AcquireClaimsInput, ArtifactTicketResponse, ClaimHeartbeatInput, ClaimMutationResponse,
    CompleteClaimInput, CompleteClaimResponse, CreateArtifactTicketInput, CreateWorkerSessionInput,
    DrainWorkerSessionInput, FailClaimInput, ReleaseClaimInput, WorkerApiErrorResponse,
    WorkerClaimsResponse, WorkerSessionHeartbeatInput, WorkerSessionHeartbeatResponse,
    WorkerSessionResponse, WORKER_PROTOCOL_VERSION,
};
use crate::app_state::AppState;
use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::Utc;
use serde::Serialize;
use std::collections::HashSet;
use std::future::Future;
use std::time::{Duration, Instant};
use uuid::Uuid;

const HEARTBEAT_INTERVAL_SECONDS: i64 = 15;
const MAX_LONG_POLL_SECONDS: u32 = 20;
const MAX_OFFERED_SLOTS_PER_REQUEST: u32 = 16;
const MAX_PROCESSOR_OFFERS_PER_REQUEST: usize = 16;
const MAX_FAILURE_CODE_BYTES: usize = 96;
const MAX_FILENAME_BYTES: usize = 160;

#[derive(Debug)]
pub(crate) struct WorkerApiError {
    status: StatusCode,
    code: &'static str,
    message: &'static str,
}

impl WorkerApiError {
    const fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
        }
    }

    fn persistence(context: &'static str, error: impl std::fmt::Debug) -> Self {
        tracing::error!(context, error = ?error, "processing worker request failed");
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "processing_service_unavailable",
            "Document processing is temporarily unavailable",
        )
    }
}

impl IntoResponse for WorkerApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(WorkerApiErrorResponse {
                code: self.code,
                message: self.message,
            }),
        )
            .into_response()
    }
}

pub(crate) async fn create_worker_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateWorkerSessionInput>,
) -> Result<Response, WorkerApiError> {
    let worker = authenticate(&state, &headers)?;
    require_request_id(input.request_id)?;
    if !input.protocol_versions.contains(&WORKER_PROTOCOL_VERSION) {
        return Err(WorkerApiError::new(
            StatusCode::BAD_REQUEST,
            "worker_protocol_unsupported",
            "No supported worker protocol version was offered",
        ));
    }
    if input.processors.iter().any(|processor| {
        !state
            .distribution
            .supports_processing_operation(processor.operation)
    }) {
        return Err(WorkerApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "processor_scope_mismatch",
            "A processor is disabled by this distribution",
        ));
    }
    with_worker_request(
        &state,
        &worker,
        input.request_id,
        "POST /internal/v1/processing/worker-sessions".to_string(),
        &input,
        || async {
            let session = register_session(
                &state.db,
                &worker,
                &input.worker_instance,
                &input.processors,
                &state.processing.config,
            )
            .await
            .map_err(session_error)?;
            WorkerMutationOutput::json(
                StatusCode::CREATED,
                &WorkerSessionResponse {
                    session_id: session.id,
                    protocol_version: WORKER_PROTOCOL_VERSION,
                    server_time: Utc::now(),
                    heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS,
                    max_long_poll_seconds: MAX_LONG_POLL_SECONDS,
                },
            )
        },
    )
    .await
}

pub(crate) async fn heartbeat_worker_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<Uuid>,
    Json(input): Json<WorkerSessionHeartbeatInput>,
) -> Result<Response, WorkerApiError> {
    let worker = authenticate(&state, &headers)?;
    require_request_id(input.request_id)?;
    with_worker_request(
        &state,
        &worker,
        input.request_id,
        format!("POST /internal/v1/processing/worker-sessions/{session_id}/heartbeat"),
        &input,
        || async {
            let processors = input
                .processors
                .iter()
                .map(|processor| {
                    (
                        processor.operation,
                        processor.processor_contract.clone(),
                        processor.healthy,
                    )
                })
                .collect::<Vec<_>>();
            let expires_at = heartbeat_session(
                &state.db,
                &worker,
                session_id,
                &processors,
                &state.processing.config,
            )
            .await
            .map_err(session_error)?;
            WorkerMutationOutput::json(
                StatusCode::OK,
                &WorkerSessionHeartbeatResponse {
                    server_time: Utc::now(),
                    expires_at,
                },
            )
        },
    )
    .await
}

pub(crate) async fn drain_worker_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<Uuid>,
    Json(input): Json<DrainWorkerSessionInput>,
) -> Result<Response, WorkerApiError> {
    let worker = authenticate(&state, &headers)?;
    require_request_id(input.request_id)?;
    with_worker_request(
        &state,
        &worker,
        input.request_id,
        format!("DELETE /internal/v1/processing/worker-sessions/{session_id}"),
        &input,
        || async {
            drain_session(&state.db, &worker, session_id)
                .await
                .map_err(session_error)?;
            Ok(WorkerMutationOutput::empty(StatusCode::NO_CONTENT))
        },
    )
    .await
}

pub(crate) async fn acquire_worker_claims(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<AcquireClaimsInput>,
) -> Result<Response, WorkerApiError> {
    let worker = authenticate(&state, &headers)?;
    require_request_id(input.request_id)?;
    let offers = validate_capacity_offers(&worker, &input)?;
    if input.wait_seconds > MAX_LONG_POLL_SECONDS {
        return Err(invalid_request(
            "wait_seconds exceeds the negotiated maximum",
        ));
    }
    with_worker_request(
        &state,
        &worker,
        input.request_id,
        "POST /internal/v1/processing/claims:acquire".to_string(),
        &input,
        || async {
            let deadline = Instant::now() + Duration::from_secs(u64::from(input.wait_seconds));
            // Commit at most one claim per request so a later failure cannot strand
            // an earlier member of a partially built response. Offers remain upper
            // bounds; agents immediately poll again with their remaining permits.
            let mut claims = Vec::with_capacity(1);
            loop {
                if let Some(claim) = try_claim(
                    &state.db,
                    &worker,
                    input.session_id,
                    &offers,
                    &state.processing.config,
                )
                .await
                .map_err(claim_error)?
                {
                    claims.push(claim);
                }
                if !claims.is_empty() || Instant::now() >= deadline {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            if claims.is_empty() {
                Ok(WorkerMutationOutput::empty(StatusCode::NO_CONTENT))
            } else {
                WorkerMutationOutput::json(StatusCode::OK, &WorkerClaimsResponse { claims })
            }
        },
    )
    .await
}

fn validate_capacity_offers(
    worker: &AuthenticatedWorker,
    input: &AcquireClaimsInput,
) -> Result<Vec<ProcessorCapacityOffer>, WorkerApiError> {
    if input.offers.is_empty() || input.offers.len() > MAX_PROCESSOR_OFFERS_PER_REQUEST {
        return Err(invalid_request(
            "processor offers are outside the supported range",
        ));
    }
    let mut unique = HashSet::new();
    let mut total_slots = 0_u32;
    let mut offers = Vec::with_capacity(input.offers.len());
    for offer in &input.offers {
        total_slots = total_slots
            .checked_add(offer.slots)
            .ok_or_else(|| invalid_request("offered slots exceed the supported range"))?;
        if offer.slots == 0
            || total_slots > MAX_OFFERED_SLOTS_PER_REQUEST
            || !worker.approves(offer.operation, &offer.processor_contract)
            || !unique.insert((offer.operation, offer.processor_contract.as_str()))
        {
            return Err(invalid_request("processor offer is invalid"));
        }
        let slots = i32::try_from(offer.slots)
            .map_err(|_| invalid_request("offered slots exceed the supported range"))?;
        offers.push(ProcessorCapacityOffer {
            operation: offer.operation,
            processor_contract: offer.processor_contract.clone(),
            slots,
        });
    }
    Ok(offers)
}

pub(crate) async fn heartbeat_worker_claim(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(claim_id): Path<Uuid>,
    Json(input): Json<ClaimHeartbeatInput>,
) -> Result<Response, WorkerApiError> {
    let worker = authenticate(&state, &headers)?;
    require_request_id(input.request_id)?;
    with_worker_request(
        &state,
        &worker,
        input.request_id,
        format!("POST /internal/v1/processing/claims/{claim_id}/heartbeat"),
        &input,
        || async {
            let response = heartbeat_claim(
                &state.db,
                &worker,
                input.session_id,
                claim_id,
                input.phase,
                &state.processing.config,
            )
            .await
            .map_err(claim_error)?;
            WorkerMutationOutput::json(StatusCode::OK, &response)
        },
    )
    .await
}

pub(crate) async fn create_worker_artifact_ticket(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(claim_id): Path<Uuid>,
    Json(input): Json<CreateArtifactTicketInput>,
) -> Result<Response, WorkerApiError> {
    let worker = authenticate(&state, &headers)?;
    require_request_id(input.request_id)?;
    validate_artifact_declaration(&input, &state)?;
    let digest = super::worker_persistence::decode_sha256(&input.sha256)
        .ok_or_else(|| invalid_request("sha256 must be a 32-byte hexadecimal digest"))?;
    with_worker_request(
        &state,
        &worker,
        input.request_id,
        format!("POST /internal/v1/processing/claims/{claim_id}/artifacts"),
        &input,
        || async {
            let transfer = create_artifact_transfer(
                &state.db,
                &worker,
                &ArtifactTransferRequest {
                    session_id: input.session_id,
                    claim_id,
                    role: &input.role,
                    media_type: &input.media_type,
                    filename: &input.filename,
                    size_bytes: input.size_bytes,
                    expected_sha256: &digest,
                },
                &state.processing.config,
            )
            .await
            .map_err(claim_error)?;
            WorkerMutationOutput::json(
                StatusCode::CREATED,
                &ArtifactTicketResponse {
                    transfer_id: transfer.id,
                    upload_url: format!("/internal/v1/processing/transfers/{}", transfer.id),
                    upload_token: transfer.token,
                    expires_at: transfer.expires_at,
                },
            )
        },
    )
    .await
}

pub(crate) async fn complete_worker_claim(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(claim_id): Path<Uuid>,
    Json(input): Json<CompleteClaimInput>,
) -> Result<Response, WorkerApiError> {
    let worker = authenticate(&state, &headers)?;
    require_request_id(input.request_id)?;
    if serde_json::to_vec(&input.metadata).map_or(true, |bytes| bytes.len() > 16 * 1024) {
        return Err(invalid_request("completion metadata is too large"));
    }
    with_worker_request(
        &state,
        &worker,
        input.request_id,
        format!("POST /internal/v1/processing/claims/{claim_id}/complete"),
        &input,
        || async {
            match complete_claim(
                &state.db,
                &worker,
                input.session_id,
                claim_id,
                &input.artifacts,
            )
            .await
            .map_err(claim_error)?
            {
                CompleteClaimOutcome::Accepted { job_id } => WorkerMutationOutput::json(
                    StatusCode::OK,
                    &CompleteClaimResponse {
                        job_id,
                        state: "finalizing",
                    },
                ),
                CompleteClaimOutcome::Lost => Err(claim_lost()),
                CompleteClaimOutcome::Cancelled => Err(WorkerApiError::new(
                    StatusCode::CONFLICT,
                    "cancellation_requested",
                    "The job was cancelled before delivery was accepted",
                )),
                CompleteClaimOutcome::Invalid => Err(WorkerApiError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "artifact_rejected",
                    "The staged artifact set does not match the operation contract",
                )),
            }
        },
    )
    .await
}

pub(crate) async fn fail_worker_claim(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(claim_id): Path<Uuid>,
    Json(input): Json<FailClaimInput>,
) -> Result<Response, WorkerApiError> {
    let worker = authenticate(&state, &headers)?;
    require_request_id(input.request_id)?;
    validate_failure(&input.code, &input.message, &state)?;
    with_worker_request(
        &state,
        &worker,
        input.request_id,
        format!("POST /internal/v1/processing/claims/{claim_id}/fail"),
        &input,
        || async {
            let outcome = fail_claim(
                &state.db,
                &worker,
                input.session_id,
                claim_id,
                input.class,
                &input.code,
                &input.message,
            )
            .await
            .map_err(claim_error)?;
            WorkerMutationOutput::json(StatusCode::OK, &mutation_response(outcome)?)
        },
    )
    .await
}

pub(crate) async fn release_worker_claim(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(claim_id): Path<Uuid>,
    Json(input): Json<ReleaseClaimInput>,
) -> Result<Response, WorkerApiError> {
    let worker = authenticate(&state, &headers)?;
    require_request_id(input.request_id)?;
    if input
        .reason
        .as_ref()
        .is_some_and(|reason| reason.len() > 256)
    {
        return Err(invalid_request("release reason is too large"));
    }
    with_worker_request(
        &state,
        &worker,
        input.request_id,
        format!("POST /internal/v1/processing/claims/{claim_id}/release"),
        &input,
        || async {
            let outcome = release_claim(&state.db, &worker, input.session_id, claim_id)
                .await
                .map_err(claim_error)?;
            WorkerMutationOutput::json(StatusCode::OK, &mutation_response(outcome)?)
        },
    )
    .await
}

pub(crate) async fn download_worker_transfer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(transfer_id): Path<Uuid>,
) -> Result<Response, WorkerApiError> {
    let token = transfer_token(&headers).ok_or_else(transfer_auth_error)?;
    match download_transfer(&state.db, transfer_id, token)
        .await
        .map_err(|error| WorkerApiError::persistence("download transfer", error))?
    {
        TransferDownloadOutcome::Content {
            content,
            media_type,
            sha256,
        } => {
            let mut response = Response::new(Body::from(content));
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_str(&media_type).map_err(|_| {
                    WorkerApiError::new(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "invalid_transfer_metadata",
                        "Transfer metadata is invalid",
                    )
                })?,
            );
            response.headers_mut().insert(
                "x-content-sha256",
                HeaderValue::from_str(&hex::encode(sha256)).map_err(|_| {
                    WorkerApiError::new(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "invalid_transfer_metadata",
                        "Transfer metadata is invalid",
                    )
                })?,
            );
            Ok(response)
        }
        TransferDownloadOutcome::Rejected => Err(transfer_rejected()),
    }
}

pub(crate) async fn upload_worker_transfer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(transfer_id): Path<Uuid>,
    body: Bytes,
) -> Result<Response, WorkerApiError> {
    let token = transfer_token(&headers).ok_or_else(transfer_auth_error)?;
    match upload_transfer(&state.db, transfer_id, token, &body)
        .await
        .map_err(|error| WorkerApiError::persistence("upload transfer", error))?
    {
        TransferUploadOutcome::Stored { size_bytes, sha256 } => {
            let mut response = StatusCode::NO_CONTENT.into_response();
            response.headers_mut().insert(
                "x-content-size",
                HeaderValue::from_str(&size_bytes.to_string()).map_err(|_| {
                    WorkerApiError::new(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "invalid_transfer_metadata",
                        "Transfer metadata is invalid",
                    )
                })?,
            );
            response.headers_mut().insert(
                "x-content-sha256",
                HeaderValue::from_str(&hex::encode(sha256)).map_err(|_| {
                    WorkerApiError::new(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "invalid_transfer_metadata",
                        "Transfer metadata is invalid",
                    )
                })?,
            );
            Ok(response)
        }
        TransferUploadOutcome::Rejected => Err(transfer_rejected()),
        TransferUploadOutcome::TooLarge => Err(WorkerApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "transfer_size_mismatch",
            "Transfer content does not match the declared size",
        )),
        TransferUploadOutcome::DigestMismatch => Err(WorkerApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "transfer_digest_mismatch",
            "Transfer content does not match the declared digest",
        )),
    }
}

fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<AuthenticatedWorker, WorkerApiError> {
    state
        .processing
        .config
        .authenticate(headers)
        .ok_or_else(|| {
            WorkerApiError::new(
                StatusCode::UNAUTHORIZED,
                "worker_authentication_required",
                "A valid worker credential is required",
            )
        })
}

struct WorkerMutationOutput {
    status: StatusCode,
    body: Option<serde_json::Value>,
}

impl WorkerMutationOutput {
    const fn empty(status: StatusCode) -> Self {
        Self { status, body: None }
    }

    fn json<T: Serialize>(status: StatusCode, body: &T) -> Result<Self, WorkerApiError> {
        let body = serde_json::to_value(body).map_err(|error| {
            WorkerApiError::persistence("serialize worker replay response", error)
        })?;
        Ok(Self {
            status,
            body: Some(body),
        })
    }

    fn into_response(self) -> Response {
        match self.body {
            Some(body) => (self.status, Json(body)).into_response(),
            None => self.status.into_response(),
        }
    }
}

async fn with_worker_request<T, F, Fut>(
    state: &AppState,
    worker: &AuthenticatedWorker,
    request_id: Uuid,
    route_key: String,
    input: &T,
    action: F,
) -> Result<Response, WorkerApiError>
where
    T: Serialize,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<WorkerMutationOutput, WorkerApiError>>,
{
    let reservation =
        begin_worker_request(&state.db, &worker.identity, request_id, route_key, input)
            .await
            .map_err(worker_request_error)?;
    let reservation = match reservation {
        WorkerRequestStart::Replay(response) => return replay_response(response),
        WorkerRequestStart::InProgress => return Err(worker_request_in_progress()),
        WorkerRequestStart::Execute(reservation) => reservation,
    };
    match action().await {
        Ok(output) => {
            reservation
                .finish(output.status.as_u16(), output.body.clone())
                .await
                .map_err(worker_request_error)?;
            Ok(output.into_response())
        }
        Err(error) if error.status.is_server_error() => {
            // Persistence actions are transactional: a returned 5xx has no domain
            // response to replay. Remove the reservation so the SDK can retry the
            // same ID. A process crash instead leaves the bounded pending fence,
            // covering the ambiguous commit window.
            reservation.abort().await.map_err(worker_request_error)?;
            Err(error)
        }
        Err(error) => {
            let body = serde_json::to_value(WorkerApiErrorResponse {
                code: error.code,
                message: error.message,
            })
            .map_err(|serialization_error| {
                WorkerApiError::persistence("serialize worker replay error", serialization_error)
            })?;
            reservation
                .finish(error.status.as_u16(), Some(body))
                .await
                .map_err(worker_request_error)?;
            Err(error)
        }
    }
}

fn replay_response(stored: StoredWorkerResponse) -> Result<Response, WorkerApiError> {
    let status = StatusCode::from_u16(stored.status).map_err(|_| {
        WorkerApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "processing_service_unavailable",
            "Document processing is temporarily unavailable",
        )
    })?;
    Ok(match stored.body {
        Some(body) => (status, Json(body)).into_response(),
        None => status.into_response(),
    })
}

fn worker_request_error(error: WorkerRequestError) -> WorkerApiError {
    match error {
        WorkerRequestError::Conflict => WorkerApiError::new(
            StatusCode::CONFLICT,
            "worker_request_id_conflict",
            "The request identifier was already used for another worker mutation",
        ),
        WorkerRequestError::Persistence(error) => {
            WorkerApiError::persistence("worker request replay persistence", error)
        }
        WorkerRequestError::Serialization(error) => {
            WorkerApiError::persistence("worker request serialization", error)
        }
    }
}

fn require_request_id(request_id: Uuid) -> Result<(), WorkerApiError> {
    if request_id.is_nil() {
        Err(invalid_request("request_id must not be nil"))
    } else {
        Ok(())
    }
}

fn validate_artifact_declaration(
    input: &CreateArtifactTicketInput,
    state: &AppState,
) -> Result<(), WorkerApiError> {
    if input.filename.is_empty()
        || input.filename.len() > MAX_FILENAME_BYTES
        || input.filename == "."
        || input.filename == ".."
        || input
            .filename
            .bytes()
            .any(|byte| byte == b'/' || byte == b'\\' || byte == 0)
    {
        return Err(invalid_request("filename is not a safe artifact basename"));
    }
    let limit = match (input.role.as_str(), input.media_type.as_str()) {
        ("pdf", "application/pdf") if input.filename.ends_with(".pdf") => {
            state.processing.config.max_output_bytes
        }
        ("log", "text/plain") if input.filename.ends_with(".log") => {
            state.processing.config.max_diagnostic_bytes
        }
        _ => {
            return Err(WorkerApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "artifact_rejected",
                "Artifact role, media type, or filename is not allowed",
            ))
        }
    };
    if input.size_bytes <= 0 || input.size_bytes > limit {
        return Err(WorkerApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "artifact_too_large",
            "Artifact size is outside the operation limit",
        ));
    }
    Ok(())
}

fn validate_failure(code: &str, message: &str, state: &AppState) -> Result<(), WorkerApiError> {
    if code.is_empty()
        || code.len() > MAX_FAILURE_CODE_BYTES
        || !code
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err(invalid_request(
            "failure code must be a lowercase identifier",
        ));
    }
    if message.is_empty()
        || i64::try_from(message.len()).map_or(true, |size| {
            size > state.processing.config.max_diagnostic_bytes
        })
    {
        return Err(invalid_request(
            "failure message is outside the diagnostic limit",
        ));
    }
    Ok(())
}

fn mutation_response(
    outcome: ClaimMutationOutcome,
) -> Result<ClaimMutationResponse, WorkerApiError> {
    match outcome {
        ClaimMutationOutcome::Updated { job_id, state } => Ok(ClaimMutationResponse {
            job_id,
            state: state.to_string(),
        }),
        ClaimMutationOutcome::Lost => Err(claim_lost()),
    }
}

fn session_error(error: WorkerSessionError) -> WorkerApiError {
    match error {
        WorkerSessionError::NotFound => WorkerApiError::new(
            StatusCode::NOT_FOUND,
            "worker_session_not_found",
            "Worker session was not found",
        ),
        WorkerSessionError::Expired => WorkerApiError::new(
            StatusCode::CONFLICT,
            "worker_session_expired",
            "Worker session has expired",
        ),
        WorkerSessionError::Draining => WorkerApiError::new(
            StatusCode::CONFLICT,
            "worker_session_draining",
            "Worker session is draining",
        ),
        WorkerSessionError::Invalid => invalid_request("Worker session payload is invalid"),
        WorkerSessionError::Persistence(error) => {
            WorkerApiError::persistence("worker session persistence", error)
        }
    }
}

fn claim_error(error: ClaimError) -> WorkerApiError {
    match error {
        ClaimError::SessionUnavailable => WorkerApiError::new(
            StatusCode::CONFLICT,
            "worker_session_unavailable",
            "Worker session is unavailable",
        ),
        ClaimError::Lost => claim_lost(),
        ClaimError::Invalid => invalid_request("Worker claim payload is invalid"),
        ClaimError::Persistence(error) => {
            WorkerApiError::persistence("worker claim persistence", error)
        }
    }
}

const fn invalid_request(message: &'static str) -> WorkerApiError {
    WorkerApiError::new(StatusCode::BAD_REQUEST, "worker_request_invalid", message)
}

const fn claim_lost() -> WorkerApiError {
    WorkerApiError::new(
        StatusCode::CONFLICT,
        "claim_lost",
        "The claim is no longer current",
    )
}

const fn worker_request_in_progress() -> WorkerApiError {
    WorkerApiError::new(
        StatusCode::CONFLICT,
        "worker_request_in_progress",
        "The worker mutation is still being processed",
    )
}

const fn transfer_auth_error() -> WorkerApiError {
    WorkerApiError::new(
        StatusCode::UNAUTHORIZED,
        "transfer_authorization_required",
        "A valid transfer capability is required",
    )
}

const fn transfer_rejected() -> WorkerApiError {
    WorkerApiError::new(
        StatusCode::GONE,
        "transfer_rejected",
        "The transfer capability is invalid, expired, or no longer current",
    )
}
