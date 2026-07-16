//! Commit-author identity resolution for revision history and flushes.

use super::git_persistence;
use crate::access::{
    commit_identity, commit_identity_by_email, list_commit_identities, CommitIdentity,
    IdentityLookupError,
};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::collections::HashMap;
use thiserror::Error;
use uuid::Uuid;

const MAX_GIT_IDENTITY_NAME_CHARS: usize = 200;
const MAX_GIT_IDENTITY_EMAIL_BYTES: usize = 320;
const GUEST_EMAIL_FINGERPRINT_BYTES: usize = 6;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct GitIdentity {
    name: String,
    email: String,
}

impl GitIdentity {
    pub(crate) fn account(
        display_name: &str,
        email: &str,
        fallback_name: &str,
        fallback_email: &str,
    ) -> Self {
        Self {
            name: normalized_git_name(display_name, fallback_name),
            email: normalized_git_email(email, fallback_email),
        }
    }

    pub(crate) fn guest(display_name: &str, fallback_email_domain: &str) -> Self {
        let fingerprint = hex::encode(
            Sha256::digest(display_name.as_bytes())
                .iter()
                .take(GUEST_EMAIL_FINGERPRINT_BYTES)
                .copied()
                .collect::<Vec<_>>(),
        );
        Self {
            name: normalized_git_name(
                &format!("{display_name} (Unverified)"),
                "Guest collaborator (Unverified)",
            ),
            email: normalized_git_email(
                &format!("guest+{fingerprint}@{fallback_email_domain}"),
                "guest@localhost",
            ),
        }
    }

    pub(crate) fn service(product_name: &str, fallback_email_domain: &str) -> Self {
        Self::account(
            product_name,
            &format!("noreply@{fallback_email_domain}"),
            "Workspace Server",
            "noreply@localhost",
        )
    }

    pub(crate) fn coauthor_trailer(&self) -> String {
        format!("Co-authored-by: {} <{}>", self.name, self.email)
    }

    pub(super) fn signature(&self) -> Result<git2::Signature<'static>, git2::Error> {
        git2::Signature::now(&self.name, &self.email)
    }
}

fn normalized_git_name(value: &str, fallback: &str) -> String {
    let cleaned = clean_git_name(value);
    let selected = if cleaned.is_empty() {
        clean_git_name(fallback)
    } else {
        cleaned
    };
    let selected = if selected.is_empty() {
        "Git user".to_string()
    } else {
        selected
    };
    selected.chars().take(MAX_GIT_IDENTITY_NAME_CHARS).collect()
}

fn clean_git_name(value: &str) -> String {
    value
        .replace(['\r', '\n', '<', '>'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalized_git_email(value: &str, fallback: &str) -> String {
    if git_email_is_safe(value) {
        value.trim().to_string()
    } else if git_email_is_safe(fallback) {
        fallback.trim().to_string()
    } else {
        "noreply@localhost".to_string()
    }
}

fn git_email_is_safe(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.len() <= MAX_GIT_IDENTITY_EMAIL_BYTES
        && !trimmed
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || matches!(byte, b'<' | b'>'))
}

#[derive(Clone, serde::Serialize, utoipa::ToSchema)]
pub(crate) struct RevisionAuthor {
    pub user_id: Uuid,
    pub display_name: String,
    pub email: String,
}

#[derive(Debug, Error)]
pub(crate) enum PendingRevisionAuthorsError {
    #[error("pending revision author IDs could not be loaded for project {project_id}")]
    Persistence {
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("pending revision identities could not be loaded for project {project_id}")]
    Identity {
        project_id: Uuid,
        #[source]
        source: IdentityLookupError,
    },
}

pub(crate) async fn resolve_revision_author(
    db: &PgPool,
    default_name: String,
    email: String,
) -> Result<RevisionAuthor, IdentityLookupError> {
    Ok(commit_identity_by_email(db, &email)
        .await?
        .map(commit_identity_author)
        .unwrap_or(RevisionAuthor {
            user_id: Uuid::nil(),
            display_name: default_name,
            email,
        }))
}

pub(crate) async fn pending_revision_authors(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Vec<RevisionAuthor>, PendingRevisionAuthorsError> {
    let user_ids = git_persistence::pending_author_ids(db, project_id)
        .await
        .map_err(|source| PendingRevisionAuthorsError::Persistence { project_id, source })?;
    let mut identities = list_commit_identities(db, &user_ids)
        .await
        .map_err(|source| PendingRevisionAuthorsError::Identity { project_id, source })?
        .into_iter()
        .map(|identity| (identity.user_id, identity))
        .collect::<HashMap<_, _>>();
    Ok(user_ids
        .into_iter()
        .filter_map(|user_id| identities.remove(&user_id))
        .map(commit_identity_author)
        .collect())
}

pub(crate) async fn revision_author(
    db: &PgPool,
    user_id: Uuid,
) -> Result<Option<RevisionAuthor>, IdentityLookupError> {
    commit_identity(db, user_id)
        .await
        .map(|identity| identity.map(commit_identity_author))
}

pub(crate) async fn pending_revision_guest_names(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Vec<String>, sqlx::Error> {
    git_persistence::pending_guest_names(db, project_id).await
}

fn commit_identity_author(identity: CommitIdentity) -> RevisionAuthor {
    RevisionAuthor {
        user_id: identity.user_id,
        display_name: identity.display_name,
        email: identity.email,
    }
}

#[cfg(test)]
mod tests {
    use super::GitIdentity;

    #[test]
    fn guest_identity_is_stable_and_cannot_inject_commit_trailers() {
        assert_eq!(
            GitIdentity::guest(
                "Guest collaborator\nCo-authored-by: Mallory <mallory@example.test>",
                "workspace.local",
            ),
            GitIdentity {
                name:
                    "Guest collaborator Co-authored-by: Mallory mallory@example.test (Unverified)"
                        .to_string(),
                email: "guest+5099b0e94cd0@workspace.local".to_string(),
            }
        );
    }

    #[test]
    fn account_identity_uses_safe_fallbacks() {
        assert_eq!(
            GitIdentity::account(
                "Alice\nWorkspace-Version: 999",
                "alice@example.test\nCo-authored-by: Mallory",
                "Workspace owner",
                "owner@workspace.local",
            ),
            GitIdentity {
                name: "Alice Workspace-Version: 999".to_string(),
                email: "owner@workspace.local".to_string(),
            }
        );
    }
}
