//! Provider authorization mode and persisted grant state.

use crate::text_enum::text_enum;

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum ExternalGitGrantStatus {
        Active => "active",
        ReauthRequired => "reauth_required",
        Revoked => "revoked",
    }
}

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum ExternalGitDisconnectRestriction {
        LinkedProjects => "linked_projects",
        LastLoginMethod => "last_login_method",
    }
}
