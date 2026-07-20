use super::sharing_model::{
    JoinedProjectShareLink, ResolvedProjectShareLink, ShareLinkMutation, TemporaryShareSession,
};
use super::sharing_persistence;
use super::{AnonymousMode, ProjectPermission};
use chrono::{DateTime, Utc};
use rand::distr::{Alphanumeric, SampleString};
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool};
use thiserror::Error;
use uuid::Uuid;

use crate::workspace::lock_project_template_status;

pub(crate) async fn enable_project_share_link(
    db: &PgPool,
    project_id: Uuid,
    permission: ProjectPermission,
    expires_at: Option<DateTime<Utc>>,
    actor_user_id: Uuid,
) -> Result<ShareLinkMutation, EnableProjectShareLinkError> {
    let created_at = Utc::now();
    if expires_at.is_some_and(|value| value <= created_at) {
        return Err(EnableProjectShareLinkError::ExpirationNotFuture);
    }
    let candidate_token = format!("psh_{}", Alphanumeric.sample_string(&mut rand::rng(), 36));
    let token_prefix = candidate_token.chars().take(12).collect::<String>();
    let share_link_id = Uuid::new_v4();
    let mut transaction = db
        .begin()
        .await
        .map_err(|source| EnableProjectShareLinkError::BeginTransaction { project_id, source })?;
    let upserted = sharing_persistence::upsert_active(
        &mut transaction,
        &sharing_persistence::ShareLinkWrite {
            id: share_link_id,
            project_id,
            token_prefix: &token_prefix,
            token_value: &candidate_token,
            permission,
            created_by: actor_user_id,
            created_at,
            expires_at,
        },
    )
    .await
    .map_err(|source| EnableProjectShareLinkError::Persist { project_id, source })?;
    super::grant_persistence::advance_project_access_epoch(&mut transaction, project_id)
        .await
        .map_err(|source| EnableProjectShareLinkError::Persist { project_id, source })?;
    let token = upserted.link.token_value.clone();
    transaction
        .commit()
        .await
        .map_err(|source| EnableProjectShareLinkError::Commit { project_id, source })?;
    Ok(ShareLinkMutation {
        link: upserted.link,
        token,
        inserted: upserted.inserted,
    })
}

pub(crate) async fn revoke_project_share_link(
    db: &PgPool,
    project_id: Uuid,
    share_link_id: Uuid,
) -> Result<(), RevokeProjectShareLinkError> {
    let mut transaction =
        db.begin()
            .await
            .map_err(|source| RevokeProjectShareLinkError::BeginTransaction {
                project_id,
                share_link_id,
                source,
            })?;
    let revoked =
        sharing_persistence::revoke(&mut transaction, project_id, share_link_id, Utc::now())
            .await
            .map_err(|source| RevokeProjectShareLinkError::Persist {
                project_id,
                share_link_id,
                source,
            })?;
    if !revoked {
        return Err(RevokeProjectShareLinkError::NotFound {
            project_id,
            share_link_id,
        });
    }
    super::grant_persistence::advance_project_access_epoch(&mut transaction, project_id)
        .await
        .map_err(|source| RevokeProjectShareLinkError::Persist {
            project_id,
            share_link_id,
            source,
        })?;
    transaction
        .commit()
        .await
        .map_err(|source| RevokeProjectShareLinkError::Commit {
            project_id,
            share_link_id,
            source,
        })?;
    Ok(())
}

pub(crate) async fn join_project_share_link(
    db: &PgPool,
    actor_user_id: Uuid,
    token: &str,
) -> Result<JoinedProjectShareLink, JoinProjectShareLinkError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(JoinProjectShareLinkError::EmptyToken);
    }
    let mut transaction =
        db.begin()
            .await
            .map_err(|source| JoinProjectShareLinkError::BeginTransaction {
                actor_user_id,
                source,
            })?;
    let grant = sharing_persistence::find_valid_grant_for_update(&mut transaction, token)
        .await
        .map_err(|source| JoinProjectShareLinkError::Lookup {
            actor_user_id,
            source,
        })?
        .ok_or(JoinProjectShareLinkError::NotFound)?;
    let role = super::grant_project_share_link_role_at_least(
        &mut transaction,
        grant.project_id,
        actor_user_id,
        grant.permission.project_role(),
        Utc::now(),
    )
    .await
    .map_err(|source| JoinProjectShareLinkError::GrantRole {
        project_id: grant.project_id,
        actor_user_id,
        source,
    })?;
    super::grant_persistence::advance_project_access_epoch(&mut transaction, grant.project_id)
        .await
        .map_err(|source| JoinProjectShareLinkError::GrantRole {
            project_id: grant.project_id,
            actor_user_id,
            source,
        })?;
    transaction
        .commit()
        .await
        .map_err(|source| JoinProjectShareLinkError::Commit {
            project_id: grant.project_id,
            actor_user_id,
            source,
        })?;
    Ok(JoinedProjectShareLink {
        project_id: grant.project_id,
        role,
        permission: grant.permission,
    })
}

