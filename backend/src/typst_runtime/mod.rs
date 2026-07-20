//! Authenticated Typst runtime assets and Universe package resolution.

mod archive;
mod cache;
mod catalog;
mod dependencies;
mod http;
mod package;
mod processing_packages;
mod universe;

pub(crate) use dependencies::{analyze_project_dependencies, TypstProjectDependencies};
pub(crate) use http::{typst_builtin_asset, typst_package_proxy};
pub(crate) use package::PackageSpec;
pub(crate) use processing_packages::{
    resolve_processing_package_closure, ResolveProcessingPackagesError, ResolvedTypstPackage,
};

use archive::{validate_package_bytes, PackageValidationError};
use cache::read_cached_package;
use catalog::{read_catalog_package, sanitize_builtin_asset_path, CatalogPackageError};
use package::{PackageLimits, PackagePayload};
use universe::{
    load_dynamic_package, package_cache_config, universe_config, FetchPackageError,
    LoadDynamicPackageError, UniverseConfigError,
};

#[cfg(test)]
mod tests;
