use super::worktree_files::{
    collect_repository_files, repository_file_path, CollectRepositoryFilesError,
};
use crate::collaboration::CollaborationContext;
use crate::object_cleanup::{
    cleanup_uncommitted_object, cleanup_uncommitted_objects, delete_queued_objects_now,
    enqueue_object_deletions,
};
use crate::object_storage::{put_object, ObjectStorage, ObjectStorageError};
use crate::workspace;
use crate::workspace::{
    guess_content_type, is_document_text_path, looks_like_text, sanitize_project_path,
};
use chrono::Utc;
use sqlx::PgPool;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use thiserror::Error;
use tracing::error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub(crate) enum MaterializeWorkspaceError {
    #[error("workspace snapshot could not be loaded for project {project_id}")]
    Persistence {
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("project {project_id} was not found while materializing its Git worktree")]
    ProjectNotFound { project_id: Uuid },
    #[error("workspace path is invalid for a Git worktree: {path}")]
    InvalidPath { path: String },
    #[error("workspace asset {path} could not be loaded for project {project_id}")]
    Asset {
        project_id: Uuid,
        path: String,
        #[source]
        source: workspace::LoadProjectContentAssetError,
    },
    #[error("filesystem operation {operation} failed at {path:?}")]
    Filesystem {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum RepositoryImportPersistenceStage {
    Begin,
    ReplaceWorkspace,
    ClearCollaboration,
    EnqueueObjectDeletion,
    Commit,
}

#[derive(Debug, Error)]
pub(crate) enum RepositoryImportError {
    #[error("workspace changed while repository content was imported")]
    WorkspaceChanged,
    #[error("project {project_id} was not found while repository content was imported")]
    ProjectNotFound { project_id: Uuid },
    #[error("project entry point could not be loaded for project {project_id}")]
    EntryPoint {
        project_id: Uuid,
        #[source]
        source: workspace::LoadProjectEntryPointError,
    },
    #[error("repository has no supported entry file for project {project_id}")]
    MissingEntryFile { project_id: Uuid },
    #[error("repository files could not be collected for project {project_id}")]
    RepositoryFiles {
        project_id: Uuid,
        #[source]
        source: CollectRepositoryFilesError,
    },
    #[error("repository contains an invalid project path: {path}")]
    InvalidPath { path: String },
    #[error("repository document is not valid UTF-8: {path}")]
    InvalidDocumentEncoding {
        path: String,
        #[source]
        source: std::string::FromUtf8Error,
    },
    #[error("repository asset is too large: {path}")]
    AssetTooLarge { path: String },
    #[error("repository asset {path} could not be stored for project {project_id}")]
    Storage {
        project_id: Uuid,
        path: String,
        #[source]
        source: ObjectStorageError,
    },
    #[error("repository import persistence failed during {stage:?} for project {project_id}")]
    Persistence {
        stage: RepositoryImportPersistenceStage,
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

pub(crate) async fn sync_project_documents_to_repo(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    project_id: Uuid,
    repo_path: &str,
) -> Result<i64, MaterializeWorkspaceError> {
    let snapshot = workspace::load_project_content_snapshot(db, project_id)
        .await
        .map_err(|source| MaterializeWorkspaceError::Persistence { project_id, source })?
        .ok_or(MaterializeWorkspaceError::ProjectNotFound { project_id })?;
    let materialized_workspace_version = snapshot.workspace_version;
    let repository_path = Path::new(repo_path);
    let staging_parent = repository_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let staging = tempfile::tempdir_in(staging_parent).map_err(|source| {
        MaterializeWorkspaceError::Filesystem {
            operation: "create staging directory",
            path: staging_parent.to_path_buf(),
            source,
        }
    })?;
    let staging_path = staging.path().to_string_lossy();

    for directory_path in snapshot.directories {
        let target = repository_file_path(&staging_path, &directory_path).map_err(|_| {
            MaterializeWorkspaceError::InvalidPath {
                path: directory_path,
            }
        })?;
        std::fs::create_dir_all(&target).map_err(|source| {
            MaterializeWorkspaceError::Filesystem {
                operation: "create workspace directory",
                path: target,
                source,
            }
        })?;
    }

    let mut documents = snapshot.documents.into_iter().collect::<Vec<_>>();
    documents.sort_by(|left, right| left.0.cmp(&right.0));
    for (path, content) in documents {
        let target = repository_file_path(&staging_path, &path)
            .map_err(|_| MaterializeWorkspaceError::InvalidPath { path: path.clone() })?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|source| {
                MaterializeWorkspaceError::Filesystem {
                    operation: "create document parent directory",
                    path: parent.to_path_buf(),
                    source,
                }
            })?;
        }
        std::fs::write(&target, content.as_bytes()).map_err(|source| {
            MaterializeWorkspaceError::Filesystem {
                operation: "write workspace document",
                path: target,
                source,
            }
        })?;
    }

    let mut assets = snapshot.assets.into_iter().collect::<Vec<_>>();
    assets.sort_by(|left, right| left.0.cmp(&right.0));
    for (path, asset) in assets {
        let bytes = workspace::load_project_content_asset_bytes(storage, &asset)
            .await
            .map_err(|source| MaterializeWorkspaceError::Asset {
                project_id,
                path: path.clone(),
                source,
            })?;
        let target = repository_file_path(&staging_path, &path)
            .map_err(|_| MaterializeWorkspaceError::InvalidPath { path: path.clone() })?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|source| {
                MaterializeWorkspaceError::Filesystem {
                    operation: "create asset parent directory",
                    path: parent.to_path_buf(),
                    source,
                }
            })?;
        }
        std::fs::write(&target, bytes).map_err(|source| MaterializeWorkspaceError::Filesystem {
            operation: "write workspace asset",
            path: target,
            source,
        })?;
    }
    replace_repo_working_tree(repository_path, staging.path())?;
    Ok(materialized_workspace_version)
}

