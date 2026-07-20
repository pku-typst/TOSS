//! Browser/user HTTP edge for durable processing commands and task queries.

use super::model::{
    CreatePptxImportInput, ProcessingCapabilities, ProcessingCapability, ProcessingCapabilityState,
    ProcessingInputProfileSelector, ProcessingJob, ProcessingJobList, ProcessingOperation,
    ProjectProcessingCapabilities, ProjectProcessingCapability, ProjectProcessingCapabilityState,
};
use super::persistence::{
    artifact_content_for_user, artifacts_for_jobs, cancel_job, capability_stats, job_for_user,
    list_jobs_for_user, mark_preparation_failed, reserve_job, store_prepared_input, PreparedInput,
    ReserveJob, ReserveJobError, ReserveJobOutcome,
};
use super::pptx::{validate_pptx, PptxValidationError};
use super::project_input::{
    capture_project_bundle, capture_typst_project_bundle, CaptureProjectBundleError,
    CapturedProjectBundle, TypstProjectBundleCapture,
};
use crate::access::{
    ensure_project_role, ensure_project_role_for_user, required_request_user_id, AccessNeed,
    ProjectAuthorizationError,
};
use crate::app_state::AppState;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use crate::typst_runtime::{analyze_project_dependencies, ResolveProcessingPackagesError};
use crate::workspace::{
    load_project_content_snapshot, load_project_entry_point, ProjectName, ProjectType,
};
use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use chrono::Utc;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path as FsPath;
use uuid::Uuid;

const IDEMPOTENCY_HEADER: &str = "idempotency-key";
type CreateJobResponse = (StatusCode, Json<ProcessingJob>);

struct ReservedJob {
    actor: Uuid,
    job_id: Uuid,
}

struct ProcessingJobReservation<'a> {
    actor: Uuid,
    project_id: Option<Uuid>,
    idempotency_scope: &'static str,
    idempotency_key: &'a str,
    operation: ProcessingOperation,
    command: &'a Value,
    options: &'a Value,
}

enum ProjectJobStart {
    Existing(CreateJobResponse),
    Reserved(ReservedJob),
}

