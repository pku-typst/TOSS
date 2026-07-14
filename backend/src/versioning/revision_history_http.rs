//! HTTP transport for revision history and manual revision creation.

use super::revision_history::{self, CreateRevisionError, ListRevisionsError};
use super::Revision;
use crate::access::{ensure_project_access, ensure_project_role, AccessNeed};
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use uuid::Uuid;

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct RevisionsResponse {
    pub revisions: Vec<Revision>,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct CreateRevisionInput {
    pub summary: String,
}

#[derive(Default, serde::Deserialize)]
pub(crate) struct ListRevisionsQuery {
    pub before: Option<String>,
    pub limit: Option<usize>,
}

pub(crate) async fn list_revisions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListRevisionsQuery>,
    Path(project_id): Path<Uuid>,
) -> Result<Json<RevisionsResponse>, ApiError> {
    ensure_project_access(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let revisions = revision_history::list_revisions(
        &state.db,
        &state.versioning,
        project_id,
        query.before.as_deref(),
        query.limit.unwrap_or(40).clamp(1, 100),
    )
    .await?;
    Ok(Json(RevisionsResponse { revisions }))
}

pub(crate) async fn create_revision(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<CreateRevisionInput>,
) -> Result<Json<Revision>, ApiError> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    state
        .collaboration
        .flush_project_collaboration(project_id)
        .await
        .map_err(|failure| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::RevisionServiceUnavailable,
                "Revision could not capture the current collaboration state",
            )
            .with_diagnostic("revision collaboration projection failed", failure)
        })?;
    let revision = revision_history::create_revision(
        &state.db,
        state.storage.as_ref(),
        &state.versioning,
        &state.distribution,
        actor,
        project_id,
        &input.summary,
    )
    .await?;
    record_event(
        &state.db,
        Some(actor),
        "revision.create",
        serde_json::json!({"project_id": project_id, "revision_id": revision.id}),
    )
    .await;
    Ok(Json(revision))
}

impl From<ListRevisionsError> for ApiError {
    fn from(source: ListRevisionsError) -> Self {
        match source {
            ListRevisionsError::ProjectNotFound { .. } => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::ProjectNotFound,
                "Project was not found",
            ),
            failure => ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::RevisionServiceUnavailable,
                "Revision history is unavailable",
            )
            .with_diagnostic("revision history request failed", failure),
        }
    }
}

impl From<CreateRevisionError> for ApiError {
    fn from(source: CreateRevisionError) -> Self {
        match source {
            CreateRevisionError::InvalidSummary => ApiError::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::RevisionSummaryInvalid,
                "Revision summary is required",
            ),
            CreateRevisionError::ProjectNotFound { .. } => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::ProjectNotFound,
                "Project was not found",
            ),
            failure => ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::RevisionServiceUnavailable,
                "Revision service is unavailable",
            )
            .with_diagnostic("revision creation request failed", failure),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_revision_summary_has_a_semantic_bad_request_response() {
        let error = ApiError::from(CreateRevisionError::InvalidSummary);

        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
        assert_eq!(error.code(), ApiErrorCode::RevisionSummaryInvalid);
    }

    #[test]
    fn missing_revision_project_has_a_semantic_not_found_response() {
        let error = ApiError::from(ListRevisionsError::ProjectNotFound {
            project_id: Uuid::nil(),
        });

        assert_eq!(error.status(), StatusCode::NOT_FOUND);
        assert_eq!(error.code(), ApiErrorCode::ProjectNotFound);
    }
}
