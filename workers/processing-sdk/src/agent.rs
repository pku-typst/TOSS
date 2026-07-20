//! Session, slot, lease, transfer, and closed-outcome orchestration.

use crate::client::{ClientError, CoreClient};
use crate::input::{verify_input, BinaryInput, ProcessorInput, ProjectInput};
use crate::protocol::*;
use async_trait::async_trait;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::env;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::sync::{watch, Semaphore};
use tokio::task::{JoinHandle, JoinSet};
use tracing::{error, info, warn};
use url::Url;
use uuid::Uuid;

const MAX_SLOTS: i32 = 16;
const MAX_ARTIFACTS: usize = 16;
const CLAIM_RENEWAL_MARGIN: Duration = Duration::from_secs(3);

#[derive(Clone)]
pub struct ProcessorDescriptor {
    pub operation: String,
    pub processor_contract: String,
    pub runtime_version: String,
    pub slots: i32,
}

pub struct ProcessorRequest {
    pub job_id: Uuid,
    pub attempt: i32,
    pub claim_id: Uuid,
    pub input: ProcessorInput,
    pub options: Value,
    pub limits: WorkerClaimLimits,
}

impl ProcessorRequest {
    pub fn project(&self) -> Option<&ProjectInput> {
        match &self.input {
            ProcessorInput::Project(input) => Some(input),
            ProcessorInput::Binary(_) => None,
        }
    }

    pub fn binary(&self) -> Option<&BinaryInput> {
        match &self.input {
            ProcessorInput::Project(_) => None,
            ProcessorInput::Binary(input) => Some(input),
        }
    }
}

pub struct ProcessorArtifact {
    pub role: String,
    pub media_type: String,
    pub filename: String,
    pub content: Vec<u8>,
}

pub struct ProcessorResult {
    pub artifacts: Vec<ProcessorArtifact>,
    pub metadata: Value,
}

#[derive(Debug)]
pub struct ProcessorFailure {
    pub class: WorkerFailureClass,
    pub code: String,
    pub message: String,
}

impl ProcessorFailure {
    pub fn new(
        class: WorkerFailureClass,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            class,
            code: code.into(),
            message: message.into(),
        }
    }
}

#[async_trait]
pub trait Processor: Send + Sync + 'static {
    fn descriptor(&self) -> ProcessorDescriptor;

    async fn process(
        &self,
        request: ProcessorRequest,
        cancellation: watch::Receiver<bool>,
    ) -> Result<ProcessorResult, ProcessorFailure>;
}

pub struct AgentConfig {
    pub core_url: Url,
    pub worker_token: String,
    pub worker_instance: String,
}

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("worker environment is invalid: {0}")]
    Configuration(String),
    #[error("worker protocol failed")]
    Client(#[from] ClientError),
    #[error("worker session negotiated an unsupported protocol")]
    Protocol,
}

impl AgentConfig {
    pub fn from_env() -> Result<Self, AgentError> {
        let core_url = env::var("PROCESSING_CORE_URL")
            .unwrap_or_else(|_| "http://core-api:8080".to_string())
            .parse::<Url>()
            .map_err(|error| AgentError::Configuration(format!("PROCESSING_CORE_URL: {error}")))?;
        if !matches!(core_url.scheme(), "http" | "https") || core_url.host_str().is_none() {
            return Err(AgentError::Configuration(
                "PROCESSING_CORE_URL must be an absolute HTTP(S) URL".to_string(),
            ));
        }
        let worker_token = read_worker_token()?;
        if worker_token.len() < 32 {
            return Err(AgentError::Configuration(
                "worker token must contain at least 32 bytes".to_string(),
            ));
        }
        let worker_instance = env::var("PROCESSING_WORKER_INSTANCE")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| env::var("HOSTNAME").ok())
            .unwrap_or_else(|| format!("worker-{}", Uuid::new_v4()));
        Ok(Self {
            core_url,
            worker_token,
            worker_instance,
        })
    }
}

