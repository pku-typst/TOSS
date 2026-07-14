//! Revision history traversal and manual revision creation.

use super::authors::{self, GitIdentity, PendingRevisionAuthorsError, RevisionAuthor};
use super::commit::{commit_allow_empty, commit_staged_if_changed};
use super::local_repository::{checkout_branch, ensure_initialized, InitializeRepositoryError};
use super::materialization::MaterializeWorkspaceError;
use super::{
    complete_materialized_workspace_sync, load_repository, sync_project_documents_to_repo,
    MaterializedWorkspaceCompletion, VersioningContext,
};
use crate::access::IdentityLookupError;
use crate::distribution::DistributionConfig;
use crate::object_storage::ObjectStorage;
use chrono::{DateTime, Utc};
use git2::{Commit, Repository, Sort};
use sqlx::PgPool;
use std::collections::HashSet;
use thiserror::Error;
use uuid::Uuid;

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct Revision {
    pub id: String,
    pub project_id: Uuid,
    #[schema(required)]
    pub actor_user_id: Option<Uuid>,
    pub summary: String,
    pub created_at: DateTime<Utc>,
    pub authors: Vec<RevisionAuthor>,
}

#[derive(Debug, Error)]
pub(crate) enum ListRevisionsError {
    #[error("project {project_id} has no revision repository")]
    ProjectNotFound { project_id: Uuid },
    #[error("revision repository lookup failed for project {project_id}")]
    Persistence {
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("revision repository initialization failed for project {project_id}")]
    RepositoryInitialization {
        project_id: Uuid,
        #[source]
        source: InitializeRepositoryError,
    },
    #[error("revision history traversal failed for project {project_id}")]
    Git {
        project_id: Uuid,
        #[source]
        source: git2::Error,
    },
    #[error("revision author lookup failed for project {project_id}")]
    Identity {
        project_id: Uuid,
        #[source]
        source: IdentityLookupError,
    },
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum CreateRevisionPersistenceStage {
    RepositoryLookup,
    PendingAuthors,
    PendingGuestAuthors,
    CompleteWorkspaceSync,
}

#[derive(Debug, Error)]
pub(crate) enum CreateRevisionError {
    #[error("revision summary is empty")]
    InvalidSummary,
    #[error("project {project_id} has no revision repository")]
    ProjectNotFound { project_id: Uuid },
    #[error("revision persistence failed during {stage:?} for project {project_id}")]
    Persistence {
        stage: CreateRevisionPersistenceStage,
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("revision repository initialization failed for project {project_id}")]
    RepositoryInitialization {
        project_id: Uuid,
        #[source]
        source: InitializeRepositoryError,
    },
    #[error("revision Git operation failed for project {project_id}")]
    Git {
        project_id: Uuid,
        #[source]
        source: git2::Error,
    },
    #[error("workspace materialization failed for project {project_id}")]
    Materialization {
        project_id: Uuid,
        #[source]
        source: MaterializeWorkspaceError,
    },
    #[error("revision author lookup failed for project {project_id}")]
    Identity {
        project_id: Uuid,
        #[source]
        source: IdentityLookupError,
    },
}

fn revision_commit_time(commit: &Commit<'_>) -> DateTime<Utc> {
    let seconds = commit.time().seconds();
    DateTime::<Utc>::from_timestamp(seconds, 0).unwrap_or_else(Utc::now)
}

fn parse_co_authors(message: &str) -> Vec<(String, String)> {
    let mut authors = Vec::new();
    for line in message.lines() {
        let trimmed = line.trim();
        if !trimmed.to_ascii_lowercase().starts_with("co-authored-by:") {
            continue;
        }
        let value = trimmed
            .split_once(':')
            .map(|(_, right)| right.trim())
            .unwrap_or_default();
        let (Some(start), Some(end)) = (value.rfind('<'), value.rfind('>')) else {
            continue;
        };
        if start >= end {
            continue;
        }
        let Some(name) = value.get(..start).map(str::trim) else {
            continue;
        };
        let Some(email_start) = start.checked_add(1) else {
            continue;
        };
        let Some(email) = value.get(email_start..end).map(str::trim) else {
            continue;
        };
        if !name.is_empty() && !email.is_empty() {
            authors.push((name.to_string(), email.to_string()));
        }
    }
    authors
}

type RevisionCommitRow = (
    String,
    String,
    DateTime<Utc>,
    String,
    String,
    Vec<(String, String)>,
);

pub(crate) async fn list_revisions(
    db: &PgPool,
    versioning: &VersioningContext,
    project_id: Uuid,
    before_cursor: Option<&str>,
    limit: usize,
) -> Result<Vec<Revision>, ListRevisionsError> {
    let config = load_repository(db, project_id)
        .await
        .map_err(|source| ListRevisionsError::Persistence { project_id, source })?
        .ok_or(ListRevisionsError::ProjectNotFound { project_id })?;
    let commit_rows = {
        let _git_lock = versioning.acquire_project_lock(project_id).await;
        ensure_initialized(&config.local_path, &config.default_branch).map_err(|source| {
            ListRevisionsError::RepositoryInitialization { project_id, source }
        })?;
        checkout_branch(&config.local_path, &config.default_branch)
            .map_err(|source| ListRevisionsError::Git { project_id, source })?;
        let repository = Repository::open(&config.local_path)
            .map_err(|source| ListRevisionsError::Git { project_id, source })?;
        let head = repository.head().ok().and_then(|head| head.target());
        let Some(head_oid) = head else {
            return Ok(Vec::new());
        };
        let mut revwalk = repository
            .revwalk()
            .map_err(|source| ListRevisionsError::Git { project_id, source })?;
        revwalk
            .set_sorting(Sort::TIME)
            .map_err(|source| ListRevisionsError::Git { project_id, source })?;
        revwalk
            .push(head_oid)
            .map_err(|source| ListRevisionsError::Git { project_id, source })?;

        let mut rows: Vec<RevisionCommitRow> = Vec::with_capacity(limit);
        let mut passed_before_cursor = before_cursor.is_none();
        for oid_result in revwalk {
            let oid =
                oid_result.map_err(|source| ListRevisionsError::Git { project_id, source })?;
            let oid_text = oid.to_string();
            if !passed_before_cursor {
                if Some(oid_text.as_str()) == before_cursor {
                    passed_before_cursor = true;
                }
                continue;
            }
            if rows.len() >= limit {
                break;
            }
            let commit = repository
                .find_commit(oid)
                .map_err(|source| ListRevisionsError::Git { project_id, source })?;
            let subject = commit
                .summary()
                .ok()
                .flatten()
                .map(str::to_string)
                .unwrap_or_else(|| "Online updates".to_string());
            let author_signature = commit.author();
            let author_name = author_signature.name().unwrap_or("Unknown").to_string();
            let author_email = author_signature
                .email()
                .unwrap_or("unknown@example.com")
                .to_string();
            let mut seen_emails = HashSet::new();
            seen_emails.insert(author_email.to_ascii_lowercase());
            let message = commit.message().unwrap_or_default();
            let co_authors = parse_co_authors(message)
                .into_iter()
                .filter(|(_, email)| seen_emails.insert(email.to_ascii_lowercase()))
                .collect();
            rows.push((
                oid_text,
                subject,
                revision_commit_time(&commit),
                author_name,
                author_email,
                co_authors,
            ));
        }
        rows
    };

    let mut revisions = Vec::with_capacity(commit_rows.len());
    for (id, summary, created_at, author_name, author_email, co_authors) in commit_rows {
        let primary = authors::resolve_revision_author(db, author_name, author_email)
            .await
            .map_err(|source| ListRevisionsError::Identity { project_id, source })?;
        let actor_user_id = (primary.user_id != Uuid::nil()).then_some(primary.user_id);
        let mut revision_authors = vec![primary];
        for (name, email) in co_authors {
            revision_authors.push(
                authors::resolve_revision_author(db, name, email)
                    .await
                    .map_err(|source| ListRevisionsError::Identity { project_id, source })?,
            );
        }
        revisions.push(Revision {
            id,
            project_id,
            actor_user_id,
            summary,
            created_at,
            authors: revision_authors,
        });
    }
    Ok(revisions)
}

pub(crate) async fn create_revision(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    versioning: &VersioningContext,
    distribution: &DistributionConfig,
    actor_user_id: Uuid,
    project_id: Uuid,
    summary: &str,
) -> Result<Revision, CreateRevisionError> {
    let summary = summary.trim().to_string();
    if summary.is_empty() {
        return Err(CreateRevisionError::InvalidSummary);
    }
    let _git_lock = versioning.acquire_project_lock(project_id).await;
    let config = load_repository(db, project_id)
        .await
        .map_err(|source| CreateRevisionError::Persistence {
            stage: CreateRevisionPersistenceStage::RepositoryLookup,
            project_id,
            source,
        })?
        .ok_or(CreateRevisionError::ProjectNotFound { project_id })?;
    ensure_initialized(&config.local_path, &config.default_branch)
        .map_err(|source| CreateRevisionError::RepositoryInitialization { project_id, source })?;
    checkout_branch(&config.local_path, &config.default_branch)
        .map_err(|source| CreateRevisionError::Git { project_id, source })?;
    let materialized_workspace_version =
        sync_project_documents_to_repo(db, storage, project_id, &config.local_path)
            .await
            .map_err(|source| match source {
                MaterializeWorkspaceError::ProjectNotFound { .. } => {
                    CreateRevisionError::ProjectNotFound { project_id }
                }
                source => CreateRevisionError::Materialization { project_id, source },
            })?;

    let fallback_email_domain = &distribution.git.fallback_email_domain;
    let actor_fallback_email = format!("owner@{fallback_email_domain}");
    let collaborator_fallback_email = format!("collaborator@{fallback_email_domain}");
    let actor_author = authors::revision_author(db, actor_user_id)
        .await
        .map_err(|source| CreateRevisionError::Identity { project_id, source })?
        .unwrap_or(RevisionAuthor {
            user_id: actor_user_id,
            display_name: distribution.git.fallback_owner_name.clone(),
            email: actor_fallback_email.clone(),
        });
    let actor_identity = GitIdentity::account(
        &actor_author.display_name,
        &actor_author.email,
        &distribution.git.fallback_owner_name,
        &actor_fallback_email,
    );
    let committer = GitIdentity::service(&distribution.product.name, fallback_email_domain);
    let pending_authors = authors::pending_revision_authors(db, project_id)
        .await
        .map_err(|failure| match failure {
            PendingRevisionAuthorsError::Persistence { source, .. } => {
                CreateRevisionError::Persistence {
                    stage: CreateRevisionPersistenceStage::PendingAuthors,
                    project_id,
                    source,
                }
            }
            PendingRevisionAuthorsError::Identity { source, .. } => {
                CreateRevisionError::Identity { project_id, source }
            }
        })?;
    let mut revision_authors = Vec::new();
    let mut trailers = Vec::new();
    let mut seen = HashSet::new();
    for author in pending_authors {
        if !seen.insert(author.user_id) {
            continue;
        }
        trailers.push(
            GitIdentity::account(
                &author.display_name,
                &author.email,
                "Collaborator",
                &collaborator_fallback_email,
            )
            .coauthor_trailer(),
        );
        revision_authors.push(author);
    }
    if !seen.contains(&actor_user_id) {
        trailers.push(actor_identity.coauthor_trailer());
        revision_authors.push(actor_author);
    }
    let guest_names = authors::pending_revision_guest_names(db, project_id)
        .await
        .map_err(|source| CreateRevisionError::Persistence {
            stage: CreateRevisionPersistenceStage::PendingGuestAuthors,
            project_id,
            source,
        })?;
    for display_name in guest_names {
        trailers.push(GitIdentity::guest(&display_name, fallback_email_domain).coauthor_trailer());
    }
    let message = if trailers.is_empty() {
        summary.clone()
    } else {
        format!("{summary}\n\n{}", trailers.join("\n"))
    };
    let commit_id =
        match commit_staged_if_changed(&config.local_path, &message, &actor_identity, &committer)
            .map_err(|source| CreateRevisionError::Git { project_id, source })?
        {
            Some(commit_id) => commit_id,
            None => commit_allow_empty(&config.local_path, &message, &actor_identity, &committer)
                .map_err(|source| CreateRevisionError::Git { project_id, source })?,
        };
    let completion =
        complete_materialized_workspace_sync(db, project_id, materialized_workspace_version)
            .await
            .map_err(|source| CreateRevisionError::Persistence {
                stage: CreateRevisionPersistenceStage::CompleteWorkspaceSync,
                project_id,
                source,
            })?;
    if completion == MaterializedWorkspaceCompletion::ProjectNotFound {
        return Err(CreateRevisionError::ProjectNotFound { project_id });
    }
    let repository = Repository::open(&config.local_path)
        .map_err(|source| CreateRevisionError::Git { project_id, source })?;
    let commit = repository
        .find_commit(commit_id)
        .map_err(|source| CreateRevisionError::Git { project_id, source })?;
    Ok(Revision {
        id: commit_id.to_string(),
        project_id,
        actor_user_id: Some(actor_user_id),
        summary: commit
            .summary()
            .ok()
            .flatten()
            .map(str::to_string)
            .unwrap_or(summary),
        created_at: revision_commit_time(&commit),
        authors: revision_authors,
    })
}

#[cfg(test)]
mod tests {
    use super::parse_co_authors;

    #[test]
    fn co_author_parser_ignores_malformed_lines() {
        let authors = parse_co_authors(
            "Subject\n\nCo-authored-by: Ada Lovelace <ada@example.com>\nco-authored-by: malformed",
        );
        assert_eq!(
            authors,
            vec![("Ada Lovelace".to_string(), "ada@example.com".to_string())]
        );
    }
}
