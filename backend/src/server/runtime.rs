use axum::Json;
use sqlx::PgPool;
use tracing::error;

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
    Json(HealthResponse {
        status: "ok",
        service: "core-api",
    })
}
