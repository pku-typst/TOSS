use super::authors::{GitIdentity, PendingRevisionAuthorsError};
use super::commit::commit_staged_if_changed;
use super::local_repository::{
    checkout_branch, ensure_initialized, worktree_is_clean, InitializeRepositoryError,
};
use super::sync_project_documents_to_repo;
use crate::access::IdentityLookupError;
use crate::distribution::DistributionConfig;
use crate::object_storage::ObjectStorage;
use crate::process_lifecycle::DrainSignal;
use chrono::Utc;
use sqlx::PgPool;
use std::env;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tracing::error;
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
pub(crate) enum FlushPersistenceStage {
    RepositoryLookup,
    PendingAuthors,
    PendingGuestAuthors,
    CompleteWorkspaceSync,
}

#[derive(Debug, Error)]
pub(crate) enum FlushPendingServerCommitError {
    #[error("Git flush persistence failed during {stage:?} for project {project_id}")]
    Persistence {
        stage: FlushPersistenceStage,
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("Git flush repository initialization failed for project {project_id}")]
    RepositoryInitialization {
        project_id: Uuid,
        #[source]
        source: InitializeRepositoryError,
    },
    #[error("Git flush repository operation failed for project {project_id}")]
    Git {
        project_id: Uuid,
        #[source]
        source: git2::Error,
    },
    #[error("Git flush workspace materialization failed for project {project_id}")]
    Materialization {
        project_id: Uuid,
        #[source]
        source: super::MaterializeWorkspaceError,
    },
    #[error("Git flush author lookup failed for project {project_id}")]
    Identity {
        project_id: Uuid,
        #[source]
        source: IdentityLookupError,
    },
}

pub(crate) async fn flush_pending_server_commit(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    distribution: &DistributionConfig,
    project_id: Uuid,
    force_author: Option<Uuid>,
    workspace_version: Option<i64>,
    summary: Option<&str>,
) -> Result<(), FlushPendingServerCommitError> {
    let repository = super::load_repository(db, project_id)
        .await
        .map_err(|source| FlushPendingServerCommitError::Persistence {
            stage: FlushPersistenceStage::RepositoryLookup,
            project_id,
            source,
        })?;
    let Some(repository) = repository else {
        clear_project_sync_queue_item(db, project_id).await;
        return Ok(());
    };
    if !repository.pending_sync {
        clear_project_sync_queue_item(db, project_id).await;
        return Ok(());
    }
    ensure_initialized(&repository.local_path, &repository.default_branch).map_err(|source| {
        FlushPendingServerCommitError::RepositoryInitialization { project_id, source }
    })?;
    checkout_branch(&repository.local_path, &repository.default_branch)
        .map_err(|source| FlushPendingServerCommitError::Git { project_id, source })?;
    let materialized_workspace_version =
        sync_project_documents_to_repo(db, storage, project_id, &repository.local_path)
            .await
            .map_err(|source| FlushPendingServerCommitError::Materialization {
                project_id,
                source,
            })?;
    if worktree_is_clean(&repository.local_path)
        .map_err(|source| FlushPendingServerCommitError::Git { project_id, source })?
    {
        super::complete_materialized_workspace_sync(db, project_id, materialized_workspace_version)
            .await
            .map_err(|source| FlushPendingServerCommitError::Persistence {
                stage: FlushPersistenceStage::CompleteWorkspaceSync,
                project_id,
                source,
            })?;
        return Ok(());
    }

    let fallback_email_domain = &distribution.git.fallback_email_domain;
    let commit_authors =
        pending_commit_authors(db, project_id, force_author, fallback_email_domain).await?;
    let committer = GitIdentity::service(&distribution.product.name, fallback_email_domain);
    let commit_author = commit_authors
        .first()
        .cloned()
        .unwrap_or_else(|| committer.clone());
    let mut message_trailers = commit_authors
        .iter()
        .map(GitIdentity::coauthor_trailer)
        .collect::<Vec<_>>();
    if let Some(version) = workspace_version {
        message_trailers.push(format!("Workspace-Version: {version}"));
    }
    let subject = summary
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Online updates");
    let message = if message_trailers.is_empty() {
        subject.to_string()
    } else {
        format!("{subject}\n\n{}", message_trailers.join("\n"))
    };
    commit_staged_if_changed(&repository.local_path, &message, &commit_author, &committer)
        .map_err(|source| FlushPendingServerCommitError::Git { project_id, source })?;
    super::complete_materialized_workspace_sync(db, project_id, materialized_workspace_version)
        .await
        .map_err(|source| FlushPendingServerCommitError::Persistence {
            stage: FlushPersistenceStage::CompleteWorkspaceSync,
            project_id,
            source,
        })?;
    Ok(())
}

