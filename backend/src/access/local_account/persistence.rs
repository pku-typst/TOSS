//! Local account credential persistence.

use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

pub(super) struct LocalAccountCredentials {
    pub user_id: Uuid,
    pub password_hash: String,
}

pub(super) struct InsertLocalAccountRecord<'value> {
    pub user_id: Uuid,
    pub email: &'value str,
    pub username: &'value str,
    pub display_name: &'value str,
    pub password_hash: &'value str,
    pub now: DateTime<Utc>,
}

pub(super) async fn credentials_by_email(
    db: &PgPool,
    email: &str,
) -> Result<Option<LocalAccountCredentials>, sqlx::Error> {
    let row = sqlx::query(
        "select u.id, la.password_hash
         from users u
         join local_accounts la on la.user_id = u.id
         where lower(u.email) = $1",
    )
    .bind(email)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| LocalAccountCredentials {
        user_id: row.get("id"),
        password_hash: row.get("password_hash"),
    }))
}

pub(super) async fn insert_user(
    connection: &mut PgConnection,
    record: &InsertLocalAccountRecord<'_>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into users (id, email, username, display_name, created_at)
         values ($1, $2, $3, $4, $5)",
    )
    .bind(record.user_id)
    .bind(record.email)
    .bind(record.username)
    .bind(record.display_name)
    .bind(record.now)
    .execute(connection)
    .await?;
    Ok(())
}

pub(super) async fn insert_local_account(
    connection: &mut PgConnection,
    record: &InsertLocalAccountRecord<'_>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into local_accounts (user_id, password_hash, created_at, updated_at)
         values ($1, $2, $3, $3)",
    )
    .bind(record.user_id)
    .bind(record.password_hash)
    .bind(record.now)
    .execute(connection)
    .await?;
    Ok(())
}