pub(crate) async fn create_latex_pdf_build(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<impl IntoResponse, ApiError> {
    let operation = ProcessingOperation::LatexCompilePdfV1;
    let reserved =
        match begin_project_job(&state, &headers, project_id, operation, &json!({})).await? {
            ProjectJobStart::Existing(response) => return Ok(response),
            ProjectJobStart::Reserved(reserved) => reserved,
        };
    let bundle = capture_or_fail(
        &state,
        reserved.job_id,
        capture_project_bundle(
            &state.db,
            state.storage.as_ref(),
            &state.collaboration,
            reserved.job_id,
            project_id,
            state.processing.config.max_input_bytes,
        )
        .await,
    )
    .await?;
    ensure_captured_project_type(&state, reserved.job_id, &bundle, ProjectType::Latex).await?;
    let Some(engine) = bundle.latex_engine else {
        return Err(fail_preparation(
            &state,
            reserved.job_id,
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
    finish_project_job(&state, reserved, bundle, options).await
}

pub(crate) async fn create_typst_pptx_export(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<impl IntoResponse, ApiError> {
    let operation = ProcessingOperation::TypstExportPptxV1;
    let reserved =
        match begin_project_job(&state, &headers, project_id, operation, &json!({})).await? {
            ProjectJobStart::Existing(response) => return Ok(response),
            ProjectJobStart::Reserved(reserved) => reserved,
        };
    let bundle = capture_or_fail(
        &state,
        reserved.job_id,
        capture_typst_project_bundle(TypstProjectBundleCapture {
            db: &state.db,
            storage: state.storage.as_ref(),
            collaboration: &state.collaboration,
            builtin_dir: &state.typst_builtin_dir,
            operation,
            job_id: reserved.job_id,
            project_id,
            max_input_bytes: state.processing.config.max_input_bytes,
        })
        .await,
    )
    .await?;
    ensure_captured_project_type(&state, reserved.job_id, &bundle, ProjectType::Typst).await?;
    let options = json!({
        "entry_file_path": bundle.entry_file_path,
        "source_epoch": bundle.source_epoch,
    });
    finish_project_job(&state, reserved, bundle, options).await
}

pub(crate) async fn create_pptx_import(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(input): Query<CreatePptxImportInput>,
    body: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    let operation = ProcessingOperation::PptxImportTypstV1;
    ensure_operation_enabled(&state, operation)?;
    require_pptx_content_type(&headers)?;
    let actor = required_request_user_id(&state.db, &headers).await?;
    let (filename, project_name) = normalize_import_filename(&input.filename)?;
    let input_profile = resolve_input_profile(
        state
            .distribution
            .processing_input_profile_selector(operation),
        input.input_profile.as_deref(),
    )?;
    let size_bytes = i64::try_from(body.len()).unwrap_or(i64::MAX);
    if body.is_empty() || size_bytes > state.processing.config.max_input_bytes {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            ApiErrorCode::ProcessingInputTooLarge,
            "PPTX input exceeds the processing input limit",
        ));
    }
    let expanded_limit = u64::try_from(state.processing.config.max_input_bytes)
        .unwrap_or(u64::MAX)
        .saturating_mul(4);
    let validation_bytes = body.clone();
    let validation = tokio::task::spawn_blocking(move || {
        validate_pptx(validation_bytes.as_ref(), expanded_limit)
    })
    .await
    .map_err(|error| processing_unavailable("PPTX validation task failed", error))?;
    if let Err(error) = validation {
        return Err(pptx_input_error(error));
    }
    let input_digest: [u8; 32] = Sha256::digest(&body).into();
    let mut options = serde_json::Map::from_iter([
        ("filename".to_string(), Value::String(filename)),
        ("project_name".to_string(), Value::String(project_name)),
    ]);
    if let Some(input_profile) = input_profile {
        options.insert("input_profile".to_string(), Value::String(input_profile));
    }
    let options = Value::Object(options);
    let command = json!({
        "operation": operation,
        "input_sha256": hex::encode(input_digest),
        "options": options,
    });
    let reserved = match reserve_processing_job(
        &state,
        ProcessingJobReservation {
            actor,
            project_id: None,
            idempotency_scope: "pptx-import",
            idempotency_key: idempotency_key(&headers)?,
            operation,
            command: &command,
            options: &options,
        },
    )
    .await?
    {
        ProjectJobStart::Existing(response) => return Ok(response),
        ProjectJobStart::Reserved(reserved) => reserved,
    };
    let options_bytes = serde_json::to_vec(&options).map_err(|error| {
        processing_unavailable("processing options could not be encoded", error)
    })?;
    let options_digest = Sha256::digest(options_bytes);
    let contract = operation.contract();
    finish_reserved_job(
        &state,
        reserved,
        PreparedInput {
            schema: contract.input_schema,
            media_type: contract.input_media_type,
            bytes: body.as_ref(),
            digest: &input_digest,
            normalized_options: &options,
            options_digest: options_digest.as_ref(),
            workspace_version: None,
            content_epoch: None,
            source_epoch: None,
            now: Utc::now(),
        },
    )
    .await
}

async fn begin_project_job(
    state: &AppState,
    headers: &HeaderMap,
    project_id: Uuid,
    operation: ProcessingOperation,
    initial_options: &Value,
) -> Result<ProjectJobStart, ApiError> {
    ensure_operation_enabled(state, operation)?;
    let actor = ensure_project_role(&state.db, headers, project_id, AccessNeed::Read).await?;
    let entry_point = load_project_entry_point(&state.db, project_id).await?;
    if operation.project_type() != Some(entry_point.project_type) {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            ApiErrorCode::ProcessingOperationInvalid,
            "The operation does not support this project type",
        ));
    }
    let command = json!({
        "operation": operation,
        "project_id": project_id,
        "options": initial_options,
    });
    reserve_processing_job(
        state,
        ProcessingJobReservation {
            actor,
            project_id: Some(project_id),
            idempotency_scope: "project-processing",
            idempotency_key: idempotency_key(headers)?,
            operation,
            command: &command,
            options: initial_options,
        },
    )
    .await
}

async fn reserve_processing_job(
    state: &AppState,
    reservation: ProcessingJobReservation<'_>,
) -> Result<ProjectJobStart, ApiError> {
    let command_bytes = serde_json::to_vec(reservation.command).map_err(|error| {
        processing_unavailable("processing command could not be encoded", error)
    })?;
    let options_bytes = serde_json::to_vec(reservation.options).map_err(|error| {
        processing_unavailable("processing options could not be encoded", error)
    })?;
    let command_digest = Sha256::digest(&command_bytes);
    let options_digest = Sha256::digest(&options_bytes);
    let now = Utc::now();
    let job_id = Uuid::new_v4();
    let outcome = reserve_job(
        &state.db,
        &state.processing.config,
        &ReserveJob {
            id: job_id,
            operation: reservation.operation,
            requester_user_id: reservation.actor,
            project_id: reservation.project_id,
            idempotency_scope: reservation.idempotency_scope,
            idempotency_key: reservation.idempotency_key,
            command_digest: command_digest.as_ref(),
            normalized_options: reservation.options,
            options_digest: options_digest.as_ref(),
            now,
        },
    )
    .await
    .map_err(reserve_error)?;
    match outcome {
        ReserveJobOutcome::Reserved => Ok(ProjectJobStart::Reserved(ReservedJob {
            actor: reservation.actor,
            job_id,
        })),
        ReserveJobOutcome::Existing(job) => {
            let artifacts = super::persistence::artifacts_by_job(&state.db, job.id)
                .await
                .map_err(|error| {
                    processing_unavailable("processing artifacts could not be read", error)
                })?;
            Ok(ProjectJobStart::Existing((
                StatusCode::OK,
                Json(job.into_public(artifacts)),
            )))
        }
    }
}

async fn capture_or_fail(
    state: &AppState,
    job_id: Uuid,
    result: Result<CapturedProjectBundle, CaptureProjectBundleError>,
) -> Result<CapturedProjectBundle, ApiError> {
    match result {
        Ok(bundle) => Ok(bundle),
        Err(error) => {
            let (code, message) = capture_failure(&error);
            if let Err(mark_error) = mark_preparation_failed(&state.db, job_id, code, message).await
            {
                tracing::error!(%job_id, %mark_error, "processing preparation failure could not be persisted");
            }
            Err(capture_error(error))
        }
    }
}

async fn ensure_captured_project_type(
    state: &AppState,
    job_id: Uuid,
    bundle: &CapturedProjectBundle,
    expected: ProjectType,
) -> Result<(), ApiError> {
    if bundle.project_type == expected {
        return Ok(());
    }
    Err(fail_preparation(
        state,
        job_id,
        "project_type_changed",
        "Project type changed while the operation was being prepared",
        ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::ProjectContentChanged,
            "Project type changed while the operation was being prepared",
        ),
    )
    .await)
}

