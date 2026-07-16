use super::lifecycle::{complete_checkpoint, fail_checkpoint, CheckpointFailure};
use super::persistence::{self, CheckpointLink, ClaimedCheckpoint};
use super::ExternalGitCheckpointPhase;
use crate::access::{commit_identity, list_commit_identities, CommitIdentity, IdentityLookupError};
use crate::app_state::AppState;
use crate::collaboration::{CollaborationContext, FlushProjectCollaborationError};
use crate::distribution::DistributionConfig;
use crate::external_repositories::{
    external_git_command_timeout_seconds, ExternalGitCommandFailure, ExternalGitCommandFailureKind,
    ExternalGitFailureCode, ExternalGitGateway,
};
use crate::object_storage::ObjectStorage;
use crate::versioning::{
    create_checkpoint_commit, ensure_repository, mark_repository_pending,
    CreateCheckpointCommitError, FlushPendingServerCommitError, GitIdentity,
};
use crate::workspace::project_workspace_version;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use std::collections::HashMap;
use std::env;
use std::time::Duration;
use thiserror::Error;
use tracing::error;
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
enum CheckpointPersistenceStage {
    LoadLink,
    LoadWorkspace,
    EnsureLocalRepository,
    LoadAuthors,
    MarkLocalRepositoryPending,
    UpdatePhase,
    Capture,
}

#[derive(Debug, Error)]
enum CheckpointError {
    #[error("external repository link is missing for project {project_id}")]
    LinkMissing { project_id: Uuid },
    #[error("workspace project is missing for checkpoint {project_id}")]
    ProjectMissing { project_id: Uuid },
    #[error("local Git repository is missing for project {project_id}")]
    LocalRepositoryMissing { project_id: Uuid },
    #[error("checkpoint connector identity {user_id} is missing for project {project_id}")]
    ConnectorIdentityMissing { project_id: Uuid, user_id: Uuid },
    #[error("checkpoint persistence failed during {stage:?} for project {project_id}")]
    Persistence {
        stage: CheckpointPersistenceStage,
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("checkpoint connector identity lookup failed for project {project_id}")]
    Identity {
        project_id: Uuid,
        #[source]
        source: IdentityLookupError,
    },
    #[error("checkpoint could not flush the workspace for project {project_id}")]
    WorkspaceFlush {
        project_id: Uuid,
        #[source]
        source: FlushPendingServerCommitError,
    },
    #[error("checkpoint could not project collaborative edits for project {project_id}")]
    CollaborationProjection {
        project_id: Uuid,
        #[source]
        source: FlushProjectCollaborationError,
    },
    #[error("checkpoint commit could not be created for project {project_id}")]
    Git {
        project_id: Uuid,
        #[source]
        source: CreateCheckpointCommitError,
    },
    #[error("external Git command failed during checkpoint processing")]
    ProviderCommand {
        #[from]
        source: ExternalGitCommandFailure,
    },
    #[error("checkpoint branch moved since the last synchronization")]
    BranchMoved,
    #[error("checkpoint push could not be verified")]
    PushVerificationFailed,
}

struct CheckpointContext {
    link: CheckpointLink,
    repository_path: String,
    workspace_version: i64,
    connector: CommitIdentity,
}

impl CheckpointError {
    fn kind(&self) -> ExternalGitCommandFailureKind {
        match self {
            Self::ProviderCommand { source } => source.kind(),
            Self::BranchMoved => ExternalGitCommandFailureKind::Conflict,
            _ => ExternalGitCommandFailureKind::Retryable,
        }
    }

    fn code(&self) -> ExternalGitFailureCode {
        match self {
            Self::ProviderCommand { source } => source.code(),
            Self::BranchMoved => ExternalGitFailureCode::CheckpointBranchMoved,
            Self::PushVerificationFailed => ExternalGitFailureCode::GitPushVerificationFailed,
            Self::LinkMissing { .. } => ExternalGitFailureCode::ExternalGitLinkMissing,
            _ => ExternalGitFailureCode::GitCheckpointFailed,
        }
    }
}

fn checkpoint_worker_interval_seconds() -> u64 {
    env::var("EXTERNAL_GIT_CHECKPOINT_WORKER_INTERVAL_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value >= 1)
        .unwrap_or(2)
}

fn checkpoint_batch_size() -> usize {
    env::var("EXTERNAL_GIT_CHECKPOINT_WORKER_BATCH_SIZE")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value >= 1)
        .unwrap_or(8)
}

