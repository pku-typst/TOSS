//! User identity projection persistence.

use sqlx::{PgPool, Row};
use uuid::Uuid;

pub(crate) struct UserIdentityRecord {
    pub id: Uuid,
    pub display_name: String,
}

pub(crate) struct CommitIdentityRecord {
    pub user_id: Uuid,
    pub display_name: String,
    pub email: String,
}

pub(crate) async fn list(
    db: &PgPool,
    user_ids: &[Uuid],
) -> Result<Vec<UserIdentityRecord>, sqlx::Error> {
    let rows = sqlx::query(
        "select id, display_name
         from users
         where id = any($1)",
    )
    .bind(user_ids)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| UserIdentityRecord {
            id: row.get("id"),
            display_name: row.get("display_name"),
        })
        .collect())
}

pub(crate) async fn display_name(
    db: &PgPool,
    user_id: Uuid,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("select display_name from users where id = $1")
        .bind(user_id)
        .fetch_optional(db)
        .await
}

pub(crate) async fn list_commit_identities(
    db: &PgPool,
    user_ids: &[Uuid],
) -> Result<Vec<CommitIdentityRecord>, sqlx::Error> {
    let rows = sqlx::query(
        "select id, display_name, email
         from users
         where id = any($1)",
    )
    .bind(user_ids)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| CommitIdentityRecord {
            user_id: row.get("id"),
            display_name: row.get("display_name"),
            email: row.get("email"),
        })
        .collect())
}

pub(crate) async fn find_commit_identity(
    db: &PgPool,
    user_id: Uuid,
) -> Result<Option<CommitIdentityRecord>, sqlx::Error> {
    let row = sqlx::query(
        "select id, display_name, email
         from users
         where id = $1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| CommitIdentityRecord {
        user_id: row.get("id"),
        display_name: row.get("display_name"),
        email: row.get("email"),
    }))
}

pub(crate) async fn find_commit_identity_by_email(
    db: &PgPool,
    email: &str,
) -> Result<Option<CommitIdentityRecord>, sqlx::Error> {
    let row = sqlx::query(
        "select id, display_name, email
         from users
         where lower(email) = lower($1)
         order by created_at asc
         limit 1",
    )
    .bind(email)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| CommitIdentityRecord {
        user_id: row.get("id"),
        display_name: row.get("display_name"),
        email: row.get("email"),
    }))
}

pub(crate) async fn username(db: &PgPool, user_id: Uuid) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("select username from users where id = $1")
        .bind(user_id)
        .fetch_optional(db)
        .await
}
