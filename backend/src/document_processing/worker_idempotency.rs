//! Bounded replay records for authenticated worker mutations.

use chrono::{Duration, Utc};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use subtle::ConstantTimeEq;
use thiserror::Error;
use uuid::Uuid;

const REQUEST_PENDING_STATUS: i32 = 102;
const REQUEST_PENDING_TTL: Duration = Duration::minutes(10);
const REQUEST_REPLAY_TTL: Duration = Duration::hours(24);

pub(super) struct WorkerRequestReservation {
    db: PgPool,
    worker_identity: String,
    request_id: Uuid,
    route_key: String,
    payload_digest: [u8; 32],
}

pub(super) struct StoredWorkerResponse {
    pub status: u16,
    pub body: Option<Value>,
}

pub(super) enum WorkerRequestStart {
    Execute(WorkerRequestReservation),
    Replay(StoredWorkerResponse),
    InProgress,
}

#[derive(Debug, Error)]
pub(super) enum WorkerRequestError {
    #[error("request identifier was reused for a different worker mutation")]
    Conflict,
    #[error("worker request replay persistence failed")]
    Persistence(#[source] sqlx::Error),
    #[error("worker request payload could not be serialized")]
    Serialization(#[source] serde_json::Error),
}

pub(super) async fn begin_worker_request<T: Serialize>(
    db: &PgPool,
    worker_identity: &str,
    request_id: Uuid,
    route_key: String,
    payload: &T,
) -> Result<WorkerRequestStart, WorkerRequestError> {
    let payload = serde_json::to_vec(payload).map_err(WorkerRequestError::Serialization)?;
    let payload_digest: [u8; 32] = Sha256::digest(payload).into();
    let now = Utc::now();
    let mut transaction = db.begin().await.map_err(WorkerRequestError::Persistence)?;
    let lock_key = format!("{worker_identity}:{request_id}");
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(lock_key)
        .fetch_one(&mut *transaction)
        .await
        .map_err(WorkerRequestError::Persistence)?;

    let existing = sqlx::query(
        "select route_key, payload_digest, response_status, response_body, expires_at
         from processing_worker_requests
         where worker_identity = $1 and request_id = $2",
    )
    .bind(worker_identity)
    .bind(request_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(WorkerRequestError::Persistence)?;
    if let Some(existing) = existing {
        let expires_at: chrono::DateTime<Utc> = existing
            .try_get("expires_at")
            .map_err(WorkerRequestError::Persistence)?;
        if expires_at <= now {
            sqlx::query(
                "delete from processing_worker_requests
                 where worker_identity = $1 and request_id = $2",
            )
            .bind(worker_identity)
            .bind(request_id)
            .execute(&mut *transaction)
            .await
            .map_err(WorkerRequestError::Persistence)?;
        } else {
            let existing_route: String = existing
                .try_get("route_key")
                .map_err(WorkerRequestError::Persistence)?;
            let existing_digest: Vec<u8> = existing
                .try_get("payload_digest")
                .map_err(WorkerRequestError::Persistence)?;
            if existing_route != route_key
                || existing_digest.len() != payload_digest.len()
                || !bool::from(existing_digest.as_slice().ct_eq(&payload_digest))
            {
                return Err(WorkerRequestError::Conflict);
            }
            let status: i32 = existing
                .try_get("response_status")
                .map_err(WorkerRequestError::Persistence)?;
            if status == REQUEST_PENDING_STATUS {
                transaction
                    .commit()
                    .await
                    .map_err(WorkerRequestError::Persistence)?;
                return Ok(WorkerRequestStart::InProgress);
            }
            let status = u16::try_from(status).map_err(|_| {
                WorkerRequestError::Persistence(sqlx::Error::Protocol(
                    "stored worker response status is invalid".to_string(),
                ))
            })?;
            let body: Option<Value> = existing
                .try_get("response_body")
                .map_err(WorkerRequestError::Persistence)?;
            transaction
                .commit()
                .await
                .map_err(WorkerRequestError::Persistence)?;
            return Ok(WorkerRequestStart::Replay(StoredWorkerResponse {
                status,
                body,
            }));
        }
    }

    sqlx::query(
        "insert into processing_worker_requests (
             worker_identity, request_id, route_key, payload_digest,
             response_status, response_body, created_at, expires_at
         ) values ($1, $2, $3, $4, $5, null, $6, $7)",
    )
    .bind(worker_identity)
    .bind(request_id)
    .bind(&route_key)
    .bind(payload_digest.as_slice())
    .bind(REQUEST_PENDING_STATUS)
    .bind(now)
    .bind(now + REQUEST_PENDING_TTL)
    .execute(&mut *transaction)
    .await
    .map_err(WorkerRequestError::Persistence)?;
    transaction
        .commit()
        .await
        .map_err(WorkerRequestError::Persistence)?;

    Ok(WorkerRequestStart::Execute(WorkerRequestReservation {
        db: db.clone(),
        worker_identity: worker_identity.to_string(),
        request_id,
        route_key,
        payload_digest,
    }))
}

impl WorkerRequestReservation {
    pub(super) async fn finish(
        self,
        status: u16,
        body: Option<Value>,
    ) -> Result<(), WorkerRequestError> {
        let result = sqlx::query(
            "update processing_worker_requests
             set response_status = $5, response_body = $6, expires_at = $7
             where worker_identity = $1 and request_id = $2
               and route_key = $3 and payload_digest = $4
               and response_status = $8",
        )
        .bind(&self.worker_identity)
        .bind(self.request_id)
        .bind(&self.route_key)
        .bind(self.payload_digest.as_slice())
        .bind(i32::from(status))
        .bind(body)
        .bind(Utc::now() + REQUEST_REPLAY_TTL)
        .bind(REQUEST_PENDING_STATUS)
        .execute(&self.db)
        .await
        .map_err(WorkerRequestError::Persistence)?;
        if result.rows_affected() != 1 {
            return Err(WorkerRequestError::Persistence(sqlx::Error::Protocol(
                "worker request reservation was lost".to_string(),
            )));
        }
        Ok(())
    }

    pub(super) async fn abort(self) -> Result<(), WorkerRequestError> {
        let result = sqlx::query(
            "delete from processing_worker_requests
             where worker_identity = $1 and request_id = $2
               and route_key = $3 and payload_digest = $4
               and response_status = $5",
        )
        .bind(&self.worker_identity)
        .bind(self.request_id)
        .bind(&self.route_key)
        .bind(self.payload_digest.as_slice())
        .bind(REQUEST_PENDING_STATUS)
        .execute(&self.db)
        .await
        .map_err(WorkerRequestError::Persistence)?;
        if result.rows_affected() != 1 {
            return Err(WorkerRequestError::Persistence(sqlx::Error::Protocol(
                "worker request reservation was lost".to_string(),
            )));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn migrated_test_pool() -> Result<Option<PgPool>, Box<dyn std::error::Error + Send + Sync>>
    {
        let database_url =
            std::env::var("TEST_DATABASE_URL").or_else(|_| std::env::var("DATABASE_URL"));
        let Ok(database_url) = database_url else {
            return Ok(None);
        };
        let pool = PgPool::connect(&database_url).await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Some(pool))
    }

    #[tokio::test]
    async fn completed_request_replays_the_exact_response(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let identity = format!("replay-{}", Uuid::new_v4());
        let request_id = Uuid::new_v4();
        let payload = json!({"value": 1});
        let start = begin_worker_request(
            &pool,
            &identity,
            request_id,
            "POST /test".to_string(),
            &payload,
        )
        .await?;
        let WorkerRequestStart::Execute(reservation) = start else {
            return Err("first request was not reserved".into());
        };
        reservation
            .finish(201, Some(json!({"result": "created"})))
            .await?;

        match begin_worker_request(
            &pool,
            &identity,
            request_id,
            "POST /test".to_string(),
            &payload,
        )
        .await?
        {
            WorkerRequestStart::Replay(response) => {
                assert_eq!(response.status, 201);
                assert_eq!(response.body, Some(json!({"result": "created"})));
            }
            WorkerRequestStart::Execute(_) | WorkerRequestStart::InProgress => {
                return Err("completed request was not replayed".into());
            }
        }
        Ok(())
    }

    #[tokio::test]
    async fn concurrent_duplicate_has_one_executor(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let identity = format!("concurrent-{}", Uuid::new_v4());
        let request_id = Uuid::new_v4();
        let payload = json!({"value": 1});
        let first = begin_worker_request(
            &pool,
            &identity,
            request_id,
            "POST /test".to_string(),
            &payload,
        );
        let second = begin_worker_request(
            &pool,
            &identity,
            request_id,
            "POST /test".to_string(),
            &payload,
        );
        let (first, second) = tokio::join!(first, second);
        let starts = [first?, second?];
        let executors = starts
            .iter()
            .filter(|start| matches!(start, WorkerRequestStart::Execute(_)))
            .count();
        let in_progress = starts
            .iter()
            .filter(|start| matches!(start, WorkerRequestStart::InProgress))
            .count();
        assert_eq!(executors, 1);
        assert_eq!(in_progress, 1);
        Ok(())
    }

    #[tokio::test]
    async fn aborted_request_can_retry_but_changed_payload_conflicts(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let identity = format!("abort-{}", Uuid::new_v4());
        let request_id = Uuid::new_v4();
        let start = begin_worker_request(
            &pool,
            &identity,
            request_id,
            "POST /test".to_string(),
            &json!({"value": 1}),
        )
        .await?;
        let WorkerRequestStart::Execute(reservation) = start else {
            return Err("first request was not reserved".into());
        };
        reservation.abort().await?;

        let retry = begin_worker_request(
            &pool,
            &identity,
            request_id,
            "POST /test".to_string(),
            &json!({"value": 1}),
        )
        .await?;
        let WorkerRequestStart::Execute(reservation) = retry else {
            return Err("aborted request did not become executable".into());
        };
        reservation.finish(204, None).await?;

        let conflict = begin_worker_request(
            &pool,
            &identity,
            request_id,
            "POST /test".to_string(),
            &json!({"value": 2}),
        )
        .await;
        assert!(matches!(conflict, Err(WorkerRequestError::Conflict)));
        Ok(())
    }
}