fn parse_ls_remote(output: &str) -> Option<String> {
    output
        .lines()
        .find_map(|line| line.split_whitespace().next())
        .filter(|value| value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase)
}

async fn remote_checkpoint_sha(
    gateway: &ExternalGitGateway<'_>,
    link: &CheckpointLink,
    repo_path: &str,
) -> Result<Option<String>, ExternalGitCommandFailure> {
    let args = vec![
        "ls-remote".to_string(),
        "--refs".to_string(),
        link.clone_url.clone(),
        format!("refs/heads/{}", link.checkpoint_branch),
    ];
    let output = gateway
        .run_command(link.linked_by_user_id, repo_path, &args, 30)
        .await?;
    Ok(parse_ls_remote(&output))
}

async fn push_checkpoint_ref(
    gateway: &ExternalGitGateway<'_>,
    link: &CheckpointLink,
    repo_path: &str,
    checkpoint_sha: &str,
) -> Result<(), CheckpointError> {
    let remote_sha = remote_checkpoint_sha(gateway, link, repo_path).await?;
    if remote_sha.as_deref() == Some(checkpoint_sha) {
        return Ok(());
    }
    let base_matches = match (&link.last_remote_sha, &remote_sha) {
        (None, None) => true,
        (Some(expected), Some(actual)) => expected.eq_ignore_ascii_case(actual),
        _ => false,
    };
    if !base_matches {
        return Err(CheckpointError::BranchMoved);
    }

    let args = vec![
        "push".to_string(),
        "--porcelain".to_string(),
        "-o".to_string(),
        "ci.skip".to_string(),
        link.clone_url.clone(),
        format!("{checkpoint_sha}:refs/heads/{}", link.checkpoint_branch),
    ];
    gateway
        .run_command(
            link.linked_by_user_id,
            repo_path,
            &args,
            external_git_command_timeout_seconds(),
        )
        .await?;
    let verified = remote_checkpoint_sha(gateway, link, repo_path).await?;
    if verified.as_deref() != Some(checkpoint_sha) {
        return Err(CheckpointError::PushVerificationFailed);
    }
    Ok(())
}

async fn checkpoint_coauthor_trailers(
    db: &PgPool,
    project_id: Uuid,
    connector_user_id: Uuid,
    captured_at: DateTime<Utc>,
    fallback_email_domain: &str,
) -> Result<Vec<String>, CheckpointError> {
    let collaborator_fallback = format!("collaborator@{fallback_email_domain}");
    let (coauthor_ids, guest_names) = tokio::try_join!(
        persistence::coauthor_ids(db, project_id, connector_user_id, captured_at),
        persistence::guest_coauthors(db, project_id, captured_at),
    )
    .map_err(|source| CheckpointError::Persistence {
        stage: CheckpointPersistenceStage::LoadAuthors,
        project_id,
        source,
    })?;
    let coauthors = list_commit_identities(db, &coauthor_ids)
        .await
        .map_err(|source| CheckpointError::Identity { project_id, source })?;
    let mut coauthors_by_id = coauthors
        .into_iter()
        .map(|identity| (identity.user_id, identity))
        .collect::<HashMap<_, _>>();
    let mut trailers = coauthor_ids
        .into_iter()
        .filter_map(|user_id| coauthors_by_id.remove(&user_id))
        .map(|author| {
            GitIdentity::account(
                &author.display_name,
                &author.email,
                "Collaborator",
                &collaborator_fallback,
            )
            .coauthor_trailer()
        })
        .collect::<Vec<_>>();
    for raw_name in guest_names {
        trailers.push(GitIdentity::guest(&raw_name, fallback_email_domain).coauthor_trailer());
    }
    Ok(trailers)
}

