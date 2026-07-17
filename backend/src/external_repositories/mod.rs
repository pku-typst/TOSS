mod checkpoint;
mod command;
mod config;
mod connection;
mod connection_http;
mod failure_code;
mod git_command;
mod http_support;
mod inbound;
mod linking;
mod linking_http;
mod login;
mod oauth;
mod oauth_http;
mod provider;
mod reauthorization;
mod worker_runtime;

pub(crate) use checkpoint::{
    record_project_activity, request_external_git_checkpoint, ExternalGitCheckpointPhase,
    ExternalGitCheckpointState,
};
pub(crate) use command::ExternalGitCommandFailure;
pub(crate) use config::{external_git_provider_registry_from_config, ExternalGitConfigFile};
pub(crate) use connection::{ExternalGitGrantStatus, ExternalRepositoryConnectionStatus};
pub(crate) use connection_http::{
    disconnect_external_git, external_git_connection_status, list_external_git_repositories,
    list_external_git_repository_branches, list_external_git_repository_owners,
    ExternalGitBranchListResponse, ExternalGitRepositoryListResponse,
    ExternalGitRepositoryOwnerListResponse,
};
pub(crate) use failure_code::ExternalGitFailureCode;
pub(crate) use git_command::{external_git_command_timeout_seconds, ExternalGitCommandFailureKind};
pub(crate) use inbound::{
    create_external_git_import, get_external_git_inbound_job,
    list_linked_external_git_repository_branches, request_external_git_inbound_sync,
    CreateExternalGitImportInput, ExternalRepositoryInboundJob, RequestExternalGitInboundSyncInput,
};
pub(crate) use linking::{ExternalGitLinkStatus, ExternalRepositoryProjectStatus};
pub(crate) use linking_http::{
    create_external_git_repository, external_git_project_status, link_external_git_repository,
    unlink_external_git_repository, CreateExternalGitRepositoryInput,
    ExternalGitProjectLinkMutationResponse, LinkExternalGitRepositoryInput,
};
pub(crate) use oauth_http::{
    authorize_external_git, external_git_login, external_git_oauth_callback,
};
pub(crate) use provider::{
    ExternalGitGateway, ExternalGitProviderCapabilities, ExternalGitProviderRegistry,
    ExternalGitRepositoryVisibility, ProviderBrand, ProviderInstanceId, ProviderKind,
};
pub(crate) use worker_runtime::spawn_external_git_workers;

#[cfg(test)]
pub(crate) use inbound::{
    ExternalGitInboundOperation, ExternalGitInboundPhase, ExternalGitJobState,
};
#[cfg(test)]
pub(crate) use linking::ExternalGitProjectState;
#[cfg(test)]
pub(crate) use provider::RepositoryOwnerKind;
