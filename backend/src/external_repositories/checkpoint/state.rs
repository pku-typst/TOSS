//! Outbound checkpoint queue state and processing phase.

use crate::text_enum::text_enum;

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum ExternalGitCheckpointState {
        Pending => "pending",
        Processing => "processing",
        RetryWait => "retry_wait",
        Paused => "paused",
    }
}

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum ExternalGitCheckpointPhase {
        Queued => "queued",
        Snapshot => "snapshot",
        CommitLocal => "commit_local",
        PushGit => "push_git",
    }
}