async fn load_checkpoint_context(
    db: &PgPool,
    project_id: Uuid,
) -> Result<CheckpointContext, CheckpointError> {
    let link = persistence::checkpoint_link(db, project_id)
        .await
        .map_err(|source| CheckpointError::Persistence {
            stage: CheckpointPersistenceStage::LoadLink,
            project_id,
            source,
        })?
        .ok_or(CheckpointError::LinkMissing { project_id })?;
    let workspace_version = project_workspace_version(db, project_id)
        .await
        .map_err(|source| CheckpointError::Persistence {
            stage: CheckpointPersistenceStage::LoadWorkspace,
            project_id,
            source,
        })?
        .ok_or(CheckpointError::ProjectMissing { project_id })?;
    let connector = commit_identity(db, link.linked_by_user_id)
        .await
        .map_err(|source| CheckpointError::Identity { project_id, source })?
        .ok_or(CheckpointError::ConnectorIdentityMissing {
            project_id,
            user_id: link.linked_by_user_id,
        })?;
    let repository_path = ensure_repository(db, project_id, Utc::now())
        .await
        .map_err(|source| CheckpointError::Persistence {
            stage: CheckpointPersistenceStage::EnsureLocalRepository,
            project_id,
            source,
        })?
        .ok_or(CheckpointError::LocalRepositoryMissing { project_id })?;
    Ok(CheckpointContext {
        link,
        repository_path,
        workspace_version,
        connector,
    })
}

async fn push_captured_checkpoint(
    db: &PgPool,
    gateway: &ExternalGitGateway<'_>,
    project_id: Uuid,
    link: &CheckpointLink,
    repo_path: &str,
    captured_version: i64,
    checkpoint_sha: &str,
) -> Result<(i64, String), CheckpointError> {
    persistence::update_queue_phase(
        db,
        project_id,
        ExternalGitCheckpointPhase::PushGit,
        Utc::now(),
    )
    .await
    .map_err(|source| CheckpointError::Persistence {
        stage: CheckpointPersistenceStage::UpdatePhase,
        project_id,
        source,
    })?;
    push_checkpoint_ref(gateway, link, repo_path, checkpoint_sha).await?;
    Ok((captured_version, checkpoint_sha.to_string()))
}

async fn create_and_push_checkpoint(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    distribution: &DistributionConfig,
    gateway: &ExternalGitGateway<'_>,
    project_id: Uuid,
    context: &mut CheckpointContext,
) -> Result<(i64, String), CheckpointError> {
    let captured_at = Utc::now();
    let captured_version = context.workspace_version;
    mark_repository_pending(db, project_id, Utc::now())
        .await
        .map_err(|source| CheckpointError::Persistence {
            stage: CheckpointPersistenceStage::MarkLocalRepositoryPending,
            project_id,
            source,
        })?;
    persistence::update_queue_phase(
        db,
        project_id,
        ExternalGitCheckpointPhase::CommitLocal,
        Utc::now(),
    )
    .await
    .map_err(|source| CheckpointError::Persistence {
        stage: CheckpointPersistenceStage::UpdatePhase,
        project_id,
        source,
    })?;
    crate::versioning::flush_pending_server_commit(
        db,
        storage,
        distribution,
        project_id,
        Some(context.link.linked_by_user_id),
        None,
        None,
    )
    .await
    .map_err(|source| CheckpointError::WorkspaceFlush { project_id, source })?;
    let trailers = checkpoint_coauthor_trailers(
        db,
        project_id,
        context.link.linked_by_user_id,
        captured_at,
        &distribution.git.fallback_email_domain,
    )
    .await?;
    let mut message = format!("Sync workspace\n\nWorkspace-Version: {captured_version}");
    if !trailers.is_empty() {
        message.push('\n');
        message.push_str(&trailers.join("\n"));
    }
    let connector_email_fallback = format!("noreply@{}", distribution.git.fallback_email_domain);
    let connector = GitIdentity::account(
        &context.connector.display_name,
        &context.connector.email,
        &distribution.git.fallback_owner_name,
        &connector_email_fallback,
    );
    let committer = GitIdentity::service(
        &distribution.product.name,
        &distribution.git.fallback_email_domain,
    );
    let checkpoint = create_checkpoint_commit(
        &context.repository_path,
        &context.link.checkpoint_branch,
        context.link.last_remote_sha.as_deref(),
        &message,
        &connector,
        &committer,
    )
    .map_err(|source| CheckpointError::Git { project_id, source })?;
    persistence::capture_checkpoint(
        db,
        project_id,
        captured_version,
        &checkpoint.oid,
        captured_at,
    )
    .await
    .map_err(|source| CheckpointError::Persistence {
        stage: CheckpointPersistenceStage::Capture,
        project_id,
        source,
    })?;
    context.link.captured_workspace_version = Some(captured_version);
    context.link.checkpoint_sha = Some(checkpoint.oid.clone());
    context.link.captured_at = Some(captured_at);
    push_checkpoint_ref(
        gateway,
        &context.link,
        &context.repository_path,
        &checkpoint.oid,
    )
    .await?;
    Ok((captured_version, checkpoint.oid))
}

