//! HTTP transport for Workspace documents.

use super::document_mutations::{
    self, CreateDocumentError, DeleteDocumentError, DocumentMutationPersistenceError,
    UpdateDocumentError, UpsertDocumentByPathError,
};
use super::documents::{self, DocumentQueryError, GetDocumentError};
use super::file_policy::{is_document_text_path, sanitize_project_path};
use super::http_error::project_service_unavailable;
use super::Document;
use crate::access::{ensure_project_access, ensure_project_role, AccessNeed};
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::collaboration::WorkspaceChange;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use uuid::Uuid;

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct DocumentsResponse {
    pub documents: Vec<Document>,
    #[schema(required)]
    pub cursor: Option<i64>,
    pub has_more: bool,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct CreateDocumentInput {
    pub path: String,
    pub content: String,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct UpdateDocumentInput {
    pub content: String,
    pub expected_path_revision: i64,
    pub expected_collaboration_revision: i64,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct UpsertDocumentByPathInput {
    pub content: String,
}

#[derive(serde::Deserialize)]
pub(crate) struct ListDocumentsQuery {
    pub path: Option<String>,
    pub after_change_sequence: Option<i64>,
}

pub(crate) async fn list_documents(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Query(query): Query<ListDocumentsQuery>,
) -> Result<Json<DocumentsResponse>, ApiError> {
    ensure_project_access(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let filter = if let Some(path) = query.path {
        let path = sanitize_project_path(&path)?;
        if !is_document_text_path(&path) {
            return Ok(Json(DocumentsResponse {
                documents: Vec::new(),
                cursor: None,
                has_more: false,
            }));
        }
        documents::DocumentListFilter::Path(path)
    } else {
        documents::DocumentListFilter::AfterChangeSequence(query.after_change_sequence)
    };
    let mut page = documents::list_documents(&state.db, project_id, filter).await?;
    page.documents
        .retain(|document| is_document_text_path(&document.path));
    Ok(Json(DocumentsResponse {
        documents: page.documents,
        cursor: page.cursor,
        has_more: page.has_more,
    }))
}

pub(crate) async fn create_document(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<CreateDocumentInput>,
) -> Result<Json<Document>, ApiError> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let document = document_mutations::create_document(
        &state.db,
        document_mutations::CreateDocumentCommand {
            project_id,
            path: sanitize_project_path(&input.path)?,
            content: input.content,
            actor_user_id: Some(actor),
            guest_display_name: None,
        },
    )
    .await?;
    state
        .collaboration
        .workspace_changed(
            project_id,
            WorkspaceChange::Tree {
                path: Some(document.path.clone()),
            },
        )
        .await;
    record_event(
        &state.db,
        Some(actor),
        "document.create",
        serde_json::json!({"project_id": project_id, "document_id": document.id}),
    )
    .await;
    Ok(Json(document))
}

pub(crate) async fn upsert_document_by_path(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, path)): Path<(Uuid, String)>,
    Json(input): Json<UpsertDocumentByPathInput>,
) -> Result<Json<Document>, ApiError> {
    let principal =
        ensure_project_access(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let expected_content_epoch = required_content_epoch(&headers)?;
    let document = document_mutations::upsert_document_by_path(
        &state.db,
        document_mutations::UpsertDocumentByPathCommand {
            project_id,
            path: sanitize_project_path(&path)?,
            content: input.content,
            expected_content_epoch,
            actor_user_id: principal.user_id,
            guest_display_name: principal.guest_display_name,
        },
    )
    .await?;
    state
        .collaboration
        .workspace_changed(
            project_id,
            WorkspaceChange::Document {
                path: document.path.clone(),
                document_id: document.id,
                collaboration_revision: document.collaboration_revision,
                change_sequence: document.change_sequence,
            },
        )
        .await;
    record_event(
        &state.db,
        principal.user_id,
        "document.upsert_by_path",
        serde_json::json!({
            "project_id": project_id,
            "document_id": document.id,
            "path": document.path
        }),
    )
    .await;
    Ok(Json(document))
}

pub(crate) async fn get_document(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, document_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Document>, ApiError> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    Ok(Json(
        documents::get_document(&state.db, project_id, document_id).await?,
    ))
}

pub(crate) async fn update_document(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, document_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<UpdateDocumentInput>,
) -> Result<Json<Document>, ApiError> {
    let principal =
        ensure_project_access(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let document = document_mutations::update_document(
        &state.db,
        document_mutations::UpdateDocumentCommand {
            project_id,
            document_id,
            expected_content_epoch: required_content_epoch(&headers)?,
            expected_path_revision: input.expected_path_revision,
            expected_collaboration_revision: input.expected_collaboration_revision,
            content: input.content,
            actor_user_id: principal.user_id,
            guest_display_name: principal.guest_display_name,
        },
    )
    .await?;
    state
        .collaboration
        .workspace_changed(
            project_id,
            WorkspaceChange::Document {
                path: document.path.clone(),
                document_id: document.id,
                collaboration_revision: document.collaboration_revision,
                change_sequence: document.change_sequence,
            },
        )
        .await;
    record_event(
        &state.db,
        principal.user_id,
        "document.update",
        serde_json::json!({"project_id": project_id, "document_id": document_id}),
    )
    .await;
    Ok(Json(document))
}

fn required_content_epoch(headers: &HeaderMap) -> Result<i64, ApiError> {
    headers
        .get("x-project-content-epoch")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::PRECONDITION_REQUIRED,
                ApiErrorCode::ProjectContentEpochRequired,
                "Project content epoch is required",
            )
        })
}

