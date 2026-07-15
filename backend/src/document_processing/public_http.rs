//! Browser/user HTTP edge for durable processing commands and task queries.

use super::model::{
    ProcessingCapabilities, ProcessingCapability, ProcessingCapabilityState, ProcessingJob,
    ProcessingJobList, ProcessingOperation,
};
use super::persistence::{
    artifact_content_for_user, artifacts_for_jobs, cancel_job, capability_stats, job_for_user,
    list_jobs_for_user, mark_preparation_failed, reserve_job, store_prepared_input, PreparedInput,
    ReserveJob, ReserveJobError, ReserveJobOutcome,
};
use super::project_input::{capture_project_bundle, CaptureProjectBundleError};
use crate::access::{
    ensure_project_role, ensure_project_role_for_user, required_request_user_id, AccessNeed,
    ProjectAuthorizationError,
};
use crate::app_state::AppState;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use crate::workspace::{load_project_entry_point, ProjectType};
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use chrono::Utc;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use uuid::Uuid;

const IDEMPOTENCY_HEADER: &str = "idempotency-key";

pub(crate) async fn create_latex_pdf_build(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<impl IntoResponse, ApiError> {
    let operation = ProcessingOperation::LatexCompilePdfV1;
    if !state.distribution.supports_processing_operation(operation) {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::ProcessingUnavailable,
            "Background LaTeX builds are disabled in this distribution",
        ));
    }
    if !state.processing.config.operation_configured(operation) {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorCode::ProcessingUnavailable,
            "No background LaTeX processor is configured",
        ));
    }
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let entry_point = load_project_entry_point(&state.db, project_id).await?;
    if entry_point.project_type != ProjectType::Latex {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            ApiErrorCode::ProcessingOperationInvalid,
            "Background LaTeX builds require a LaTeX project",
        ));
    }
    let idempotency_key = idempotency_key(&headers)?;
    let command_digest = Sha256::digest(format!("{}:{project_id}", operation.as_ref()).as_bytes());
    let placeholder_options = json!({});
    let placeholder_options_bytes = serde_json::to_vec(&placeholder_options).map_err(|error| {
        processing_unavailable("processing options could not be encoded", error)
    })?;
    let placeholder_options_digest = Sha256::digest(&placeholder_options_bytes);
    let now = Utc::now();
    let job_id = Uuid::new_v4();
    let outcome = reserve_job(
        &state.db,
        &state.processing.config,
        &ReserveJob {
            id: job_id,
            operation,
            requester_user_id: actor,
            project_id: Some(project_id),
            idempotency_scope: "project-build",
            idempotency_key,
            command_digest: command_digest.as_ref(),
            normalized_options: &placeholder_options,
            options_digest: placeholder_options_digest.as_ref(),
            now,
        },
    )
    .await
    .map_err(reserve_error)?;
    if let ReserveJobOutcome::Existing(job) = outcome {
        let artifacts = super::persistence::artifacts_by_job(&state.db, job.id)
            .await
            .map_err(|error| {
                processing_unavailable("processing artifacts could not be read", error)
            })?;
        return Ok((StatusCode::OK, Json(job.into_public(artifacts))));
    }

    let bundle = match capture_project_bundle(
        &state.db,
        state.storage.as_ref(),
        &state.collaboration,
        job_id,
        project_id,
        state.processing.config.max_input_bytes,
    )
    .await
    {
        Ok(bundle) => bundle,
        Err(error) => {
            let (code, message) = capture_failure(&error);
            if let Err(mark_error) = mark_preparation_failed(&state.db, job_id, code, message).await
            {
                tracing::error!(%job_id, %mark_error, "processing preparation failure could not be persisted");
            }
            return Err(capture_error(error));
        }
    };
    if bundle.project_type != ProjectType::Latex {
        return Err(fail_preparation(
            &state,
            job_id,
            "project_type_changed",
            "Project type changed while the build was being prepared",
            ApiError::new(
                StatusCode::CONFLICT,
                ApiErrorCode::ProjectContentChanged,
                "Project type changed while the build was being prepared",
            ),
        )
        .await);
    }
    let Some(engine) = bundle.latex_engine else {
        return Err(fail_preparation(
            &state,
            job_id,
            "latex_engine_missing",
            "LaTeX engine is missing from the captured project",
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                ApiErrorCode::ProcessingOperationInvalid,
                "LaTeX engine is missing from the captured project",
            ),
        )
        .await);
    };
    let options = json!({
        "engine": engine,
        "entry_file_path": bundle.entry_file_path,
        "source_epoch": bundle.source_epoch,
    });
    let options_bytes = match serde_json::to_vec(&options) {
        Ok(bytes) => bytes,
        Err(error) => {
            return Err(fail_preparation(
                &state,
                job_id,
                "options_encoding_failed",
                "Processing options could not be encoded",
                processing_unavailable("processing options could not be encoded", error),
            )
            .await)
        }
    };
    let options_digest = Sha256::digest(&options_bytes);
    let stored = store_prepared_input(
        &state.db,
        job_id,
        &PreparedInput {
            schema: bundle.schema,
            bytes: &bundle.bytes,
            digest: &bundle.digest,
            normalized_options: &options,
            options_digest: options_digest.as_ref(),
            workspace_version: bundle.workspace_version,
            content_epoch: bundle.content_epoch,
            source_epoch: bundle.source_epoch,
            now: Utc::now(),
        },
    )
    .await;
    let job = match stored {
        Ok(Some(job)) => job,
        Ok(None) => {
            // Cancellation and queue expiry serialize against the transition out of
            // `preparing`. Return the winning terminal resource instead of turning
            // that legitimate race into a storage outage.
            if let Some(job) = job_for_user(&state.db, actor, job_id)
                .await
                .map_err(|error| {
                    processing_unavailable("processing job could not be read", error)
                })?
            {
                let artifacts = super::persistence::artifacts_by_job(&state.db, job.id)
                    .await
                    .map_err(|error| {
                        processing_unavailable("processing artifacts could not be read", error)
                    })?;
                return Ok((StatusCode::OK, Json(job.into_public(artifacts))));
            }
            return Err(fail_preparation(
                &state,
                job_id,
                "input_state_conflict",
                "Processing input could not be queued",
                processing_unavailable(
                    "processing input state changed before it could be queued",
                    "reserved processing job disappeared",
                ),
            )
            .await);
        }
        Err(error) => {
            return Err(fail_preparation(
                &state,
                job_id,
                "input_persistence_failed",
                "Processing input could not be queued",
                processing_unavailable("processing input could not be queued", error),
            )
            .await)
        }
    };
    Ok((StatusCode::ACCEPTED, Json(job.into_public(Vec::new()))))
}

