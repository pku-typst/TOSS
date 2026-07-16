use super::cache::{
    cache_paths, prune_package_cache, read_cached_package, write_cached_package, PackageCacheConfig,
};
use super::{
    validate_package_bytes, PackageLimits, PackagePayload, PackageSpec, PackageValidationError,
};
use futures::StreamExt;
use std::collections::HashMap;
use std::env;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use thiserror::Error;
use tokio::sync::Mutex;
use tracing::warn;

pub(super) const DEFAULT_MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
pub(super) const DEFAULT_MAX_EXTRACTED_BYTES: u64 = 256 * 1024 * 1024;
pub(super) const DEFAULT_MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
pub(super) const DEFAULT_MAX_FILES: u64 = 4096;
const DEFAULT_CACHE_MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Clone)]
pub(super) struct UniverseConfig {
    pub(super) enabled: bool,
    pub(super) base_url: reqwest::Url,
    pub(super) cache: PackageCacheConfig,
}

static PACKAGE_FETCH_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
static UNIVERSE_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn package_fetch_locks() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    PACKAGE_FETCH_LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn package_fetch_lock(key: &str) -> Arc<Mutex<()>> {
    let mut locks = package_fetch_locks().lock().await;
    locks
        .entry(key.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

async fn release_package_fetch_lock(key: &str, lock: &Arc<Mutex<()>>) {
    let mut locks = package_fetch_locks().lock().await;
    let is_current = locks
        .get(key)
        .map(|current| Arc::ptr_eq(current, lock))
        .unwrap_or(false);
    if is_current && Arc::strong_count(lock) == 2 {
        locks.remove(key);
    }
}

fn universe_http_client() -> Result<&'static reqwest::Client, reqwest::Error> {
    if let Some(client) = UNIVERSE_HTTP_CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 3 || attempt.url().scheme() != "https" {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()?;
    Ok(UNIVERSE_HTTP_CLIENT.get_or_init(|| client))
}

fn env_bool(name: &str, default: bool) -> bool {
    env::var(name)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(default)
}

fn env_u64(name: &str, default: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

pub(super) fn universe_config() -> Result<UniverseConfig, UniverseConfigError> {
    let raw_base = env::var("TYPST_UNIVERSE_BASE_URL")
        .unwrap_or_else(|_| "https://packages.typst.org".to_string());
    let normalized_base = format!("{}/", raw_base.trim().trim_end_matches('/'));
    let base_url = reqwest::Url::parse(&normalized_base)
        .map_err(|source| UniverseConfigError::InvalidBaseUrl { source })?;
    if base_url.scheme() != "https"
        || base_url.host_str().is_none()
        || !base_url.username().is_empty()
        || base_url.password().is_some()
        || base_url.query().is_some()
        || base_url.fragment().is_some()
    {
        return Err(UniverseConfigError::UnsafeBaseUrl);
    }
    Ok(UniverseConfig {
        enabled: env_bool("TYPST_UNIVERSE_ENABLED", true),
        base_url,
        cache: PackageCacheConfig {
            root: env::var("TYPST_PACKAGE_CACHE_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("/tmp/typst-packages-cache")),
            max_bytes: env_u64("TYPST_PACKAGE_CACHE_MAX_BYTES", DEFAULT_CACHE_MAX_BYTES),
            limits: PackageLimits {
                max_archive_bytes: env_u64(
                    "TYPST_PACKAGE_MAX_ARCHIVE_BYTES",
                    DEFAULT_MAX_ARCHIVE_BYTES,
                ),
                max_extracted_bytes: env_u64(
                    "TYPST_PACKAGE_MAX_EXTRACTED_BYTES",
                    DEFAULT_MAX_EXTRACTED_BYTES,
                ),
                max_file_bytes: env_u64("TYPST_PACKAGE_MAX_FILE_BYTES", DEFAULT_MAX_FILE_BYTES),
                max_files: env_u64("TYPST_PACKAGE_MAX_FILES", DEFAULT_MAX_FILES),
            },
        },
    })
}

#[derive(Debug, Error)]
pub(super) enum UniverseConfigError {
    #[error("Typst Universe base URL is invalid")]
    InvalidBaseUrl {
        #[source]
        source: url::ParseError,
    },
    #[error("Typst Universe base URL must be a credential-free HTTPS origin or path")]
    UnsafeBaseUrl,
}

async fn fetch_upstream_package(
    config: &UniverseConfig,
    spec: &PackageSpec,
) -> Result<(Vec<u8>, String), FetchPackageError> {
    let url = config
        .base_url
        .join(&format!(
            "{}/{}-{}.tar.gz",
            spec.namespace, spec.name, spec.version
        ))
        .map_err(|source| FetchPackageError::InvalidUrl { source })?;
    let client = universe_http_client().map_err(FetchPackageError::BuildClient)?;
    let response =
        client
            .get(url.clone())
            .send()
            .await
            .map_err(|source| FetchPackageError::Request {
                package: spec.key(),
                source,
            })?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(FetchPackageError::NotFound);
    }
    if !response.status().is_success() {
        return Err(FetchPackageError::UpstreamStatus {
            package: spec.key(),
            status: response.status(),
        });
    }
    if let Some(size) = response.content_length() {
        if size > config.cache.limits.max_archive_bytes {
            return Err(FetchPackageError::ArchiveTooLarge {
                size: Some(size),
                limit: config.cache.limits.max_archive_bytes,
            });
        }
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|source| FetchPackageError::ResponseBody {
            package: spec.key(),
            source,
        })?;
        let next_size = bytes
            .len()
            .checked_add(chunk.len())
            .and_then(|value| u64::try_from(value).ok())
            .ok_or(FetchPackageError::ArchiveTooLarge {
                size: None,
                limit: config.cache.limits.max_archive_bytes,
            })?;
        if next_size > config.cache.limits.max_archive_bytes {
            return Err(FetchPackageError::ArchiveTooLarge {
                size: Some(next_size),
                limit: config.cache.limits.max_archive_bytes,
            });
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((bytes, url.to_string()))
}

#[derive(Debug, Error)]
pub(super) enum FetchPackageError {
    #[error("Typst package upstream URL is invalid")]
    InvalidUrl {
        #[source]
        source: url::ParseError,
    },
    #[error("could not build Typst package HTTP client")]
    BuildClient(#[source] reqwest::Error),
    #[error("Typst package upstream request failed for {package}")]
    Request {
        package: String,
        #[source]
        source: reqwest::Error,
    },
    #[error("Typst package was not found")]
    NotFound,
    #[error("Typst package upstream returned {status} for {package}")]
    UpstreamStatus {
        package: String,
        status: reqwest::StatusCode,
    },
    #[error("Typst package archive size {size:?} exceeds the {limit}-byte limit")]
    ArchiveTooLarge { size: Option<u64>, limit: u64 },
    #[error("Typst package upstream response body failed for {package}")]
    ResponseBody {
        package: String,
        #[source]
        source: reqwest::Error,
    },
}

pub(super) async fn load_dynamic_package(
    config: &UniverseConfig,
    spec: &PackageSpec,
) -> Result<PackagePayload, LoadDynamicPackageError> {
    let key = spec.key();
    let lock = package_fetch_lock(&key).await;
    let result = {
        let _guard = lock.lock().await;
        async {
            if let Some(payload) = read_cached_package(&config.cache, spec).await {
                return Ok(payload);
            }
            let (downloaded, source_url) = fetch_upstream_package(config, spec)
                .await
                .map_err(LoadDynamicPackageError::Fetch)?;
            let (bytes, sha256) =
                validate_package_bytes(downloaded, spec.clone(), config.cache.limits)
                    .await
                    .map_err(LoadDynamicPackageError::Validation)?;
            if let Err(error) =
                write_cached_package(&config.cache, spec, &bytes, &sha256, source_url).await
            {
                warn!(error = ?error, package = %spec.key(), "failed to persist Typst package");
            } else {
                let (package_path, _) = cache_paths(&config.cache, spec);
                tokio::spawn(prune_package_cache(config.cache.clone(), package_path));
            }
            Ok(PackagePayload {
                bytes,
                sha256,
                cache_status: "MISS",
            })
        }
        .await
    };
    release_package_fetch_lock(&key, &lock).await;
    result
}

#[derive(Debug, Error)]
pub(super) enum LoadDynamicPackageError {
    #[error(transparent)]
    Fetch(#[from] FetchPackageError),
    #[error(transparent)]
    Validation(#[from] PackageValidationError),
}
