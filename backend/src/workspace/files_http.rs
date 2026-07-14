//! HTTP transport for the Workspace file tree.

use super::file_policy::{guess_content_type, is_document_text_path, sanitize_project_path};
use super::http_error::project_service_unavailable;
use super::project_file_creation::{self, CreateProjectFileError};
use super::project_file_deletion::{self, DeleteProjectFileError};
use super::project_file_move::{self, MoveProjectFileError};
use super::project_tree::{self, LoadProjectTreeError};
use super::ProjectFileKind;
use crate::access::{ensure_project_access, AccessNeed};
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::collaboration::WorkspaceChange;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use uuid::Uuid;

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct CreateProjectFileInput {
    pub path: String,
    pub kind: ProjectFileKind,
    pub content: Option<String>,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct MoveProjectFileInput {
    pub from_path: String,
    pub to_path: String,
}

pub(crate) async fn get_project_tree(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<project_tree::ProjectTreeResponse>, ApiError> {
    ensure_project_access(&state.db, &headers, project_id, AccessNeed::Read).await?;
    Ok(Json(
        project_tree::load_project_tree(&state.db, project_id).await?,
    ))
}

pub(crate) async fn create_project_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<CreateProjectFileInput>,
) -> Result<StatusCode, ApiError> {
    let principal =
        ensure_project_access(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let actor = principal.user_id;
    let path = sanitize_project_path(&input.path)?;
    let kind = input.kind;
    project_file_creation::create_project_file(
        &state.db,
        state.storage.as_ref(),
        project_file_creation::CreateProjectFileCommand {
            project_id,
            path: path.clone(),
            kind,
            content: input.content.unwrap_or_default(),
            content_type: guess_content_type(&path),
            is_text: is_document_text_path(&path),
            actor_user_id: actor,
            guest_display_name: principal.guest_display_name,
        },
    )
    .await?;
    state
        .collaboration
        .workspace_changed(
            project_id,
            WorkspaceChange::Tree {
                path: Some(path.clone()),
            },
        )
        .await;
    record_event(
        &state.db,
        actor,
        "project.file.create",
        serde_json::json!({ "project_id": project_id, "path": path, "kind": kind }),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn move_project_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<MoveProjectFileInput>,
) -> Result<StatusCode, ApiError> {
    let principal =
        ensure_project_access(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let actor = principal.user_id;
    let from_path = sanitize_project_path(&input.from_path)?;
    let to_path = sanitize_project_path(&input.to_path)?;
    project_file_move::move_project_file(
        &state.db,
        project_file_move::MoveProjectFileCommand {
            project_id,
            from_path: from_path.clone(),
            to_path: to_path.clone(),
            actor_user_id: actor,
            guest_display_name: principal.guest_display_name,
        },
    )
    .await?;
    state
        .collaboration
        .workspace_changed(
            project_id,
            WorkspaceChange::Tree {
                path: Some(to_path.clone()),
            },
        )
        .await;
    record_event(
        &state.db,
        actor,
        "project.file.move",
        serde_json::json!({ "project_id": project_id, "from_path": from_path, "to_path": to_path }),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn delete_project_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, path)): Path<(Uuid, String)>,
) -> Result<StatusCode, ApiError> {
    let principal =
        ensure_project_access(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let actor = principal.user_id;
    let path = sanitize_project_path(&path)?;
    project_file_deletion::delete_project_file(
        &state.db,
        state.storage.as_ref(),
        project_file_deletion::DeleteProjectFileCommand {
            project_id,
            path: path.clone(),
            actor_user_id: actor,
            guest_display_name: principal.guest_display_name,
        },
    )
    .await?;
    state
        .collaboration
        .workspace_changed(
            project_id,
            WorkspaceChange::Tree {
                path: Some(path.clone()),
            },
        )
        .await;
    record_event(
        &state.db,
        actor,
        "project.file.delete",
        serde_json::json!({ "project_id": project_id, "path": path }),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

impl From<DeleteProjectFileError> for ApiError {
    fn from(source: DeleteProjectFileError) -> Self {
        match source {
            DeleteProjectFileError::EntryFileDeletion => ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                ApiErrorCode::UnprocessableEntity,
                "Choose another entry file before deleting this path",
            ),
            failure @ DeleteProjectFileError::Persistence { .. } => {
                project_service_unavailable(failure)
            }
        }
    }
}

impl From<LoadProjectTreeError> for ApiError {
    fn from(source: LoadProjectTreeError) -> Self {
        match source {
            LoadProjectTreeError::ProjectNotFound => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::ProjectNotFound,
                "Project was not found",
            ),
            failure @ (LoadProjectTreeError::InvalidStoredPath { .. }
            | LoadProjectTreeError::Persistence { .. }) => project_service_unavailable(failure),
        }
    }
}

impl From<CreateProjectFileError> for ApiError {
    fn from(source: CreateProjectFileError) -> Self {
        match source {
            CreateProjectFileError::PathConflict => ApiError::new(
                StatusCode::CONFLICT,
                ApiErrorCode::ProjectPathConflict,
                "A project file already exists at this path",
            ),
            failure @ (CreateProjectFileError::Storage(_)
            | CreateProjectFileError::Persistence(_)) => project_service_unavailable(failure),
        }
    }
}

impl From<MoveProjectFileError> for ApiError {
    fn from(source: MoveProjectFileError) -> Self {
        match source {
            MoveProjectFileError::PathConflict => ApiError::new(
                StatusCode::CONFLICT,
                ApiErrorCode::ProjectPathConflict,
                "A project file already exists at the destination path",
            ),
            MoveProjectFileError::EntryFileTypeMismatch => ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                ApiErrorCode::UnprocessableEntity,
                "The moved entry file does not apply to this project type",
            ),
            failure @ MoveProjectFileError::Persistence { .. } => {
                project_service_unavailable(failure)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_move_conflicts_have_a_semantic_conflict_response() {
        let error = ApiError::from(MoveProjectFileError::PathConflict);

        assert_eq!(error.status(), StatusCode::CONFLICT);
        assert_eq!(error.code(), ApiErrorCode::ProjectPathConflict);
    }

    #[test]
    fn entry_file_deletion_has_a_semantic_response() {
        let error = ApiError::from(DeleteProjectFileError::EntryFileDeletion);

        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error.code(), ApiErrorCode::UnprocessableEntity);
    }

    #[test]
    fn invalid_entry_file_moves_have_a_semantic_response() {
        let error = ApiError::from(MoveProjectFileError::EntryFileTypeMismatch);

        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error.code(), ApiErrorCode::UnprocessableEntity);
    }
}
