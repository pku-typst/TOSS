//! Project grant values and read contracts owned by Identity and Access.

use crate::text_enum::text_enum;
use chrono::{DateTime, Utc};
use uuid::Uuid;

text_enum! {
    pub enum ProjectRole {
        Owner => "Owner",
        ReadWrite => "ReadWrite",
        ReadOnly => "ReadOnly",
    }
}

impl ProjectRole {
    pub const fn rank(self) -> u8 {
        match self {
            Self::Owner => 3,
            Self::ReadWrite => 2,
            Self::ReadOnly => 1,
        }
    }

    pub const fn access_type(self) -> ProjectAccessType {
        match self {
            Self::Owner => ProjectAccessType::Manage,
            Self::ReadWrite => ProjectAccessType::Write,
            Self::ReadOnly => ProjectAccessType::Read,
        }
    }
}

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum ProjectPermission {
        Read => "read",
        Write => "write",
    }
}

impl ProjectPermission {
    pub const fn project_role(self) -> ProjectRole {
        match self {
            Self::Read => ProjectRole::ReadOnly,
            Self::Write => ProjectRole::ReadWrite,
        }
    }

    pub const fn can_write(self) -> bool {
        matches!(self, Self::Write)
    }
}

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum ProjectAccessType {
        Read => "read",
        Write => "write",
        Manage => "manage",
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, sqlx::Type)]
#[sqlx(type_name = "text")]
pub(crate) enum ProjectRoleSource {
    #[sqlx(rename = "direct_role")]
    DirectRole,
    #[sqlx(rename = "share_link_invite")]
    ShareLinkInvite,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, serde::Serialize, utoipa::ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum ProjectAccessSource {
    DirectRole,
    ShareLinkInvite,
    Organization { name: String },
}

impl From<ProjectRoleSource> for ProjectAccessSource {
    fn from(source: ProjectRoleSource) -> Self {
        match source {
            ProjectRoleSource::DirectRole => Self::DirectRole,
            ProjectRoleSource::ShareLinkInvite => Self::ShareLinkInvite,
        }
    }
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ProjectRoleBinding {
    pub project_id: Uuid,
    pub user_id: Uuid,
    pub role: ProjectRole,
    pub granted_at: DateTime<Utc>,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ProjectGroupRoleBinding {
    pub project_id: Uuid,
    pub group_name: String,
    pub role: ProjectRole,
    pub granted_at: DateTime<Utc>,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ProjectOrganizationAccess {
    pub project_id: Uuid,
    pub organization_id: Uuid,
    pub organization_name: String,
    pub permission: ProjectPermission,
    #[schema(required)]
    pub granted_by: Option<Uuid>,
    pub granted_at: DateTime<Utc>,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ProjectAccessUser {
    pub user_id: Uuid,
    pub email: String,
    pub display_name: String,
    pub role: ProjectRole,
    pub access_type: ProjectAccessType,
    pub sources: Vec<ProjectAccessSource>,
}

#[cfg(test)]
mod tests {
    use super::{ProjectAccessSource, ProjectPermission, ProjectRole};

    #[test]
    fn grant_values_use_canonical_wire_names() -> Result<(), serde_json::Error> {
        assert_eq!(
            serde_json::to_string(&ProjectPermission::Write)?,
            "\"write\""
        );
        assert_eq!(
            serde_json::to_string(&ProjectRole::ReadWrite)?,
            "\"ReadWrite\""
        );
        assert_eq!("viewer".parse::<ProjectPermission>(), Err(()));
        assert_eq!("READ".parse::<ProjectPermission>(), Err(()));
        Ok(())
    }

    #[test]
    fn access_sources_use_a_tagged_wire_shape() -> Result<(), serde_json::Error> {
        assert_eq!(
            serde_json::to_value(ProjectAccessSource::DirectRole)?,
            serde_json::json!({ "kind": "direct_role" })
        );
        assert_eq!(
            serde_json::to_value(ProjectAccessSource::Organization {
                name: "NV Docs".to_string(),
            })?,
            serde_json::json!({ "kind": "organization", "name": "NV Docs" })
        );
        Ok(())
    }
}
