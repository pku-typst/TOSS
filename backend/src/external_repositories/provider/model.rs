use crate::text_enum::text_enum;
use chrono::{DateTime, Utc};
use std::fmt;
use std::str::FromStr;
use thiserror::Error;

#[derive(
    Clone,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
    serde::Deserialize,
    serde::Serialize,
    sqlx::Type,
    utoipa::ToSchema,
)]
#[serde(transparent)]
#[sqlx(transparent)]
#[schema(value_type = String)]
pub(crate) struct ProviderInstanceId(String);

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
#[error("provider instance ID is invalid")]
pub(crate) struct InvalidProviderInstanceId;

impl ProviderInstanceId {
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl FromStr for ProviderInstanceId {
    type Err = InvalidProviderInstanceId;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let bytes = value.as_bytes();
        let valid = (1..=64).contains(&bytes.len())
            && bytes
                .first()
                .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
            && bytes
                .last()
                .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
            && bytes
                .iter()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-');
        valid
            .then(|| Self(value.to_string()))
            .ok_or(InvalidProviderInstanceId)
    }
}

impl fmt::Display for ProviderInstanceId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

text_enum! {
    pub enum ProviderKind {
        GitHub => "github",
        GitLab => "gitlab",
        Gitea => "gitea",
        Forgejo => "forgejo",
    }
}

text_enum! {
    pub enum ProviderBrand {
        Identity => "identity",
        GitHub => "github",
        GitLab => "gitlab",
        Gitea => "gitea",
        Forgejo => "forgejo",
        Codeberg => "codeberg",
    }
}

