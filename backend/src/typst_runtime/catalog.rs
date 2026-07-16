use super::{validate_package_bytes, PackageLimits, PackagePayload, PackageSpec};
use serde::Deserialize;
use std::path::{Component, Path, PathBuf};
use thiserror::Error;

pub(super) const CATALOG_SCHEMA: u32 = 2;

#[derive(Debug, Deserialize)]
pub(super) struct TypstCatalog {
    pub(super) schema: u32,
    #[serde(default)]
    pub(super) local_packages: Vec<CatalogPackage>,
    #[serde(default)]
    pub(super) universe_seeds: Vec<CatalogPackage>,
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct CatalogPackage {
    pub(super) namespace: String,
    pub(super) name: String,
    pub(super) version: String,
    pub(super) artifact_path: String,
    pub(super) sha256: String,
    pub(super) size_bytes: u64,
}

pub(super) fn sanitize_builtin_asset_path(root: &Path, raw: &str) -> Option<PathBuf> {
    let relative = Path::new(raw);
    if relative.as_os_str().is_empty() || relative.is_absolute() {
        return None;
    }
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return None;
    }
    Some(root.join(relative))
}

pub(super) async fn read_catalog_package(
    builtin_dir: &Path,
    spec: &PackageSpec,
    limits: PackageLimits,
) -> Result<Option<PackagePayload>, CatalogPackageError> {
    let catalog_path = builtin_dir.join("catalog.json");
    let catalog_bytes = tokio::fs::read(&catalog_path).await.map_err(|source| {
        CatalogPackageError::ReadCatalog {
            path: catalog_path.clone(),
            source,
        }
    })?;
    let catalog: TypstCatalog = serde_json::from_slice(&catalog_bytes).map_err(|source| {
        CatalogPackageError::ParseCatalog {
            path: catalog_path,
            source,
        }
    })?;
    if catalog.schema != CATALOG_SCHEMA {
        return Err(CatalogPackageError::UnsupportedCatalogSchema {
            schema: catalog.schema,
        });
    }
    let (entries, cache_status) = if spec.is_local() {
        (catalog.local_packages, "LOCAL")
    } else {
        (catalog.universe_seeds, "SEED")
    };
    let Some(entry) = entries.into_iter().find(|entry| {
        entry.namespace == spec.namespace
            && entry.name == spec.name
            && entry.version == spec.version
    }) else {
        return Ok(None);
    };
    let Some(artifact_path) = sanitize_builtin_asset_path(builtin_dir, &entry.artifact_path) else {
        return Err(CatalogPackageError::InvalidArtifactPath {
            path: entry.artifact_path,
        });
    };
    let bytes = tokio::fs::read(&artifact_path).await.map_err(|source| {
        CatalogPackageError::ReadArtifact {
            path: artifact_path,
            source,
        }
    })?;
    let actual_size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    if entry.size_bytes != actual_size {
        return Err(CatalogPackageError::SizeMismatch {
            expected: entry.size_bytes,
            actual: actual_size,
        });
    }
    let (bytes, sha256) = validate_package_bytes(bytes, spec.clone(), limits)
        .await
        .map_err(CatalogPackageError::Validation)?;
    if sha256 != entry.sha256 {
        return Err(CatalogPackageError::ChecksumMismatch);
    }
    Ok(Some(PackagePayload {
        bytes,
        sha256,
        cache_status,
    }))
}

#[derive(Debug, Error)]
pub(super) enum CatalogPackageError {
    #[error("could not read built-in Typst catalog {path}", path = path.display())]
    ReadCatalog {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("could not parse built-in Typst catalog {path}", path = path.display())]
    ParseCatalog {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("built-in Typst catalog schema {schema} is unsupported")]
    UnsupportedCatalogSchema { schema: u32 },
    #[error("Typst package seed path {path} is invalid")]
    InvalidArtifactPath { path: String },
    #[error("could not read Typst package seed {path}", path = path.display())]
    ReadArtifact {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("Typst package seed is {actual} bytes but its catalog declares {expected} bytes")]
    SizeMismatch { expected: u64, actual: u64 },
    #[error(transparent)]
    Validation(#[from] super::PackageValidationError),
    #[error("Typst package seed checksum does not match its catalog")]
    ChecksumMismatch,
}
