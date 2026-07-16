use crate::external_repositories::ExternalGitFailureCode;
use crate::workspace::{
    guess_content_type, is_document_text_path, sanitize_project_path, ProjectType,
};
use std::collections::BTreeSet;
use std::env;
use std::io::Read;
use std::path::{Path, PathBuf};
use thiserror::Error;

const DEFAULT_MAX_FILES: usize = 4_096;
const DEFAULT_MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;

pub(crate) struct ImportedExternalGitDocument {
    pub path: String,
    pub source_path: PathBuf,
}

pub(crate) struct ImportedExternalGitAsset {
    pub path: String,
    pub source_path: PathBuf,
    pub content_type: String,
    pub size_bytes: i64,
}

pub(crate) struct PreparedExternalGitImport {
    pub documents: Vec<ImportedExternalGitDocument>,
    pub directories: Vec<String>,
    pub assets: Vec<ImportedExternalGitAsset>,
    pub entry_file_path: String,
    pub remote_sha: String,
    _checkout: tempfile::TempDir,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum ImportFilesystemOperation {
    ReadDirectory,
    ReadDirectoryEntry,
    ReadFileType,
    ReadMetadata,
    OpenFile,
    ReadFilePrefix,
}

#[derive(Debug, Error)]
pub(crate) enum ExternalGitImportFailure {
    #[error("repository filesystem operation {operation:?} failed at {path:?}")]
    Filesystem {
        operation: ImportFilesystemOperation,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("repository symlink is not supported at {path:?}")]
    SymlinkNotSupported { path: PathBuf },
    #[error("repository submodule is not supported at {path:?}")]
    SubmoduleNotSupported { path: PathBuf },
    #[error("repository special file is not supported at {path:?}")]
    SpecialFileNotSupported { path: PathBuf },
    #[error("repository file count limit was exceeded")]
    FileLimitExceeded,
    #[error("repository file size limit was exceeded at {path:?}")]
    FileSizeLimitExceeded { path: PathBuf },
    #[error("repository total size limit was exceeded")]
    TotalSizeLimitExceeded,
    #[error("repository path is invalid at {path:?}")]
    InvalidPath { path: PathBuf },
    #[error("repository LFS object is missing at {path:?}")]
    LfsObjectMissing { path: PathBuf },
    #[error("repository is empty")]
    Empty,
    #[error("repository text encoding is invalid at {path:?}")]
    TextEncodingInvalid {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("repository has no supported entry file")]
    MissingEntryFile,
}

impl ExternalGitImportFailure {
    pub(crate) const fn code(&self) -> ExternalGitFailureCode {
        match self {
            Self::Filesystem { .. } => ExternalGitFailureCode::RepositoryContentUnreadable,
            Self::SymlinkNotSupported { .. } => {
                ExternalGitFailureCode::RepositorySymlinksNotSupported
            }
            Self::SubmoduleNotSupported { .. } => {
                ExternalGitFailureCode::RepositorySubmodulesNotSupported
            }
            Self::SpecialFileNotSupported { .. } => {
                ExternalGitFailureCode::RepositorySpecialFilesNotSupported
            }
            Self::FileLimitExceeded => ExternalGitFailureCode::RepositoryFileLimitExceeded,
            Self::FileSizeLimitExceeded { .. } => {
                ExternalGitFailureCode::RepositoryFileSizeLimitExceeded
            }
            Self::TotalSizeLimitExceeded => {
                ExternalGitFailureCode::RepositoryTotalSizeLimitExceeded
            }
            Self::InvalidPath { .. } => ExternalGitFailureCode::RepositoryPathInvalid,
            Self::LfsObjectMissing { .. } => ExternalGitFailureCode::RepositoryLfsObjectMissing,
            Self::Empty => ExternalGitFailureCode::RepositoryIsEmpty,
            Self::TextEncodingInvalid { .. } => {
                ExternalGitFailureCode::RepositoryTextEncodingInvalid
            }
            Self::MissingEntryFile => ExternalGitFailureCode::RepositoryMissingEntryFile,
        }
    }
}

struct CollectedFile {
    path: String,
    source_path: PathBuf,
    size_bytes: u64,
}

#[derive(Clone, Copy)]
struct ImportLimits {
    max_files: usize,
    max_file_bytes: u64,
    max_total_bytes: u64,
}

fn env_usize(name: &str, fallback: usize) -> usize {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn env_u64(name: &str, fallback: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn import_limits() -> ImportLimits {
    ImportLimits {
        max_files: env_usize("EXTERNAL_GIT_IMPORT_MAX_FILES", DEFAULT_MAX_FILES),
        max_file_bytes: env_u64("EXTERNAL_GIT_IMPORT_MAX_FILE_BYTES", DEFAULT_MAX_FILE_BYTES),
        max_total_bytes: env_u64(
            "EXTERNAL_GIT_IMPORT_MAX_TOTAL_BYTES",
            DEFAULT_MAX_TOTAL_BYTES,
        ),
    }
}

fn collect_files(
    root: &Path,
    current: &Path,
    limits: ImportLimits,
    files: &mut Vec<CollectedFile>,
    total_bytes: &mut u64,
) -> Result<(), ExternalGitImportFailure> {
    let entries =
        std::fs::read_dir(current).map_err(|source| ExternalGitImportFailure::Filesystem {
            operation: ImportFilesystemOperation::ReadDirectory,
            path: current.to_path_buf(),
            source,
        })?;
    for entry in entries {
        let entry = entry.map_err(|source| ExternalGitImportFailure::Filesystem {
            operation: ImportFilesystemOperation::ReadDirectoryEntry,
            path: current.to_path_buf(),
            source,
        })?;
        let path = entry.path();
        let file_type =
            entry
                .file_type()
                .map_err(|source| ExternalGitImportFailure::Filesystem {
                    operation: ImportFilesystemOperation::ReadFileType,
                    path: path.clone(),
                    source,
                })?;
        if file_type.is_symlink() {
            return Err(ExternalGitImportFailure::SymlinkNotSupported { path });
        }
        if file_type.is_dir() {
            if path.file_name().and_then(|value| value.to_str()) == Some(".git") {
                if current == root {
                    continue;
                }
                return Err(ExternalGitImportFailure::SubmoduleNotSupported { path });
            }
            collect_files(root, &path, limits, files, total_bytes)?;
            continue;
        }
        if !file_type.is_file() {
            return Err(ExternalGitImportFailure::SpecialFileNotSupported { path });
        }
        if files.len() >= limits.max_files {
            return Err(ExternalGitImportFailure::FileLimitExceeded);
        }
        let metadata = entry
            .metadata()
            .map_err(|source| ExternalGitImportFailure::Filesystem {
                operation: ImportFilesystemOperation::ReadMetadata,
                path: path.clone(),
                source,
            })?;
        if metadata.len() > limits.max_file_bytes {
            return Err(ExternalGitImportFailure::FileSizeLimitExceeded { path });
        }
        *total_bytes = total_bytes
            .checked_add(metadata.len())
            .ok_or(ExternalGitImportFailure::TotalSizeLimitExceeded)?;
        if *total_bytes > limits.max_total_bytes {
            return Err(ExternalGitImportFailure::TotalSizeLimitExceeded);
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| ExternalGitImportFailure::InvalidPath { path: path.clone() })?
            .to_str()
            .ok_or_else(|| ExternalGitImportFailure::InvalidPath { path: path.clone() })?;
        let clean_path = sanitize_project_path(relative)
            .map_err(|_| ExternalGitImportFailure::InvalidPath { path: path.clone() })?;
        if clean_path != relative {
            return Err(ExternalGitImportFailure::InvalidPath { path });
        }
        if clean_path == ".gitmodules" || clean_path.ends_with("/.gitmodules") {
            return Err(ExternalGitImportFailure::SubmoduleNotSupported { path });
        }
        let mut prefix = [0_u8; 64];
        let mut file =
            std::fs::File::open(&path).map_err(|source| ExternalGitImportFailure::Filesystem {
                operation: ImportFilesystemOperation::OpenFile,
                path: path.clone(),
                source,
            })?;
        let prefix_len =
            file.read(&mut prefix)
                .map_err(|source| ExternalGitImportFailure::Filesystem {
                    operation: ImportFilesystemOperation::ReadFilePrefix,
                    path: path.clone(),
                    source,
                })?;
        if prefix
            .get(..prefix_len)
            .is_some_and(|value| value.starts_with(b"version https://git-lfs.github.com/spec/v1\n"))
        {
            return Err(ExternalGitImportFailure::LfsObjectMissing { path });
        }
        files.push(CollectedFile {
            path: clean_path,
            source_path: path,
            size_bytes: metadata.len(),
        });
    }
    Ok(())
}

pub(crate) fn prepare_external_git_import(
    checkout: tempfile::TempDir,
    repository_path: PathBuf,
    project_type: ProjectType,
    current_entry: &str,
    remote_sha: String,
) -> Result<PreparedExternalGitImport, ExternalGitImportFailure> {
    let mut files = Vec::new();
    let mut total_bytes = 0_u64;
    collect_files(
        &repository_path,
        &repository_path,
        import_limits(),
        &mut files,
        &mut total_bytes,
    )?;
    if files.is_empty() {
        return Err(ExternalGitImportFailure::Empty);
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));

    let mut documents = Vec::new();
    let mut assets = Vec::new();
    let mut directories = BTreeSet::new();
    for file in files {
        let path = file.path;
        let parts = path.split('/').collect::<Vec<_>>();
        let mut parent = String::new();
        for part in parts.iter().take(parts.len().saturating_sub(1)) {
            if !parent.is_empty() {
                parent.push('/');
            }
            parent.push_str(part);
            directories.insert(parent.clone());
        }
        if is_document_text_path(&path) {
            std::fs::read_to_string(&file.source_path).map_err(|source| {
                ExternalGitImportFailure::TextEncodingInvalid {
                    path: file.source_path.clone(),
                    source,
                }
            })?;
            documents.push(ImportedExternalGitDocument {
                path,
                source_path: file.source_path,
            });
        } else {
            let size_bytes = i64::try_from(file.size_bytes).map_err(|_| {
                ExternalGitImportFailure::FileSizeLimitExceeded {
                    path: file.source_path.clone(),
                }
            })?;
            assets.push(ImportedExternalGitAsset {
                content_type: guess_content_type(&path),
                path,
                source_path: file.source_path,
                size_bytes,
            });
        }
    }

    let document_paths = documents
        .iter()
        .map(|document| document.path.clone())
        .collect::<Vec<_>>();
    let entry_file_path = project_type
        .choose_entry_file_path(current_entry, &document_paths)
        .ok_or(ExternalGitImportFailure::MissingEntryFile)?;
    Ok(PreparedExternalGitImport {
        documents,
        directories: directories.into_iter().collect(),
        assets,
        entry_file_path,
        remote_sha,
        _checkout: checkout,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collection_rejects_symlinks() -> Result<(), String> {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().map_err(|error| error.to_string())?;
        std::fs::write(temp.path().join("main.typ"), "Hello").map_err(|error| error.to_string())?;
        symlink("main.typ", temp.path().join("alias.typ")).map_err(|error| error.to_string())?;
        let mut files = Vec::new();
        let mut total_bytes = 0;
        let result = collect_files(
            temp.path(),
            temp.path(),
            import_limits(),
            &mut files,
            &mut total_bytes,
        );
        assert_eq!(
            result.err().map(|error| error.code()),
            Some(ExternalGitFailureCode::RepositorySymlinksNotSupported)
        );
        Ok(())
    }

    #[test]
    fn collection_rejects_submodules_and_path_rewrites() -> Result<(), String> {
        let submodule = tempfile::tempdir().map_err(|error| error.to_string())?;
        std::fs::write(submodule.path().join(".gitmodules"), "[submodule \"docs\"]")
            .map_err(|error| error.to_string())?;
        let mut files = Vec::new();
        let mut total_bytes = 0;
        let result = collect_files(
            submodule.path(),
            submodule.path(),
            import_limits(),
            &mut files,
            &mut total_bytes,
        );
        assert_eq!(
            result.err().map(|error| error.code()),
            Some(ExternalGitFailureCode::RepositorySubmodulesNotSupported)
        );

        let ambiguous = tempfile::tempdir().map_err(|error| error.to_string())?;
        std::fs::write(ambiguous.path().join(" main.typ"), "Hello")
            .map_err(|error| error.to_string())?;
        files.clear();
        total_bytes = 0;
        let result = collect_files(
            ambiguous.path(),
            ambiguous.path(),
            import_limits(),
            &mut files,
            &mut total_bytes,
        );
        assert_eq!(
            result.err().map(|error| error.code()),
            Some(ExternalGitFailureCode::RepositoryPathInvalid)
        );
        Ok(())
    }
}
