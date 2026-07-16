//! Transactional checkpoint-operation state shared with sibling workflows.

use super::super::provider::ProviderInstanceId;
use super::persistence;
use sqlx::PgConnection;
use uuid::Uuid;

pub(in crate::external_repositories) async fn resume_reauthorized_checkpoints(
    connection: &mut PgConnection,
    user_id: Uuid,
    provider: &ProviderInstanceId,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<(), sqlx::Error> {
    persistence::resume_reauthorized_checkpoints(connection, user_id, provider, now).await
}

pub(in crate::external_repositories) async fn checkpoint_operation_exists(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<bool, sqlx::Error> {
    persistence::checkpoint_operation_exists(connection, project_id).await
}

pub(in crate::external_repositories) async fn checkpoint_operation_exists_for_update(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<bool, sqlx::Error> {
    persistence::checkpoint_operation_exists_for_update(connection, project_id).await
}
