//! HTTP transport for the Workspace project catalog and basic lifecycle.

use super::http_error::project_service_unavailable;
use super::project_catalog::{self, ListProjectsError};
use super::project_creation::{self, CreateProject, CreateProjectError};
use super::project_rename::{self, RenameProjectError};
use super::{LatexEngine, Project, ProjectName, ProjectType};
use crate::access::{ensure_project_role, required_request_user_id, AccessNeed};
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use uuid::Uuid;

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ProjectListResponse {
    pub projects: Vec<Project>,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct CreateProjectInput {
    pub name: String,
    pub project_type: Option<ProjectType>,
    pub latex_engine: Option<LatexEngine>,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct UpdateProjectNameInput {
    pub name: String,
}

#[derive(serde::Deserialize)]
pub(crate) struct ListProjectsQuery {
    pub include_archived: Option<bool>,
    pub q: Option<String>,
}

pub(crate) async fn list_projects(
    State(state): State<AppState>,
    Query(query): Query<ListProjectsQuery>,
    headers: HeaderMap,
) -> Result<Json<ProjectListResponse>, ApiError> {
    let actor_user_id = required_request_user_id(&state.db, &headers).await?;
    let projects = project_catalog::list_projects(
        &state.db,
        actor_user_id,
        query.include_archived.unwrap_or(true),
        query.q.as_deref(),
    )
    .await?;
    Ok(Json(ProjectListResponse { projects }))
}

pub(crate) async fn create_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateProjectInput>,
) -> Result<Json<Project>, ApiError> {
    let actor_user_id = required_request_user_id(&state.db, &headers).await?;
    let name = ProjectName::parse(&input.name)?;
    let project = project_creation::create_project(
        &state.db,
        &state.distribution,
        CreateProject {
            actor_user_id,
            name: &name,
            project_type: input.project_type.unwrap_or(ProjectType::Typst),
            latex_engine: input.latex_engine.unwrap_or(LatexEngine::Xetex),
        },
    )
    .await?;
    record_event(
        &state.db,
        Some(actor_user_id),
        "project.create",
        serde_json::json!({"project_id": project.id, "name": project.name}),
    )
    .await;
    Ok(Json(project))
}

pub(crate) async fn update_project_name(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UpdateProjectNameInput>,
) -> Result<StatusCode, ApiError> {
    let actor_user_id =
        ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let name = ProjectName::parse(&input.name)?;
    project_rename::rename_project(&state.db, project_id, &name).await?;
    record_event(
        &state.db,
        Some(actor_user_id),
        "project.rename",
        serde_json::json!({
            "project_id": project_id,
            "name": name.as_str()
        }),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

impl From<ListProjectsError> for ApiError {
    fn from(source: ListProjectsError) -> Self {
        project_service_unavailable(source)
    }
}

impl From<CreateProjectError> for ApiError {
    fn from(source: CreateProjectError) -> Self {
        match source {
            CreateProjectError::ProjectTypeDisabled { .. } => ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                ApiErrorCode::ProjectTypeDisabled,
                "This project type is disabled in the current deployment",
            ),
            failure @ (CreateProjectError::StarterContentMissing { .. }
            | CreateProjectError::Identity(_)
            | CreateProjectError::Persistence(_)) => project_service_unavailable(failure),
        }
    }
}

impl From<RenameProjectError> for ApiError {
    fn from(source: RenameProjectError) -> Self {
        match source {
            RenameProjectError::ProjectNotFound => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::ProjectNotFound,
                "Project was not found",
            ),
            failure @ RenameProjectError::Persistence(_) => project_service_unavailable(failure),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_project_names_have_a_semantic_bad_request_response() {
        let error = ApiError::from(super::super::InvalidProjectName);

        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
        assert_eq!(error.code(), ApiErrorCode::ProjectNameInvalid);
    }
}
