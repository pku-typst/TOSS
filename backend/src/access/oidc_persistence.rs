//! OIDC state and account persistence.

use chrono::{DateTime, Utc};
use sqlx::PgConnection;

pub(crate) async fn delete_expired_states(
    connection: &mut PgConnection,
) -> Result<(), sqlx::Error> {
    sqlx::query("delete from oidc_states where created_at < now() - interval '15 minutes'")
        .execute(connection)
        .await?;
    Ok(())
}

pub(crate) async fn upsert_state(
    connection: &mut PgConnection,
    state: &str,
    nonce: &str,
    created_at: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into oidc_states (state, nonce, created_at) values ($1, $2, $3)
         on conflict (state) do update
         set nonce = excluded.nonce, created_at = excluded.created_at",
    )
    .bind(state)
    .bind(nonce)
    .bind(created_at)
    .execute(connection)
    .await?;
    Ok(())
}

pub(crate) async fn consume_state(
    connection: &mut PgConnection,
    state: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "delete from oidc_states
         where state = $1
           and created_at > now() - interval '10 minutes'
         returning nonce",
    )
    .bind(state)
    .fetch_optional(connection)
    .await
}
