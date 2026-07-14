//! Repository-link lifecycle and composed project status.

use crate::text_enum::text_enum;

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum ExternalGitLinkStatus {
        Linking => "linking",
        Active => "active",
        ReauthRequired => "reauth_required",
        Conflict => "conflict",
        Error => "error",
    }
}

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum ExternalGitProjectState {
        Unlinked => "unlinked",
        Linking => "linking",
        Active => "active",
        ReauthRequired => "reauth_required",
        Conflict => "conflict",
        Error => "error",
        Syncing => "syncing",
        RetryWait => "retry_wait",
        Pending => "pending",
        Dirty => "dirty",
    }
}

impl From<ExternalGitLinkStatus> for ExternalGitProjectState {
    fn from(status: ExternalGitLinkStatus) -> Self {
        match status {
            ExternalGitLinkStatus::Linking => Self::Linking,
            ExternalGitLinkStatus::Active => Self::Active,
            ExternalGitLinkStatus::ReauthRequired => Self::ReauthRequired,
            ExternalGitLinkStatus::Conflict => Self::Conflict,
            ExternalGitLinkStatus::Error => Self::Error,
        }
    }
}
