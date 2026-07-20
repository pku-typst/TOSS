//! Exact package closure materialization for durable Typst processing inputs.

use super::archive::archive_path_is_safe;
use super::{
    analyze_project_dependencies, load_dynamic_package, package_cache_config, read_cached_package,
    read_catalog_package, universe_config, CatalogPackageError, LoadDynamicPackageError,
    PackagePayload, PackageSpec, UniverseConfigError,
};
use flate2::read::MultiGzDecoder;
use serde::Deserialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Read;
use std::path::{Component, Path};
use tar::Archive;
use thiserror::Error;

const MAX_PROCESSING_PACKAGES: usize = 128;

pub(crate) struct ResolvedTypstPackage {
    pub namespace: String,
    pub name: String,
    pub version: String,
    pub archive_sha256: String,
    pub files: Vec<ResolvedTypstPackageFile>,
}

pub(crate) struct ResolvedTypstPackageFile {
    pub path: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Error)]
pub(crate) enum ResolveProcessingPackagesError {
    #[error("Typst package dependency is dynamic and cannot be captured")]
    DynamicDependency,
    #[error("Typst package closure contains too many packages")]
    TooManyPackages,
    #[error("Typst package closure exceeds the processing input limit")]
    TooLarge,
    #[error("local Typst package {package} was not found")]
    LocalPackageNotFound { package: String },
    #[error("Typst Universe package resolution is disabled")]
    UniverseDisabled,
    #[error("Typst Universe configuration is invalid")]
    UniverseConfig {
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    #[error("built-in Typst package resolution failed")]
    Catalog {
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    #[error("Typst Universe package download failed")]
    DynamicPackage {
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    #[error("Typst package {package} archive could not be read")]
    Archive {
        package: String,
        #[source]
        source: std::io::Error,
    },
    #[error("Typst package {package} archive contains an unsafe entry")]
    UnsafeArchive { package: String },
    #[error("Typst package {package} manifest is missing or invalid")]
    Manifest { package: String },
    #[error("Typst package {package} contains duplicate files")]
    DuplicateFile { package: String },
}

#[derive(Deserialize)]
struct PackageManifest {
    package: PackageManifestEntry,
}

#[derive(Deserialize)]
struct PackageManifestEntry {
    entrypoint: String,
}

pub(crate) async fn resolve_processing_package_closure(
    builtin_dir: &Path,
    roots: &super::TypstProjectDependencies,
    max_expanded_bytes: i64,
) -> Result<Vec<ResolvedTypstPackage>, ResolveProcessingPackagesError> {
    if roots.has_dynamic_imports {
        return Err(ResolveProcessingPackagesError::DynamicDependency);
    }
    let mut pending = roots.packages.iter().cloned().collect::<VecDeque<_>>();
    let mut visited = HashSet::new();
    let mut resolved = Vec::new();
    let mut expanded_bytes = 0_i64;
    while let Some(spec) = pending.pop_front() {
        if !visited.insert(spec.clone()) {
            continue;
        }
        if visited.len() > MAX_PROCESSING_PACKAGES {
            return Err(ResolveProcessingPackagesError::TooManyPackages);
        }
        let payload = resolve_package(builtin_dir, &spec).await?;
        let (files, manifest) = extract_package_files(&spec, &payload, &mut expanded_bytes)?;
        if expanded_bytes > max_expanded_bytes {
            return Err(ResolveProcessingPackagesError::TooLarge);
        }
        let documents = files
            .iter()
            .filter(|file| file.path.to_ascii_lowercase().ends_with(".typ"))
            .filter_map(|file| {
                std::str::from_utf8(&file.bytes)
                    .ok()
                    .map(|source| (file.path.clone(), source.to_string()))
            })
            .collect::<HashMap<_, _>>();
        let dependencies = analyze_project_dependencies(&manifest.package.entrypoint, &documents);
        if dependencies.has_dynamic_imports {
            return Err(ResolveProcessingPackagesError::DynamicDependency);
        }
        pending.extend(dependencies.packages);
        resolved.push(ResolvedTypstPackage {
            namespace: spec.namespace().to_string(),
            name: spec.name().to_string(),
            version: spec.version().to_string(),
            archive_sha256: payload.sha256,
            files,
        });
    }
    resolved.sort_by(|left, right| {
        (&left.namespace, &left.name, &left.version).cmp(&(
            &right.namespace,
            &right.name,
            &right.version,
        ))
    });
    Ok(resolved)
}

async fn resolve_package(
    builtin_dir: &Path,
    spec: &PackageSpec,
) -> Result<PackagePayload, ResolveProcessingPackagesError> {
    let cache = package_cache_config();
    if let Some(payload) = read_catalog_package(builtin_dir, spec, cache.limits)
        .await
        .map_err(
            |source: CatalogPackageError| ResolveProcessingPackagesError::Catalog {
                source: Box::new(source),
            },
        )?
    {
        return Ok(payload);
    }
    if spec.is_local() {
        return Err(ResolveProcessingPackagesError::LocalPackageNotFound {
            package: spec.key(),
        });
    }
    let universe = universe_config().map_err(|source: UniverseConfigError| {
        ResolveProcessingPackagesError::UniverseConfig {
            source: Box::new(source),
        }
    })?;
    if let Some(payload) = read_cached_package(&universe.cache, spec).await {
        return Ok(payload);
    }
    if !universe.enabled {
        return Err(ResolveProcessingPackagesError::UniverseDisabled);
    }
    load_dynamic_package(&universe, spec)
        .await
        .map_err(
            |source: LoadDynamicPackageError| ResolveProcessingPackagesError::DynamicPackage {
                source: Box::new(source),
            },
        )
}

fn extract_package_files(
    spec: &PackageSpec,
    payload: &PackagePayload,
    expanded_bytes: &mut i64,
) -> Result<(Vec<ResolvedTypstPackageFile>, PackageManifest), ResolveProcessingPackagesError> {
    let package = spec.key();
    let decoder = MultiGzDecoder::new(payload.bytes.as_slice());
    let mut archive = Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|source| ResolveProcessingPackagesError::Archive {
            package: package.clone(),
            source,
        })?;
    let mut files = Vec::new();
    let mut paths = HashSet::new();
    let mut manifest = None::<PackageManifest>;
    for entry in entries {
        let mut entry = entry.map_err(|source| ResolveProcessingPackagesError::Archive {
            package: package.clone(),
            source,
        })?;
        if entry.header().entry_type().is_dir() {
            continue;
        }
        let path = entry
            .path()
            .map_err(|source| ResolveProcessingPackagesError::Archive {
                package: package.clone(),
                source,
            })?
            .into_owned();
        if !entry.header().entry_type().is_file() || !archive_path_is_safe(&path) {
            return Err(ResolveProcessingPackagesError::UnsafeArchive { package });
        }
        let path = normalized_archive_path(&path).ok_or_else(|| {
            ResolveProcessingPackagesError::UnsafeArchive {
                package: package.clone(),
            }
        })?;
        if !paths.insert(path.clone()) {
            return Err(ResolveProcessingPackagesError::DuplicateFile { package });
        }
        let declared_size =
            i64::try_from(entry.size()).map_err(|_| ResolveProcessingPackagesError::TooLarge)?;
        *expanded_bytes = expanded_bytes
            .checked_add(declared_size)
            .ok_or(ResolveProcessingPackagesError::TooLarge)?;
        let mut bytes = Vec::with_capacity(usize::try_from(entry.size()).unwrap_or(0));
        entry.read_to_end(&mut bytes).map_err(|source| {
            ResolveProcessingPackagesError::Archive {
                package: package.clone(),
                source,
            }
        })?;
        if path == "typst.toml" {
            manifest = std::str::from_utf8(&bytes)
                .ok()
                .and_then(|source| toml::from_str(source).ok());
        }
        files.push(ResolvedTypstPackageFile { path, bytes });
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let manifest = manifest.ok_or(ResolveProcessingPackagesError::Manifest { package })?;
    if !paths.contains(&manifest.package.entrypoint) {
        return Err(ResolveProcessingPackagesError::Manifest {
            package: spec.key(),
        });
    }
    Ok((files, manifest))
}

fn normalized_archive_path(path: &Path) -> Option<String> {
    let parts = path
        .components()
        .filter_map(|component| match component {
            Component::CurDir => None,
            Component::Normal(value) => value.to_str(),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => None,
        })
        .collect::<Vec<_>>();
    (!parts.is_empty()).then(|| parts.join("/"))
}