pub(crate) async fn list_processing_jobs(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ProcessingJobList>, ApiError> {
    let actor = required_request_user_id(&state.db, &headers).await?;
    let records = list_jobs_for_user(&state.db, actor)
        .await
        .map_err(|error| processing_unavailable("processing jobs could not be listed", error))?;
    let mut visible = Vec::with_capacity(records.len());
    for record in records {
        if let Some(project_id) = record.project_id {
            match ensure_project_role_for_user(&state.db, actor, project_id, AccessNeed::Read).await
            {
                Ok(()) => {}
                Err(ProjectAuthorizationError::PermissionDenied) => continue,
                Err(error) => return Err(error.into()),
            }
        }
        visible.push(record);
    }
    let job_ids = visible.iter().map(|job| job.id).collect::<Vec<_>>();
    let artifacts = artifacts_for_jobs(&state.db, &job_ids)
        .await
        .map_err(|error| {
            processing_unavailable("processing artifacts could not be listed", error)
        })?;
    let mut artifacts_by_job = HashMap::<Uuid, Vec<_>>::new();
    for artifact in artifacts {
        artifacts_by_job
            .entry(artifact.job_id)
            .or_default()
            .push(artifact);
    }
    Ok(Json(ProcessingJobList {
        jobs: visible
            .into_iter()
            .map(|job| {
                let artifacts = artifacts_by_job.remove(&job.id).unwrap_or_default();
                job.into_public(artifacts)
            })
            .collect(),
    }))
}

pub(crate) async fn get_processing_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<Uuid>,
) -> Result<Json<ProcessingJob>, ApiError> {
    let actor = required_request_user_id(&state.db, &headers).await?;
    let job = authorized_job(&state, actor, job_id).await?;
    let artifacts = super::persistence::artifacts_by_job(&state.db, job_id)
        .await
        .map_err(|error| processing_unavailable("processing artifacts could not be read", error))?;
    Ok(Json(job.into_public(artifacts)))
}

