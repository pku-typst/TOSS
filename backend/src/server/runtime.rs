use crate::app_state::AppState;
use crate::process_lifecycle::unavailable_response;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Json;
use sqlx::PgPool;
use std::time::Duration;
use tracing::error;

const READINESS_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct HealthResponse {
    status: &'static str,
    service: &'static str,
}

pub(super) async fn run_migrations(pool: &PgPool) -> Result<(), sqlx::migrate::MigrateError> {
    sqlx::migrate!("./migrations")
        .run(pool)
        .await
        .inspect_err(|error| error!("migration failed: {error}"))?;
    Ok(())
}

pub(super) async fn health() -> Json<HealthResponse> {
    healthy_response()
}

pub(super) async fn ready(State(state): State<AppState>) -> Response {
    if state.drain.is_triggered() {
        return unavailable_response();
    }
    let dependencies = async {
        sqlx::query_scalar::<_, i32>("select 1")
            .fetch_one(&state.db)
            .await
            .map_err(ReadinessError::Database)?;
        let data = tokio::fs::metadata(&state.data_dir)
            .await
            .map_err(ReadinessError::DataDirectory)?;
        let git = tokio::fs::metadata(&state.git_storage_dir)
            .await
            .map_err(ReadinessError::GitDirectory)?;
        if !data.is_dir() || !git.is_dir() {
            return Err(ReadinessError::StorageType);
        }
        Ok::<_, ReadinessError>(())
    };
    match tokio::time::timeout(READINESS_TIMEOUT, dependencies).await {
        Ok(Ok(())) if !state.drain.is_triggered() => healthy_response().into_response(),
        Ok(Ok(())) => unavailable_response(),
        Ok(Err(readiness_error)) => {
            error!(?readiness_error, "readiness dependency check failed");
            unavailable_response()
        }
        Err(_) => {
            error!("readiness dependency check timed out");
            unavailable_response()
        }
    }
}

fn healthy_response() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "core-api",
    })
}

#[derive(Debug, thiserror::Error)]
enum ReadinessError {
    #[error("database check failed")]
    Database(#[source] sqlx::Error),
    #[error("data directory check failed")]
    DataDirectory(#[source] std::io::Error),
    #[error("Git directory check failed")]
    GitDirectory(#[source] std::io::Error),
    #[error("required storage path is not a directory")]
    StorageType,
}