pub(crate) async fn sync_repo_documents_to_project(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    collaboration: &CollaborationContext,
    project_id: Uuid,
    repo_path: &str,
    expected_workspace_version: Option<i64>,
) -> Result<i64, RepositoryImportError> {
    let prepared = prepare_repo_import(db, storage, project_id, repo_path).await?;
    apply_repo_import(
        db,
        storage,
        collaboration,
        project_id,
        expected_workspace_version,
        &prepared,
    )
    .await
}

fn clear_repo_working_tree(repo_path: &Path) -> Result<(), MaterializeWorkspaceError> {
    let entries =
        std::fs::read_dir(repo_path).map_err(|source| MaterializeWorkspaceError::Filesystem {
            operation: "read repository worktree",
            path: repo_path.to_path_buf(),
            source,
        })?;
    for entry in entries {
        let entry = entry.map_err(|source| MaterializeWorkspaceError::Filesystem {
            operation: "read repository worktree entry",
            path: repo_path.to_path_buf(),
            source,
        })?;
        let path = entry.path();
        if path.file_name().and_then(|name| name.to_str()) == Some(".git") {
            continue;
        }
        let file_type =
            entry
                .file_type()
                .map_err(|source| MaterializeWorkspaceError::Filesystem {
                    operation: "inspect repository worktree entry",
                    path: path.clone(),
                    source,
                })?;
        if file_type.is_dir() {
            std::fs::remove_dir_all(&path).map_err(|source| {
                MaterializeWorkspaceError::Filesystem {
                    operation: "remove repository directory",
                    path,
                    source,
                }
            })?;
        } else {
            std::fs::remove_file(&path).map_err(|source| {
                MaterializeWorkspaceError::Filesystem {
                    operation: "remove repository file",
                    path,
                    source,
                }
            })?;
        }
    }
    Ok(())
}

fn replace_repo_working_tree(
    repo_path: &Path,
    staged_path: &Path,
) -> Result<(), MaterializeWorkspaceError> {
    clear_repo_working_tree(repo_path)?;
    let entries =
        std::fs::read_dir(staged_path).map_err(|source| MaterializeWorkspaceError::Filesystem {
            operation: "read staged worktree",
            path: staged_path.to_path_buf(),
            source,
        })?;
    for entry in entries {
        let entry = entry.map_err(|source| MaterializeWorkspaceError::Filesystem {
            operation: "read staged worktree entry",
            path: staged_path.to_path_buf(),
            source,
        })?;
        let source_path = entry.path();
        let target = repo_path.join(entry.file_name());
        std::fs::rename(&source_path, &target).map_err(|source| {
            MaterializeWorkspaceError::Filesystem {
                operation: "move staged worktree entry",
                path: source_path,
                source,
            }
        })?;
    }
    Ok(())
}

struct PreparedRepoImport {
    documents: Vec<workspace::WorkspaceDocument>,
    assets: Vec<workspace::WorkspaceAsset>,
    directories: Vec<String>,
    entry_file_path: String,
}