async fn process_checkpoint(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    distribution: &DistributionConfig,
    gateway: &ExternalGitGateway<'_>,
    collaboration: &CollaborationContext,
    project_id: Uuid,
) -> Result<(i64, String), CheckpointError> {
    collaboration
        .flush_project_collaboration(project_id)
        .await
        .map_err(|source| CheckpointError::CollaborationProjection { project_id, source })?;
    let mut context = load_checkpoint_context(db, project_id).await?;
    if let (Some(captured_version), Some(checkpoint_sha)) = (
        context.link.captured_workspace_version,
        context.link.checkpoint_sha.clone(),
    ) {
        return push_captured_checkpoint(
            db,
            gateway,
            project_id,
            &context.link,
            &context.repository_path,
            captured_version,
            &checkpoint_sha,
        )
        .await;
    }
    create_and_push_checkpoint(db, storage, distribution, gateway, project_id, &mut context).await
}

async fn record_checkpoint_failure(
    db: &PgPool,
    claimed: &ClaimedCheckpoint,
    failure: &CheckpointError,
) {
    if let Err(error) = fail_checkpoint(
        db,
        CheckpointFailure::from_claim(claimed, failure.kind(), failure.code()),
    )
    .await
    {
        tracing::error!(
            ?error,
            project_id = %claimed.project_id,
            "external Git checkpoint failure persistence failed"
        );
    }
}

pub(crate) fn spawn_external_git_checkpoint_worker(state: AppState) {
    let interval = Duration::from_secs(checkpoint_worker_interval_seconds());
    let batch_size = checkpoint_batch_size();
    let providers = state
        .external_git_providers
        .instance_ids()
        .collect::<Vec<_>>();
    for provider in providers {
        let state = state.clone();
        tokio::spawn(async move {
            loop {
                for _ in 0..batch_size {
                    let now = Utc::now();
                    let claimed = match persistence::claim_due(
                        &state.db,
                        &provider,
                        now,
                        now - chrono::Duration::minutes(10),
                    )
                    .await
                    {
                        Ok(Some(value)) => value,
                        Ok(None) => break,
                        Err(error) => {
                            tracing::error!(
                                ?error,
                                "external Git checkpoint worker could not claim work"
                            );
                            break;
                        }
                    };
                    let _git_lock = state
                        .versioning
                        .acquire_project_lock(claimed.project_id)
                        .await;
                    let gateway = state.external_git_gateway(&provider);
                    match process_checkpoint(
                        &state.db,
                        state.storage.as_ref(),
                        &state.distribution,
                        &gateway,
                        &state.collaboration,
                        claimed.project_id,
                    )
                    .await
                    {
                        Ok((workspace_version, remote_sha)) => {
                            if let Err(error) = complete_checkpoint(
                                &state.db,
                                claimed.project_id,
                                workspace_version,
                                &remote_sha,
                            )
                            .await
                            {
                                tracing::error!(
                                    ?error,
                                    project_id = %claimed.project_id,
                                    "external Git checkpoint completion persistence failed"
                                );
                            }
                        }
                        Err(failure) => {
                            error!(error = ?failure, project_id = %claimed.project_id, code = %failure.code(), "external Git checkpoint failed");
                            record_checkpoint_failure(&state.db, &claimed, &failure).await;
                        }
                    }
                }
                tokio::time::sleep(interval).await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_single_ls_remote_ref() {
        assert_eq!(
            parse_ls_remote(
                "0123456789abcdef0123456789abcdef01234567\trefs/heads/workspace/example\n"
            )
            .as_deref(),
            Some("0123456789abcdef0123456789abcdef01234567")
        );
        assert_eq!(parse_ls_remote(""), None);
        assert_eq!(parse_ls_remote("not-a-sha\trefs/heads/main\n"), None);
    }
}
