//! Deployment-owned worker identities, contract allowlists, and resource policy.

use super::model::ProcessingOperation;
use axum::http::{header, HeaderMap};
use chrono::Duration;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use subtle::ConstantTimeEq;

const DEFAULT_MAX_QUEUED_JOBS: i64 = 100;
const DEFAULT_MAX_ACTIVE_JOBS_PER_USER: i64 = 4;
const DEFAULT_MAX_ACTIVE_JOBS_PER_PROJECT: i64 = 2;
const DEFAULT_MAX_INPUT_BYTES: i64 = 128 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES: i64 = 64 * 1024 * 1024;
const DEFAULT_MAX_DIAGNOSTIC_BYTES: i64 = 64 * 1024;
const DEFAULT_JOB_WALL_SECONDS: i64 = 300;
const DEFAULT_QUEUE_WAIT_SECONDS: i64 = 24 * 60 * 60;
const DEFAULT_RETENTION_SECONDS: i64 = 7 * 24 * 60 * 60;
const DEFAULT_CLAIM_LEASE_SECONDS: i64 = 45;
const DEFAULT_SESSION_LEASE_SECONDS: i64 = 60;
const DEFAULT_TRANSFER_SECONDS: i64 = 300;
const DEFAULT_FINALIZATION_LEASE_SECONDS: i64 = 60;

#[derive(Clone)]
pub(crate) struct ProcessingConfig {
    identities: Vec<WorkerIdentity>,
    pub max_queued_jobs: i64,
    pub max_active_jobs_per_user: i64,
    pub max_active_jobs_per_project: i64,
    pub max_input_bytes: i64,
    pub max_output_bytes: i64,
    pub max_diagnostic_bytes: i64,
    pub job_wall_seconds: i64,
    pub queue_wait: Duration,
    pub retention: Duration,
    pub claim_lease: Duration,
    pub session_lease: Duration,
    pub transfer_ttl: Duration,
    pub finalization_lease: Duration,
}

#[derive(Clone)]
struct WorkerIdentity {
    id: String,
    token_fingerprint: [u8; 32],
    operations: HashMap<ProcessingOperation, HashSet<String>>,
}