pub async fn run_agent<P: Processor>(
    config: AgentConfig,
    processor: Arc<P>,
) -> Result<(), AgentError> {
    let processor: Arc<dyn Processor> = processor;
    run_agent_with_processors(config, vec![processor]).await
}

pub async fn run_agent_with_processors(
    config: AgentConfig,
    processors: Vec<Arc<dyn Processor>>,
) -> Result<(), AgentError> {
    if processors.is_empty() {
        return Err(AgentError::Configuration(
            "at least one processor is required".to_string(),
        ));
    }
    let mut registry = HashMap::with_capacity(processors.len());
    let mut descriptors = Vec::with_capacity(processors.len());
    let mut shared_slots = 0_i32;
    for processor in processors {
        let descriptor = processor.descriptor();
        validate_descriptor(&descriptor)?;
        shared_slots = shared_slots.max(descriptor.slots);
        let key = processor_key(&descriptor.operation, &descriptor.processor_contract);
        if registry.insert(key, processor).is_some() {
            return Err(AgentError::Configuration(
                "processor operation and contract pairs must be unique".to_string(),
            ));
        }
        descriptors.push(descriptor);
    }
    let client = CoreClient::new(config.core_url, config.worker_token)?;
    let session = client
        .create_session(&CreateWorkerSessionInput {
            request_id: Uuid::new_v4(),
            worker_instance: config.worker_instance,
            protocol_versions: vec![PROTOCOL_VERSION],
            processors: descriptors.iter().map(advertisement).collect(),
        })
        .await?;
    if session.protocol_version != PROTOCOL_VERSION {
        return Err(AgentError::Protocol);
    }
    info!(
        session_id = %session.session_id,
        processors = descriptors.len(),
        shared_slots,
        "processing worker session established"
    );

    let semaphore = Arc::new(Semaphore::new(shared_slots as usize));
    let (session_stop_tx, session_stop_rx) = watch::channel(false);
    let (session_lost_tx, mut session_lost_rx) = watch::channel(false);
    let session_task = tokio::spawn(session_heartbeat_loop(
        client.clone(),
        session.session_id,
        descriptors.clone(),
        Duration::from_secs(session.heartbeat_interval_seconds.max(1) as u64),
        session_stop_rx,
        session_lost_tx,
    ));
    let mut claims = JoinSet::new();
    let mut shutdown = Box::pin(shutdown_signal());
    let mut session_draining = false;

    loop {
        while let Some(result) = claims.try_join_next() {
            if let Err(join_error) = result {
                error!(?join_error, "processing claim task stopped unexpectedly");
            }
        }
        if *session_lost_rx.borrow() {
            warn!(session_id = %session.session_id, "worker session was lost");
            break;
        }
        let permit = match Arc::clone(&semaphore).try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                tokio::select! {
                    _ = &mut shutdown => break,
                    changed = session_lost_rx.changed() => {
                        if changed.is_err() || *session_lost_rx.borrow() { break; }
                    }
                    result = claims.join_next() => {
                        if let Some(Err(join_error)) = result {
                            error!(?join_error, "processing claim task stopped unexpectedly");
                        }
                    }
                }
                continue;
            }
        };

        let acquire_input = AcquireClaimsInput {
            request_id: Uuid::new_v4(),
            session_id: session.session_id,
            offers: descriptors
                .iter()
                .map(|descriptor| WorkerProcessorOffer {
                    operation: descriptor.operation.clone(),
                    processor_contract: descriptor.processor_contract.clone(),
                    slots: 1,
                })
                .collect(),
            wait_seconds: session.max_long_poll_seconds,
        };
        let acquire = client.acquire_claims(&acquire_input);
        tokio::pin!(acquire);
        let mut stop_after_acquire = false;
        let acquired = tokio::select! {
            _ = &mut shutdown => {
                stop_after_acquire = true;
                match client.drain_session(session.session_id).await {
                    Ok(()) => {
                        session_draining = true;
                        (&mut acquire).await
                    }
                    Err(error) => {
                        warn!(?error, "processing worker could not fence its in-flight acquisition during drain");
                        break;
                    }
                }
            }
            changed = session_lost_rx.changed() => {
                if changed.is_err() || *session_lost_rx.borrow() { break; }
                continue;
            }
            result = &mut acquire => result,
        };
        match acquired {
            Ok(batch) => {
                let mut granted = batch.into_iter();
                let first = granted.next();
                for claim in granted {
                    warn!(claim_id = %claim.claim_id, "Core granted more than one claim per acquisition");
                    let _ = client
                        .release_claim(
                            claim.claim_id,
                            &ReleaseClaimInput {
                                session_id: session.session_id,
                                request_id: Uuid::new_v4(),
                                reason: Some("claim_batch_contract_mismatch".to_string()),
                            },
                        )
                        .await;
                }
                if let Some(claim) = first {
                    let key = processor_key(&claim.operation, &claim.processor_contract);
                    let Some(claim_processor) = registry.get(&key).cloned() else {
                        warn!(claim_id = %claim.claim_id, "Core granted a claim outside the processor registry");
                        let _ = client
                            .release_claim(
                                claim.claim_id,
                                &ReleaseClaimInput {
                                    session_id: session.session_id,
                                    request_id: Uuid::new_v4(),
                                    reason: Some("processor_registry_mismatch".to_string()),
                                },
                            )
                            .await;
                        drop(permit);
                        continue;
                    };
                    let claim_client = client.clone();
                    let heartbeat_interval =
                        Duration::from_secs((session.heartbeat_interval_seconds.max(3) / 2) as u64);
                    claims.spawn(async move {
                        let _permit = permit;
                        process_claim(
                            claim_client,
                            session.session_id,
                            claim_processor,
                            claim,
                            heartbeat_interval,
                        )
                        .await;
                    });
                } else {
                    drop(permit);
                }
            }
            Err(error) => {
                drop(permit);
                if stop_after_acquire {
                    info!(?error, "in-flight acquisition closed during worker drain");
                } else {
                    warn!(?error, "processing claim acquisition failed");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
        if stop_after_acquire {
            break;
        }
    }

    if !session_draining {
        let _ = client.drain_session(session.session_id).await;
    }
    let _ = session_stop_tx.send(true);
    let _ = session_task.await;
    while let Some(result) = claims.join_next().await {
        if let Err(join_error) = result {
            error!(?join_error, "processing claim task stopped during drain");
        }
    }
    Ok(())
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};

    let mut terminate = match signal(SignalKind::terminate()) {
        Ok(signal) => signal,
        Err(error) => {
            warn!(
                ?error,
                "could not install SIGTERM handler; waiting for SIGINT"
            );
            let _ = tokio::signal::ctrl_c().await;
            return;
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

async fn process_claim(
    client: CoreClient,
    session_id: Uuid,
    processor: Arc<dyn Processor>,
    claim: WorkerClaim,
    heartbeat_interval: Duration,
) {
    info!(job_id = %claim.job_id, claim_id = %claim.claim_id, "processing claim started");
    let mut lease = LeaseGuard::start(
        client.clone(),
        session_id,
        claim.claim_id,
        claim.lease_expires_at,
        heartbeat_interval,
    );
    let outcome = execute_claim(&client, session_id, processor.as_ref(), &claim, &mut lease).await;
    if let Err(error) = outcome {
        warn!(job_id = %claim.job_id, claim_id = %claim.claim_id, ?error, "processing claim did not close cleanly");
    }
    lease.stop().await;
}

#[derive(Debug, Error)]
enum ExecuteClaimError {
    #[error("claim was cancelled or lost")]
    Cancelled,
    #[error("worker protocol failed")]
    Client(#[from] ClientError),
}

async fn execute_claim(
    client: &CoreClient,
    session_id: Uuid,
    processor: &dyn Processor,
    claim: &WorkerClaim,
    lease: &mut LeaseGuard,
) -> Result<(), ExecuteClaimError> {
    let content = match client
        .download_transfer(&claim.input.download_url, &claim.input.download_token)
        .await
    {
        Ok(content) => content,
        Err(error) => {
            report_failure(
                client,
                session_id,
                claim,
                ProcessorFailure::new(
                    WorkerFailureClass::TransientInfrastructure,
                    "input_transfer_failed",
                    "Immutable input could not be downloaded",
                ),
            )
            .await;
            return Err(error.into());
        }
    };
    if lease.cancelled() {
        release_cancelled(client, session_id, claim).await;
        return Err(ExecuteClaimError::Cancelled);
    }
    let input = match verify_input(&content, &claim.input) {
        Ok(input) => input,
        Err(error) => {
            warn!(?error, claim_id = %claim.claim_id, "processing input was rejected");
            report_failure(
                client,
                session_id,
                claim,
                ProcessorFailure::new(
                    WorkerFailureClass::InvalidInput,
                    "processing_input_invalid",
                    "The immutable processing input is invalid",
                ),
            )
            .await;
            return Ok(());
        }
    };
    let result = processor
        .process(processor_request(claim, input), lease.cancellation())
        .await;
    if lease.cancelled() {
        release_cancelled(client, session_id, claim).await;
        return Err(ExecuteClaimError::Cancelled);
    }
    let result = match result {
        Ok(result) => result,
        Err(failure) => {
            report_failure(client, session_id, claim, failure).await;
            return Ok(());
        }
    };
    lease.set_phase(ProcessingPhase::UploadingResult);
    let artifacts = match validate_artifacts(result.artifacts, &claim.limits) {
        Ok(artifacts) => artifacts,
        Err(failure) => {
            report_failure(client, session_id, claim, failure).await;
            return Ok(());
        }
    };
    let mut completed = Vec::with_capacity(artifacts.len());
    for artifact in artifacts {
        if lease.cancelled() {
            release_cancelled(client, session_id, claim).await;
            return Err(ExecuteClaimError::Cancelled);
        }
        let size_bytes = i64::try_from(artifact.content.len()).unwrap_or(i64::MAX);
        let sha256 = hex::encode(Sha256::digest(&artifact.content));
        let ticket = client
            .create_artifact_ticket(
                claim.claim_id,
                &CreateArtifactTicketInput {
                    session_id,
                    request_id: Uuid::new_v4(),
                    role: artifact.role.clone(),
                    media_type: artifact.media_type,
                    filename: artifact.filename,
                    size_bytes,
                    sha256: sha256.clone(),
                },
            )
            .await?;
        client
            .upload_transfer(&ticket.upload_url, &ticket.upload_token, artifact.content)
            .await?;
        completed.push(CompletedArtifactInput {
            transfer_id: ticket.transfer_id,
            role: artifact.role,
            size_bytes,
            sha256,
        });
    }
    client
        .complete_claim(
            claim.claim_id,
            &CompleteClaimInput {
                session_id,
                request_id: Uuid::new_v4(),
                artifacts: completed,
                metadata: result.metadata,
            },
        )
        .await?;
    info!(job_id = %claim.job_id, claim_id = %claim.claim_id, "processing delivery accepted");
    Ok(())
}

fn processor_request(claim: &WorkerClaim, input: ProcessorInput) -> ProcessorRequest {
    ProcessorRequest {
        input,
        job_id: claim.job_id,
        attempt: claim.attempt,
        claim_id: claim.claim_id,
        options: claim.options.clone(),
        limits: claim.limits.clone(),
    }
}

fn validate_artifacts(
    artifacts: Vec<ProcessorArtifact>,
    limits: &WorkerClaimLimits,
) -> Result<Vec<ProcessorArtifact>, ProcessorFailure> {
    if artifacts.is_empty() || artifacts.len() > MAX_ARTIFACTS {
        return Err(contract_failure(
            "Processor returned an invalid artifact count",
        ));
    }
    let mut roles = HashSet::new();
    let mut total = 0_i64;
    for artifact in &artifacts {
        let size = i64::try_from(artifact.content.len()).unwrap_or(i64::MAX);
        total = total.saturating_add(size);
        let role_limit = if matches!(artifact.role.as_str(), "log" | "report") {
            limits.diagnostic_bytes
        } else {
            limits.output_bytes
        };
        if artifact.role.is_empty()
            || !roles.insert(artifact.role.as_str())
            || size <= 0
            || size > role_limit
        {
            return Err(contract_failure("Processor returned an invalid artifact"));
        }
    }
    if total > limits.output_bytes.saturating_add(limits.diagnostic_bytes) {
        return Err(contract_failure(
            "Processor artifact set exceeds its byte limit",
        ));
    }
    Ok(artifacts)
}

fn contract_failure(message: &str) -> ProcessorFailure {
    ProcessorFailure::new(
        WorkerFailureClass::InternalContractViolation,
        "processor_output_invalid",
        message,
    )
}

async fn report_failure(
    client: &CoreClient,
    session_id: Uuid,
    claim: &WorkerClaim,
    failure: ProcessorFailure,
) {
    let code = normalize_code(&failure.code);
    let message = truncate_text(&failure.message, claim.limits.diagnostic_bytes);
    if let Err(error) = client
        .fail_claim(
            claim.claim_id,
            &FailClaimInput {
                session_id,
                request_id: Uuid::new_v4(),
                class: failure.class,
                code,
                message,
            },
        )
        .await
    {
        warn!(?error, claim_id = %claim.claim_id, "claim failure could not be reported");
    }
}

async fn release_cancelled(client: &CoreClient, session_id: Uuid, claim: &WorkerClaim) {
    let _ = client
        .release_claim(
            claim.claim_id,
            &ReleaseClaimInput {
                session_id,
                request_id: Uuid::new_v4(),
                reason: Some("cancellation_or_lease_loss".to_string()),
            },
        )
        .await;
}

fn normalize_code(value: &str) -> String {
    let normalized = value
        .bytes()
        .take(96)
        .map(|byte| {
            if byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' {
                char::from(byte)
            } else {
                '_'
            }
        })
        .collect::<String>();
    if normalized.is_empty() {
        "processor_failed".to_string()
    } else {
        normalized
    }
}

fn truncate_text(value: &str, max_bytes: i64) -> String {
    let limit = usize::try_from(max_bytes.max(1)).unwrap_or(usize::MAX);
    if value.len() <= limit {
        return value.to_string();
    }
    let mut end = limit.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value.get(..end).unwrap_or("Processor failed").to_string()
}

struct LeaseGuard {
    phase_tx: watch::Sender<ProcessingPhase>,
    cancellation_rx: watch::Receiver<bool>,
    stop_tx: watch::Sender<bool>,
    task: JoinHandle<()>,
}

impl LeaseGuard {
    fn start(
        client: CoreClient,
        session_id: Uuid,
        claim_id: Uuid,
        initial_expiry: chrono::DateTime<chrono::Utc>,
        interval: Duration,
    ) -> Self {
        let (phase_tx, phase_rx) = watch::channel(ProcessingPhase::Processing);
        let (cancellation_tx, cancellation_rx) = watch::channel(false);
        let (stop_tx, stop_rx) = watch::channel(false);
        let task = tokio::spawn(claim_heartbeat_loop(
            client,
            session_id,
            claim_id,
            initial_expiry,
            interval,
            phase_rx,
            cancellation_tx,
            stop_rx,
        ));
        Self {
            phase_tx,
            cancellation_rx,
            stop_tx,
            task,
        }
    }

    fn cancellation(&self) -> watch::Receiver<bool> {
        self.cancellation_rx.clone()
    }

    fn cancelled(&self) -> bool {
        *self.cancellation_rx.borrow()
    }

    fn set_phase(&self, phase: ProcessingPhase) {
        self.phase_tx.send_replace(phase);
    }

    async fn stop(self) {
        let _ = self.stop_tx.send(true);
        let _ = self.task.await;
    }
}

#[allow(
    clippy::too_many_arguments,
    reason = "lease guard state is explicit at the task boundary"
)]
async fn claim_heartbeat_loop(
    client: CoreClient,
    session_id: Uuid,
    claim_id: Uuid,
    initial_expiry: chrono::DateTime<chrono::Utc>,
    interval: Duration,
    phase_rx: watch::Receiver<ProcessingPhase>,
    cancellation_tx: watch::Sender<bool>,
    mut stop_rx: watch::Receiver<bool>,
) {
    let initial_remaining = (initial_expiry - chrono::Utc::now())
        .to_std()
        .unwrap_or(Duration::ZERO);
    let mut stop_at =
        tokio::time::Instant::now() + initial_remaining.saturating_sub(CLAIM_RENEWAL_MARGIN);
    let mut tick = tokio::time::interval(interval.max(Duration::from_secs(1)));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(stop_at) => {
                cancellation_tx.send_replace(true);
                return;
            }
            changed = stop_rx.changed() => {
                if changed.is_err() || *stop_rx.borrow() { return; }
            }
            _ = tick.tick() => {
                let phase = *phase_rx.borrow();
                let heartbeat = ClaimHeartbeatInput {
                    request_id: Uuid::new_v4(),
                    session_id,
                    phase,
                };
                let response = match heartbeat_before_lease_deadline(
                    stop_at,
                    &mut stop_rx,
                    client.heartbeat_claim(claim_id, &heartbeat),
                ).await {
                    HeartbeatWait::LeaseExpired => {
                        cancellation_tx.send_replace(true);
                        return;
                    }
                    HeartbeatWait::Stop => return,
                    HeartbeatWait::Response(response) => response,
                };
                match response {
                    Ok(response) if response.state == ClaimHeartbeatState::Active => {
                        if let Some(expiry) = response.lease_expires_at {
                            let remaining = (expiry - response.server_time)
                                .to_std()
                                .unwrap_or(Duration::ZERO);
                            stop_at = tokio::time::Instant::now()
                                + remaining.saturating_sub(CLAIM_RENEWAL_MARGIN);
                        }
                    }
                    Ok(_) => {
                        cancellation_tx.send_replace(true);
                        return;
                    }
                    Err(error) => {
                        warn!(?error, %claim_id, "claim heartbeat failed; retaining the last confirmed lease fence");
                    }
                }
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum HeartbeatWait<T> {
    Response(T),
    Stop,
    LeaseExpired,
}

async fn heartbeat_before_lease_deadline<T>(
    stop_at: tokio::time::Instant,
    stop_rx: &mut watch::Receiver<bool>,
    heartbeat: impl std::future::Future<Output = T>,
) -> HeartbeatWait<T> {
    tokio::select! {
        biased;
        _ = tokio::time::sleep_until(stop_at) => HeartbeatWait::LeaseExpired,
        changed = stop_rx.changed() => {
            let _ = changed;
            HeartbeatWait::Stop
        },
        response = heartbeat => HeartbeatWait::Response(response),
    }
}

async fn session_heartbeat_loop(
    client: CoreClient,
    session_id: Uuid,
    descriptors: Vec<ProcessorDescriptor>,
    interval: Duration,
    mut stop_rx: watch::Receiver<bool>,
    lost_tx: watch::Sender<bool>,
) {
    let mut failures = 0_u8;
    let mut tick = tokio::time::interval(interval);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            changed = stop_rx.changed() => {
                if changed.is_err() || *stop_rx.borrow() { return; }
            }
            _ = tick.tick() => {
                match client.heartbeat_session(
                    session_id,
                    &WorkerSessionHeartbeatInput {
                        request_id: Uuid::new_v4(),
                        processors: descriptors
                            .iter()
                            .map(|descriptor| WorkerProcessorHealth {
                                operation: descriptor.operation.clone(),
                                processor_contract: descriptor.processor_contract.clone(),
                                healthy: true,
                            })
                            .collect(),
                    },
                ).await {
                    Ok(_) => failures = 0,
                    Err(error) => {
                        failures = failures.saturating_add(1);
                        warn!(?error, failures, "worker session heartbeat failed");
                        if failures >= 4 {
                            lost_tx.send_replace(true);
                            return;
                        }
                    }
                }
            }
        }
    }
}

fn advertisement(descriptor: &ProcessorDescriptor) -> WorkerProcessorAdvertisement {
    WorkerProcessorAdvertisement {
        operation: descriptor.operation.clone(),
        processor_contract: descriptor.processor_contract.clone(),
        runtime_version: descriptor.runtime_version.clone(),
        slots: descriptor.slots,
    }
}

fn processor_key(operation: &str, processor_contract: &str) -> (String, String) {
    (operation.to_string(), processor_contract.to_string())
}

fn validate_descriptor(descriptor: &ProcessorDescriptor) -> Result<(), AgentError> {
    let contract = descriptor.processor_contract.strip_prefix("sha256:");
    if descriptor.operation.is_empty()
        || descriptor.runtime_version.is_empty()
        || descriptor.slots <= 0
        || descriptor.slots > MAX_SLOTS
        || !contract.is_some_and(|digest| {
            digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return Err(AgentError::Configuration(
            "processor descriptor is invalid".to_string(),
        ));
    }
    Ok(())
}

fn read_worker_token() -> Result<String, AgentError> {
    if let Ok(path) = env::var("PROCESSING_WORKER_TOKEN_FILE") {
        let value = std::fs::read_to_string(&path).map_err(|error| {
            AgentError::Configuration(format!("PROCESSING_WORKER_TOKEN_FILE {path}: {error}"))
        })?;
        return Ok(value.trim().to_string());
    }
    env::var("PROCESSING_WORKER_TOKEN").map_err(|_| {
        AgentError::Configuration(
            "PROCESSING_WORKER_TOKEN_FILE or PROCESSING_WORKER_TOKEN is required".to_string(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::{heartbeat_before_lease_deadline, normalize_code, truncate_text, HeartbeatWait};
    use std::future::pending;
    use std::time::Duration;
    use tokio::sync::watch;

    #[test]
    fn diagnostics_are_bounded_on_character_boundaries() {
        assert_eq!(truncate_text("aéz", 2), "a");
        assert_eq!(normalize_code("Bad-Code!"), "_ad__ode_");
    }

    #[tokio::test]
    async fn claim_heartbeat_never_outlives_the_confirmed_lease() {
        let (_stop_tx, mut stop_rx) = watch::channel(false);
        let result = heartbeat_before_lease_deadline(
            tokio::time::Instant::now(),
            &mut stop_rx,
            pending::<()>(),
        )
        .await;

        assert_eq!(result, HeartbeatWait::LeaseExpired);
    }

    #[tokio::test]
    async fn claim_heartbeat_can_still_finish_before_the_lease_deadline() {
        let (_stop_tx, mut stop_rx) = watch::channel(false);
        let result = heartbeat_before_lease_deadline(
            tokio::time::Instant::now() + Duration::from_secs(60),
            &mut stop_rx,
            async { 7 },
        )
        .await;

        assert_eq!(result, HeartbeatWait::Response(7));
    }
}
