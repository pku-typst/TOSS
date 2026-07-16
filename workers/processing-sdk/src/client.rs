//! Secret-redacting HTTP client for the internal worker protocol.

use crate::protocol::*;
use bytes::Bytes;
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use url::Url;
use uuid::Uuid;

const MUTATION_ATTEMPTS: usize = 4;
const DOWNLOAD_ATTEMPTS: usize = 3;

#[derive(Clone)]
pub(crate) struct CoreClient {
    base_url: Url,
    http: reqwest::Client,
    worker_token: Arc<str>,
}

#[derive(Debug, Error)]
pub enum ClientError {
    #[error("worker protocol transport failed")]
    Transport(#[source] reqwest::Error),
    #[error("worker protocol URL is invalid")]
    InvalidUrl(#[source] url::ParseError),
    #[error("worker protocol returned {status}: {code}: {message}")]
    Protocol {
        status: StatusCode,
        code: String,
        message: String,
    },
    #[error("worker protocol response was invalid")]
    InvalidResponse(#[source] reqwest::Error),
}

impl CoreClient {
    pub(crate) fn new(base_url: Url, worker_token: String) -> Result<Self, ClientError> {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .user_agent("toss-processing-sdk/1")
            .build()
            .map_err(ClientError::Transport)?;
        Ok(Self {
            base_url,
            http,
            worker_token: Arc::from(worker_token),
        })
    }

    pub(crate) async fn create_session(
        &self,
        input: &CreateWorkerSessionInput,
    ) -> Result<WorkerSessionResponse, ClientError> {
        self.worker_json(
            Method::POST,
            "/internal/v1/processing/worker-sessions",
            input,
        )
        .await
    }

    pub(crate) async fn heartbeat_session(
        &self,
        session_id: Uuid,
        input: &WorkerSessionHeartbeatInput,
    ) -> Result<WorkerSessionHeartbeatResponse, ClientError> {
        self.worker_json(
            Method::POST,
            &format!("/internal/v1/processing/worker-sessions/{session_id}/heartbeat"),
            input,
        )
        .await
    }

    pub(crate) async fn drain_session(&self, session_id: Uuid) -> Result<(), ClientError> {
        self.worker_empty(
            Method::DELETE,
            &format!("/internal/v1/processing/worker-sessions/{session_id}"),
            &DrainWorkerSessionInput {
                request_id: Uuid::new_v4(),
            },
        )
        .await
    }

    pub(crate) async fn acquire_claims(
        &self,
        input: &AcquireClaimsInput,
    ) -> Result<Vec<WorkerClaim>, ClientError> {
        let url = self.resolve("/internal/v1/processing/claims:acquire")?;
        let mut attempt = 0;
        loop {
            let result = async {
                let response = self
                    .http
                    .post(url.clone())
                    .bearer_auth(self.worker_token.as_ref())
                    .json(input)
                    .send()
                    .await
                    .map_err(ClientError::Transport)?;
                if response.status() == StatusCode::NO_CONTENT {
                    return Ok(Vec::new());
                }
                checked(response)
                    .await?
                    .json::<WorkerClaimsResponse>()
                    .await
                    .map(|body| body.claims)
                    .map_err(ClientError::InvalidResponse)
            }
            .await;
            match result {
                Err(error)
                    if retryable_mutation_error(&error) && attempt + 1 < MUTATION_ATTEMPTS =>
                {
                    mutation_backoff(attempt).await;
                    attempt += 1;
                }
                result => return result,
            }
        }
    }

    pub(crate) async fn heartbeat_claim(
        &self,
        claim_id: Uuid,
        input: &ClaimHeartbeatInput,
    ) -> Result<ClaimHeartbeatResponse, ClientError> {
        self.worker_json(
            Method::POST,
            &format!("/internal/v1/processing/claims/{claim_id}/heartbeat"),
            input,
        )
        .await
    }

    pub(crate) async fn create_artifact_ticket(
        &self,
        claim_id: Uuid,
        input: &CreateArtifactTicketInput,
    ) -> Result<ArtifactTicketResponse, ClientError> {
        self.worker_json(
            Method::POST,
            &format!("/internal/v1/processing/claims/{claim_id}/artifacts"),
            input,
        )
        .await
    }

    pub(crate) async fn complete_claim(
        &self,
        claim_id: Uuid,
        input: &CompleteClaimInput,
    ) -> Result<CompleteClaimResponse, ClientError> {
        self.worker_json(
            Method::POST,
            &format!("/internal/v1/processing/claims/{claim_id}/complete"),
            input,
        )
        .await
    }

    pub(crate) async fn fail_claim(
        &self,
        claim_id: Uuid,
        input: &FailClaimInput,
    ) -> Result<ClaimMutationResponse, ClientError> {
        self.worker_json(
            Method::POST,
            &format!("/internal/v1/processing/claims/{claim_id}/fail"),
            input,
        )
        .await
    }

    pub(crate) async fn release_claim(
        &self,
        claim_id: Uuid,
        input: &ReleaseClaimInput,
    ) -> Result<ClaimMutationResponse, ClientError> {
        self.worker_json(
            Method::POST,
            &format!("/internal/v1/processing/claims/{claim_id}/release"),
            input,
        )
        .await
    }

    pub(crate) async fn download_transfer(
        &self,
        relative_url: &str,
        capability: &str,
    ) -> Result<Vec<u8>, ClientError> {
        let url = self.resolve(relative_url)?;
        let mut attempt = 0;
        loop {
            let result = async {
                checked(
                    self.http
                        .get(url.clone())
                        .header("authorization", format!("ProcessingTransfer {capability}"))
                        .send()
                        .await
                        .map_err(ClientError::Transport)?,
                )
                .await?
                .bytes()
                .await
                .map(|bytes| bytes.to_vec())
                .map_err(ClientError::InvalidResponse)
            }
            .await;
            match result {
                Err(error)
                    if retryable_transfer_error(&error) && attempt + 1 < DOWNLOAD_ATTEMPTS =>
                {
                    mutation_backoff(attempt).await;
                    attempt += 1;
                }
                result => return result,
            }
        }
    }

    pub(crate) async fn upload_transfer(
        &self,
        relative_url: &str,
        capability: &str,
        content: Vec<u8>,
    ) -> Result<(), ClientError> {
        let url = self.resolve(relative_url)?;
        let content = Bytes::from(content);
        let mut attempt = 0;
        loop {
            let result = async {
                checked(
                    self.http
                        .put(url.clone())
                        .header("authorization", format!("ProcessingTransfer {capability}"))
                        .header("content-type", "application/octet-stream")
                        .body(content.clone())
                        .send()
                        .await
                        .map_err(ClientError::Transport)?,
                )
                .await
                .map(|_| ())
            }
            .await;
            match result {
                Err(error)
                    if retryable_transfer_error(&error) && attempt + 1 < MUTATION_ATTEMPTS =>
                {
                    mutation_backoff(attempt).await;
                    attempt += 1;
                }
                result => return result,
            }
        }
    }

    async fn worker_json<I, O>(
        &self,
        method: Method,
        path: &str,
        input: &I,
    ) -> Result<O, ClientError>
    where
        I: Serialize + ?Sized,
        O: DeserializeOwned,
    {
        let url = self.resolve(path)?;
        let mut attempt = 0;
        loop {
            let result = async {
                checked(
                    self.http
                        .request(method.clone(), url.clone())
                        .bearer_auth(self.worker_token.as_ref())
                        .json(input)
                        .send()
                        .await
                        .map_err(ClientError::Transport)?,
                )
                .await?
                .json::<O>()
                .await
                .map_err(ClientError::InvalidResponse)
            }
            .await;
            match result {
                Err(error)
                    if retryable_mutation_error(&error) && attempt + 1 < MUTATION_ATTEMPTS =>
                {
                    mutation_backoff(attempt).await;
                    attempt += 1;
                }
                result => return result,
            }
        }
    }

    async fn worker_empty<I: Serialize + ?Sized>(
        &self,
        method: Method,
        path: &str,
        input: &I,
    ) -> Result<(), ClientError> {
        let url = self.resolve(path)?;
        let mut attempt = 0;
        loop {
            let result = async {
                checked(
                    self.http
                        .request(method.clone(), url.clone())
                        .bearer_auth(self.worker_token.as_ref())
                        .json(input)
                        .send()
                        .await
                        .map_err(ClientError::Transport)?,
                )
                .await
                .map(|_| ())
            }
            .await;
            match result {
                Err(error)
                    if retryable_mutation_error(&error) && attempt + 1 < MUTATION_ATTEMPTS =>
                {
                    mutation_backoff(attempt).await;
                    attempt += 1;
                }
                result => return result,
            }
        }
    }

    fn resolve(&self, relative_url: &str) -> Result<Url, ClientError> {
        let resolved = self
            .base_url
            .join(relative_url)
            .map_err(ClientError::InvalidUrl)?;
        if resolved.scheme() != self.base_url.scheme()
            || resolved.host_str() != self.base_url.host_str()
            || resolved.port_or_known_default() != self.base_url.port_or_known_default()
        {
            return Err(ClientError::InvalidUrl(
                url::ParseError::RelativeUrlWithoutBase,
            ));
        }
        Ok(resolved)
    }
}

fn retryable_mutation_error(error: &ClientError) -> bool {
    match error {
        ClientError::Transport(_) | ClientError::InvalidResponse(_) => true,
        ClientError::Protocol { status, code, .. } => {
            code == "worker_request_in_progress" || status.is_server_error()
        }
        ClientError::InvalidUrl(_) => false,
    }
}

fn retryable_transfer_error(error: &ClientError) -> bool {
    match error {
        ClientError::Transport(_) | ClientError::InvalidResponse(_) => true,
        ClientError::Protocol { status, .. } => status.is_server_error(),
        ClientError::InvalidUrl(_) => false,
    }
}

async fn mutation_backoff(attempt: usize) {
    let milliseconds = 100_u64.saturating_mul(1_u64 << attempt.min(4));
    tokio::time::sleep(Duration::from_millis(milliseconds)).await;
}

async fn checked(response: reqwest::Response) -> Result<reqwest::Response, ClientError> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response
        .json::<WorkerApiErrorResponse>()
        .await
        .unwrap_or(WorkerApiErrorResponse {
            code: "unexpected_response".to_string(),
            message: "Core returned an unexpected response".to_string(),
            request_id: None,
        });
    Err(ClientError::Protocol {
        status,
        code: body.code,
        message: body.message,
    })
}
