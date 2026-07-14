use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

pub(super) async fn insert(
    db: &PgPool,
    id: Uuid,
    actor_user_id: Option<Uuid>,
    event_type: &str,
    payload: &serde_json::Value,
    created_at: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into audit_events
           (id, actor_user_id, event_type, payload, created_at)
         values ($1, $2, $3, $4, $5)",
    )
    .bind(id)
    .bind(actor_user_id)
    .bind(event_type)
    .bind(payload)
    .bind(created_at)
    .execute(db)
    .await?;
    Ok(())
}
