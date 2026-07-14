use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use thiserror::Error;

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
#[error("repository-relative path is invalid")]
pub(super) struct InvalidRepositoryPath;

#[derive(Debug, Error)]
pub(crate) enum CollectRepositoryFilesError {
    #[error("repository worktree could not be read at {path:?}")]
    Filesystem {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("repository file {path:?} is outside worktree {root:?}")]
    PathOutsideRepository {
        root: PathBuf,
        path: PathBuf,
        #[source]
        source: std::path::StripPrefixError,
    },
}

pub(super) fn collect_repository_files(
    repository_path: &str,
) -> Result<HashMap<String, Vec<u8>>, CollectRepositoryFilesError> {
    let root = PathBuf::from(repository_path);
    let mut files = HashMap::new();
    collect_directory_files(&root, &root, &mut files)?;
    Ok(files)
}

fn collect_directory_files(
    root: &Path,
    current: &Path,
    files: &mut HashMap<String, Vec<u8>>,
) -> Result<(), CollectRepositoryFilesError> {
    let entries =
        std::fs::read_dir(current).map_err(|source| CollectRepositoryFilesError::Filesystem {
            path: current.to_path_buf(),
            source,
        })?;
    for entry_result in entries {
        let entry = entry_result.map_err(|source| CollectRepositoryFilesError::Filesystem {
            path: current.to_path_buf(),
            source,
        })?;
        let path = entry.path();
        let file_type =
            entry
                .file_type()
                .map_err(|source| CollectRepositoryFilesError::Filesystem {
                    path: path.clone(),
                    source,
                })?;
        if file_type.is_dir() {
            if path.file_name().and_then(|name| name.to_str()) == Some(".git") {
                continue;
            }
            collect_directory_files(root, &path, files)?;
        } else if file_type.is_file() {
            let relative_path = path
                .strip_prefix(root)
                .map_err(
                    |source| CollectRepositoryFilesError::PathOutsideRepository {
                        root: root.to_path_buf(),
                        path: path.clone(),
                        source,
                    },
                )?
                .to_string_lossy()
                .to_string();
            let bytes =
                std::fs::read(&path).map_err(|source| CollectRepositoryFilesError::Filesystem {
                    path: path.clone(),
                    source,
                })?;
            files.insert(relative_path, bytes);
        }
    }
    Ok(())
}

pub(super) fn repository_file_path(
    repository_path: &str,
    relative_path: &str,
) -> Result<PathBuf, InvalidRepositoryPath> {
    let relative_path = Path::new(relative_path);
    if relative_path.is_absolute()
        || relative_path.components().any(|component| match component {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => true,
            Component::Normal(name) => name
                .to_str()
                .is_some_and(|value| value.eq_ignore_ascii_case(".git")),
            Component::CurDir => false,
        })
    {
        return Err(InvalidRepositoryPath);
    }
    Ok(PathBuf::from(repository_path).join(relative_path))
}

pub(super) fn clear_preserving_metadata(root: &Path) -> std::io::Result<()> {
    for entry_result in std::fs::read_dir(root)? {
        let entry = entry_result?;
        let path = entry.path();
        if path.file_name().and_then(|name| name.to_str()) == Some(".git") {
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            std::fs::remove_dir_all(path)?;
        } else {
            std::fs::remove_file(path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::repository_file_path;
    use std::path::PathBuf;

    #[test]
    fn repository_paths_reject_git_metadata_components() {
        assert!(repository_file_path("/tmp/repo", ".git/config").is_err());
        assert!(repository_file_path("/tmp/repo", "assets/.GIT/index").is_err());
        assert!(repository_file_path("/tmp/repo", "../outside").is_err());
        assert_eq!(
            repository_file_path("/tmp/repo", "slides/main.typ"),
            Ok(PathBuf::from("/tmp/repo/slides/main.typ"))
        );
    }
}
