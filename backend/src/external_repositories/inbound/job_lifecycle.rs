//! Claiming and transitioning inbound jobs executed by the background worker.

use super::super::provider::ProviderInstanceId;
use super::persistence::{self, ClaimedInboundJob};
use super::{ExternalGitInboundPhase, ExternalGitJobState};
use crate::external_repositories::{ExternalGitCommandFailureKind, ExternalGitFailureCode};
use chrono::Utc;
use sqlx::{PgConnection, PgPool};
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum InboundFailurePolicy {
    PreserveProcessingLease,
    PauseForReauthorization,
    Retry { phase: ExternalGitInboundPhase },
    Fail { phase: ExternalGitInboundPhase },
}

#[derive(Debug)]
pub(super) struct InboundFailure {
    policy: InboundFailurePolicy,
    error_code: ExternalGitFailureCode,
}

#[derive(Debug, Eq, PartialEq)]
enum InboundFailureTransition {
    PreserveProcessingLease,
    Record {
        state: ExternalGitJobState,
        retry_phase: ExternalGitInboundPhase,
        next_attempt_at: chrono::DateTime<Utc>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum InboundFailurePersistence {
    Recorded,
    ProcessingLeasePreserved,
}

impl InboundFailure {
    pub(super) const fn from_command(
        kind: ExternalGitCommandFailureKind,
        error_code: ExternalGitFailureCode,
    ) -> Self {
        let policy = match kind {
            ExternalGitCommandFailureKind::ReauthRequired => {
                InboundFailurePolicy::PauseForReauthorization
            }
            ExternalGitCommandFailureKind::Retryable => InboundFailurePolicy::Retry {
                phase: ExternalGitInboundPhase::Queued,
            },
            ExternalGitCommandFailureKind::Forbidden | ExternalGitCommandFailureKind::Conflict => {
                InboundFailurePolicy::Fail {
                    phase: ExternalGitInboundPhase::Queued,
                }
            }
        };
        Self { policy, error_code }
    }

    pub(super) const fn retryable(error_code: ExternalGitFailureCode) -> Self {
        Self {
            policy: InboundFailurePolicy::Retry {
                phase: ExternalGitInboundPhase::Queued,
            },
            error_code,
        }
    }

    pub(super) const fn terminal(error_code: ExternalGitFailureCode) -> Self {
        Self {
            policy: InboundFailurePolicy::Fail {
                phase: ExternalGitInboundPhase::Queued,
            },
            error_code,
        }
    }

    pub(super) const fn retryable_from_revision(error_code: ExternalGitFailureCode) -> Self {
        Self {
            policy: InboundFailurePolicy::Retry {
                phase: ExternalGitInboundPhase::Revision,
            },
            error_code,
        }
    }

    pub(super) const fn ambiguous_apply() -> Self {
        Self {
            policy: InboundFailurePolicy::PreserveProcessingLease,
            error_code: ExternalGitFailureCode::RepositoryApplyFailed,
        }
    }

    pub(super) const fn code(&self) -> ExternalGitFailureCode {
        self.error_code
    }

    #[cfg(test)]
    pub(super) const fn policy(&self) -> InboundFailurePolicy {
        self.policy
    }

    fn transition(
        &self,
        attempt_count: i32,
        now: chrono::DateTime<Utc>,
    ) -> InboundFailureTransition {
        match self.policy {
            InboundFailurePolicy::PreserveProcessingLease => {
                InboundFailureTransition::PreserveProcessingLease
            }
            InboundFailurePolicy::PauseForReauthorization => InboundFailureTransition::Record {
                state: ExternalGitJobState::Paused,
                retry_phase: ExternalGitInboundPhase::Queued,
                next_attempt_at: now,
            },
            InboundFailurePolicy::Retry { phase } => InboundFailureTransition::Record {
                state: ExternalGitJobState::RetryWait,
                retry_phase: phase,
                next_attempt_at: now
                    + chrono::Duration::seconds(retry_delay_seconds(attempt_count)),
            },
            InboundFailurePolicy::Fail { phase } => InboundFailureTransition::Record {
                state: ExternalGitJobState::Failed,
                retry_phase: phase,
                next_attempt_at: now,
            },
        }
    }
}

fn retry_delay_seconds(attempt_count: i32) -> i64 {
    match attempt_count {
        ..=1 => 10,
        2 => 60,
        3 => 300,
        4 => 1_800,
        _ => 3_600,
    }
}

pub(in crate::external_repositories) async fn resume_reauthorized_jobs(
    connection: &mut PgConnection,
    user_id: Uuid,
    provider: &ProviderInstanceId,
    now: chrono::DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    persistence::resume_reauthorized_jobs(connection, user_id, provider, now).await
}

pub(in crate::external_repositories) async fn active_job_exists(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<bool, sqlx::Error> {
    persistence::active_job_exists(connection, project_id).await
}

#[derive(Clone, Copy, Debug)]
pub(super) enum CompleteInboundJobPersistenceStage {
    Begin,
    CompleteJob,
    ClearImportError,
    Commit,
}

#[derive(Debug, Error)]
pub(super) enum CompleteInboundJobError {
    #[error("inbound job {job_id} is no longer processing")]
    NotProcessing { job_id: Uuid },
    #[error("inbound job completion failed during {stage:?} for job {job_id}")]
    Persistence {
        stage: CompleteInboundJobPersistenceStage,
        job_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

pub(super) async fn complete_job(
    db: &PgPool,
    job_id: Uuid,
    project_id: Uuid,
) -> Result<(), CompleteInboundJobError> {
    let now = Utc::now();
    let mut transaction =
        db.begin()
            .await
            .map_err(|source| CompleteInboundJobError::Persistence {
                stage: CompleteInboundJobPersistenceStage::Begin,
                job_id,
                source,
            })?;
    let completed = persistence::complete_job(&mut transaction, job_id, now)
        .await
        .map_err(|source| CompleteInboundJobError::Persistence {
            stage: CompleteInboundJobPersistenceStage::CompleteJob,
            job_id,
            source,
        })?;
    if !completed {
        return Err(CompleteInboundJobError::NotProcessing { job_id });
    }
    persistence::clear_last_import_error(&mut transaction, project_id, now)
        .await
        .map_err(|source| CompleteInboundJobError::Persistence {
            stage: CompleteInboundJobPersistenceStage::ClearImportError,
            job_id,
            source,
        })?;
    transaction
        .commit()
        .await
        .map_err(|source| CompleteInboundJobError::Persistence {
            stage: CompleteInboundJobPersistenceStage::Commit,
            job_id,
            source,
        })?;
    Ok(())
}

pub(super) async fn record_failure(
    db: &PgPool,
    claimed: &ClaimedInboundJob,
    failure: &InboundFailure,
) -> Result<InboundFailurePersistence, sqlx::Error> {
    let now = Utc::now();
    let InboundFailureTransition::Record {
        state,
        retry_phase,
        next_attempt_at,
    } = failure.transition(claimed.attempt_count, now)
    else {
        return Ok(InboundFailurePersistence::ProcessingLeasePreserved);
    };
    let mut transaction = db.begin().await?;
    let job_updated = persistence::fail_job(
        &mut transaction,
        claimed.id,
        state,
        retry_phase,
        next_attempt_at,
        failure.error_code,
        now,
    )
    .await?;
    if !job_updated {
        transaction.commit().await?;
        return Ok(InboundFailurePersistence::Recorded);
    }
    persistence::update_link_import_error(
        &mut transaction,
        claimed.project_id,
        failure.error_code,
        now,
    )
    .await?;
    transaction.commit().await?;
    Ok(InboundFailurePersistence::Recorded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_failures_map_to_closed_lifecycle_policies() {
        assert_eq!(
            InboundFailure::from_command(
                ExternalGitCommandFailureKind::ReauthRequired,
                ExternalGitFailureCode::GitAuthorizationRequired,
            )
            .policy(),
            InboundFailurePolicy::PauseForReauthorization
        );
        assert_eq!(
            InboundFailure::from_command(
                ExternalGitCommandFailureKind::Retryable,
                ExternalGitFailureCode::GitProviderUnavailable,
            )
            .policy(),
            InboundFailurePolicy::Retry {
                phase: ExternalGitInboundPhase::Queued,
            }
        );
        assert_eq!(
            InboundFailure::from_command(
                ExternalGitCommandFailureKind::Conflict,
                ExternalGitFailureCode::CheckpointBranchMoved,
            )
            .policy(),
            InboundFailurePolicy::Fail {
                phase: ExternalGitInboundPhase::Queued,
            }
        );
    }

    #[test]
    fn retry_transitions_preserve_the_resume_phase_and_bound_backoff() {
        let now = Utc::now();
        let failure = InboundFailure::retryable_from_revision(
            ExternalGitFailureCode::RepositoryRevisionFailed,
        );
        assert_eq!(
            failure.transition(99, now),
            InboundFailureTransition::Record {
                state: ExternalGitJobState::RetryWait,
                retry_phase: ExternalGitInboundPhase::Revision,
                next_attempt_at: now + chrono::Duration::seconds(3_600),
            }
        );
    }

    #[test]
    fn ambiguous_apply_preserves_the_processing_lease() {
        assert!(matches!(
            InboundFailure::ambiguous_apply().transition(1, Utc::now()),
            InboundFailureTransition::PreserveProcessingLease
        ));
    }
}
