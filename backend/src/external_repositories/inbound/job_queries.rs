//! Public inbound-job reads and their persistence projection mapping.

use super::persistence;
use super::{ExternalGitJobState, ExternalRepositoryInboundJob};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub(super) enum JobLookupError {
    #[error("external repository inbound job was not found")]
    NotFound,
    #[error("external repository inbound job {job_id} could not be loaded")]
    Persistence {
        job_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

pub(super) async fn job_by_id(
    db: &PgPool,
    job_id: Uuid,
) -> Result<ExternalRepositoryInboundJob, JobLookupError> {
    persistence::inbound_job(db, job_id)
        .await
        .map_err(|source| JobLookupError::Persistence { job_id, source })?
        .map(inbound_job)
        .ok_or(JobLookupError::NotFound)
}

pub(in crate::external_repositories) async fn latest_inbound_job(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Option<ExternalRepositoryInboundJob>, sqlx::Error> {
    persistence::latest_inbound_job(db, project_id)
        .await
        .map(|record| record.map(inbound_job))
}

fn inbound_job(record: persistence::InboundJobRecord) -> ExternalRepositoryInboundJob {
    let next_retry_at = if record.state == ExternalGitJobState::RetryWait {
        record.next_attempt_at
    } else {
        None
    };
    ExternalRepositoryInboundJob {
        id: record.id,
        project_id: record.project_id,
        provider: record.provider_instance_id,
        operation: record.operation,
        source_branch: record.source_branch,
        state: record.state,
        phase: record.phase,
        attempt_count: record.attempt_count,
        remote_sha: record.remote_sha,
        last_error: record.last_error,
        next_retry_at,
        created_at: record.created_at,
        updated_at: record.updated_at,
        completed_at: record.completed_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::external_repositories::{
        ExternalGitInboundOperation, ExternalGitInboundPhase, ProviderInstanceId,
    };
    use chrono::Utc;

    fn inbound_job_record(
        state: ExternalGitJobState,
        next_attempt_at: chrono::DateTime<Utc>,
    ) -> Result<
        persistence::InboundJobRecord,
        crate::external_repositories::provider::InvalidProviderInstanceId,
    > {
        Ok(persistence::InboundJobRecord {
            id: Uuid::nil(),
            project_id: Uuid::nil(),
            provider_instance_id: "gitlab".parse::<ProviderInstanceId>()?,
            operation: ExternalGitInboundOperation::Sync,
            source_branch: "main".to_string(),
            state,
            phase: ExternalGitInboundPhase::Queued,
            attempt_count: 0,
            remote_sha: None,
            last_error: None,
            next_attempt_at: Some(next_attempt_at),
            created_at: next_attempt_at,
            updated_at: next_attempt_at,
            completed_at: None,
        })
    }

    #[test]
    fn inbound_job_exposes_retry_time_only_while_waiting_to_retry(
    ) -> Result<(), crate::external_repositories::provider::InvalidProviderInstanceId> {
        let next_attempt_at = Utc::now();
        let pending = inbound_job(inbound_job_record(
            ExternalGitJobState::Pending,
            next_attempt_at,
        )?);
        assert_eq!(pending.next_retry_at, None);

        let retry_wait = inbound_job(inbound_job_record(
            ExternalGitJobState::RetryWait,
            next_attempt_at,
        )?);
        assert_eq!(retry_wait.next_retry_at, Some(next_attempt_at));
        Ok(())
    }
}
