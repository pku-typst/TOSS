//! Read-only Workspace file-tree projection.

use super::file_policy::{is_document_text_path, sanitize_project_path};
use super::{files_persistence, ProjectFileKind};
use sqlx::PgPool;
use std::collections::HashSet;
use thiserror::Error;
use uuid::Uuid;

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ProjectFileNode {
    pub path: String,
    pub kind: ProjectFileKind,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ProjectTreeResponse {
    pub nodes: Vec<ProjectFileNode>,
    pub entry_file_path: String,
    pub content_epoch: i64,
}

#[derive(Debug, Error)]
pub(super) enum LoadProjectTreeError {
    #[error("project was not found")]
    ProjectNotFound,
    #[error("stored project path is invalid: {path}")]
    InvalidStoredPath { path: String },
    #[error("project tree lookup failed for project {project_id}")]
    Persistence {
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

pub(super) async fn load_project_tree(
    db: &PgPool,
    project_id: Uuid,
) -> Result<ProjectTreeResponse, LoadProjectTreeError> {
    let tree = files_persistence::load_tree(db, project_id)
        .await
        .map_err(|source| LoadProjectTreeError::Persistence { project_id, source })?
        .ok_or(LoadProjectTreeError::ProjectNotFound)?;
    let entry_file_path = tree
        .entry_file_path
        .unwrap_or_else(|| tree.project_type.default_entry_file_path().to_string());
    let mut directories = HashSet::new();
    let mut nodes = Vec::new();
    for path in tree.document_paths {
        let path = sanitize_project_path(&path)
            .map_err(|_| LoadProjectTreeError::InvalidStoredPath { path })?;
        if !is_document_text_path(&path) {
            continue;
        }
        collect_parent_directories(&path, &mut directories);
        nodes.push(ProjectFileNode {
            path,
            kind: ProjectFileKind::File,
        });
    }
    for path in tree.asset_paths {
        let path = sanitize_project_path(&path)
            .map_err(|_| LoadProjectTreeError::InvalidStoredPath { path })?;
        collect_parent_directories(&path, &mut directories);
        nodes.push(ProjectFileNode {
            path,
            kind: ProjectFileKind::File,
        });
    }
    for path in tree.directory_paths {
        let path = sanitize_project_path(&path)
            .map_err(|_| LoadProjectTreeError::InvalidStoredPath { path })?;
        directories.insert(path);
    }
    nodes.extend(directories.into_iter().map(|path| ProjectFileNode {
        path,
        kind: ProjectFileKind::Directory,
    }));
    nodes.sort_by(|left, right| left.path.cmp(&right.path));
    nodes.dedup_by(|left, right| left.path == right.path && left.kind == right.kind);

    Ok(ProjectTreeResponse {
        nodes,
        entry_file_path,
        content_epoch: tree.content_epoch,
    })
}

fn collect_parent_directories(path: &str, directories: &mut HashSet<String>) {
    let mut current = String::new();
    let mut components = path.split('/').peekable();
    while let Some(component) = components.next() {
        if components.peek().is_none() {
            break;
        }
        if !current.is_empty() {
            current.push('/');
        }
        current.push_str(component);
        directories.insert(current.clone());
    }
}