async fn finish_project_job(
    state: &AppState,
    reserved: ReservedJob,
    bundle: CapturedProjectBundle,
    options: Value,
) -> Result<CreateJobResponse, ApiError> {
    let options_bytes = match serde_json::to_vec(&options) {
        Ok(bytes) => bytes,
        Err(error) => {
            return Err(fail_preparation(
                state,
                reserved.job_id,
                "options_encoding_failed",
                "Processing options could not be encoded",
                processing_unavailable("processing options could not be encoded", error),
            )
            .await)
        }
    };
    let options_digest = Sha256::digest(&options_bytes);
    finish_reserved_job(
        state,
        reserved,
        PreparedInput {
            schema: bundle.schema,
            media_type: bundle.media_type,
            bytes: &bundle.bytes,
            digest: &bundle.digest,
            normalized_options: &options,
            options_digest: options_digest.as_ref(),
            workspace_version: Some(bundle.workspace_version),
            content_epoch: Some(bundle.content_epoch),
            source_epoch: Some(bundle.source_epoch),
            now: Utc::now(),
        },
    )
    .await
}

async fn finish_reserved_job(
    state: &AppState,
    reserved: ReservedJob,
    input: PreparedInput<'_>,
) -> Result<CreateJobResponse, ApiError> {
    let stored = store_prepared_input(&state.db, reserved.job_id, &input).await;
    let job = match stored {
        Ok(Some(job)) => job,
        Ok(None) => {
            // Cancellation and queue expiry serialize against the transition out of
            // `preparing`. Return the winning terminal resource instead of turning
            // that legitimate race into a storage outage.
            if let Some(job) = job_for_user(&state.db, reserved.actor, reserved.job_id)
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
                state,
                reserved.job_id,
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
                state,
                reserved.job_id,
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
    for operation in state
        .processing
        .configured_operations()
        .into_iter()
        .filter(|operation| state.distribution.supports_processing_operation(*operation))
    {
        let stats = capability_stats(&state.db, operation)
            .await
            .map_err(|error| {
                processing_unavailable("processing capability could not be read", error)
            })?;
        let (capability_state, reason) = if stats.healthy_sessions == 0 {
            (
                ProcessingCapabilityState::Waiting,
                Some("worker_temporarily_offline".to_string()),
            )
        } else {
            (ProcessingCapabilityState::Available, None)
        };
        let input_profile_selector = state
            .distribution
            .processing_input_profile_selector(operation);
        capabilities.push(ProcessingCapability {
            operation,
            state: capability_state,
            input_profile_selector: input_profile_selector.cloned(),
            healthy_sessions: stats.healthy_sessions,
            active_slots: stats.active_slots,
            active_jobs: stats.active_jobs,
            queued_jobs: stats.queued_jobs,
            reason,
        });
    }
    Ok(Json(ProcessingCapabilities { capabilities }))
}

pub(crate) async fn project_processing_capabilities(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<ProjectProcessingCapabilities>, ApiError> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let snapshot = load_project_content_snapshot(&state.db, project_id)
        .await
        .map_err(|error| {
            processing_unavailable("project processing capability could not be read", error)
        })?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::ProjectNotFound,
                "Project was not found",
            )
        })?;
    let dependencies = (snapshot.project_type == ProjectType::Typst)
        .then(|| analyze_project_dependencies(&snapshot.entry_file_path, &snapshot.documents));
    let mut capabilities = Vec::new();
    for operation in state
        .processing
        .configured_operations()
        .into_iter()
        .filter(|operation| state.distribution.supports_processing_operation(*operation))
        .filter(|operation| operation.project_type() == Some(snapshot.project_type))
    {
        let dynamic_dependency = dependencies
            .as_ref()
            .is_some_and(|dependencies| dependencies.has_dynamic_imports);
        let (capability_state, reason) = if dynamic_dependency {
            (
                ProjectProcessingCapabilityState::Inapplicable,
                Some("dynamic_typst_dependency".to_string()),
            )
        } else {
            let stats = capability_stats(&state.db, operation)
                .await
                .map_err(|error| {
                    processing_unavailable("project processing capability could not be read", error)
                })?;
            if stats.healthy_sessions == 0 {
                (
                    ProjectProcessingCapabilityState::Waiting,
                    Some("worker_temporarily_offline".to_string()),
                )
            } else {
                (ProjectProcessingCapabilityState::Available, None)
            }
        };
        capabilities.push(ProjectProcessingCapability {
            operation,
            state: capability_state,
            reason,
        });
    }
    Ok(Json(ProjectProcessingCapabilities { capabilities }))
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

