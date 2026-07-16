//! Atomic terminal transitions for an outbound checkpoint attempt.

use super::persistence::{self, ClaimedCheckpoint};
use super::ExternalGitCheckpointState;
use crate::external_repositories::{
    ExternalGitCommandFailureKind, ExternalGitFailureCode, ExternalGitLinkStatus,
};
use chrono::Utc;
use sqlx::PgPool;
use uuid::Uuid;

pub(super) struct CheckpointFailure {
    project_id: Uuid,
    attempt_count: i32,
    kind: ExternalGitCommandFailureKind,
    error_code: ExternalGitFailureCode,
}

struct CheckpointFailureTransition {
    queue_state: ExternalGitCheckpointState,
    link_status: ExternalGitLinkStatus,
    next_attempt_at: chrono::DateTime<Utc>,
}

impl CheckpointFailure {
    pub(super) fn from_claim(
        claimed: &ClaimedCheckpoint,
        kind: ExternalGitCommandFailureKind,
        error_code: ExternalGitFailureCode,
    ) -> Self {
        Self {
            project_id: claimed.project_id,
            attempt_count: claimed.attempt_count,
            kind,
            error_code,
        }
    }

    fn transition(&self, now: chrono::DateTime<Utc>) -> CheckpointFailureTransition {
        let (queue_state, link_status, next_attempt_at) = match self.kind {
            ExternalGitCommandFailureKind::ReauthRequired => (
                ExternalGitCheckpointState::Paused,
                ExternalGitLinkStatus::ReauthRequired,
                now,
            ),
            ExternalGitCommandFailureKind::Forbidden => (
                ExternalGitCheckpointState::Paused,
                ExternalGitLinkStatus::Error,
                now,
            ),
            ExternalGitCommandFailureKind::Conflict => (
                ExternalGitCheckpointState::Paused,
                ExternalGitLinkStatus::Conflict,
                now,
            ),
            ExternalGitCommandFailureKind::Retryable => (
                ExternalGitCheckpointState::RetryWait,
                ExternalGitLinkStatus::Error,
                now + chrono::Duration::seconds(retry_delay_seconds(self.attempt_count)),
            ),
        };
        CheckpointFailureTransition {
            queue_state,
            link_status,
            next_attempt_at,
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

pub(super) async fn complete_checkpoint(
    db: &PgPool,
    project_id: Uuid,
    workspace_version: i64,
    remote_sha: &str,
) -> Result<(), sqlx::Error> {
    let mut transaction = db.begin().await?;
    persistence::complete_checkpoint(
        &mut transaction,
        project_id,
        workspace_version,
        remote_sha,
        Utc::now(),
    )
    .await?;
    transaction.commit().await
}

pub(super) async fn fail_checkpoint(
    db: &PgPool,
    failure: CheckpointFailure,
) -> Result<(), sqlx::Error> {
    let now = Utc::now();
    let transition = failure.transition(now);
    let mut transaction = db.begin().await?;
    persistence::fail_checkpoint(
        &mut transaction,
        failure.project_id,
        transition.queue_state,
        transition.link_status,
        transition.next_attempt_at,
        failure.error_code,
        now,
    )
    .await?;
    transaction.commit().await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transition(
        kind: ExternalGitCommandFailureKind,
        attempt_count: i32,
        now: chrono::DateTime<Utc>,
    ) -> CheckpointFailureTransition {
        CheckpointFailure::from_claim(
            &ClaimedCheckpoint {
                project_id: Uuid::new_v4(),
                attempt_count,
            },
            kind,
            ExternalGitFailureCode::GitCheckpointFailed,
        )
        .transition(now)
    }

    #[test]
    fn failures_choose_only_valid_queue_and_link_state_pairs() {
        let now = Utc::now();
        let reauth = transition(ExternalGitCommandFailureKind::ReauthRequired, 1, now);
        assert_eq!(reauth.queue_state, ExternalGitCheckpointState::Paused);
        assert_eq!(reauth.link_status, ExternalGitLinkStatus::ReauthRequired);
        assert_eq!(reauth.next_attempt_at, now);

        let forbidden = transition(ExternalGitCommandFailureKind::Forbidden, 1, now);
        assert_eq!(forbidden.queue_state, ExternalGitCheckpointState::Paused);
        assert_eq!(forbidden.link_status, ExternalGitLinkStatus::Error);

        let conflict = transition(ExternalGitCommandFailureKind::Conflict, 1, now);
        assert_eq!(conflict.queue_state, ExternalGitCheckpointState::Paused);
        assert_eq!(conflict.link_status, ExternalGitLinkStatus::Conflict);
    }

    #[test]
    fn retryable_failures_use_a_bounded_backoff() {
        let now = Utc::now();
        let first = transition(ExternalGitCommandFailureKind::Retryable, 1, now);
        assert_eq!(first.queue_state, ExternalGitCheckpointState::RetryWait);
        assert_eq!(first.link_status, ExternalGitLinkStatus::Error);
        assert_eq!(first.next_attempt_at, now + chrono::Duration::seconds(10));

        let bounded = transition(ExternalGitCommandFailureKind::Retryable, 99, now);
        assert_eq!(
            bounded.next_attempt_at,
            now + chrono::Duration::seconds(3_600)
        );
    }
}