pub(crate) async fn revoke_project_temporary_sessions(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<(), sqlx::Error> {
    sharing_persistence::revoke_project_temporary_sessions(connection, project_id).await?;
    super::grant_persistence::advance_project_access_epoch(connection, project_id).await?;
    Ok(())
}

pub(crate) async fn resolve_project_share_link(
    db: &PgPool,
    token: &str,
) -> Result<ResolvedProjectShareLink, ResolveProjectShareLinkError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(ResolveProjectShareLinkError::EmptyToken);
    }
    sharing_persistence::resolve_valid(db, token)
        .await
        .map_err(|source| ResolveProjectShareLinkError::Lookup { source })?
        .ok_or(ResolveProjectShareLinkError::NotFound)
}

pub(crate) async fn create_temporary_share_login(
    db: &PgPool,
    token: &str,
    display_name: &str,
    anonymous_mode: AnonymousMode,
) -> Result<TemporaryShareSession, CreateTemporaryShareLoginError> {
    ensure_guest_write_allowed(anonymous_mode)?;
    let token = token.trim();
    let display_name = display_name.trim();
    if token.is_empty() {
        return Err(CreateTemporaryShareLoginError::EmptyToken);
    }
    if display_name.is_empty() || display_name.len() > 64 {
        return Err(CreateTemporaryShareLoginError::InvalidDisplayName);
    }
    let session_token = format!("gsh_{}", Alphanumeric.sample_string(&mut rand::rng(), 44));
    let session_token_fingerprint = Sha256::digest(session_token.as_bytes());
    let session_id = Uuid::new_v4();
    let created_at = Utc::now();
    let expires_at = created_at + chrono::Duration::days(30);
    let mut transaction = db
        .begin()
        .await
        .map_err(|source| CreateTemporaryShareLoginError::BeginTransaction { source })?;
    let project_id = sharing_persistence::temporary_share_project_id(&mut transaction, token)
        .await
        .map_err(|source| CreateTemporaryShareLoginError::ShareLinkLookup { source })?
        .ok_or(CreateTemporaryShareLoginError::NotFound)?;
    // A template-status change locks the project before revoking guest sessions. Keep the same
    // project-then-link order so admission and that status change cannot race or deadlock.
    let is_template = lock_project_template_status(&mut transaction, project_id)
        .await
        .map_err(
            |source| CreateTemporaryShareLoginError::ProjectClassification { project_id, source },
        )?
        .ok_or(CreateTemporaryShareLoginError::NotFound)?;
    if is_template {
        return Err(CreateTemporaryShareLoginError::TemplateUnsupported { project_id });
    }
    let target =
        sharing_persistence::lock_temporary_share_target(&mut transaction, token, project_id)
            .await
            .map_err(|source| CreateTemporaryShareLoginError::ShareLinkLock { project_id, source })?
            .ok_or(CreateTemporaryShareLoginError::NotFound)?;
    if target.permission != ProjectPermission::Write {
        return Err(CreateTemporaryShareLoginError::WritePermissionRequired { project_id });
    }
    sharing_persistence::insert_anonymous_session(
        &mut transaction,
        &sharing_persistence::AnonymousShareSessionWrite {
            id: session_id,
            project_id,
            share_link_id: target.share_link_id,
            session_token_fingerprint: session_token_fingerprint.as_ref(),
            display_name,
            permission: target.permission,
            created_at,
            expires_at,
        },
    )
    .await
    .map_err(|source| CreateTemporaryShareLoginError::Persist { project_id, source })?;
    transaction
        .commit()
        .await
        .map_err(|source| CreateTemporaryShareLoginError::Commit { project_id, source })?;
    Ok(TemporaryShareSession {
        project_id,
        session_token,
        session_id,
        display_name: display_name.to_string(),
        permission: target.permission,
    })
}

