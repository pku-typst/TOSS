use crate::object_storage::{delete_object, ObjectStorage};
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::time::Duration;
use tracing::{error, warn};

const DELETE_BATCH_SIZE: usize = 32;
const DELETE_WORKER_INTERVAL: Duration = Duration::from_secs(5);
const DELETE_LOCK_TIMEOUT_MINUTES: i64 = 15;

fn retry_delay_seconds(attempt_count: i32) -> i64 {
    let exponent = u32::try_from(attempt_count.clamp(0, 8)).unwrap_or(8);
    5_i64
        .saturating_mul(2_i64.saturating_pow(exponent))
        .min(900)
}

fn external_object_keys(keys: &[String]) -> impl Iterator<Item = &str> {
    keys.iter()
        .map(String::as_str)
        .filter(|key| !key.trim().is_empty() && !key.starts_with("inline://"))
}

pub async fn enqueue_object_deletions(
    transaction: &mut Transaction<'_, Postgres>,
    keys: &[String],
) -> Result<(), sqlx::Error> {
    let now = Utc::now();
    for key in external_object_keys(keys) {
        sqlx::query(
            "insert into object_deletion_queue (
                 object_key, next_attempt_at, attempt_count, locked_at,
                 last_error, created_at, updated_at
             ) values ($1, $2, 0, null, null, $2, $2)
             on conflict (object_key) do update
             set next_attempt_at = least(object_deletion_queue.next_attempt_at, excluded.next_attempt_at),
                 locked_at = null,
                 last_error = null,
                 updated_at = excluded.updated_at",
        )
        .bind(key)
        .bind(now)
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}

async fn enqueue_object_deletion(db: &PgPool, key: &str) -> Result<(), sqlx::Error> {
    let now = Utc::now();
    sqlx::query(
        "insert into object_deletion_queue (
             object_key, next_attempt_at, attempt_count, locked_at,
             last_error, created_at, updated_at
         ) values ($1, $2, 0, null, null, $2, $2)
         on conflict (object_key) do update
         set next_attempt_at = least(object_deletion_queue.next_attempt_at, excluded.next_attempt_at),
             locked_at = null,
             updated_at = excluded.updated_at",
    )
    .bind(key)
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn cleanup_uncommitted_object(db: &PgPool, storage: Option<&ObjectStorage>, key: &str) {
    if key.starts_with("inline://") {
        return;
    }
    let Some(storage) = storage else {
        return;
    };
    if delete_object(storage, key).await.is_ok() {
        return;
    }
    if let Err(error) = enqueue_object_deletion(db, key).await {
        error!(object_key = key, %error, "failed to queue uncommitted object cleanup");
    }
}

pub async fn cleanup_uncommitted_objects(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    keys: &[String],
) {
    for key in keys {
        cleanup_uncommitted_object(db, storage, key).await;
    }
}

pub async fn delete_queued_objects_now(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    keys: &[String],
) {
    let Some(storage) = storage else {
        return;
    };
    for key in external_object_keys(keys) {
        match object_is_pinned(db, key).await {
            Ok(true) => continue,
            Ok(false) => {}
            Err(error) => {
                warn!(object_key = key, %error, "object pin lookup failed; deletion deferred");
                continue;
            }
        }
        match delete_object(storage, key).await {
            Ok(()) => {
                if let Err(error) =
                    sqlx::query("delete from object_deletion_queue where object_key = $1")
                        .bind(key)
                        .execute(db)
                        .await
                {
                    warn!(object_key = key, %error, "deleted object but could not clear cleanup queue");
                }
            }
            Err(error) => {
                warn!(object_key = key, %error, "object deletion deferred for retry");
            }
        }
    }
}

async fn object_is_pinned(db: &PgPool, key: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "select exists(
             select 1 from processing_input_asset_pins where object_key = $1
         )",
    )
    .bind(key)
    .fetch_one(db)
    .await
}

async fn claim_due_object(db: &PgPool) -> Result<Option<(String, i32)>, sqlx::Error> {
    let now = Utc::now();
    let stale_before = now - chrono::Duration::minutes(DELETE_LOCK_TIMEOUT_MINUTES);
    let row = sqlx::query(
        "with candidate as (
             select object_key
             from object_deletion_queue
             where next_attempt_at <= $1
               and (locked_at is null or locked_at <= $2)
               and not exists (
                   select 1 from processing_input_asset_pins pin
                   where pin.object_key = object_deletion_queue.object_key
               )
             order by next_attempt_at asc, created_at asc
             for update skip locked
             limit 1
         )
         update object_deletion_queue queued
         set locked_at = $1,
             attempt_count = queued.attempt_count + 1,
             updated_at = $1
         from candidate
         where queued.object_key = candidate.object_key
         returning queued.object_key, queued.attempt_count",
    )
    .bind(now)
    .bind(stale_before)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|value| (value.get("object_key"), value.get("attempt_count"))))
}

async fn defer_object_deletion(
    db: &PgPool,
    key: &str,
    attempt_count: i32,
) -> Result<(), sqlx::Error> {
    let now = Utc::now();
    let next_attempt_at: DateTime<Utc> =
        now + chrono::Duration::seconds(retry_delay_seconds(attempt_count));
    sqlx::query(
        "update object_deletion_queue
         set next_attempt_at = $2, locked_at = null,
             last_error = 'object_store_delete_failed', updated_at = $3
         where object_key = $1",
    )
    .bind(key)
    .bind(next_attempt_at)
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}

pub fn spawn_object_cleanup_worker(db: PgPool, storage: Option<ObjectStorage>) {
    let Some(storage) = storage else {
        return;
    };
    tokio::spawn(async move {
        loop {
            for _ in 0..DELETE_BATCH_SIZE {
                let claimed = match claim_due_object(&db).await {
                    Ok(Some(value)) => value,
                    Ok(None) => break,
                    Err(error) => {
                        error!(%error, "object cleanup worker could not claim work");
                        break;
                    }
                };
                let (key, attempt_count) = claimed;
                if delete_object(&storage, &key).await.is_ok() {
                    if let Err(error) =
                        sqlx::query("delete from object_deletion_queue where object_key = $1")
                            .bind(&key)
                            .execute(&db)
                            .await
                    {
                        error!(object_key = key, %error, "object cleanup status persistence failed");
                    }
                } else if let Err(error) = defer_object_deletion(&db, &key, attempt_count).await {
                    error!(object_key = key, %error, "object cleanup retry persistence failed");
                }
            }
            tokio::time::sleep(DELETE_WORKER_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::retry_delay_seconds;

    #[test]
    fn object_cleanup_retry_schedule_is_bounded() {
        assert_eq!(retry_delay_seconds(0), 5);
        assert_eq!(retry_delay_seconds(1), 10);
        assert_eq!(retry_delay_seconds(8), 900);
        assert_eq!(retry_delay_seconds(i32::MAX), 900);
    }
}
