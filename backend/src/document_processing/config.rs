//! Deployment-owned worker identities, contract allowlists, and resource policy.

use super::model::ProcessingOperation;
use axum::http::{header, HeaderMap};
use chrono::Duration;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::env;
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
    token: String,
    operations: Vec<WorkerOperationInput>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerOperationInput {
    id: String,
    processor_contracts: Vec<String>,
}

impl ProcessingConfig {
    pub(crate) fn from_env() -> Result<Self, String> {
        let identities = match env::var("PROCESSING_WORKER_IDENTITIES_JSON") {
            Ok(raw) if !raw.trim().is_empty() => parse_identities(&raw)?,
            Ok(_) | Err(env::VarError::NotPresent) => Vec::new(),
            Err(env::VarError::NotUnicode(_)) => {
                return Err("PROCESSING_WORKER_IDENTITIES_JSON must be valid Unicode".to_string())
            }
        };
        Ok(Self {
            identities,
            max_queued_jobs: positive_i64("PROCESSING_MAX_QUEUED_JOBS", DEFAULT_MAX_QUEUED_JOBS)?,
            max_active_jobs_per_user: positive_i64(
                "PROCESSING_MAX_ACTIVE_JOBS_PER_USER",
                DEFAULT_MAX_ACTIVE_JOBS_PER_USER,
            )?,
            max_active_jobs_per_project: positive_i64(
                "PROCESSING_MAX_ACTIVE_JOBS_PER_PROJECT",
                DEFAULT_MAX_ACTIVE_JOBS_PER_PROJECT,
            )?,
            max_input_bytes: positive_i64("PROCESSING_MAX_INPUT_BYTES", DEFAULT_MAX_INPUT_BYTES)?,
            max_output_bytes: positive_i64(
                "PROCESSING_MAX_OUTPUT_BYTES",
                DEFAULT_MAX_OUTPUT_BYTES,
            )?,
            max_diagnostic_bytes: positive_i64(
                "PROCESSING_MAX_DIAGNOSTIC_BYTES",
                DEFAULT_MAX_DIAGNOSTIC_BYTES,
            )?,
            job_wall_seconds: positive_i64(
                "PROCESSING_JOB_WALL_SECONDS",
                DEFAULT_JOB_WALL_SECONDS,
            )?,
            queue_wait: Duration::seconds(positive_i64(
                "PROCESSING_QUEUE_WAIT_SECONDS",
                DEFAULT_QUEUE_WAIT_SECONDS,
            )?),
            retention: Duration::seconds(positive_i64(
                "PROCESSING_RETENTION_SECONDS",
                DEFAULT_RETENTION_SECONDS,
            )?),
            claim_lease: Duration::seconds(positive_i64(
                "PROCESSING_CLAIM_LEASE_SECONDS",
                DEFAULT_CLAIM_LEASE_SECONDS,
            )?),
            session_lease: Duration::seconds(positive_i64(
                "PROCESSING_SESSION_LEASE_SECONDS",
                DEFAULT_SESSION_LEASE_SECONDS,
            )?),
            transfer_ttl: Duration::seconds(positive_i64(
                "PROCESSING_TRANSFER_SECONDS",
                DEFAULT_TRANSFER_SECONDS,
            )?),
            finalization_lease: Duration::seconds(positive_i64(
                "PROCESSING_FINALIZATION_LEASE_SECONDS",
                DEFAULT_FINALIZATION_LEASE_SECONDS,
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

fn parse_identities(raw: &str) -> Result<Vec<WorkerIdentity>, String> {
    let inputs: Vec<WorkerIdentityInput> = serde_json::from_str(raw)
        .map_err(|error| format!("PROCESSING_WORKER_IDENTITIES_JSON is invalid: {error}"))?;
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
        if input.token.len() < 32 {
            return Err(format!("worker identity {} token is too short", input.id));
        }
        let token_fingerprint: [u8; 32] = Sha256::digest(input.token.as_bytes()).into();
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

fn positive_i64(name: &str, default: i64) -> Result<i64, String> {
    match env::var(name) {
        Ok(value) => value
            .parse::<i64>()
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(|| format!("{name} must be a positive integer")),
        Err(env::VarError::NotPresent) => Ok(default),
        Err(env::VarError::NotUnicode(_)) => Err(format!("{name} must be valid Unicode")),
    }
}

#[cfg(test)]
mod tests {
    use super::parse_identities;

    #[test]
    fn worker_identity_requires_exact_contracts() {
        let error = parse_identities(
            r#"[{"id":"latex","token":"01234567890123456789012345678901","operations":[{"id":"latex.compile.pdf/v1","processor_contracts":[]}]}]"#,
        )
        .err();
        assert!(error.is_some_and(|message| message.contains("exact processor contract")));
    }
}
