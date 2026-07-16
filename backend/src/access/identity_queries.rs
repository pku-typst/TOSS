//! User identity projections consumed by Access and peer contexts.

use super::identity_persistence;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
enum IdentityLookup {
    Users,
    DisplayName,
    CommitIdentities,
    CommitIdentity,
    CommitIdentityByEmail,
    Username,
}

#[derive(Debug, Error)]
#[error("identity lookup {query:?} failed")]
pub(crate) struct IdentityLookupError {
    query: IdentityLookup,
    #[source]
    source: sqlx::Error,
}

fn lookup_error(query: IdentityLookup, source: sqlx::Error) -> IdentityLookupError {
    IdentityLookupError { query, source }
}

pub(crate) struct UserIdentity {
    pub id: Uuid,
    pub display_name: String,
}

pub(crate) struct CommitIdentity {
    pub user_id: Uuid,
    pub display_name: String,
    pub email: String,
}

pub(crate) async fn list_user_identities(
    db: &PgPool,
    user_ids: &[Uuid],
) -> Result<Vec<UserIdentity>, IdentityLookupError> {
    identity_persistence::list(db, user_ids)
        .await
        .map_err(|source| lookup_error(IdentityLookup::Users, source))
        .map(|records| {
            records
                .into_iter()
                .map(|record| UserIdentity {
                    id: record.id,
                    display_name: record.display_name,
                })
                .collect()
        })
}

pub(crate) async fn user_display_name(
    db: &PgPool,
    user_id: Uuid,
) -> Result<Option<String>, IdentityLookupError> {
    identity_persistence::display_name(db, user_id)
        .await
        .map_err(|source| lookup_error(IdentityLookup::DisplayName, source))
}

pub(crate) async fn list_commit_identities(
    db: &PgPool,
    user_ids: &[Uuid],
) -> Result<Vec<CommitIdentity>, IdentityLookupError> {
    identity_persistence::list_commit_identities(db, user_ids)
        .await
        .map_err(|source| lookup_error(IdentityLookup::CommitIdentities, source))
        .map(|records| {
            records
                .into_iter()
                .map(commit_identity_from_record)
                .collect()
        })
}

pub(crate) async fn commit_identity(
    db: &PgPool,
    user_id: Uuid,
) -> Result<Option<CommitIdentity>, IdentityLookupError> {
    identity_persistence::find_commit_identity(db, user_id)
        .await
        .map_err(|source| lookup_error(IdentityLookup::CommitIdentity, source))
        .map(|record| record.map(commit_identity_from_record))
}

pub(crate) async fn commit_identity_by_email(
    db: &PgPool,
    email: &str,
) -> Result<Option<CommitIdentity>, IdentityLookupError> {
    identity_persistence::find_commit_identity_by_email(db, email)
        .await
        .map_err(|source| lookup_error(IdentityLookup::CommitIdentityByEmail, source))
        .map(|record| record.map(commit_identity_from_record))
}

pub(crate) async fn user_username(
    db: &PgPool,
    user_id: Uuid,
) -> Result<Option<String>, IdentityLookupError> {
    identity_persistence::username(db, user_id)
        .await
        .map_err(|source| lookup_error(IdentityLookup::Username, source))
}

fn commit_identity_from_record(
    record: identity_persistence::CommitIdentityRecord,
) -> CommitIdentity {
    CommitIdentity {
        user_id: record.user_id,
        display_name: record.display_name,
        email: record.email,
    }
}