impl ProviderBrand {
    pub(crate) const fn supports(self, kind: ProviderKind) -> bool {
        matches!(
            (self, kind),
            (Self::GitHub, ProviderKind::GitHub)
                | (Self::GitLab, ProviderKind::GitLab)
                | (Self::Gitea, ProviderKind::Gitea)
                | (Self::Forgejo | Self::Codeberg, ProviderKind::Forgejo)
        )
    }
}

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum ExternalGitRepositoryVisibility {
        Private => "private",
        Internal => "internal",
        Public => "public",
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProviderIdentity {
    pub account_id: String,
    pub username: String,
    pub name: Option<String>,
    pub email: Option<String>,
}

pub(crate) struct ProviderLoginProfile {
    pub identity: ProviderIdentity,
    pub verified_email: String,
}

pub(crate) struct RefreshedToken {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<i64>,
    pub scopes: Vec<String>,
}

pub(crate) struct ProviderAuthorizationGrant {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub refresh_redirect_uri: String,
    pub expires_in: Option<i64>,
    pub scopes: Vec<String>,
}

#[derive(Debug, Error)]
pub(crate) enum ProviderAuthorizationError {
    #[error("external Git provider does not support separate authorization")]
    NotSupported,
    #[error("external Git authorization endpoint is invalid")]
    InvalidEndpoint {
        #[source]
        source: url::ParseError,
    },
    #[error("external Git authorization request failed")]
    Transport {
        #[source]
        source: reqwest::Error,
    },
    #[error("external Git authorization was rejected with status {status}: {reason:?}")]
    Rejected {
        status: reqwest::StatusCode,
        reason: ProviderAuthorizationRejection,
    },
    #[error("external Git authorization endpoint returned status {status}")]
    UnexpectedStatus { status: reqwest::StatusCode },
    #[error("external Git authorization response was invalid")]
    InvalidResponse {
        #[source]
        source: reqwest::Error,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProviderAuthorizationRejection {
    AccessDenied,
    InvalidClient,
    InvalidGrant,
    RedirectUriMismatch,
    Unclassified,
}

pub(crate) struct GitHttpAuthorization {
    pub username: String,
    pub access_token: String,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ExternalGitProviderCapabilities {
    pub repository_creation: bool,
    pub supported_visibilities: Vec<ExternalGitRepositoryVisibility>,
}

#[derive(Debug, Error)]
pub(crate) enum ProviderIdentityError {
    #[error("external Git identity request failed")]
    Transport {
        #[source]
        source: reqwest::Error,
    },
    #[error("external Git identity request for {resource:?} was rejected with status {status}")]
    Rejected {
        resource: ProviderIdentityResource,
        status: reqwest::StatusCode,
    },
    #[error("external Git identity response was invalid")]
    InvalidResponse {
        #[source]
        source: reqwest::Error,
    },
    #[error("external Git provider account has no verified primary email")]
    VerifiedEmailUnavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProviderIdentityResource {
    Profile,
    VerifiedEmails,
}

#[derive(Debug, Error)]
pub(crate) enum RefreshTokenError {
    #[error("external Git refresh token was rejected with status {status}")]
    Rejected { status: reqwest::StatusCode },
    #[error("external Git token refresh request failed")]
    Transport {
        #[source]
        source: reqwest::Error,
    },
    #[error("external Git token refresh endpoint returned status {status}")]
    UnexpectedStatus { status: reqwest::StatusCode },
    #[error("external Git token refresh response was invalid")]
    InvalidResponse {
        #[source]
        source: reqwest::Error,
    },
}

text_enum! {
    pub enum RepositoryOwnerKind {
        User => "user",
        Organization => "organization",
    }
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, utoipa::ToSchema)]
pub(crate) struct RepositoryOwner {
    pub id: String,
    pub name: String,
    pub path: String,
    pub kind: RepositoryOwnerKind,
    pub full_path: String,
    pub web_url: String,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, utoipa::ToSchema)]
pub(crate) struct RemoteRepository {
    pub id: String,
    pub name: String,
    pub path: String,
    pub full_path: String,
    pub default_branch: Option<String>,
    pub visibility: ExternalGitRepositoryVisibility,
    pub web_url: String,
    pub archived: bool,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) enum RepositoryAccess {
    None,
    Read,
    Write,
    Maintain,
    Admin,
}

impl RepositoryAccess {
    pub const fn can_write(self) -> bool {
        matches!(self, Self::Write | Self::Maintain | Self::Admin)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RemoteRepositoryDetails {
    pub repository: RemoteRepository,
    pub clone_url: String,
    pub access: RepositoryAccess,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, utoipa::ToSchema)]
pub(crate) struct RemoteBranch {
    pub name: String,
    pub default: bool,
    pub protected: bool,
    pub commit_sha: String,
    pub committed_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProviderPage<T> {
    pub items: Vec<T>,
    pub next_page: Option<u32>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProviderListQuery {
    pub search: Option<String>,
    pub page: u32,
    pub per_page: u32,
}

pub(super) struct CreateRemoteRepository {
    pub(super) name: String,
    pub(super) path: String,
    pub(super) owner_id: String,
    pub(super) owner_kind: RepositoryOwnerKind,
    pub(super) visibility: ExternalGitRepositoryVisibility,
    pub(super) initialize: bool,
}

#[cfg(test)]
mod tests {
    use super::{ExternalGitRepositoryVisibility, ProviderBrand, ProviderInstanceId, ProviderKind};

    #[test]
    fn provider_instance_ids_are_stable_config_keys_not_adapter_kinds() {
        let github = "github".parse::<ProviderInstanceId>();
        assert!(github.is_ok());
        assert_eq!(github.map(|id| id.to_string()), Ok("github".to_string()));
        assert!("codeberg".parse::<ProviderInstanceId>().is_ok());
        assert!("engineering-gitlab".parse::<ProviderInstanceId>().is_ok());
        for invalid in [
            "",
            "GitHub",
            "-github",
            "github-",
            "git/hub",
            &"a".repeat(65),
        ] {
            assert!(invalid.parse::<ProviderInstanceId>().is_err());
        }
    }

    #[test]
    fn provider_kinds_are_closed_protocol_adapter_choices() {
        assert_eq!("github".parse(), Ok(ProviderKind::GitHub));
        assert_eq!("gitlab".parse(), Ok(ProviderKind::GitLab));
        assert_eq!("gitea".parse(), Ok(ProviderKind::Gitea));
        assert_eq!("forgejo".parse(), Ok(ProviderKind::Forgejo));
        assert!("codeberg".parse::<ProviderKind>().is_err());
    }

    #[test]
    fn provider_brand_is_explicit_and_distinct_from_adapter_kind() {
        assert!(ProviderBrand::Codeberg.supports(ProviderKind::Forgejo));
        assert!(!ProviderBrand::Codeberg.supports(ProviderKind::Gitea));
        assert!(!ProviderBrand::Identity.supports(ProviderKind::GitLab));
    }

    #[test]
    fn repository_visibility_rejects_aliases_and_unknown_values() {
        assert_eq!(
            "PRIVATE".parse::<ExternalGitRepositoryVisibility>(),
            Err(())
        );
        assert!(
            serde_json::from_str::<ExternalGitRepositoryVisibility>("\"private-repo\"").is_err()
        );
    }
}