impl PreparedRepoImport {
    fn object_keys(&self) -> Vec<String> {
        self.assets
            .iter()
            .map(|asset| asset.object_key.clone())
            .collect()
    }
}

struct RawRepoAsset {
    path: String,
    content_type: String,
    size_bytes: i64,
    bytes: Vec<u8>,
}

async fn prepare_repo_import(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    project_id: Uuid,
    repo_path: &str,
) -> Result<PreparedRepoImport, RepositoryImportError> {
    let entry_point = workspace::load_project_entry_point(db, project_id)
        .await
        .map_err(|source| RepositoryImportError::EntryPoint { project_id, source })?;
    let mut files = collect_repository_files(repo_path)
        .map_err(|source| RepositoryImportError::RepositoryFiles { project_id, source })?
        .into_iter()
        .collect::<Vec<_>>();
    files.sort_by(|left, right| left.0.cmp(&right.0));
    let mut documents = Vec::new();
    let mut raw_assets = Vec::new();
    let mut directories = HashSet::new();
    for (path, bytes) in files {
        let clean_path = sanitize_project_path(&path)
            .map_err(|_| RepositoryImportError::InvalidPath { path })?;
        collect_parent_directories(&clean_path, &mut directories);
        if is_document_text_path(&clean_path) && looks_like_text(&bytes) {
            let content = String::from_utf8(bytes).map_err(|source| {
                RepositoryImportError::InvalidDocumentEncoding {
                    path: clean_path.clone(),
                    source,
                }
            })?;
            documents.push(workspace::WorkspaceDocument {
                path: clean_path,
                content,
            });
        } else {
            let size_bytes =
                i64::try_from(bytes.len()).map_err(|_| RepositoryImportError::AssetTooLarge {
                    path: clean_path.clone(),
                })?;
            raw_assets.push(RawRepoAsset {
                content_type: guess_content_type(&clean_path),
                size_bytes,
                path: clean_path,
                bytes,
            });
        }
    }

    let document_paths = documents
        .iter()
        .map(|document: &workspace::WorkspaceDocument| document.path.clone())
        .collect::<Vec<_>>();
    let entry_file_path = entry_point
        .project_type
        .choose_entry_file_path(&entry_point.entry_file_path, &document_paths)
        .ok_or(RepositoryImportError::MissingEntryFile { project_id })?;

    let mut assets = Vec::new();
    for raw in raw_assets {
        let id = Uuid::new_v4();
        let (object_key, inline_data) = if let Some(storage) = storage {
            let object_key = format!("projects/{project_id}/assets/{id}");
            if let Err(storage_error) =
                put_object(storage, &object_key, &raw.content_type, raw.bytes).await
            {
                cleanup_uncommitted_object(db, Some(storage), &object_key).await;
                let staged_keys = assets
                    .iter()
                    .map(|asset: &workspace::WorkspaceAsset| asset.object_key.clone())
                    .collect::<Vec<_>>();
                cleanup_uncommitted_objects(db, Some(storage), &staged_keys).await;
                return Err(RepositoryImportError::Storage {
                    project_id,
                    path: raw.path,
                    source: storage_error,
                });
            }
            (object_key, None)
        } else {
            (format!("inline://{id}"), Some(raw.bytes))
        };
        assets.push(workspace::WorkspaceAsset {
            id,
            path: raw.path,
            object_key,
            content_type: raw.content_type,
            size_bytes: raw.size_bytes,
            inline_data,
        });
    }
    let mut directories = directories.into_iter().collect::<Vec<_>>();
    directories.sort();
    Ok(PreparedRepoImport {
        documents,
        assets,
        directories,
        entry_file_path,
    })
}

fn collect_parent_directories(path: &str, directories: &mut HashSet<String>) {
    let mut current = String::new();
    let part_count = path.split('/').count();
    for part in path.split('/').take(part_count.saturating_sub(1)) {
        if !current.is_empty() {
            current.push('/');
        }
        current.push_str(part);
        directories.insert(current.clone());
    }
}

