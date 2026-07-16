//! Authenticated Typst runtime assets and Universe package resolution.

mod archive;
mod cache;
mod catalog;
mod http;
mod package;
mod universe;

pub(crate) use http::{typst_builtin_asset, typst_package_proxy};

use archive::{validate_package_bytes, PackageValidationError};
use cache::read_cached_package;
use catalog::{read_catalog_package, sanitize_builtin_asset_path, CatalogPackageError};
use package::{PackageLimits, PackagePayload, PackageSpec};
use universe::{
    load_dynamic_package, package_cache_config, universe_config, FetchPackageError,
    LoadDynamicPackageError, UniverseConfigError,
};

#[cfg(test)]
mod tests;
