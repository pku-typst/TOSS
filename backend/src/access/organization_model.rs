//! Organization membership values owned by Identity and Access.

use crate::text_enum::text_enum;
use chrono::{DateTime, Utc};
use uuid::Uuid;

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum OrganizationRole {
        Owner => "owner",
        Member => "member",
    }
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct OrganizationMembership {
    pub organization_id: Uuid,
    pub organization_name: String,
    pub membership_role: OrganizationRole,
    pub joined_at: DateTime<Utc>,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct Organization {
    pub id: Uuid,
    pub name: String,
    pub created_at: DateTime<Utc>,
}

impl OrganizationRole {
    pub const fn rank(self) -> u8 {
        match self {
            Self::Owner => 2,
            Self::Member => 1,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::OrganizationRole;

    #[test]
    fn organization_role_rejects_unknown_aliases() {
        assert_eq!("administrator".parse::<OrganizationRole>(), Err(()));
        assert!(serde_json::from_str::<OrganizationRole>("\"administrator\"").is_err());
    }
}