async fn apply_repo_import(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    collaboration: &CollaborationContext,
    project_id: Uuid,
    expected_workspace_version: Option<i64>,
    prepared: &PreparedRepoImport,
) -> Result<i64, RepositoryImportError> {
    let staged_object_keys = prepared.object_keys();
    let mut transaction = match db.begin().await {
        Ok(transaction) => transaction,
        Err(source) => {
            cleanup_uncommitted_objects(db, storage, &staged_object_keys).await;
            return Err(RepositoryImportError::Persistence {
                stage: RepositoryImportPersistenceStage::Begin,
                project_id,
                source,
            });
        }
    };
    let persistence: Result<
        workspace::ReplaceProjectContentResult,
        (RepositoryImportPersistenceStage, sqlx::Error),
    > = async {
        let result = workspace::replace_project_content(
            &mut transaction,
            &workspace::ReplaceProjectContent {
                project_id,
                expected_workspace_version,
                documents: &prepared.documents,
                assets: &prepared.assets,
                directories: &prepared.directories,
                entry_file_path: &prepared.entry_file_path,
                asset_uploaded_by: None,
                updated_at: Utc::now(),
            },
        )
        .await
        .map_err(|source| (RepositoryImportPersistenceStage::ReplaceWorkspace, source))?;
        if let workspace::ReplaceProjectContentResult::Replaced(replaced) = &result {
            collaboration
                .clear_persisted_project(&mut transaction, project_id)
                .await
                .map_err(|source| (RepositoryImportPersistenceStage::ClearCollaboration, source))?;
            enqueue_object_deletions(&mut transaction, &replaced.old_object_keys)
                .await
                .map_err(|source| {
                    (
                        RepositoryImportPersistenceStage::EnqueueObjectDeletion,
                        source,
                    )
                })?;
        }
        Ok(result)
    }
    .await;
    let (old_object_keys, content_epoch, workspace_version) = match persistence {
        Ok(workspace::ReplaceProjectContentResult::Replaced(replaced)) => (
            replaced.old_object_keys,
            replaced.content_epoch,
            replaced.workspace_version,
        ),
        Ok(workspace::ReplaceProjectContentResult::WorkspaceVersionChanged) => {
            if let Err(rollback_error) = transaction.rollback().await {
                error!(%rollback_error, %project_id, "version-conflicted repository import rollback failed");
            }
            cleanup_uncommitted_objects(db, storage, &staged_object_keys).await;
            return Err(RepositoryImportError::WorkspaceChanged);
        }
        Ok(workspace::ReplaceProjectContentResult::NotFound) => {
            if let Err(rollback_error) = transaction.rollback().await {
                error!(%rollback_error, %project_id, "missing-project repository import rollback failed");
            }
            cleanup_uncommitted_objects(db, storage, &staged_object_keys).await;
            return Err(RepositoryImportError::ProjectNotFound { project_id });
        }
        Ok(workspace::ReplaceProjectContentResult::InvalidEntryFile) => {
            if let Err(rollback_error) = transaction.rollback().await {
                error!(%rollback_error, %project_id, "invalid-entry repository import rollback failed");
            }
            cleanup_uncommitted_objects(db, storage, &staged_object_keys).await;
            return Err(RepositoryImportError::MissingEntryFile { project_id });
        }
        Err((stage, source)) => {
            if let Err(rollback_error) = transaction.rollback().await {
                error!(%rollback_error, %project_id, "repository import rollback failed");
            }
            cleanup_uncommitted_objects(db, storage, &staged_object_keys).await;
            return Err(RepositoryImportError::Persistence {
                stage,
                project_id,
                source,
            });
        }
    };
    if let Err(source) = transaction.commit().await {
        return Err(RepositoryImportError::Persistence {
            stage: RepositoryImportPersistenceStage::Commit,
            project_id,
            source,
        });
    }
    delete_queued_objects_now(db, storage, &old_object_keys).await;
    collaboration
        .invalidate_project(project_id, content_epoch)
        .await;
    Ok(workspace_version)
}

#[cfg(test)]
mod tests {
    use super::replace_repo_working_tree;

    #[test]
    fn staged_worktree_replacement_preserves_git_metadata() -> Result<(), Box<dyn std::error::Error>>
    {
        let root = tempfile::tempdir()?;
        let repository = root.path().join("repository");
        let staged = root.path().join("staged");
        std::fs::create_dir_all(repository.join(".git"))?;
        std::fs::write(repository.join(".git/config"), "metadata")?;
        std::fs::write(repository.join("old.typ"), "old")?;
        std::fs::create_dir_all(staged.join("empty"))?;
        std::fs::write(staged.join("main.typ"), "new")?;

        replace_repo_working_tree(&repository, &staged)?;

        assert_eq!(
            std::fs::read_to_string(repository.join(".git/config"))?,
            "metadata"
        );
        assert!(!repository.join("old.typ").exists());
        assert_eq!(std::fs::read_to_string(repository.join("main.typ"))?, "new");
        assert!(repository.join("empty").is_dir());
        Ok(())
    }
}