#[derive(Clone)]
pub(crate) struct AuthenticatedWorker {
    pub identity: String,
    operations: HashMap<ProcessingOperation, HashSet<String>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerIdentityInput {
    id: String,
    token_file: PathBuf,
    operations: Vec<WorkerOperationInput>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerOperationInput {
    id: String,
    processor_contracts: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProcessingConfigFile {
    #[serde(default)]
    worker_identities: Vec<WorkerIdentityInput>,
    #[serde(default = "default_max_queued_jobs")]
    max_queued_jobs: i64,
    #[serde(default = "default_max_active_jobs_per_user")]
    max_active_jobs_per_user: i64,
    #[serde(default = "default_max_active_jobs_per_project")]
    max_active_jobs_per_project: i64,
    #[serde(default = "default_max_input_bytes")]
    max_input_bytes: i64,
    #[serde(default = "default_max_output_bytes")]
    max_output_bytes: i64,
    #[serde(default = "default_max_diagnostic_bytes")]
    max_diagnostic_bytes: i64,
    #[serde(default = "default_job_wall_seconds")]
    job_wall_seconds: i64,
    #[serde(default = "default_queue_wait_seconds")]
    queue_wait_seconds: i64,
    #[serde(default = "default_retention_seconds")]
    retention_seconds: i64,
    #[serde(default = "default_claim_lease_seconds")]
    claim_lease_seconds: i64,
    #[serde(default = "default_session_lease_seconds")]
    session_lease_seconds: i64,
    #[serde(default = "default_transfer_seconds")]
    transfer_seconds: i64,
    #[serde(default = "default_finalization_lease_seconds")]
    finalization_lease_seconds: i64,
}

impl Default for ProcessingConfigFile {
    fn default() -> Self {
        Self {
            worker_identities: Vec::new(),
            max_queued_jobs: DEFAULT_MAX_QUEUED_JOBS,
            max_active_jobs_per_user: DEFAULT_MAX_ACTIVE_JOBS_PER_USER,
            max_active_jobs_per_project: DEFAULT_MAX_ACTIVE_JOBS_PER_PROJECT,
            max_input_bytes: DEFAULT_MAX_INPUT_BYTES,
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
            max_diagnostic_bytes: DEFAULT_MAX_DIAGNOSTIC_BYTES,
            job_wall_seconds: DEFAULT_JOB_WALL_SECONDS,
            queue_wait_seconds: DEFAULT_QUEUE_WAIT_SECONDS,
            retention_seconds: DEFAULT_RETENTION_SECONDS,
            claim_lease_seconds: DEFAULT_CLAIM_LEASE_SECONDS,
            session_lease_seconds: DEFAULT_SESSION_LEASE_SECONDS,
            transfer_seconds: DEFAULT_TRANSFER_SECONDS,
            finalization_lease_seconds: DEFAULT_FINALIZATION_LEASE_SECONDS,
        }
    }
}

impl ProcessingConfig {
    pub(crate) fn from_config(
        config: ProcessingConfigFile,
        config_root: &Path,
    ) -> Result<Self, String> {
        let identities = parse_identities(config.worker_identities, config_root)?;
        Ok(Self {
            identities,
            max_queued_jobs: positive(
                "document_processing.max_queued_jobs",
                config.max_queued_jobs,
            )?,
            max_active_jobs_per_user: positive(
                "document_processing.max_active_jobs_per_user",
                config.max_active_jobs_per_user,
            )?,
            max_active_jobs_per_project: positive(
                "document_processing.max_active_jobs_per_project",
                config.max_active_jobs_per_project,
            )?,
            max_input_bytes: positive(
                "document_processing.max_input_bytes",
                config.max_input_bytes,
            )?,
            max_output_bytes: positive(
                "document_processing.max_output_bytes",
                config.max_output_bytes,
            )?,
            max_diagnostic_bytes: positive(
                "document_processing.max_diagnostic_bytes",
                config.max_diagnostic_bytes,
            )?,
            job_wall_seconds: positive(
                "document_processing.job_wall_seconds",
                config.job_wall_seconds,
            )?,
            queue_wait: Duration::seconds(positive(
                "document_processing.queue_wait_seconds",
                config.queue_wait_seconds,
            )?),
            retention: Duration::seconds(positive(
                "document_processing.retention_seconds",
                config.retention_seconds,
            )?),
            claim_lease: Duration::seconds(positive(
                "document_processing.claim_lease_seconds",
                config.claim_lease_seconds,
            )?),
            session_lease: Duration::seconds(positive(
                "document_processing.session_lease_seconds",
                config.session_lease_seconds,
            )?),
            transfer_ttl: Duration::seconds(positive(
                "document_processing.transfer_seconds",
                config.transfer_seconds,
            )?),
            finalization_lease: Duration::seconds(positive(
                "document_processing.finalization_lease_seconds",
                config.finalization_lease_seconds,
            )?),
        })
    }

    pub(crate) fn authenticate(&self, headers: &HeaderMap) -> Option<AuthenticatedWorker> {
        let token = headers
            .get(header::AUTHORIZATION)?
            .to_str()
            .ok()?
            .strip_prefix("Bearer ")?
            .trim();
        let candidate: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        self.identities.iter().find_map(|identity| {
            if bool::from(identity.token_fingerprint.ct_eq(&candidate)) {
                Some(AuthenticatedWorker {
                    identity: identity.id.clone(),
                    operations: identity.operations.clone(),
                })
            } else {
                None
            }
        })
    }

    pub(crate) fn operation_configured(&self, operation: ProcessingOperation) -> bool {
        self.identities
            .iter()
            .any(|identity| identity.operations.contains_key(&operation))
    }

    pub(crate) fn configured_operations(&self) -> Vec<ProcessingOperation> {
        let mut operations = self
            .identities
            .iter()
            .flat_map(|identity| identity.operations.keys().copied())
            .collect::<Vec<_>>();
        operations.sort_by(|left, right| left.as_ref().cmp(right.as_ref()));
        operations.dedup();
        operations
    }
}

impl AuthenticatedWorker {
    pub(crate) fn approves(
        &self,
        operation: ProcessingOperation,
        processor_contract: &str,
    ) -> bool {
        self.operations
            .get(&operation)
            .is_some_and(|contracts| contracts.contains(processor_contract))
    }
}

fn parse_identities(
    inputs: Vec<WorkerIdentityInput>,
    config_root: &Path,
) -> Result<Vec<WorkerIdentity>, String> {
    let mut identities = Vec::with_capacity(inputs.len());
    let mut ids = HashSet::new();
    let mut fingerprints = HashSet::new();
    for input in inputs {
        if input.id.is_empty()
            || input.id.len() > 64
            || !input
                .id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err("worker identity IDs must be lowercase slugs".to_string());
        }
        if !ids.insert(input.id.clone()) {
            return Err(format!("duplicate worker identity {}", input.id));
        }
        let token_path = if input.token_file.is_absolute() {
            input.token_file.clone()
        } else {
            config_root.join(&input.token_file)
        };
        let token = std::fs::read_to_string(&token_path).map_err(|error| {
            format!(
                "worker identity {} token file '{}' could not be read: {error}",
                input.id,
                token_path.display()
            )
        })?;
        let token = token.trim();
        if token.len() < 32
            || token.len() > 512
            || token.chars().any(char::is_whitespace)
            || token.chars().any(char::is_control)
        {
            return Err(format!(
                "worker identity {} token must contain 32-512 non-whitespace characters",
                input.id
            ));
        }
        let token_fingerprint: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        if !fingerprints.insert(token_fingerprint) {
            return Err("worker identity tokens must be unique".to_string());
        }
        let mut operations = HashMap::new();
        for operation in input.operations {
            let operation_id = ProcessingOperation::from_str(&operation.id).map_err(|_| {
                format!(
                    "worker identity {} has unknown operation {}",
                    input.id, operation.id
                )
            })?;
            if operation.processor_contracts.is_empty() {
                return Err(format!(
                    "worker identity {} operation {} needs an exact processor contract",
                    input.id, operation.id
                ));
            }
            let mut contracts = HashSet::new();
            for contract in operation.processor_contracts {
                if !valid_processor_contract(&contract) {
                    return Err(format!(
                        "worker identity {} has invalid processor contract",
                        input.id
                    ));
                }
                if !contracts.insert(contract) {
                    return Err(format!(
                        "worker identity {} repeats a processor contract",
                        input.id
                    ));
                }
            }
            if operations.insert(operation_id, contracts).is_some() {
                return Err(format!(
                    "worker identity {} repeats operation {}",
                    input.id, operation.id
                ));
            }
        }
        if operations.is_empty() {
            return Err(format!("worker identity {} has no operations", input.id));
        }
        identities.push(WorkerIdentity {
            id: input.id,
            token_fingerprint,
            operations,
        });
    }
    Ok(identities)
}

fn valid_processor_contract(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn positive(name: &str, value: i64) -> Result<i64, String> {
    if value > 0 {
        Ok(value)
    } else {
        Err(format!("{name} must be a positive integer"))
    }
}

macro_rules! default_value {
    ($function:ident, $value:ident) => {
        fn $function() -> i64 {
            $value
        }
    };
}

default_value!(default_max_queued_jobs, DEFAULT_MAX_QUEUED_JOBS);
default_value!(
    default_max_active_jobs_per_user,
    DEFAULT_MAX_ACTIVE_JOBS_PER_USER
);
default_value!(
    default_max_active_jobs_per_project,
    DEFAULT_MAX_ACTIVE_JOBS_PER_PROJECT
);
default_value!(default_max_input_bytes, DEFAULT_MAX_INPUT_BYTES);
default_value!(default_max_output_bytes, DEFAULT_MAX_OUTPUT_BYTES);
default_value!(default_max_diagnostic_bytes, DEFAULT_MAX_DIAGNOSTIC_BYTES);
default_value!(default_job_wall_seconds, DEFAULT_JOB_WALL_SECONDS);
default_value!(default_queue_wait_seconds, DEFAULT_QUEUE_WAIT_SECONDS);
default_value!(default_retention_seconds, DEFAULT_RETENTION_SECONDS);
default_value!(default_claim_lease_seconds, DEFAULT_CLAIM_LEASE_SECONDS);
default_value!(default_session_lease_seconds, DEFAULT_SESSION_LEASE_SECONDS);
default_value!(default_transfer_seconds, DEFAULT_TRANSFER_SECONDS);
default_value!(
    default_finalization_lease_seconds,
    DEFAULT_FINALIZATION_LEASE_SECONDS
);

#[cfg(test)]
mod tests {
    use super::{parse_identities, ProcessingConfigFile};

    #[test]
    fn worker_identity_requires_exact_contracts() -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempfile::tempdir()?;
        std::fs::write(
            directory.path().join("worker.token"),
            "01234567890123456789012345678901",
        )?;
        let config: ProcessingConfigFile = toml::from_str(
            r#"
[[worker_identities]]
id = "latex"
token_file = "worker.token"

[[worker_identities.operations]]
id = "latex.compile.pdf/v1"
processor_contracts = []
"#,
        )?;
        let error = parse_identities(config.worker_identities, directory.path()).err();
        assert!(error.is_some_and(|message| message.contains("exact processor contract")));
        Ok(())
    }
}