fn ensure_guest_write_allowed(
    anonymous_mode: AnonymousMode,
) -> Result<(), CreateTemporaryShareLoginError> {
    if anonymous_mode.allows_guest_write() {
        Ok(())
    } else {
        Err(CreateTemporaryShareLoginError::GuestWriteDisabled)
    }
}

#[derive(Debug, Error)]
pub(crate) enum EnableProjectShareLinkError {
    #[error("share-link expiration must be in the future")]
    ExpirationNotFuture,
    #[error("could not begin share-link update transaction for project {project_id}")]
    BeginTransaction {
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("could not persist share link for project {project_id}")]
    Persist {
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("could not commit share-link update for project {project_id}")]
    Commit {
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

#[derive(Debug, Error)]
pub(crate) enum RevokeProjectShareLinkError {
    #[error("share link {share_link_id} was not found in project {project_id}")]
    NotFound {
        project_id: Uuid,
        share_link_id: Uuid,
    },
    #[error("could not begin revoking share link {share_link_id} from project {project_id}")]
    BeginTransaction {
        project_id: Uuid,
        share_link_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error(
        "could not persist revocation of share link {share_link_id} from project {project_id}"
    )]
    Persist {
        project_id: Uuid,
        share_link_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("could not commit revocation of share link {share_link_id} from project {project_id}")]
    Commit {
        project_id: Uuid,
        share_link_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

#[derive(Debug, Error)]
pub(crate) enum JoinProjectShareLinkError {
    #[error("share-link token is empty")]
    EmptyToken,
    #[error("share link was not found")]
    NotFound,
    #[error("could not begin share-link join for user {actor_user_id}")]
    BeginTransaction {
        actor_user_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("could not look up share link for user {actor_user_id}")]
    Lookup {
        actor_user_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("could not grant project {project_id} access to user {actor_user_id}")]
    GrantRole {
        project_id: Uuid,
        actor_user_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("could not commit project {project_id} access for user {actor_user_id}")]
    Commit {
        project_id: Uuid,
        actor_user_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

#[derive(Debug, Error)]
pub(crate) enum ResolveProjectShareLinkError {
    #[error("share-link token is empty")]
    EmptyToken,
    #[error("share link was not found")]
    NotFound,
    #[error("could not resolve share link")]
    Lookup {
        #[source]
        source: sqlx::Error,
    },
}

#[derive(Debug, Error)]
pub(crate) enum CreateTemporaryShareLoginError {
    #[error("named guest editing is disabled")]
    GuestWriteDisabled,
    #[error("share-link token is empty")]
    EmptyToken,
    #[error("guest display name must contain 1 to 64 characters")]
    InvalidDisplayName,
    #[error("share link was not found")]
    NotFound,
    #[error("project {project_id} is a template and does not accept temporary share sessions")]
    TemplateUnsupported { project_id: Uuid },
    #[error("project {project_id} share link does not grant write access")]
    WritePermissionRequired { project_id: Uuid },
    #[error("could not begin creating a temporary share session")]
    BeginTransaction {
        #[source]
        source: sqlx::Error,
    },
    #[error("could not resolve the temporary share-session link")]
    ShareLinkLookup {
        #[source]
        source: sqlx::Error,
    },
    #[error("could not classify temporary share-session project {project_id}")]
    ProjectClassification {
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("could not lock the temporary share-session link for project {project_id}")]
    ShareLinkLock {
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("could not persist temporary share session for project {project_id}")]
    Persist {
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("could not commit temporary share session for project {project_id}")]
    Commit {
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

#[cfg(test)]
mod tests {
    use super::{ensure_guest_write_allowed, CreateTemporaryShareLoginError};
    use crate::access::AnonymousMode;

    #[test]
    fn temporary_share_sessions_require_named_guest_write_mode() {
        assert!(ensure_guest_write_allowed(AnonymousMode::ReadWriteNamed).is_ok());
        assert!(matches!(
            ensure_guest_write_allowed(AnonymousMode::ReadOnly),
            Err(CreateTemporaryShareLoginError::GuestWriteDisabled)
        ));
        assert!(matches!(
            ensure_guest_write_allowed(AnonymousMode::Off),
            Err(CreateTemporaryShareLoginError::GuestWriteDisabled)
        ));
    }
}
