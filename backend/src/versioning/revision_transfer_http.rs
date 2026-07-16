use super::revision_documents::{self, RevisionDocumentsError, RevisionTransferRequest};
use super::revision_transfer::{RevisionTransfer, RevisionTransferError};
use crate::access::{ensure_project_access, AccessNeed};
use crate::app_state::AppState;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use uuid::Uuid;

#[derive(Default, serde::Deserialize)]
pub(crate) struct RevisionDocumentsQuery {
    pub current_revision_id: Option<String>,
    pub include_live_anchor: Option<bool>,
}

pub(crate) async fn get_revision_documents(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<RevisionDocumentsQuery>,
    Path((project_id, revision_id)): Path<(Uuid, String)>,
) -> Result<Json<RevisionTransfer>, ApiError> {
    ensure_project_access(&state.db, &headers, project_id, AccessNeed::Read).await?;
    revision_documents::revision_documents(
        &state.db,
        &state.versioning,
        project_id,
        revision_id,
        RevisionTransferRequest {
            current_revision_id: query.current_revision_id,
            include_live_anchor: query.include_live_anchor.unwrap_or(false),
        },
    )
    .await
    .map(Json)
    .map_err(Into::into)
}

impl From<RevisionDocumentsError> for ApiError {
    fn from(source: RevisionDocumentsError) -> Self {
        match source {
            RevisionDocumentsError::ProjectNotFound { .. } => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::ProjectNotFound,
                "Project was not found",
            ),
            RevisionDocumentsError::Transfer {
                source:
                    RevisionTransferError::InvalidRevisionId { .. }
                    | RevisionTransferError::RevisionNotFound { .. },
                ..
            } => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::RevisionNotFound,
                "Revision was not found",
            ),
            failure => ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::RevisionServiceUnavailable,
                "Revision service is unavailable",
            )
            .with_diagnostic("revision document transfer request failed", failure),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_revision_project_has_a_semantic_not_found_response() {
        let error = ApiError::from(RevisionDocumentsError::ProjectNotFound {
            project_id: Uuid::nil(),
        });

        assert_eq!(error.status(), StatusCode::NOT_FOUND);
        assert_eq!(error.code(), ApiErrorCode::ProjectNotFound);
    }
}