fn ensure_operation_enabled(
    state: &AppState,
    operation: ProcessingOperation,
) -> Result<(), ApiError> {
    if !state.distribution.supports_processing_operation(operation) {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::ProcessingUnavailable,
            "This background operation is disabled in the distribution",
        ));
    }
    if !state.processing.config.operation_configured(operation) {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorCode::ProcessingUnavailable,
            "No compatible background processor is configured",
        ));
    }
    Ok(())
}

fn require_pptx_content_type(headers: &HeaderMap) -> Result<(), ApiError> {
    let valid = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<mime::Mime>().ok())
        .is_some_and(|value| value.essence_str() == super::operation_contract::PPTX_MEDIA_TYPE);
    if valid {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ApiErrorCode::ProcessingInputInvalid,
            "PPTX import requires the PPTX media type",
        ))
    }
}

fn normalize_import_filename(raw: &str) -> Result<(String, String), ApiError> {
    let filename = raw.trim();
    let path = FsPath::new(filename);
    let safe_basename = path.file_name().and_then(|value| value.to_str()) == Some(filename);
    let pptx_extension = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("pptx"));
    if filename.is_empty()
        || filename.len() > 255
        || !safe_basename
        || !pptx_extension
        || filename.contains(['/', '\\'])
        || filename.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::ProcessingInputInvalid,
            "PPTX filename is invalid",
        ));
    }
    let project_name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::ProcessingInputInvalid,
                "PPTX filename is invalid",
            )
        })?;
    let project_name = ProjectName::parse(project_name).map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::ProjectNameInvalid,
            "PPTX filename cannot be used as a project name",
        )
    })?;
    Ok((filename.to_string(), project_name.as_str().to_string()))
}

