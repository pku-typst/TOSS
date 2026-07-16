//! Inbound import/synchronization job state and public read contract.

use super::super::provider::ProviderInstanceId;
use crate::external_repositories::ExternalGitFailureCode;
use crate::text_enum::text_enum;
use chrono::{DateTime, Utc};
use uuid::Uuid;

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum ExternalGitInboundOperation {
        Import => "import",
        Sync => "sync",
    }
}

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum ExternalGitJobState {
        Pending => "pending",
        Processing => "processing",
        RetryWait => "retry_wait",
        Paused => "paused",
        Failed => "failed",
        Succeeded => "succeeded",
    }
}

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum ExternalGitInboundPhase {
        Queued => "queued",
        Fetch => "fetch",
        Lfs => "lfs",
        Validate => "validate",
        Assets => "assets",
        Apply => "apply",
        Revision => "revision",
        Complete => "complete",
    }
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ExternalRepositoryInboundJob {
    pub(super) id: Uuid,
    pub(super) project_id: Uuid,
    pub(super) provider: ProviderInstanceId,
    pub(super) operation: ExternalGitInboundOperation,
    pub(super) source_branch: String,
    pub(super) state: ExternalGitJobState,
    pub(super) phase: ExternalGitInboundPhase,
    pub(super) attempt_count: i32,
    #[schema(required)]
    pub(super) remote_sha: Option<String>,
    #[schema(required)]
    pub(super) last_error: Option<ExternalGitFailureCode>,
    #[schema(required)]
    pub(super) next_retry_at: Option<DateTime<Utc>>,
    pub(super) created_at: DateTime<Utc>,
    pub(super) updated_at: DateTime<Utc>,
    #[schema(required)]
    pub(super) completed_at: Option<DateTime<Utc>>,
}

impl ExternalRepositoryInboundJob {
    pub(super) fn pending(
        id: Uuid,
        project_id: Uuid,
        provider: ProviderInstanceId,
        operation: ExternalGitInboundOperation,
        source_branch: String,
        now: DateTime<Utc>,
    ) -> Self {
        Self {
            id,
            project_id,
            provider,
            operation,
            source_branch,
            state: ExternalGitJobState::Pending,
            phase: ExternalGitInboundPhase::Queued,
            attempt_count: 0,
            remote_sha: None,
            last_error: None,
            next_retry_at: None,
            created_at: now,
            updated_at: now,
            completed_at: None,
        }
    }
}
