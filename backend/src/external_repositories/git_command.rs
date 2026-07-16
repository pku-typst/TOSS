//! Hardened Git subprocess execution shared by provider adapters and workers.

use super::provider::GitHttpAuthorization;
use super::ExternalGitFailureCode;
use std::env;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;
use thiserror::Error;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ExternalGitCommandFailureKind {
    ReauthRequired,
    Forbidden,
    Conflict,
    Retryable,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum GitCommandSetupOperation {
    CreateAskpassDirectory,
    WriteAskpassScript,
    ReadAskpassPermissions,
    SetAskpassPermissions,
}

#[derive(Debug, Error)]
pub(crate) enum ExternalGitCommandError {
    #[error("external Git authorization is required")]
    AuthorizationRequired,
    #[error("external Git operation was forbidden")]
    PermissionDenied,
    #[error("external Git repository was not found")]
    RepositoryNotFound,
    #[error("external Git branch moved")]
    BranchMoved,
    #[error("external Git command setup failed during {operation:?}")]
    Setup {
        operation: GitCommandSetupOperation,
        #[source]
        source: std::io::Error,
    },
    #[error("external Git process could not be started")]
    Spawn {
        #[source]
        source: std::io::Error,
    },
    #[error("external Git command timed out after {timeout_seconds} seconds")]
    Timeout { timeout_seconds: u64 },
    #[error("external Git remote rejected the command with exit status {exit_status:?}")]
    RemoteRejected { exit_status: Option<i32> },
}

impl ExternalGitCommandError {
    pub(crate) const fn kind(&self) -> ExternalGitCommandFailureKind {
        match self {
            Self::AuthorizationRequired => ExternalGitCommandFailureKind::ReauthRequired,
            Self::PermissionDenied | Self::RepositoryNotFound => {
                ExternalGitCommandFailureKind::Forbidden
            }
            Self::BranchMoved => ExternalGitCommandFailureKind::Conflict,
            Self::Setup { .. }
            | Self::Spawn { .. }
            | Self::Timeout { .. }
            | Self::RemoteRejected { .. } => ExternalGitCommandFailureKind::Retryable,
        }
    }

    pub(crate) const fn code(&self) -> ExternalGitFailureCode {
        match self {
            Self::AuthorizationRequired => ExternalGitFailureCode::GitAuthorizationRequired,
            Self::PermissionDenied => ExternalGitFailureCode::GitPermissionDenied,
            Self::RepositoryNotFound => ExternalGitFailureCode::GitRepositoryNotFound,
            Self::BranchMoved => ExternalGitFailureCode::CheckpointBranchMoved,
            Self::Setup { .. } | Self::Spawn { .. } => ExternalGitFailureCode::GitCommandFailed,
            Self::Timeout { .. } => ExternalGitFailureCode::GitCommandTimeout,
            Self::RemoteRejected { .. } => ExternalGitFailureCode::GitProviderUnavailable,
        }
    }

    pub(crate) const fn requires_reauthorization(&self) -> bool {
        matches!(self, Self::AuthorizationRequired)
    }
}

pub(crate) fn external_git_command_timeout_seconds() -> u64 {
    env::var("EXTERNAL_GIT_COMMAND_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value >= 30)
        .unwrap_or(600)
}

fn classify_git_failure(stderr: &str, exit_status: Option<i32>) -> ExternalGitCommandError {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("non-fast-forward")
        || lower.contains("fetch first")
        || lower.contains("failed to push some refs")
    {
        return ExternalGitCommandError::BranchMoved;
    }
    if lower.contains("authentication failed")
        || lower.contains("http basic: access denied")
        || lower.contains("could not read username")
    {
        return ExternalGitCommandError::AuthorizationRequired;
    }
    if lower.contains("repository not found") || lower.contains("requested url returned error: 404")
    {
        return ExternalGitCommandError::RepositoryNotFound;
    }
    if lower.contains("403") || lower.contains("forbidden") || lower.contains("not allowed to push")
    {
        return ExternalGitCommandError::PermissionDenied;
    }
    ExternalGitCommandError::RemoteRejected { exit_status }
}

pub(crate) async fn run_authenticated_external_git_command(
    repo_path: &str,
    authorization: &GitHttpAuthorization,
    args: &[String],
    timeout_seconds: u64,
) -> Result<String, ExternalGitCommandError> {
    let askpass_dir = tempfile::tempdir().map_err(|source| ExternalGitCommandError::Setup {
        operation: GitCommandSetupOperation::CreateAskpassDirectory,
        source,
    })?;
    let askpass_path = askpass_dir.path().join("git-askpass.sh");
    std::fs::write(
        &askpass_path,
        b"#!/bin/sh\ncase \"$1\" in\n  *sername*) printf '%s\\n' \"$EXTERNAL_GIT_USERNAME\" ;;\n  *) printf '%s\\n' \"$EXTERNAL_GIT_TOKEN\" ;;\nesac\n",
    )
    .map_err(|source| ExternalGitCommandError::Setup {
        operation: GitCommandSetupOperation::WriteAskpassScript,
        source,
    })?;
    let mut permissions = std::fs::metadata(&askpass_path)
        .map_err(|source| ExternalGitCommandError::Setup {
            operation: GitCommandSetupOperation::ReadAskpassPermissions,
            source,
        })?
        .permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&askpass_path, permissions).map_err(|source| {
        ExternalGitCommandError::Setup {
            operation: GitCommandSetupOperation::SetAskpassPermissions,
            source,
        }
    })?;

    let mut command = tokio::process::Command::new("git");
    command
        .arg("-C")
        .arg(repo_path)
        .arg("-c")
        .arg("credential.helper=")
        .arg("-c")
        .arg("http.lowSpeedLimit=1")
        .arg("-c")
        .arg("http.lowSpeedTime=300")
        .args(args)
        .env("GIT_ASKPASS", &askpass_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_LFS_SKIP_SMUDGE", "1")
        .env("EXTERNAL_GIT_USERNAME", &authorization.username)
        .env("EXTERNAL_GIT_TOKEN", &authorization.access_token)
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(timeout_seconds), command.output())
        .await
        .map_err(|_| ExternalGitCommandError::Timeout { timeout_seconds })?
        .map_err(|source| ExternalGitCommandError::Spawn { source })?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(classify_git_failure(&stderr, output.status.code()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_errors_are_classified_without_exposing_details() {
        assert_eq!(
            classify_git_failure("HTTP Basic: Access denied", Some(128)).kind(),
            ExternalGitCommandFailureKind::ReauthRequired
        );
        assert_eq!(
            classify_git_failure("rejected (non-fast-forward)", Some(1)).kind(),
            ExternalGitCommandFailureKind::Conflict
        );
        assert_eq!(
            classify_git_failure("The requested URL returned error: 403", Some(128)).kind(),
            ExternalGitCommandFailureKind::Forbidden
        );
        assert_eq!(
            classify_git_failure("connection timed out", Some(128)).kind(),
            ExternalGitCommandFailureKind::Retryable
        );
    }
}