fn resolve_input_profile(
    configured: Option<&ProcessingInputProfileSelector>,
    requested: Option<&str>,
) -> Result<Option<String>, ApiError> {
    let requested = requested.map(str::trim);
    if requested.is_some_and(str::is_empty) {
        return Err(invalid_input_profile());
    }
    let Some(configured) = configured else {
        return if requested.is_none() {
            Ok(None)
        } else {
            Err(invalid_input_profile())
        };
    };
    let selected = requested.unwrap_or(&configured.default_profile);
    configured
        .profiles
        .iter()
        .find(|profile| profile.id == selected)
        .map(|profile| Some(profile.id.clone()))
        .ok_or_else(invalid_input_profile)
}

fn invalid_input_profile() -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        ApiErrorCode::ProcessingOperationInvalid,
        "The requested processing input profile is unavailable",
    )
}

fn pptx_input_error(error: PptxValidationError) -> ApiError {
    match error {
        PptxValidationError::Limit => ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            ApiErrorCode::ProcessingInputTooLarge,
            "PPTX input exceeds structural limits",
        ),
        PptxValidationError::Archive
        | PptxValidationError::UnsafePart
        | PptxValidationError::MissingPart => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            ApiErrorCode::ProcessingInputInvalid,
            "PPTX input is not a valid presentation package",
        ),
    }
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
        CaptureProjectBundleError::Package(
            ResolveProcessingPackagesError::TooManyPackages
            | ResolveProcessingPackagesError::TooLarge,
        ) => (
            "input_too_large",
            "Project dependencies exceed the processing input limit",
        ),
        CaptureProjectBundleError::Package(ResolveProcessingPackagesError::DynamicDependency) => (
            "dynamic_typst_dependency",
            "Project contains a dynamic Typst dependency",
        ),
        CaptureProjectBundleError::Package(_) => (
            "package_capture_failed",
            "Typst package dependencies could not be captured",
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
        CaptureProjectBundleError::Package(
            ResolveProcessingPackagesError::TooManyPackages
            | ResolveProcessingPackagesError::TooLarge,
        ) => ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            ApiErrorCode::ProcessingInputTooLarge,
            "Project dependencies exceed the processing input limit",
        ),
        CaptureProjectBundleError::Package(
            ResolveProcessingPackagesError::DynamicDependency
            | ResolveProcessingPackagesError::LocalPackageNotFound { .. }
            | ResolveProcessingPackagesError::UnsafeArchive { .. }
            | ResolveProcessingPackagesError::Manifest { .. }
            | ResolveProcessingPackagesError::DuplicateFile { .. },
        ) => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            ApiErrorCode::ProcessingInputInvalid,
            "Typst package dependencies cannot be processed",
        ),
        failure @ CaptureProjectBundleError::Package(_) => {
            processing_unavailable("Typst package dependencies could not be captured", failure)
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

#[cfg(test)]
mod tests {
    use super::resolve_input_profile;
    use crate::document_processing::{ProcessingInputProfile, ProcessingInputProfileSelector};
    use crate::localized_text::LocalizedText;

    fn text(value: &str) -> LocalizedText {
        LocalizedText {
            en: value.to_string(),
            zh_cn: value.to_string(),
        }
    }

    fn selector() -> ProcessingInputProfileSelector {
        ProcessingInputProfileSelector {
            label: text("Profile"),
            default_profile: "profile-a".to_string(),
            profiles: vec![
                ProcessingInputProfile {
                    id: "profile-a".to_string(),
                    label: text("Profile A"),
                    description: text("First profile"),
                },
                ProcessingInputProfile {
                    id: "profile-b".to_string(),
                    label: text("Profile B"),
                    description: text("Second profile"),
                },
            ],
        }
    }

    #[test]
    fn input_profile_uses_the_validated_distribution_default() {
        let configured = selector();

        assert!(matches!(
            resolve_input_profile(Some(&configured), None),
            Ok(Some(profile)) if profile == "profile-a"
        ));
    }

    #[test]
    fn input_profile_accepts_only_a_configured_value() {
        let configured = selector();

        assert!(matches!(
            resolve_input_profile(Some(&configured), Some(" profile-b ")),
            Ok(Some(profile)) if profile == "profile-b"
        ));
        assert!(resolve_input_profile(Some(&configured), Some("unknown")).is_err());
        assert!(resolve_input_profile(Some(&configured), Some(" ")).is_err());
    }

    #[test]
    fn input_profile_is_absent_when_the_distribution_defines_none() {
        assert!(matches!(resolve_input_profile(None, None), Ok(None)));
        assert!(resolve_input_profile(None, Some("profile-a")).is_err());
    }
}
