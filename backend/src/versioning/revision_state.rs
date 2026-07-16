use crate::workspace::{guess_content_type, is_document_text_path, sanitize_project_path};
use git2::{Commit, Repository, TreeWalkMode, TreeWalkResult};
use std::collections::HashMap;
use thiserror::Error;

pub(super) struct GitRevisionAsset {
    pub content_type: String,
    pub bytes: Vec<u8>,
}

pub(super) struct GitRevisionState {
    pub documents: HashMap<String, String>,
    pub assets: HashMap<String, GitRevisionAsset>,
}

#[derive(Debug, Error)]
pub(super) enum LoadGitRevisionStateError {
    #[error("Git revision state could not be read")]
    Git {
        #[source]
        source: git2::Error,
    },
    #[error("Git revision contains an invalid project path: {path}")]
    InvalidPath { path: String },
}

pub(super) fn load_git_state_from_commit(
    repository: &Repository,
    commit: &Commit<'_>,
) -> Result<GitRevisionState, LoadGitRevisionStateError> {
    let tree = commit
        .tree()
        .map_err(|source| LoadGitRevisionStateError::Git { source })?;
    let mut documents = HashMap::new();
    let mut assets = HashMap::new();
    let mut walk_error = None;

    let walk_result = tree.walk(TreeWalkMode::PreOrder, |root, entry| {
        if walk_error.is_some() {
            return TreeWalkResult::Abort;
        }
        if entry.kind() != Some(git2::ObjectType::Blob) {
            return TreeWalkResult::Ok;
        }
        let Ok(name) = entry.name() else {
            return TreeWalkResult::Ok;
        };
        let raw_path = format!("{root}{name}");
        let Ok(clean_path) = sanitize_project_path(&raw_path) else {
            walk_error = Some(LoadGitRevisionStateError::InvalidPath { path: raw_path });
            return TreeWalkResult::Abort;
        };

        let blob = match repository.find_blob(entry.id()) {
            Ok(value) => value,
            Err(source) => {
                walk_error = Some(LoadGitRevisionStateError::Git { source });
                return TreeWalkResult::Abort;
            }
        };
        let bytes = blob.content();
        if is_document_text_path(&clean_path) {
            if let Ok(text) = std::str::from_utf8(bytes) {
                documents.insert(clean_path, text.to_string());
                return TreeWalkResult::Ok;
            }
        }
        let content_type = guess_content_type(&clean_path);
        assets.insert(
            clean_path,
            GitRevisionAsset {
                content_type,
                bytes: bytes.to_vec(),
            },
        );
        TreeWalkResult::Ok
    });

    if let Some(error) = walk_error {
        return Err(error);
    }
    walk_result.map_err(|source| LoadGitRevisionStateError::Git { source })?;
    Ok(GitRevisionState { documents, assets })
}
