//! HTTP transport for Workspace project settings.

use super::file_policy::sanitize_project_path;
use super::http_error::project_service_unavailable;
use super::project_settings::{
    change_project_setting, get_or_create_project_settings, ChangeProjectSetting,
    ChangeProjectSettingError, GetProjectSettingsError, ProjectSettingChange,
};
use super::ProjectSettings;
use crate::access::{ensure_project_access, ensure_project_role, AccessNeed};
use crate::app_state::AppState;
use crate::collaboration::WorkspaceChange;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use uuid::Uuid;

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct UpdateProjectEntryFileInput {
    pub entry_file_path: String,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct UpdateProjectLatexEngineInput {
    pub latex_engine: super::LatexEngine,
}

pub(crate) async fn get_project_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<ProjectSettings>, ApiError> {
    ensure_project_access(&state.db, &headers, project_id, AccessNeed::Read).await?;
    Ok(Json(
        get_or_create_project_settings(&state.db, project_id).await?,
    ))
}

pub(crate) async fn update_project_entry_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UpdateProjectEntryFileInput>,
) -> Result<Json<ProjectSettings>, ApiError> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let entry_file_path = sanitize_project_path(&input.entry_file_path)?;
    let settings = change_project_setting(
        &state.db,
        ChangeProjectSetting {
            project_id,
            change: ProjectSettingChange::EntryFilePath(entry_file_path),
            actor_user_id: actor,
        },
    )
    .await?;
    state
        .collaboration
        .workspace_changed(project_id, WorkspaceChange::Settings)
        .await;
    Ok(Json(settings))
}

pub(crate) async fn update_project_latex_engine(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UpdateProjectLatexEngineInput>,
) -> Result<Json<ProjectSettings>, ApiError> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let settings = change_project_setting(
        &state.db,
        ChangeProjectSetting {
            project_id,
            change: ProjectSettingChange::LatexEngine(input.latex_engine),
            actor_user_id: actor,
        },
    )
    .await?;
    state
        .collaboration
        .workspace_changed(project_id, WorkspaceChange::Settings)
        .await;
    Ok(Json(settings))
}

impl From<GetProjectSettingsError> for ApiError {
    fn from(source: GetProjectSettingsError) -> Self {
        match source {
            GetProjectSettingsError::ProjectNotFound => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::ProjectNotFound,
                "Project was not found",
            ),
            failure @ GetProjectSettingsError::Persistence(_) => {
                project_service_unavailable(failure)
            }
        }
    }
}

impl From<ChangeProjectSettingError> for ApiError {
    fn from(source: ChangeProjectSettingError) -> Self {
        match source {
            ChangeProjectSettingError::ProjectNotFound => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::ProjectNotFound,
                "Project was not found",
            ),
            ChangeProjectSettingError::LatexEngineNotApplicable => ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                ApiErrorCode::UnprocessableEntity,
                "LaTeX engine does not apply to this project type",
            ),
            ChangeProjectSettingError::EntryFileTypeMismatch => ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                ApiErrorCode::UnprocessableEntity,
                "Entry file does not apply to this project type",
            ),
            ChangeProjectSettingError::EntryFileNotFound => ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                ApiErrorCode::UnprocessableEntity,
                "Entry file was not found in the project",
            ),
            failure @ ChangeProjectSettingError::Persistence(_) => {
                project_service_unavailable(failure)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_settings_projects_have_a_semantic_not_found_response() {
        let error = ApiError::from(GetProjectSettingsError::ProjectNotFound);

        assert_eq!(error.status(), StatusCode::NOT_FOUND);
        assert_eq!(error.code(), ApiErrorCode::ProjectNotFound);
    }

    #[test]
    fn latex_engine_changes_are_rejected_for_non_latex_projects() {
        let error = ApiError::from(ChangeProjectSettingError::LatexEngineNotApplicable);

        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error.code(), ApiErrorCode::UnprocessableEntity);
    }

    #[test]
    fn entry_file_invariants_have_semantic_responses() {
        for source in [
            ChangeProjectSettingError::EntryFileTypeMismatch,
            ChangeProjectSettingError::EntryFileNotFound,
        ] {
            let error = ApiError::from(source);
            assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
            assert_eq!(error.code(), ApiErrorCode::UnprocessableEntity);
        }
    }
}
