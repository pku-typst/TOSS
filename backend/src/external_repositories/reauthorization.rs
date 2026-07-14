//! Reauthorization recovery process spanning External Repositories sub-features.

use super::provider::ProviderInstanceId;
use chrono::{DateTime, Utc};
use sqlx::PgConnection;
use uuid::Uuid;

pub(super) async fn resume_work(
    connection: &mut PgConnection,
    user_id: Uuid,
    provider: &ProviderInstanceId,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    super::linking::resume_reauthorized_links(connection, user_id, provider, now).await?;
    super::checkpoint::resume_reauthorized_checkpoints(connection, user_id, provider, now).await?;
    super::inbound::resume_reauthorized_jobs(connection, user_id, provider, now).await
}
