//! OIDC group-to-organization mapping values owned by Identity and Access.

use super::OrganizationRole;
use chrono::{DateTime, Utc};
use uuid::Uuid;

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct OrgGroupRoleMapping {
    pub organization_id: Uuid,
    pub group_name: String,
    pub role: OrganizationRole,
    pub granted_at: DateTime<Utc>,
}
