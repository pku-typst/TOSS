//! Hardened Git subprocess execution shared by provider adapters and workers.

use super::provider::GitHttpAuthorization;
use super::ExternalGitFailureCode;
use crate::native_process::{isolate_process_group, terminate_process_group};
use crate::process_lifecycle::DrainSignal;
use std::env;
use std::os::unix::fs::PermissionsExt;
use std::process::{Output, Stdio};
use std::time::Duration;
use thiserror::Error;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};

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
    #[error("external Git process execution failed")]
    Execution {
        #[source]
        source: std::io::Error,
    },
    #[error("external Git command was interrupted by process drain")]
    Interrupted,
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
            | Self::Execution { .. }
            | Self::Interrupted
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
            Self::Setup { .. }
            | Self::Spawn { .. }
            | Self::Execution { .. }
            | Self::Interrupted => ExternalGitFailureCode::GitCommandFailed,
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
    drain: DrainSignal,
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

    let mut command = Command::new("git");
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
    let output =
        execute_external_git_command(command, Duration::from_secs(timeout_seconds), drain).await?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(classify_git_failure(&stderr, output.status.code()))
}

async fn execute_external_git_command(
    mut command: Command,
    timeout: Duration,
    drain: DrainSignal,
) -> Result<Output, ExternalGitCommandError> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    isolate_process_group(&mut command);
    let mut child = command
        .spawn()
        .map_err(|source| ExternalGitCommandError::Spawn { source })?;
    enum Execution<T> {
        Complete(T),
        Interrupted,
    }
    let execution = {
        let child_execution = collect_child_output(&mut child);
        tokio::pin!(child_execution);
        tokio::select! {
            biased;
            _ = drain.triggered() => Execution::Interrupted,
            result = tokio::time::timeout(timeout, &mut child_execution) => Execution::Complete(result),
        }
    };
    match execution {
        Execution::Complete(Ok(Ok(output))) => Ok(output),
        Execution::Complete(Ok(Err(source))) => {
            terminate_process_group(&mut child).await;
            Err(ExternalGitCommandError::Execution { source })
        }
        Execution::Complete(Err(_)) => {
            terminate_process_group(&mut child).await;
            Err(ExternalGitCommandError::Timeout {
                timeout_seconds: timeout.as_secs(),
            })
        }
        Execution::Interrupted => {
            terminate_process_group(&mut child).await;
            Err(ExternalGitCommandError::Interrupted)
        }
    }
}

async fn collect_child_output(child: &mut Child) -> Result<Output, std::io::Error> {
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("external Git stdout pipe is unavailable"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| std::io::Error::other("external Git stderr pipe is unavailable"))?;
    let read_stdout = async move {
        let mut output = Vec::new();
        stdout.read_to_end(&mut output).await?;
        Ok::<_, std::io::Error>(output)
    };
    let read_stderr = async move {
        let mut output = Vec::new();
        stderr.read_to_end(&mut output).await?;
        Ok::<_, std::io::Error>(output)
    };
    let (stdout, stderr) = tokio::try_join!(read_stdout, read_stderr)?;
    let status = child.wait().await?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
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
        assert_eq!(
            ExternalGitCommandError::Interrupted.kind(),
            ExternalGitCommandFailureKind::Retryable
        );
        assert_eq!(
            ExternalGitCommandError::Interrupted.code(),
            ExternalGitFailureCode::GitCommandFailed
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn process_drain_interrupts_and_reaps_external_git_commands() {
        let drain = DrainSignal::idle();
        let trigger = drain.clone();
        let mut command = Command::new("sh");
        command.arg("-c").arg("exec sleep 10").kill_on_drop(true);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            trigger.trigger_for_test();
        });

        let result = execute_external_git_command(command, Duration::from_secs(5), drain).await;
        assert!(matches!(result, Err(ExternalGitCommandError::Interrupted)));
    }
}