async fn pending_commit_authors(
    db: &PgPool,
    project_id: Uuid,
    force_author: Option<Uuid>,
    fallback_email_domain: &str,
) -> Result<Vec<GitIdentity>, FlushPendingServerCommitError> {
    let fallback_email = format!("collaborator@{fallback_email_domain}");
    let mut authors = super::authors::pending_revision_authors(db, project_id)
        .await
        .map_err(|failure| match failure {
            PendingRevisionAuthorsError::Persistence { source, .. } => {
                FlushPendingServerCommitError::Persistence {
                    stage: FlushPersistenceStage::PendingAuthors,
                    project_id,
                    source,
                }
            }
            PendingRevisionAuthorsError::Identity { source, .. } => {
                FlushPendingServerCommitError::Identity { project_id, source }
            }
        })?
        .into_iter()
        .map(|author| {
            GitIdentity::account(
                &author.display_name,
                &author.email,
                "Collaborator",
                &fallback_email,
            )
        })
        .collect::<Vec<_>>();
    let guest_names = super::authors::pending_revision_guest_names(db, project_id)
        .await
        .map_err(|source| FlushPendingServerCommitError::Persistence {
            stage: FlushPersistenceStage::PendingGuestAuthors,
            project_id,
            source,
        })?;
    for name in guest_names {
        authors.push(GitIdentity::guest(&name, fallback_email_domain));
    }
    if authors.is_empty() {
        if let Some(user_id) = force_author {
            if let Some(author) = super::authors::revision_author(db, user_id)
                .await
                .map_err(|source| FlushPendingServerCommitError::Identity { project_id, source })?
            {
                authors.push(GitIdentity::account(
                    &author.display_name,
                    &author.email,
                    "Collaborator",
                    &fallback_email,
                ));
            }
        }
    }
    Ok(authors)
}

pub(crate) async fn clear_project_sync_queue_item(db: &PgPool, project_id: Uuid) {
    if let Err(database_error) =
        super::state::clear_sync_queue_if_repository_clean(db, project_id).await
    {
        error!(%database_error, %project_id, "sync queue cleanup failed");
    }
}

fn git_flush_worker_interval_seconds() -> u64 {
    env::var("GIT_FLUSH_WORKER_INTERVAL_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value >= 1)
        .unwrap_or(3)
}

fn git_autosave_interval_seconds() -> i64 {
    env::var("GIT_AUTOSAVE_INTERVAL_SECONDS")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value >= 60)
        .unwrap_or(600)
}

fn git_flush_worker_batch_size() -> i64 {
    env::var("GIT_FLUSH_WORKER_BATCH_SIZE")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value >= 1)
        .unwrap_or(64)
}

pub(crate) fn spawn_git_flush_worker(
    db: PgPool,
    storage: Option<ObjectStorage>,
    distribution: Arc<DistributionConfig>,
    versioning: super::VersioningContext,
    drain: DrainSignal,
) -> tokio::task::JoinHandle<()> {
    let interval = Duration::from_secs(git_flush_worker_interval_seconds());
    let batch_size = git_flush_worker_batch_size();
    tokio::spawn(async move {
        loop {
            if drain.is_triggered() {
                return;
            }
            let due_before =
                Utc::now() - chrono::Duration::seconds(git_autosave_interval_seconds());
            match super::list_due_projects(&db, batch_size, due_before).await {
                Ok(projects) => {
                    for project_id in projects {
                        if drain.is_triggered() {
                            return;
                        }
                        if let Err(database_error) =
                            super::mark_sync_attempt(&db, project_id, Utc::now()).await
                        {
                            error!(%database_error, %project_id, "git flush attempt could not be recorded");
                            continue;
                        }
                        let _git_lock = versioning.acquire_project_lock(project_id).await;
                        if let Err(flush_error) = flush_pending_server_commit(
                            &db,
                            storage.as_ref(),
                            &distribution,
                            project_id,
                            None,
                            None,
                            None,
                        )
                        .await
                        {
                            error!(error = ?flush_error, %project_id, "git flush worker failed");
                            let diagnostic = flush_error.to_string();
                            if let Err(database_error) =
                                super::record_sync_failure(&db, project_id, &diagnostic).await
                            {
                                error!(%database_error, %project_id, "git flush failure could not be recorded");
                            }
                        }
                    }
                }
                Err(database_error) => {
                    error!(%database_error, "git flush worker could not load pending projects");
                }
            }
            tokio::select! {
                _ = drain.triggered() => return,
                _ = tokio::time::sleep(interval) => {}
            }
        }
    })
}
