use super::authors::GitIdentity;
use git2::{IndexAddOption, Oid, Repository};
use thiserror::Error;

pub(super) fn commit_staged_if_changed(
    repository_path: &str,
    message: &str,
    author: &GitIdentity,
    committer: &GitIdentity,
) -> Result<Option<Oid>, git2::Error> {
    let repository = Repository::open(repository_path)?;
    let mut index = repository.index()?;
    index.add_all(["*"].iter(), IndexAddOption::DEFAULT, None)?;
    index.write()?;

    let tree_id = index.write_tree()?;
    let tree = repository.find_tree(tree_id)?;
    let head_commit = repository
        .head()
        .ok()
        .and_then(|head| head.target())
        .and_then(|oid| repository.find_commit(oid).ok());
    if let Some(parent) = head_commit.as_ref() {
        if parent
            .tree()
            .is_ok_and(|parent_tree| parent_tree.id() == tree.id())
        {
            return Ok(None);
        }
    }

    let author = author.signature()?;
    let committer = committer.signature()?;
    let commit_id = if let Some(parent) = head_commit {
        repository.commit(
            Some("HEAD"),
            &author,
            &committer,
            message,
            &tree,
            &[&parent],
        )?
    } else {
        repository.commit(Some("HEAD"), &author, &committer, message, &tree, &[])?
    };
    Ok(Some(commit_id))
}

pub(super) fn commit_allow_empty(
    repository_path: &str,
    message: &str,
    author: &GitIdentity,
    committer: &GitIdentity,
) -> Result<Oid, git2::Error> {
    let repository = Repository::open(repository_path)?;
    let mut index = repository.index()?;
    index.add_all(["*"].iter(), IndexAddOption::DEFAULT, None)?;
    index.write()?;

    let tree_id = index.write_tree()?;
    let tree = repository.find_tree(tree_id)?;
    let head_commit = repository
        .head()
        .ok()
        .and_then(|head| head.target())
        .and_then(|oid| repository.find_commit(oid).ok());

    let author = author.signature()?;
    let committer = committer.signature()?;
    if let Some(parent) = head_commit {
        repository.commit(
            Some("HEAD"),
            &author,
            &committer,
            message,
            &tree,
            &[&parent],
        )
    } else {
        repository.commit(Some("HEAD"), &author, &committer, message, &tree, &[])
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub(crate) struct CheckpointCommit {
    pub(crate) oid: String,
    pub(crate) changed: bool,
}

#[derive(Debug, Error)]
pub(crate) enum CreateCheckpointCommitError {
    #[error("checkpoint branch name is invalid")]
    InvalidBranch,
    #[error("checkpoint commit could not be created")]
    Git {
        #[from]
        source: git2::Error,
    },
}

pub(crate) fn create_checkpoint_commit(
    repository_path: &str,
    branch_name: &str,
    parent_sha: Option<&str>,
    message: &str,
    author: &GitIdentity,
    committer: &GitIdentity,
) -> Result<CheckpointCommit, CreateCheckpointCommitError> {
    let repository = Repository::open(repository_path)?;
    let source_commit = repository.head()?.peel_to_commit()?;
    let tree = source_commit.tree()?;
    let parent = parent_sha
        .map(Oid::from_str)
        .transpose()?
        .map(|oid| repository.find_commit(oid))
        .transpose()?;
    if let Some(parent) = parent.as_ref() {
        let parent_tree = parent.tree()?;
        if parent_tree.id() == tree.id() {
            return Ok(CheckpointCommit {
                oid: parent.id().to_string(),
                changed: false,
            });
        }
    }

    let reference_name = format!("refs/heads/{branch_name}");
    if !git2::Reference::is_valid_name(&reference_name) {
        return Err(CreateCheckpointCommitError::InvalidBranch);
    }
    let author = author.signature()?;
    let committer = committer.signature()?;
    let parents = parent.as_ref().map(|value| vec![value]).unwrap_or_default();
    let oid = repository.commit(
        Some(&reference_name),
        &author,
        &committer,
        message,
        &tree,
        &parents,
    )?;
    Ok(CheckpointCommit {
        oid: oid.to_string(),
        changed: true,
    })
}

#[cfg(test)]
mod tests {
    use super::{commit_staged_if_changed, create_checkpoint_commit};
    use crate::versioning::authors::GitIdentity;
    use crate::versioning::local_repository::{checkout_branch, ensure_initialized};
    use git2::{Oid, Repository};
    use std::error::Error;

    #[test]
    fn checkpoint_branch_has_one_commit_per_changed_manual_snapshot() -> Result<(), Box<dyn Error>>
    {
        let temporary = tempfile::tempdir()?;
        let repository_path = temporary.path().to_string_lossy().to_string();
        let author =
            GitIdentity::account("Owner", "owner@example.com", "Owner", "owner@example.com");
        let committer = GitIdentity::service("Workspace", "workspace.local");
        ensure_initialized(&repository_path, "main")?;
        std::fs::write(temporary.path().join("main.typ"), "one")?;
        commit_staged_if_changed(
            &repository_path,
            "internal autosave one",
            &author,
            &committer,
        )?;

        let first = create_checkpoint_commit(
            &repository_path,
            "workspace/test",
            None,
            "manual sync one",
            &author,
            &committer,
        )?;
        assert!(first.changed);

        checkout_branch(&repository_path, "main")?;
        std::fs::write(temporary.path().join("main.typ"), "two")?;
        commit_staged_if_changed(
            &repository_path,
            "internal autosave two",
            &author,
            &committer,
        )?;
        let second = create_checkpoint_commit(
            &repository_path,
            "workspace/test",
            Some(&first.oid),
            "manual sync two",
            &author,
            &committer,
        )?;
        assert!(second.changed);

        let unchanged = create_checkpoint_commit(
            &repository_path,
            "workspace/test",
            Some(&second.oid),
            "manual sync without changes",
            &author,
            &committer,
        )?;
        assert!(!unchanged.changed);
        assert_eq!(unchanged.oid, second.oid);

        let repository = Repository::open(&repository_path)?;
        let second_commit = repository.find_commit(Oid::from_str(&second.oid)?)?;
        assert_eq!(second_commit.author().name()?, "Owner");
        assert_eq!(second_commit.author().email()?, "owner@example.com");
        assert_eq!(second_commit.committer().name()?, "Workspace");
        assert_eq!(
            second_commit.committer().email()?,
            "noreply@workspace.local"
        );
        assert_eq!(second_commit.parent_count(), 1);
        assert_eq!(second_commit.parent_id(0)?.to_string(), first.oid);
        assert_eq!(
            repository
                .find_commit(Oid::from_str(&first.oid)?)?
                .parent_count(),
            0
        );
        Ok(())
    }
}
