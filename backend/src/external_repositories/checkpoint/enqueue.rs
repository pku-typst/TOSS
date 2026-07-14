//! Deciding whether an outbound checkpoint request should be queued.

use super::persistence;
use crate::workspace::lock_workspace_version;
use chrono::Utc;
use sqlx::PgPool;
use uuid::Uuid;

pub(super) enum EnqueueCheckpointResult {
    NotLinked,
    InboundActive,
    UpToDate(i64),
    Queued(i64),
}

pub(super) async fn enqueue_checkpoint(
    db: &PgPool,
    project_id: Uuid,
) -> Result<EnqueueCheckpointResult, sqlx::Error> {
    let now = Utc::now();
    let mut transaction = db.begin().await?;
    let Some(workspace_version) = lock_workspace_version(&mut transaction, project_id).await?
    else {
        transaction.commit().await?;
        return Ok(EnqueueCheckpointResult::NotLinked);
    };
    let Some(target) = persistence::target_for_update(&mut transaction, project_id).await? else {
        transaction.commit().await?;
        return Ok(EnqueueCheckpointResult::NotLinked);
    };
    let result = if target.inbound_active {
        EnqueueCheckpointResult::InboundActive
    } else if target.synced_workspace_version.is_none() {
        EnqueueCheckpointResult::NotLinked
    } else if let Some(queued_version) = target.queued_version {
        persistence::resume_queue(&mut transaction, project_id, now).await?;
        EnqueueCheckpointResult::Queued(queued_version)
    } else if target.last_remote_sha.is_some()
        && target.synced_workspace_version.unwrap_or_default() >= workspace_version
    {
        EnqueueCheckpointResult::UpToDate(workspace_version)
    } else {
        persistence::insert_queue(&mut transaction, project_id, workspace_version, now)
            .await?
            .map(EnqueueCheckpointResult::Queued)
            .unwrap_or(EnqueueCheckpointResult::NotLinked)
    };
    transaction.commit().await?;
    Ok(result)
}
