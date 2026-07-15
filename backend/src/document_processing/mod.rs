//! Durable document-processing jobs and isolated capability-worker protocol.

mod config;
mod context;
mod finalization;
mod model;
mod persistence;
mod project_input;
mod public_http;
mod worker_http;
mod worker_idempotency;
mod worker_persistence;
pub(crate) mod worker_protocol;

pub(crate) use config::ProcessingConfig;
pub(crate) use context::DocumentProcessingContext;
pub(crate) use finalization::spawn_processing_maintenance;
pub(crate) use model::{
    ProcessingCapabilities, ProcessingJob, ProcessingJobList, ProcessingOperation,
};
pub(crate) use public_http::{
    cancel_processing_job, create_latex_pdf_build, download_processing_artifact,
    get_processing_job, list_processing_jobs, processing_capabilities,
};
pub(crate) use worker_http::{
    acquire_worker_claims, complete_worker_claim, create_worker_artifact_ticket,
    create_worker_session, download_worker_transfer, drain_worker_session, fail_worker_claim,
    heartbeat_worker_claim, heartbeat_worker_session, release_worker_claim, upload_worker_transfer,
};
