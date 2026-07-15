//! Generated-shape wire values for worker protocol v1.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Serialize)]
pub struct CreateWorkerSessionInput {
    pub request_id: Uuid,
    pub worker_instance: String,
    pub protocol_versions: Vec<u32>,
    pub processors: Vec<WorkerProcessorAdvertisement>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct WorkerProcessorAdvertisement {
    pub operation: String,
    pub processor_contract: String,
    pub runtime_version: String,
    pub slots: i32,
}

#[derive(Deserialize)]
pub struct WorkerSessionResponse {
    pub session_id: Uuid,
    pub protocol_version: u32,
    pub server_time: DateTime<Utc>,
    pub heartbeat_interval_seconds: i64,
    pub max_long_poll_seconds: u32,
}

#[derive(Serialize)]
pub struct WorkerSessionHeartbeatInput {
    pub request_id: Uuid,
    pub processors: Vec<WorkerProcessorHealth>,
}

#[derive(Serialize)]
pub struct WorkerProcessorHealth {
    pub operation: String,
    pub processor_contract: String,
    pub healthy: bool,
}

#[derive(Deserialize)]
pub struct WorkerSessionHeartbeatResponse {
    pub server_time: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct DrainWorkerSessionInput {
    pub request_id: Uuid,
}

#[derive(Serialize)]
pub struct AcquireClaimsInput {
    pub request_id: Uuid,
    pub session_id: Uuid,
    pub offers: Vec<WorkerProcessorOffer>,
    pub wait_seconds: u32,
}

#[derive(Serialize)]
pub struct WorkerProcessorOffer {
    pub operation: String,
    pub processor_contract: String,
    pub slots: u32,
}

#[derive(Deserialize)]
pub struct WorkerClaimsResponse {
    pub claims: Vec<WorkerClaim>,
}

#[derive(Clone, Deserialize)]
pub struct WorkerClaim {
    pub job_id: Uuid,
    pub attempt: i32,
    pub claim_id: Uuid,
    pub lease_expires_at: DateTime<Utc>,
    pub operation: String,
    pub processor_contract: String,
    pub options: Value,
    pub input: WorkerClaimInput,
    pub limits: WorkerClaimLimits,
}

#[derive(Clone, Deserialize)]
pub struct WorkerClaimInput {
    pub schema: String,
    pub size_bytes: i64,
    pub sha256: String,
    pub download_url: String,
    pub download_token: String,
}

#[derive(Clone, Deserialize)]
pub struct WorkerClaimLimits {
    pub wall_seconds: i64,
    pub output_bytes: i64,
    pub diagnostic_bytes: i64,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessingPhase {
    Processing,
    UploadingResult,
}

#[derive(Serialize)]
pub struct ClaimHeartbeatInput {
    pub request_id: Uuid,
    pub session_id: Uuid,
    pub phase: ProcessingPhase,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClaimHeartbeatState {
    Active,
    CancellationRequested,
    ClaimLost,
    JobTerminal,
}

#[derive(Deserialize)]
pub struct ClaimHeartbeatResponse {
    pub state: ClaimHeartbeatState,
    pub server_time: DateTime<Utc>,
    pub lease_expires_at: Option<DateTime<Utc>>,
    pub cancellation_deadline: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
pub struct CreateArtifactTicketInput {
    pub session_id: Uuid,
    pub request_id: Uuid,
    pub role: String,
    pub media_type: String,
    pub filename: String,
    pub size_bytes: i64,
    pub sha256: String,
}

#[derive(Deserialize)]
pub struct ArtifactTicketResponse {
    pub transfer_id: Uuid,
    pub upload_url: String,
    pub upload_token: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct CompleteClaimInput {
    pub session_id: Uuid,
    pub request_id: Uuid,
    pub artifacts: Vec<CompletedArtifactInput>,
    pub metadata: Value,
}

#[derive(Serialize)]
pub struct CompletedArtifactInput {
    pub transfer_id: Uuid,
    pub role: String,
    pub size_bytes: i64,
    pub sha256: String,
}

#[derive(Deserialize)]
pub struct CompleteClaimResponse {
    pub job_id: Uuid,
    pub state: String,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerFailureClass {
    InvalidInput,
    ProcessorRejected,
    UnsupportedDependency,
    ResourceLimit,
    TransientInfrastructure,
    WorkerInterrupted,
    InternalContractViolation,
}

#[derive(Serialize)]
pub struct FailClaimInput {
    pub session_id: Uuid,
    pub request_id: Uuid,
    pub class: WorkerFailureClass,
    pub code: String,
    pub message: String,
}

#[derive(Serialize)]
pub struct ReleaseClaimInput {
    pub session_id: Uuid,
    pub request_id: Uuid,
    pub reason: Option<String>,
}

#[derive(Deserialize)]
pub struct ClaimMutationResponse {
    pub job_id: Uuid,
    pub state: String,
}

#[derive(Deserialize)]
pub struct WorkerApiErrorResponse {
    pub code: String,
    pub message: String,
    pub request_id: Option<String>,
}
