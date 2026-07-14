//! User authorization and credential access for external repository providers.

mod access_token;
mod authorization;
mod cipher;
mod disconnection;
mod grant;
mod persistence;
mod status;

pub(crate) use access_token::{
    mark_provider_reauth_required, provider_access_token, ProviderAccessTokenError,
};
pub(crate) use authorization::{
    complete_external_git_authorization, persist_external_git_grant, ExternalGitAuthorizationError,
    ExternalGitGrantInput, PersistExternalGitGrantError,
};
pub(crate) use disconnection::{disconnect_external_git_account, DisconnectExternalGitError};
pub(crate) use grant::{ExternalGitDisconnectRestriction, ExternalGitGrantStatus};
pub(crate) use status::{
    external_git_connection_status, external_git_user_id_for_provider_account,
    ExternalGitProviderMetadata, ExternalRepositoryConnectionStatus,
};