pub(crate) async fn cancel_processing_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<Uuid>,
) -> Result<Json<ProcessingJob>, ApiError> {
    let actor = required_request_user_id(&state.db, &headers).await?;
    authorized_job(&state, actor, job_id).await?;
    let job = cancel_job(&state.db, actor, job_id)
        .await
        .map_err(|error| processing_unavailable("processing job could not be cancelled", error))?
        .ok_or_else(processing_job_not_found)?;
    let artifacts = super::persistence::artifacts_by_job(&state.db, job_id)
        .await
        .map_err(|error| processing_unavailable("processing artifacts could not be read", error))?;
    Ok(Json(job.into_public(artifacts)))
}

pub(crate) async fn processing_capabilities(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ProcessingCapabilities>, ApiError> {
    required_request_user_id(&state.db, &headers).await?;
    let mut capabilities = Vec::new();
    for operation in [
        ProcessingOperation::LatexCompilePdfV1,
        ProcessingOperation::TypstExportPptxV1,
        ProcessingOperation::PptxImportTypstV1,
    ] {
        let allowed = state.distribution.supports_processing_operation(operation);
        let configured = state.processing.config.operation_configured(operation);
        let stats = capability_stats(&state.db, operation)
            .await
            .map_err(|error| {
                processing_unavailable("processing capability could not be read", error)
            })?;
        let (capability_state, reason) = if !allowed {
            (
                ProcessingCapabilityState::Unavailable,
                Some("disabled_by_distribution".to_string()),
            )
        } else if !configured {
            (
                ProcessingCapabilityState::Unavailable,
                Some("worker_not_configured".to_string()),
            )
        } else if stats.healthy_sessions == 0 {
            (
                ProcessingCapabilityState::Waiting,
                Some("worker_temporarily_offline".to_string()),
            )
        } else {
            (ProcessingCapabilityState::Available, None)
        };
        capabilities.push(ProcessingCapability {
            operation,
            state: capability_state,
            healthy_sessions: stats.healthy_sessions,
            active_slots: stats.active_slots,
            active_jobs: stats.active_jobs,
            queued_jobs: stats.queued_jobs,
            reason,
        });
    }
    Ok(Json(ProcessingCapabilities { capabilities }))
}

pub(crate) async fn download_processing_artifact(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((job_id, artifact_id)): Path<(Uuid, Uuid)>,
) -> Result<impl IntoResponse, ApiError> {
    let actor = required_request_user_id(&state.db, &headers).await?;
    authorized_job(&state, actor, job_id).await?;
    let (_, content) = artifact_content_for_user(&state.db, actor, job_id, artifact_id)
        .await
        .map_err(|error| processing_unavailable("processing artifact could not be read", error))?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::ProcessingArtifactNotFound,
                "Processing artifact was not found",
            )
        })?;
    let mut response = axum::http::Response::new(Body::from(content.content));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_str(&content.artifact.media_type)
            .unwrap_or_else(|_| header::HeaderValue::from_static("application/octet-stream")),
    );
    let disposition = format!("attachment; filename=\"{}\"", content.artifact.filename);
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        header::HeaderValue::from_str(&disposition)
            .unwrap_or_else(|_| header::HeaderValue::from_static("attachment")),
    );
    Ok(response)
}

async fn authorized_job(
    state: &AppState,
    actor: Uuid,
    job_id: Uuid,
) -> Result<super::persistence::JobRecord, ApiError> {
    let job = job_for_user(&state.db, actor, job_id)
        .await
        .map_err(|error| processing_unavailable("processing job could not be read", error))?
        .ok_or_else(processing_job_not_found)?;
    if let Some(project_id) = job.project_id {
        ensure_project_role_for_user(&state.db, actor, project_id, AccessNeed::Read).await?;
    }
    Ok(job)
}

