//! Internal service wire contracts for worker sessions, claims, and transfers.

use super::model::{ProcessingOperation, ProcessingPhase};
use crate::text_enum::text_enum;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub(crate) const WORKER_PROTOCOL_VERSION: u32 = 1;

#[derive(Serialize, utoipa::ToSchema)]
pub(crate) struct WorkerApiErrorResponse {
    pub code: &'static str,
    pub message: &'static str,
}

#[derive(Deserialize, Serialize, utoipa::ToSchema)]
pub(crate) struct CreateWorkerSessionInput {
    pub request_id: Uuid,
    pub worker_instance: String,
    pub protocol_versions: Vec<u32>,
    pub processors: Vec<WorkerProcessorAdvertisement>,
}

#[derive(Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub(crate) struct WorkerProcessorAdvertisement {
    pub operation: ProcessingOperation,
    pub processor_contract: String,
    pub runtime_version: String,
    pub slots: i32,
}

#[derive(Serialize, utoipa::ToSchema)]
pub(crate) struct WorkerSessionResponse {
    pub session_id: Uuid,
    pub protocol_version: u32,
    pub server_time: DateTime<Utc>,
    pub heartbeat_interval_seconds: i64,
    pub max_long_poll_seconds: u32,
}

#[derive(Deserialize, Serialize, utoipa::ToSchema)]
pub(crate) struct WorkerSessionHeartbeatInput {
    pub request_id: Uuid,
    pub processors: Vec<WorkerProcessorHealth>,
}

#[derive(Deserialize, Serialize, utoipa::ToSchema)]
pub(crate) struct DrainWorkerSessionInput {
    pub request_id: Uuid,
}

#[derive(Deserialize, Serialize, utoipa::ToSchema)]
pub(crate) struct WorkerProcessorHealth {
    pub operation: ProcessingOperation,
    pub processor_contract: String,
    pub healthy: bool,
}

#[derive(Serialize, utoipa::ToSchema)]
pub(crate) struct WorkerSessionHeartbeatResponse {
    pub server_time: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Deserialize, Serialize, utoipa::ToSchema)]
pub(crate) struct AcquireClaimsInput {
    pub request_id: Uuid,
    pub session_id: Uuid,
    pub offers: Vec<WorkerProcessorOffer>,
    #[serde(default)]
    pub wait_seconds: u32,
}

#[derive(Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub(crate) struct WorkerProcessorOffer {
    pub operation: ProcessingOperation,
    pub processor_contract: String,
    pub slots: u32,
}

#[derive(Serialize, utoipa::ToSchema)]
pub(crate) struct WorkerClaimsResponse {
    pub claims: Vec<WorkerClaim>,
}

#[derive(Serialize, utoipa::ToSchema)]
pub(crate) struct WorkerClaim {
    pub job_id: Uuid,
    pub attempt: i32,
    pub claim_id: Uuid,
    pub lease_expires_at: DateTime<Utc>,
    pub operation: ProcessingOperation,
    pub processor_contract: String,
    pub options: Value,
    pub input: WorkerClaimInput,
    pub limits: WorkerClaimLimits,
}

#[derive(Serialize, utoipa::ToSchema)]
pub(crate) struct WorkerClaimInput {
    pub schema: String,
    pub size_bytes: i64,
    pub sha256: String,
    pub download_url: String,
    pub download_token: String,
}

#[derive(Clone, Serialize, utoipa::ToSchema)]
pub(crate) struct WorkerClaimLimits {
    pub wall_seconds: i64,
    pub output_bytes: i64,
    pub diagnostic_bytes: i64,
}

#[derive(Deserialize, Serialize, utoipa::ToSchema)]
pub(crate) struct ClaimHeartbeatInput {
    pub request_id: Uuid,
    pub session_id: Uuid,
    pub phase: ProcessingPhase,
}

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum ClaimHeartbeatState {
        Active => "active",
        CancellationRequested => "cancellation_requested",
        ClaimLost => "claim_lost",
        JobTerminal => "job_terminal",
    }
}

#[derive(Serialize, utoipa::ToSchema)]
pub(crate) struct ClaimHeartbeatResponse {
    pub state: ClaimHeartbeatState,
    pub server_time: DateTime<Utc>,
    #[schema(required)]
    pub lease_expires_at: Option<DateTime<Utc>>,
    #[schema(required)]
    pub cancellation_deadline: Option<DateTime<Utc>>,
}

#[derive(Deserialize, Serialize, utoipa::ToSchema)]
pub(crate) struct CreateArtifactTicketInput {
    pub session_id: Uuid,
    pub request_id: Uuid,
    pub role: String,
    pub media_type: String,
    pub filename: String,
    pub size_bytes: i64,
    pub sha256: String,
}

#[derive(Serialize, utoipa::ToSchema)]
pub(crate) struct ArtifactTicketResponse {
    pub transfer_id: Uuid,
    pub upload_url: String,
    pub upload_token: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Deserialize, Serialize, utoipa::ToSchema)]
pub(crate) struct CompleteClaimInput {
    pub session_id: Uuid,
    pub request_id: Uuid,
    pub artifacts: Vec<CompletedArtifactInput>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Deserialize, Serialize, utoipa::ToSchema)]
pub(crate) struct CompletedArtifactInput {
    pub transfer_id: Uuid,
    pub role: String,
    pub size_bytes: i64,
    pub sha256: String,
}

#[derive(Serialize, utoipa::ToSchema)]
pub(crate) struct CompleteClaimResponse {
    pub job_id: Uuid,
    pub state: &'static str,
}

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum WorkerFailureClass {
        InvalidInput => "invalid_input",
        ProcessorRejected => "processor_rejected",
        UnsupportedDependency => "unsupported_dependency",
        ResourceLimit => "resource_limit",
        TransientInfrastructure => "transient_infrastructure",
        WorkerInterrupted => "worker_interrupted",
        InternalContractViolation => "internal_contract_violation",
    }
}

impl WorkerFailureClass {
    pub(crate) const fn retryable(self) -> bool {
        matches!(
            self,
            Self::TransientInfrastructure | Self::WorkerInterrupted
        )
    }
}

#[derive(Deserialize, Serialize, utoipa::ToSchema)]
pub(crate) struct FailClaimInput {
    pub session_id: Uuid,
    pub request_id: Uuid,
    pub class: WorkerFailureClass,
    pub code: String,
    pub message: String,
}

#[derive(Deserialize, Serialize, utoipa::ToSchema)]
pub(crate) struct ReleaseClaimInput {
    pub session_id: Uuid,
    pub request_id: Uuid,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Serialize, utoipa::ToSchema)]
pub(crate) struct ClaimMutationResponse {
    pub job_id: Uuid,
    pub state: String,
}

pub(super) struct IssuedTransfer {
    pub id: Uuid,
    pub token: String,
    pub expires_at: DateTime<Utc>,
}
