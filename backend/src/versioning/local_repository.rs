use super::worktree_files::clear_preserving_metadata;
use git2::{build::CheckoutBuilder, Oid, Repository, StatusOptions};
use std::env;
use std::path::{Path, PathBuf};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub(crate) enum InitializeRepositoryError {
    #[error("Git repository directory could not be created at {path}")]
    Filesystem {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("Git repository could not be initialized or configured at {path}")]
    Git {
        path: PathBuf,
        #[source]
        source: git2::Error,
    },
}

#[derive(Debug, Error)]
pub(super) enum RestoreRepositoryHeadError {
    #[error("Git head could not be restored")]
    Git {
        #[source]
        source: git2::Error,
    },
    #[error("Git worktree could not be cleared at {path:?}")]
    Filesystem {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

pub(crate) fn storage_root() -> PathBuf {
    if let Ok(explicit) = env::var("GIT_STORAGE_PATH") {
        return PathBuf::from(explicit);
    }
    if let Ok(data_dir) = env::var("DATA_DIR") {
        return PathBuf::from(data_dir).join("git");
    }
    PathBuf::from("./tmp/git")
}

pub(super) fn project_repository_path(project_id: Uuid) -> PathBuf {
    storage_root().join(project_id.to_string())
}

pub(super) fn ensure_initialized(
    repository_path: &str,
    default_branch: &str,
) -> Result<(), InitializeRepositoryError> {
    let path = PathBuf::from(repository_path);
    std::fs::create_dir_all(&path).map_err(|source| InitializeRepositoryError::Filesystem {
        path: path.clone(),
        source,
    })?;
    let git_dir = path.join(".git");
    if !git_dir.exists() {
        let mut options = git2::RepositoryInitOptions::new();
        options.initial_head(default_branch);
        Repository::init_opts(&path, &options).map_err(|source| {
            InitializeRepositoryError::Git {
                path: path.clone(),
                source,
            }
        })?;
    }
    let repository = Repository::open(&path).map_err(|source| InitializeRepositoryError::Git {
        path: path.clone(),
        source,
    })?;
    let mut configuration =
        repository
            .config()
            .map_err(|source| InitializeRepositoryError::Git {
                path: path.clone(),
                source,
            })?;
    configuration
        .set_bool("receive.denyNonFastForwards", true)
        .map_err(|source| InitializeRepositoryError::Git {
            path: path.clone(),
            source,
        })?;
    configuration
        .set_str("receive.denyCurrentBranch", "updateInstead")
        .map_err(|source| InitializeRepositoryError::Git {
            path: path.clone(),
            source,
        })?;
    configuration
        .set_bool("http.receivepack", true)
        .map_err(|source| InitializeRepositoryError::Git { path, source })?;
    Ok(())
}

pub(super) fn checkout_branch(
    repository_path: &str,
    default_branch: &str,
) -> Result<(), git2::Error> {
    let repository = Repository::open(repository_path)?;
    let branch_reference = format!("refs/heads/{default_branch}");
    repository.set_head(&branch_reference)?;
    if repository.find_reference(&branch_reference).is_ok() {
        let mut checkout = CheckoutBuilder::new();
        checkout.safe();
        repository.checkout_head(Some(&mut checkout))?;
    }
    Ok(())
}

pub(super) fn worktree_is_clean(repository_path: &str) -> Result<bool, git2::Error> {
    let repository = Repository::open(repository_path)?;
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_unmodified(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repository.statuses(Some(&mut options))?;
    Ok(statuses.is_empty())
}

pub(super) fn head_oid(repository_path: &str) -> Result<Option<Oid>, git2::Error> {
    let repository = Repository::open(repository_path)?;
    Ok(repository.head().ok().and_then(|head| head.target()))
}

pub(super) fn restore_head(
    repository_path: &str,
    default_branch: &str,
    target: Option<Oid>,
) -> Result<(), RestoreRepositoryHeadError> {
    if let Some(target) = target {
        let repository = Repository::open(repository_path)
            .map_err(|source| RestoreRepositoryHeadError::Git { source })?;
        let object = repository
            .find_object(target, None)
            .map_err(|source| RestoreRepositoryHeadError::Git { source })?;
        return repository
            .reset(&object, git2::ResetType::Hard, None)
            .map_err(|source| RestoreRepositoryHeadError::Git { source });
    }
    let repository = Repository::open(repository_path)
        .map_err(|source| RestoreRepositoryHeadError::Git { source })?;
    let branch_reference = format!("refs/heads/{default_branch}");
    if let Ok(mut reference) = repository.find_reference(&branch_reference) {
        reference
            .delete()
            .map_err(|source| RestoreRepositoryHeadError::Git { source })?;
    }
    repository
        .set_head(&branch_reference)
        .map_err(|source| RestoreRepositoryHeadError::Git { source })?;
    let mut index = repository
        .index()
        .map_err(|source| RestoreRepositoryHeadError::Git { source })?;
    index
        .clear()
        .map_err(|source| RestoreRepositoryHeadError::Git { source })?;
    index
        .write()
        .map_err(|source| RestoreRepositoryHeadError::Git { source })?;
    clear_preserving_metadata(Path::new(repository_path)).map_err(|source| {
        RestoreRepositoryHeadError::Filesystem {
            path: PathBuf::from(repository_path),
            source,
        }
    })
}

pub(super) fn is_ancestor(
    repository_path: &str,
    ancestor: Oid,
    tip: Oid,
) -> Result<bool, git2::Error> {
    let repository = Repository::open(repository_path)?;
    repository.graph_descendant_of(tip, ancestor)
}

#[cfg(test)]
mod tests {
    use super::{ensure_initialized, head_oid, restore_head};
    use crate::versioning::authors::GitIdentity;
    use crate::versioning::commit::commit_staged_if_changed;
    use git2::Repository;
    use std::error::Error;

    #[test]
    fn restoring_an_unborn_head_removes_the_rejected_first_push() -> Result<(), Box<dyn Error>> {
        let temporary = tempfile::tempdir()?;
        let repository_path = temporary.path().to_string_lossy().to_string();
        let author =
            GitIdentity::account("Owner", "owner@example.com", "Owner", "owner@example.com");
        let committer = GitIdentity::service("Workspace", "workspace.local");
        ensure_initialized(&repository_path, "main")?;
        std::fs::write(temporary.path().join("main.typ"), "rejected")?;
        commit_staged_if_changed(&repository_path, "rejected first push", &author, &committer)?;

        restore_head(&repository_path, "main", None)?;

        assert_eq!(head_oid(&repository_path)?, None);
        assert!(!temporary.path().join("main.typ").exists());
        let repository = Repository::open(&repository_path)?;
        assert_eq!(repository.index()?.len(), 0);
        Ok(())
    }

    #[test]
    fn restoring_a_previous_head_resets_the_ref_index_and_worktree() -> Result<(), Box<dyn Error>> {
        let temporary = tempfile::tempdir()?;
        let repository_path = temporary.path().to_string_lossy().to_string();
        let author =
            GitIdentity::account("Owner", "owner@example.com", "Owner", "owner@example.com");
        let committer = GitIdentity::service("Workspace", "workspace.local");
        ensure_initialized(&repository_path, "main")?;
        let document_path = temporary.path().join("main.typ");
        std::fs::write(&document_path, "accepted")?;
        commit_staged_if_changed(&repository_path, "accepted", &author, &committer)?;
        let accepted = head_oid(&repository_path)?
            .ok_or_else(|| std::io::Error::other("accepted head is missing"))?;
        std::fs::write(&document_path, "interrupted")?;
        commit_staged_if_changed(&repository_path, "interrupted", &author, &committer)?;
        assert_ne!(head_oid(&repository_path)?, Some(accepted));

        restore_head(&repository_path, "main", Some(accepted))?;

        assert_eq!(head_oid(&repository_path)?, Some(accepted));
        assert_eq!(std::fs::read_to_string(document_path)?, "accepted");
        let repository = Repository::open(&repository_path)?;
        assert!(repository.statuses(None)?.is_empty());
        Ok(())
    }
}
