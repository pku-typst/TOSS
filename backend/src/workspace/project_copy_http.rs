//! HTTP transport for Workspace project copy.

use super::http_error::project_service_unavailable;
use super::project_copy::{self, CopyProject, CopyProjectError};
use super::{Project, ProjectName};
use crate::access::required_request_user_id;
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use uuid::Uuid;

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct CreateProjectCopyInput {
    pub name: String,
}

pub(crate) async fn copy_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(source_project_id): Path<Uuid>,
    Json(input): Json<CreateProjectCopyInput>,
) -> Result<Json<Project>, ApiError> {
    let actor_user_id = required_request_user_id(&state.db, &headers).await?;
    let name = ProjectName::parse(&input.name)?;
    let project = project_copy::copy_project(
        &state.db,
        state.storage.as_ref(),
        &state.data_dir,
        &state.distribution,
        CopyProject {
            actor_user_id,
            source_project_id,
            name: &name,
        },
    )
    .await?;
    record_event(
        &state.db,
        Some(actor_user_id),
        "project.copy",
        serde_json::json!({
            "source_project_id": source_project_id,
            "project_id": project.id,
            "name": project.name
        }),
    )
    .await;
    Ok(Json(project))
}

impl From<CopyProjectError> for ApiError {
    fn from(source: CopyProjectError) -> Self {
        match source {
            CopyProjectError::SourceProjectNotFound => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::ProjectNotFound,
                "Project was not found",
            ),
            CopyProjectError::SourceProjectAccessForbidden => ApiError::new(
                StatusCode::FORBIDDEN,
                ApiErrorCode::ProjectAccessForbidden,
                "Project access is forbidden",
            ),
            CopyProjectError::ProjectTypeDisabled { .. } => ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                ApiErrorCode::ProjectTypeDisabled,
                "This project type is disabled in the current deployment",
            ),
            CopyProjectError::AssetTooLarge { .. } => ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                ApiErrorCode::ProjectAssetTooLarge,
                "A project asset is too large",
            ),
            failure @ (CopyProjectError::StorageUnavailable { .. }
            | CopyProjectError::AssetDownload { .. }
            | CopyProjectError::AssetUpload { .. }
            | CopyProjectError::CatalogAccess(_)
            | CopyProjectError::Identity(_)
            | CopyProjectError::Thumbnail(_)
            | CopyProjectError::Persistence(_)) => project_service_unavailable(failure),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_copy_sources_have_a_semantic_not_found_response() {
        let error = ApiError::from(CopyProjectError::SourceProjectNotFound);

        assert_eq!(error.status(), StatusCode::NOT_FOUND);
        assert_eq!(error.code(), ApiErrorCode::ProjectNotFound);
    }

    #[test]
    fn oversized_copy_assets_have_a_semantic_payload_response() {
        let error = ApiError::from(CopyProjectError::AssetTooLarge {
            path: "large.bin".to_owned(),
        });

        assert_eq!(error.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(error.code(), ApiErrorCode::ProjectAssetTooLarge);
    }
}