pub(crate) async fn delete_document(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, document_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    document_mutations::delete_document(
        &state.db,
        document_mutations::DeleteDocumentCommand {
            project_id,
            document_id,
            actor_user_id: Some(actor),
            guest_display_name: None,
        },
    )
    .await?;
    state
        .collaboration
        .workspace_changed(project_id, WorkspaceChange::Tree { path: None })
        .await;
    record_event(
        &state.db,
        Some(actor),
        "document.delete",
        serde_json::json!({"project_id": project_id, "document_id": document_id}),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

impl From<DocumentQueryError> for ApiError {
    fn from(source: DocumentQueryError) -> Self {
        project_service_unavailable(source)
    }
}

impl From<DocumentMutationPersistenceError> for ApiError {
    fn from(source: DocumentMutationPersistenceError) -> Self {
        project_service_unavailable(source)
    }
}

impl From<GetDocumentError> for ApiError {
    fn from(source: GetDocumentError) -> Self {
        match source {
            GetDocumentError::DocumentNotFound => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::ProjectDocumentNotFound,
                "Document was not found",
            ),
            failure @ GetDocumentError::Query(_) => project_service_unavailable(failure),
        }
    }
}

impl From<CreateDocumentError> for ApiError {
    fn from(source: CreateDocumentError) -> Self {
        match source {
            CreateDocumentError::PathConflict => ApiError::new(
                StatusCode::CONFLICT,
                ApiErrorCode::ProjectPathConflict,
                "A project file already exists at this path",
            ),
            failure @ CreateDocumentError::Persistence(_) => project_service_unavailable(failure),
        }
    }
}

impl From<UpsertDocumentByPathError> for ApiError {
    fn from(source: UpsertDocumentByPathError) -> Self {
        match source {
            UpsertDocumentByPathError::ProjectNotFound => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::ProjectNotFound,
                "Project was not found",
            ),
            UpsertDocumentByPathError::ContentEpochChanged => ApiError::new(
                StatusCode::CONFLICT,
                ApiErrorCode::ProjectContentChanged,
                "Project content changed; refresh and try again",
            ),
            UpsertDocumentByPathError::PathConflict => ApiError::new(
                StatusCode::CONFLICT,
                ApiErrorCode::ProjectPathConflict,
                "A project file already exists at this path",
            ),
            failure @ UpsertDocumentByPathError::Persistence(_) => {
                project_service_unavailable(failure)
            }
        }
    }
}

impl From<UpdateDocumentError> for ApiError {
    fn from(source: UpdateDocumentError) -> Self {
        match source {
            UpdateDocumentError::ProjectNotFound => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::ProjectNotFound,
                "Project was not found",
            ),
            UpdateDocumentError::ContentEpochChanged => ApiError::new(
                StatusCode::CONFLICT,
                ApiErrorCode::ProjectContentChanged,
                "Project content changed; refresh and try again",
            ),
            UpdateDocumentError::DocumentNotFound => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::ProjectDocumentNotFound,
                "Document was not found",
            ),
            UpdateDocumentError::DocumentRevisionChanged => ApiError::new(
                StatusCode::CONFLICT,
                ApiErrorCode::ProjectDocumentChanged,
                "Document changed; refresh and try again",
            ),
            failure @ UpdateDocumentError::Persistence(_) => project_service_unavailable(failure),
        }
    }
}

impl From<DeleteDocumentError> for ApiError {
    fn from(source: DeleteDocumentError) -> Self {
        match source {
            DeleteDocumentError::DocumentNotFound => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::ProjectDocumentNotFound,
                "Document was not found",
            ),
            DeleteDocumentError::EntryFileDeletion => ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                ApiErrorCode::UnprocessableEntity,
                "Choose another entry file before deleting this document",
            ),
            failure @ DeleteDocumentError::Persistence(_) => project_service_unavailable(failure),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_path_conflicts_have_a_semantic_conflict_response() {
        let error = ApiError::from(CreateDocumentError::PathConflict);

        assert_eq!(error.status(), StatusCode::CONFLICT);
        assert_eq!(error.code(), ApiErrorCode::ProjectPathConflict);
    }

    #[test]
    fn entry_document_deletion_has_a_semantic_response() {
        let error = ApiError::from(DeleteDocumentError::EntryFileDeletion);

        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error.code(), ApiErrorCode::UnprocessableEntity);
    }
}
