//! Best-effort application audit event recording.

mod persistence;

use chrono::Utc;
use sqlx::PgPool;
use tracing::error;
use uuid::Uuid;

pub(crate) async fn record_event(
    db: &PgPool,
    actor_user_id: Option<Uuid>,
    event_type: &str,
    payload: serde_json::Value,
) {
    if let Err(database_error) = persistence::insert(
        db,
        Uuid::new_v4(),
        actor_user_id,
        event_type,
        &payload,
        Utc::now(),
    )
    .await
    {
        error!(%database_error, event_type, "audit event insert failed");
    }
}
