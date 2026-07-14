//! Authentication policy values owned by Identity and Access.

use crate::text_enum::text_enum;
use chrono::{DateTime, Utc};

#[derive(Clone)]
pub(crate) struct OidcProviderDefaults {
    pub provider_id: String,
    pub provider_display_name: String,
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
    pub groups_claim: String,
}

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum AnonymousMode {
        Off => "off",
        ReadOnly => "read_only",
        ReadWriteNamed => "read_write_named",
    }
}

impl AnonymousMode {
    pub const fn allows_read(self) -> bool {
        matches!(self, Self::ReadOnly | Self::ReadWriteNamed)
    }

    pub const fn allows_guest_write(self) -> bool {
        matches!(self, Self::ReadWriteNamed)
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct AuthSettings {
    pub allow_local_login: bool,
    pub allow_local_registration: bool,
    pub allow_oidc: bool,
    pub anonymous_mode: AnonymousMode,
    pub site_name: String,
    pub announcement: String,
    #[schema(required)]
    pub oidc_issuer: Option<String>,
    #[schema(required)]
    pub oidc_client_id: Option<String>,
    #[schema(required)]
    pub oidc_client_secret: Option<String>,
    #[schema(required)]
    pub oidc_redirect_uri: Option<String>,
    pub oidc_groups_claim: String,
    pub updated_at: DateTime<Utc>,
}

#[cfg(test)]
mod tests {
    use super::AnonymousMode;

    #[test]
    fn anonymous_mode_uses_canonical_wire_names() -> Result<(), serde_json::Error> {
        assert_eq!(
            serde_json::to_string(&AnonymousMode::ReadWriteNamed)?,
            "\"read_write_named\""
        );
        assert_eq!("read-write".parse::<AnonymousMode>(), Err(()));
        Ok(())
    }
}
