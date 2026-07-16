//! Project sharing read contracts owned by Identity and Access.

use super::{ProjectPermission, ProjectRole};
use chrono::{DateTime, Utc};
use uuid::Uuid;

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ProjectShareLink {
    pub id: Uuid,
    pub project_id: Uuid,
    pub token_prefix: String,
    pub token_value: String,
    pub permission: ProjectPermission,
    #[schema(required)]
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    #[schema(required)]
    pub expires_at: Option<DateTime<Utc>>,
    #[schema(required)]
    pub revoked_at: Option<DateTime<Utc>>,
}

pub(crate) struct ShareLinkMutation {
    pub link: ProjectShareLink,
    pub token: String,
    pub inserted: bool,
}

pub(crate) struct JoinedProjectShareLink {
    pub project_id: Uuid,
    pub role: ProjectRole,
    pub permission: ProjectPermission,
}

pub(crate) struct ResolvedProjectShareLink {
    pub project_id: Uuid,
    pub permission: ProjectPermission,
}

pub(crate) struct TemporaryShareSession {
    pub project_id: Uuid,
    pub session_token: String,
    pub session_id: Uuid,
    pub display_name: String,
    pub permission: ProjectPermission,
}