fn idempotency_key(headers: &HeaderMap) -> Result<&str, ApiError> {
    let value = headers
        .get(IDEMPOTENCY_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::PRECONDITION_REQUIRED,
                ApiErrorCode::ProcessingIdempotencyRequired,
                "Idempotency-Key is required",
            )
        })?;
    if value.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::ProcessingIdempotencyInvalid,
            "Idempotency-Key is invalid",
        ));
    }
    Ok(value)
}

fn reserve_error(error: ReserveJobError) -> ApiError {
    match error {
        ReserveJobError::IdempotencyConflict => ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::ProcessingIdempotencyConflict,
            "Idempotency-Key was already used for another command",
        ),
        ReserveJobError::GlobalLimit
        | ReserveJobError::RequesterLimit
        | ReserveJobError::ProjectLimit => ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            ApiErrorCode::ProcessingQueueFull,
            "Background processing capacity is full",
        ),
        ReserveJobError::Persistence(error) => {
            processing_unavailable("processing job admission failed", error)
        }
    }
}

fn capture_failure(error: &CaptureProjectBundleError) -> (&'static str, &'static str) {
    match error {
        CaptureProjectBundleError::ProjectNotFound => {
            ("project_not_found", "Project was not found")
        }
        CaptureProjectBundleError::EntryFileNotFound => {
            ("entry_file_not_found", "Project entry file was not found")
        }
        CaptureProjectBundleError::DuplicatePath => {
            ("duplicate_path", "Project contains duplicate paths")
        }
        CaptureProjectBundleError::TooManyFiles => {
            ("too_many_files", "Project contains too many files")
        }
        CaptureProjectBundleError::TooLarge => (
            "input_too_large",
            "Project exceeds the processing input limit",
        ),
        CaptureProjectBundleError::Collaboration(_)
        | CaptureProjectBundleError::Persistence(_)
        | CaptureProjectBundleError::Asset(_)
        | CaptureProjectBundleError::Manifest(_)
        | CaptureProjectBundleError::Archive(_) => (
            "input_capture_failed",
            "Project input could not be captured",
        ),
    }
}

fn capture_error(error: CaptureProjectBundleError) -> ApiError {
    match error {
        CaptureProjectBundleError::ProjectNotFound => ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::ProjectNotFound,
            "Project was not found",
        ),
        CaptureProjectBundleError::EntryFileNotFound | CaptureProjectBundleError::DuplicatePath => {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                ApiErrorCode::ProcessingInputInvalid,
                "Project cannot be processed",
            )
        }
        CaptureProjectBundleError::TooManyFiles | CaptureProjectBundleError::TooLarge => {
            ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                ApiErrorCode::ProcessingInputTooLarge,
                "Project exceeds the processing input limit",
            )
        }
        failure @ (CaptureProjectBundleError::Collaboration(_)
        | CaptureProjectBundleError::Persistence(_)
        | CaptureProjectBundleError::Asset(_)
        | CaptureProjectBundleError::Manifest(_)
        | CaptureProjectBundleError::Archive(_)) => {
            processing_unavailable("processing input capture failed", failure)
        }
    }
}

async fn fail_preparation(
    state: &AppState,
    job_id: Uuid,
    code: &'static str,
    message: &'static str,
    response: ApiError,
) -> ApiError {
    if let Err(mark_error) = mark_preparation_failed(&state.db, job_id, code, message).await {
        tracing::error!(%job_id, %mark_error, "processing preparation failure could not be persisted");
    }
    response
}

fn processing_job_not_found() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        ApiErrorCode::ProcessingJobNotFound,
        "Processing job was not found",
    )
}

fn processing_unavailable(
    context: &'static str,
    error: impl std::fmt::Debug + Send + Sync + 'static,
) -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        ApiErrorCode::ProcessingServiceUnavailable,
        "Background processing is unavailable",
    )
    .with_diagnostic(context, error)
}
