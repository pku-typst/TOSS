//! Project lifecycle, content, tree, settings, and Workspace version ownership.

mod activity;
mod assets_http;
mod assets_persistence;
mod collaboration_projection;
mod content;
mod content_generation;
mod document_mutations;
mod documents;
mod documents_http;
mod documents_persistence;
mod file_model;
mod file_policy;
mod files_http;
mod files_persistence;
mod http_error;
mod pdf_artifacts;
mod pdf_artifacts_http;
mod pdf_artifacts_persistence;
mod persistence;
mod project_archive;
mod project_archive_http;
mod project_archive_state;
mod project_archive_state_http;
mod project_asset_deletion;
mod project_asset_upload;
mod project_assets;
mod project_catalog;
mod project_copy;
mod project_copy_http;
mod project_copy_persistence;
mod project_creation;
mod project_entry_point;
mod project_file_creation;
mod project_file_deletion;
mod project_file_move;
mod project_metadata;
mod project_model;
mod project_name;
mod project_provisioning;
mod project_rename;
mod project_settings;
mod project_thumbnail;
mod project_thumbnail_http;
mod project_thumbnail_persistence;
mod project_tree;
mod projects_http;
mod projects_persistence;
mod revision_paths;
mod revision_paths_persistence;
mod settings_http;
mod settings_persistence;

pub(crate) use activity::mark_project_dirty;
use activity::record_collaborative_document_activity;
pub(crate) use assets_http::{
    delete_project_asset, get_project_asset, get_project_asset_raw, list_project_assets,
    upload_project_asset, ProjectAssetContentResponse, ProjectAssetListResponse, UploadAssetInput,
};
pub(crate) use collaboration_projection::{
    lock_project_collaboration_document, project_collaboration_document, CollaborationContributor,
    CollaborationProjectionError, CollaborationProjectionOutcome, ProjectCollaborationDocument,
};
pub(crate) use content::{
    load_project_content_asset_bytes, load_project_content_snapshot,
    lock_processing_project_snapshot, CreateProjectGraph, LoadProjectContentAssetError,
    ProjectContentSnapshot, ReplaceProjectContent, ReplaceProjectContentResult, WorkspaceAsset,
    WorkspaceDocument,
};
pub(crate) use content_generation::{
    lock_project_content_epoch, lock_project_content_exclusively, lock_project_content_mutation,
    project_content_epoch, ProjectContentEpochMatch,
};
pub(crate) use documents::{
    document_collaboration_revision_matches, document_collaboration_seed, Document,
    DocumentIdentityQueryError,
};
pub(crate) use documents_http::{
    create_document, delete_document, get_document, list_documents, update_document,
    upsert_document_by_path, CreateDocumentInput, DocumentsResponse, UpdateDocumentInput,
    UpsertDocumentByPathInput,
};
pub(crate) use file_model::ProjectFileKind;
pub(crate) use file_policy::{
    guess_content_type, is_document_text_path, looks_like_text, sanitize_project_path,
    InvalidProjectPath,
};
pub(crate) use files_http::{
    create_project_file, delete_project_file, get_project_tree, move_project_file,
    CreateProjectFileInput, MoveProjectFileInput,
};
pub(crate) use pdf_artifacts::PdfArtifact;
pub(crate) use pdf_artifacts_http::{
    download_latest_project_pdf_artifact, upload_project_pdf_artifact, UploadPdfArtifactInput,
};
pub(crate) use persistence::{
    advance_workspace_version, lock_workspace_version, project_workspace_version,
    replace_project_content,
};
pub(crate) use project_archive_http::download_project_archive;
pub(crate) use project_archive_state_http::{update_project_archived, UpdateProjectArchivedInput};
pub(crate) use project_assets::ProjectAsset;
pub(crate) use project_copy_http::{copy_project, CreateProjectCopyInput};
pub(crate) use project_entry_point::{
    load_project_entry_point, LoadProjectEntryPointError, ProjectEntryPoint,
};
pub(crate) use project_metadata::{
    list_project_template_sources, lock_project_template_status, project_descriptor,
    project_template_status, set_project_template_status, ProjectDescriptor,
};
pub(crate) use project_model::{LatexEngine, Project, ProjectType};
pub(crate) use project_name::{InvalidProjectName, ProjectName};
pub(crate) use project_provisioning::provision_project;
pub(crate) use project_settings::ProjectSettings;
pub(crate) use project_thumbnail::{
    load_project_thumbnail, store_project_thumbnail, LoadProjectThumbnailError,
};
pub(crate) use project_thumbnail_http::{
    get_project_thumbnail, upload_project_thumbnail, UploadProjectThumbnailInput,
};
pub(crate) use project_thumbnail_persistence::project_ids_with_thumbnails;
pub(crate) use project_tree::ProjectTreeResponse;
pub(crate) use projects_http::{
    create_project, list_projects, update_project_name, CreateProjectInput, ProjectListResponse,
    UpdateProjectNameInput,
};
pub(crate) use revision_paths::{
    revision_path_snapshot, RevisionPathSnapshot, RevisionPathSnapshotError,
};
pub(crate) use settings_http::{
    get_project_settings, update_project_entry_file, update_project_latex_engine,
    UpdateProjectEntryFileInput, UpdateProjectLatexEngineInput,
};
