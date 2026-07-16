use super::{validate_package_bytes, PackageLimits, PackagePayload, PackageSpec};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;
use tracing::warn;
use uuid::Uuid;

const CACHE_METADATA_SCHEMA: u32 = 1;

#[derive(Clone)]
pub(super) struct PackageCacheConfig {
    pub(super) root: PathBuf,
    pub(super) max_bytes: u64,
    pub(super) limits: PackageLimits,
}

#[derive(Debug, Serialize, Deserialize)]
struct CacheMetadata {
    schema: u32,
    namespace: String,
    name: String,
    version: String,
    sha256: String,
    size_bytes: u64,
    source_url: String,
    fetched_at: DateTime<Utc>,
}

pub(super) fn cache_paths(config: &PackageCacheConfig, spec: &PackageSpec) -> (PathBuf, PathBuf) {
    let root = config
        .root
        .join(&spec.namespace)
        .join(&spec.name)
        .join(&spec.version);
    (root.join("package.tar.gz"), root.join("metadata.json"))
}

async fn remove_cache_entry(package_path: &Path, metadata_path: &Path) {
    let _ = tokio::fs::remove_file(package_path).await;
    let _ = tokio::fs::remove_file(metadata_path).await;
}

pub(super) async fn read_cached_package(
    config: &PackageCacheConfig,
    spec: &PackageSpec,
) -> Option<PackagePayload> {
    let (package_path, metadata_path) = cache_paths(config, spec);
    let metadata_bytes = tokio::fs::read(&metadata_path).await.ok()?;
    let metadata: CacheMetadata = serde_json::from_slice(&metadata_bytes).ok()?;
    if metadata.schema != CACHE_METADATA_SCHEMA
        || metadata.namespace != spec.namespace
        || metadata.name != spec.name
        || metadata.version != spec.version
    {
        remove_cache_entry(&package_path, &metadata_path).await;
        return None;
    }
    let bytes = match tokio::fs::read(&package_path).await {
        Ok(value) => value,
        Err(_) => {
            remove_cache_entry(&package_path, &metadata_path).await;
            return None;
        }
    };
    let validated = validate_package_bytes(bytes, spec.clone(), config.limits).await;
    let Ok((bytes, sha256)) = validated else {
        remove_cache_entry(&package_path, &metadata_path).await;
        return None;
    };
    if metadata.size_bytes != u64::try_from(bytes.len()).unwrap_or(u64::MAX)
        || metadata.sha256 != sha256
    {
        remove_cache_entry(&package_path, &metadata_path).await;
        return None;
    }
    Some(PackagePayload {
        bytes,
        sha256,
        cache_status: "HIT",
    })
}

pub(super) async fn write_cached_package(
    config: &PackageCacheConfig,
    spec: &PackageSpec,
    bytes: &[u8],
    sha256: &str,
    source_url: String,
) -> Result<(), CacheWriteError> {
    let (package_path, metadata_path) = cache_paths(config, spec);
    let Some(parent) = package_path.parent() else {
        return Err(CacheWriteError::MissingParent { package_path });
    };
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|source| CacheWriteError::CreateDirectory {
            path: parent.to_path_buf(),
            source,
        })?;
    let suffix = Uuid::new_v4();
    let package_tmp = parent.join(format!("package.{suffix}.tmp"));
    let metadata_tmp = parent.join(format!("metadata.{suffix}.tmp"));
    let metadata = CacheMetadata {
        schema: CACHE_METADATA_SCHEMA,
        namespace: spec.namespace.clone(),
        name: spec.name.clone(),
        version: spec.version.clone(),
        sha256: sha256.to_string(),
        size_bytes: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
        source_url,
        fetched_at: Utc::now(),
    };
    let metadata_bytes =
        serde_json::to_vec_pretty(&metadata).map_err(CacheWriteError::SerializeMetadata)?;
    tokio::fs::write(&package_tmp, bytes)
        .await
        .map_err(|source| CacheWriteError::WritePackage {
            path: package_tmp.clone(),
            source,
        })?;
    tokio::fs::write(&metadata_tmp, metadata_bytes)
        .await
        .map_err(|source| CacheWriteError::WriteMetadata {
            path: metadata_tmp.clone(),
            source,
        })?;
    tokio::fs::rename(&package_tmp, &package_path)
        .await
        .map_err(|source| CacheWriteError::CommitPackage {
            source_path: package_tmp,
            target_path: package_path,
            source,
        })?;
    tokio::fs::rename(&metadata_tmp, &metadata_path)
        .await
        .map_err(|source| CacheWriteError::CommitMetadata {
            source_path: metadata_tmp,
            target_path: metadata_path,
            source,
        })?;
    Ok(())
}

#[derive(Debug, Error)]
pub(super) enum CacheWriteError {
    #[error("Typst package cache path {package_path} has no parent", package_path = package_path.display())]
    MissingParent { package_path: PathBuf },
    #[error("could not create Typst package cache directory {path}", path = path.display())]
    CreateDirectory {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("could not serialize Typst package cache metadata")]
    SerializeMetadata(#[source] serde_json::Error),
    #[error("could not write Typst package cache file {path}", path = path.display())]
    WritePackage {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("could not write Typst package metadata file {path}", path = path.display())]
    WriteMetadata {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("could not commit Typst package cache file from {source_path} to {target_path}", source_path = source_path.display(), target_path = target_path.display())]
    CommitPackage {
        source_path: PathBuf,
        target_path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("could not commit Typst package metadata file from {source_path} to {target_path}", source_path = source_path.display(), target_path = target_path.display())]
    CommitMetadata {
        source_path: PathBuf,
        target_path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

fn collect_cached_archives(
    root: &Path,
) -> std::io::Result<Vec<(PathBuf, u64, std::time::SystemTime)>> {
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
            if entry.file_name() != "package.tar.gz" {
                continue;
            }
            let metadata = entry.metadata()?;
            found.push((
                entry.path(),
                metadata.len(),
                metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
            ));
        }
    }
    Ok(found)
}

pub(super) async fn prune_package_cache(config: PackageCacheConfig, keep: PathBuf) {
    let result = tokio::task::spawn_blocking(move || {
        let mut archives = collect_cached_archives(&config.root)?;
        let mut total = archives.iter().try_fold(0_u64, |sum, (_, size, _)| {
            sum.checked_add(*size)
                .ok_or_else(|| std::io::Error::other("Typst package cache size overflow"))
        })?;
        if total <= config.max_bytes {
            return Ok::<(), std::io::Error>(());
        }
        archives.sort_by_key(|(_, _, modified)| *modified);
        for (path, size, _) in archives {
            if total <= config.max_bytes || path == keep {
                continue;
            }
            std::fs::remove_file(&path)?;
            let metadata_path = path.with_file_name("metadata.json");
            let _ = std::fs::remove_file(metadata_path);
            total = total.saturating_sub(size);
        }
        Ok(())
    })
    .await;
    if let Err(error) = result {
        warn!("Typst package cache prune task failed: {error}");
    } else if let Ok(Err(error)) = result {
        warn!("Typst package cache prune failed: {error}");
    }
}
