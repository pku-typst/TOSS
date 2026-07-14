use super::config::LatexCacheLimits;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};
use thiserror::Error;
use tracing::warn;
use uuid::Uuid;

static PRUNE_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

pub(super) fn missing_marker_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("asset");
    path.with_file_name(format!("{file_name}.missing"))
}

pub(super) async fn ensure_directory(path: &Path) -> Result<(), CacheIoError> {
    tokio::fs::create_dir_all(path)
        .await
        .map_err(|source| CacheIoError::CreateDirectory {
            path: path.to_path_buf(),
            source,
        })
}

pub(super) async fn read_bounded(
    path: &Path,
    max_bytes: u64,
) -> Result<Option<Vec<u8>>, CacheIoError> {
    let metadata = match tokio::fs::metadata(path).await {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(CacheIoError::Inspect {
                path: path.to_path_buf(),
                source,
            })
        }
    };
    if metadata.len() > max_bytes {
        remove_if_present(path).await?;
        return Ok(None);
    }
    tokio::fs::read(path)
        .await
        .map(Some)
        .map_err(|source| CacheIoError::Read {
            path: path.to_path_buf(),
            source,
        })
}

pub(super) async fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), CacheIoError> {
    let parent = path.parent().ok_or_else(|| CacheIoError::MissingParent {
        path: path.to_path_buf(),
    })?;
    ensure_directory(parent).await?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| CacheIoError::InvalidFileName {
            path: path.to_path_buf(),
        })?;
    let temporary = parent.join(format!(".{file_name}.{}.tmp", Uuid::new_v4()));
    tokio::fs::write(&temporary, bytes)
        .await
        .map_err(|source| CacheIoError::Write {
            path: temporary.clone(),
            source,
        })?;
    if let Err(source) = tokio::fs::rename(&temporary, path).await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(CacheIoError::Commit {
            source_path: temporary,
            target_path: path.to_path_buf(),
            source,
        });
    }
    Ok(())
}

pub(super) async fn remove_if_present(path: &Path) -> Result<(), CacheIoError> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(CacheIoError::Remove {
            path: path.to_path_buf(),
            source,
        }),
    }
}

pub(super) fn marker_is_fresh(path: &Path, ttl: Duration) -> Result<bool, CacheIoError> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(source) => {
            return Err(CacheIoError::Inspect {
                path: path.to_path_buf(),
                source,
            })
        }
    };
    let modified = metadata
        .modified()
        .map_err(|source| CacheIoError::Inspect {
            path: path.to_path_buf(),
            source,
        })?;
    Ok(SystemTime::now()
        .duration_since(modified)
        .map(|age| age <= ttl)
        .unwrap_or(true))
}

pub(super) async fn persist(
    root: &Path,
    path: &Path,
    bytes: &[u8],
    limits: LatexCacheLimits,
) -> Result<(), CacheIoError> {
    write_atomic(path, bytes).await?;
    tokio::spawn(prune(
        root.to_path_buf(),
        path.to_path_buf(),
        limits.cache_max_bytes,
    ));
    Ok(())
}

fn collect_files(root: &Path) -> std::io::Result<Vec<(PathBuf, u64, SystemTime)>> {
    let mut pending = vec![root.to_path_buf()];
    let mut found = Vec::new();
    while let Some(directory) = pending.pop() {
        let entries = match std::fs::read_dir(&directory) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        for entry_result in entries {
            let entry = entry_result?;
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                pending.push(entry.path());
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let metadata = entry.metadata()?;
            found.push((
                entry.path(),
                metadata.len(),
                metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            ));
        }
    }
    Ok(found)
}

async fn prune(root: PathBuf, keep: PathBuf, max_bytes: u64) {
    let prune_lock = PRUNE_LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
    let Ok(_guard) = prune_lock.try_lock() else {
        return;
    };
    let task = tokio::task::spawn_blocking(move || {
        let mut files = collect_files(&root)?;
        let mut total = files.iter().try_fold(0_u64, |sum, (_, size, _)| {
            sum.checked_add(*size)
                .ok_or_else(|| std::io::Error::other("TeXLive cache size overflow"))
        })?;
        if total <= max_bytes {
            return Ok::<(), std::io::Error>(());
        }
        files.sort_by_key(|(_, _, modified)| *modified);
        for (path, size, _) in files {
            if total <= max_bytes {
                break;
            }
            if path == keep {
                continue;
            }
            std::fs::remove_file(&path)?;
            total = total.saturating_sub(size);
        }
        Ok(())
    })
    .await;
    match task {
        Err(error) => warn!(error = ?error, "TeXLive cache prune worker failed"),
        Ok(Err(error)) => warn!(error = ?error, "TeXLive cache prune failed"),
        Ok(Ok(())) => {}
    }
}

#[derive(Debug, Error)]
pub(super) enum CacheIoError {
    #[error("TeXLive cache path {path} has no parent", path = path.display())]
    MissingParent { path: PathBuf },
    #[error("TeXLive cache path {path} has no valid file name", path = path.display())]
    InvalidFileName { path: PathBuf },
    #[error("could not inspect TeXLive cache path {path}", path = path.display())]
    Inspect {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("could not create TeXLive cache directory {path}", path = path.display())]
    CreateDirectory {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("could not read TeXLive cache file {path}", path = path.display())]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("could not write TeXLive cache file {path}", path = path.display())]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("could not commit TeXLive cache file from {source_path} to {target_path}", source_path = source_path.display(), target_path = target_path.display())]
    Commit {
        source_path: PathBuf,
        target_path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("could not remove TeXLive cache file {path}", path = path.display())]
    Remove {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

#[cfg(test)]
mod tests {
    use super::{marker_is_fresh, prune, read_bounded, write_atomic};
    use std::error::Error;
    use std::time::Duration;

    #[tokio::test]
    async fn bounded_reads_discard_oversized_files() -> Result<(), Box<dyn Error>> {
        let directory = tempfile::tempdir()?;
        let archive = directory.path().join("example.tar.xz");
        std::fs::write(&archive, b"abc")?;
        assert_eq!(read_bounded(&archive, 3).await?, Some(b"abc".to_vec()));
        assert_eq!(read_bounded(&archive, 2).await?, None);
        assert!(!archive.exists());
        Ok(())
    }

    #[tokio::test]
    async fn pruning_preserves_the_current_file() -> Result<(), Box<dyn Error>> {
        let directory = tempfile::tempdir()?;
        let root = directory.path();
        let keep = root.join("26/current.sty");
        let removable = root.join("26/old.sty");
        write_atomic(&keep, &[2; 20]).await?;
        write_atomic(&removable, &[3; 30]).await?;
        prune(root.to_path_buf(), keep.clone(), 20).await;

        assert!(keep.is_file());
        assert!(!removable.exists());
        Ok(())
    }

    #[test]
    fn recent_negative_cache_markers_are_reused() -> Result<(), Box<dyn Error>> {
        let directory = tempfile::tempdir()?;
        let marker = directory.path().join("missing.marker");
        std::fs::write(&marker, b"missing")?;
        assert!(marker_is_fresh(&marker, Duration::from_secs(60))?);
        Ok(())
    }
}
