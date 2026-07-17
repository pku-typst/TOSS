use super::connection::ProviderAccessTokenError;
use super::git_command::{
    run_authenticated_external_git_command, ExternalGitCommandError, ExternalGitCommandFailureKind,
};
use super::provider::ExternalGitGateway;
use super::ExternalGitFailureCode;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub(crate) enum ExternalGitCommandFailure {
    #[error("external Git credentials are unavailable")]
    Credential {
        #[source]
        source: ProviderAccessTokenError,
    },
    #[error("external Git command failed")]
    Command {
        #[source]
        source: ExternalGitCommandError,
    },
}

impl ExternalGitCommandFailure {
    fn interrupted() -> Self {
        Self::Command {
            source: ExternalGitCommandError::Interrupted,
        }
    }

    pub(crate) const fn kind(&self) -> ExternalGitCommandFailureKind {
        match self {
            Self::Credential { source } => match source {
                ProviderAccessTokenError::NotConnected
                | ProviderAccessTokenError::ReauthorizationRequired => {
                    ExternalGitCommandFailureKind::ReauthRequired
                }
                ProviderAccessTokenError::NotConfigured
                | ProviderAccessTokenError::Persistence { .. }
                | ProviderAccessTokenError::Cipher { .. }
                | ProviderAccessTokenError::RefreshUnavailable { .. }
                | ProviderAccessTokenError::InvalidRefreshResponse { .. }
                | ProviderAccessTokenError::ConcurrentRefreshUnavailable => {
                    ExternalGitCommandFailureKind::Retryable
                }
            },
            Self::Command { source } => source.kind(),
        }
    }

    pub(crate) const fn code(&self) -> ExternalGitFailureCode {
        match self {
            Self::Credential { source } => match source {
                ProviderAccessTokenError::NotConnected
                | ProviderAccessTokenError::ReauthorizationRequired => {
                    ExternalGitFailureCode::GitAuthorizationRequired
                }
                ProviderAccessTokenError::NotConfigured
                | ProviderAccessTokenError::Persistence { .. }
                | ProviderAccessTokenError::Cipher { .. }
                | ProviderAccessTokenError::RefreshUnavailable { .. }
                | ProviderAccessTokenError::InvalidRefreshResponse { .. }
                | ProviderAccessTokenError::ConcurrentRefreshUnavailable => {
                    ExternalGitFailureCode::GitProviderUnavailable
                }
            },
            Self::Command { source } => source.code(),
        }
    }

    pub(crate) const fn requires_reauthorization(&self) -> bool {
        match self {
            Self::Credential { source } => matches!(
                source,
                ProviderAccessTokenError::ReauthorizationRequired
                    | ProviderAccessTokenError::NotConnected
            ),
            Self::Command { source } => source.requires_reauthorization(),
        }
    }
}

impl ExternalGitGateway<'_> {
    pub(crate) async fn run_command(
        &self,
        user_id: Uuid,
        repo_path: &str,
        args: &[String],
        timeout_seconds: u64,
    ) -> Result<String, ExternalGitCommandFailure> {
        let drain = self.drain_signal();
        let authorization = tokio::select! {
            biased;
            _ = drain.triggered() => return Err(ExternalGitCommandFailure::interrupted()),
            result = self.git_http_authorization(user_id, false) => {
                result.map_err(|source| ExternalGitCommandFailure::Credential { source })?
            }
        };
        match run_authenticated_external_git_command(
            repo_path,
            &authorization,
            args,
            timeout_seconds,
            drain.clone(),
        )
        .await
        .map_err(|source| ExternalGitCommandFailure::Command { source })
        {
            Err(error) if error.requires_reauthorization() => {
                let refreshed = tokio::select! {
                    biased;
                    _ = drain.triggered() => return Err(ExternalGitCommandFailure::interrupted()),
                    result = self.git_http_authorization(user_id, true) => {
                        result.map_err(|source| ExternalGitCommandFailure::Credential { source })?
                    }
                };
                let result = run_authenticated_external_git_command(
                    repo_path,
                    &refreshed,
                    args,
                    timeout_seconds,
                    drain,
                )
                .await
                .map_err(|source| ExternalGitCommandFailure::Command { source });
                if matches!(
                    &result,
                    Err(error) if error.requires_reauthorization()
                ) {
                    self.mark_reauthorization_required(user_id, "git_rejected_refreshed_token")
                        .await;
                }
                result
            }
            result => result,
        }
    }
}
