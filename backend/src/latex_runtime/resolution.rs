use super::cache::{
    ensure_directory, marker_is_fresh, missing_marker_path, persist, read_bounded,
    remove_if_present, write_atomic, CacheIoError,
};
use super::config::{
    texlive_asset_url, texlive_base_url, LatexCacheLimits, LatexUpstreamConfigError,
};
use super::request::TexliveRequest;
use super::singleflight::lock_for;
use super::upstream::{fetch_bytes, UpstreamFetchError};
use std::path::Path;
use thiserror::Error;
use tracing::warn;

pub(super) enum AssetResolution {
    Found(Vec<u8>),
    Missing,
}

pub(super) async fn resolve(
    root: &Path,
    request: &TexliveRequest,
    limits: LatexCacheLimits,
) -> Result<AssetResolution, TexliveAssetError> {
    ensure_directory(root)
        .await
        .map_err(TexliveAssetError::CacheUnavailable)?;
    let cache_path = root
        .join(request.format.to_string())
        .join(&request.filename);
    let marker_path = missing_marker_path(&cache_path);
    if let Some(bytes) = read_bounded(&cache_path, limits.max_file_bytes)
        .await
        .map_err(TexliveAssetError::CacheUnavailable)?
    {
        return Ok(AssetResolution::Found(bytes));
    }

    if marker_is_fresh(&marker_path, limits.missing_ttl)
        .map_err(TexliveAssetError::CacheUnavailable)?
    {
        return Ok(AssetResolution::Missing);
    }
    let request_lock = lock_for(&format!("texlive:{}", cache_path.display())).await;
    let _guard = request_lock.lock().await;
    if let Some(bytes) = read_bounded(&cache_path, limits.max_file_bytes)
        .await
        .map_err(TexliveAssetError::CacheUnavailable)?
    {
        return Ok(AssetResolution::Found(bytes));
    }
    if marker_is_fresh(&marker_path, limits.missing_ttl)
        .map_err(TexliveAssetError::CacheUnavailable)?
    {
        return Ok(AssetResolution::Missing);
    }
    remove_marker_best_effort(&marker_path).await;

    let Some(base) = texlive_base_url().map_err(TexliveAssetError::InvalidConfiguration)? else {
        write_marker_best_effort(&marker_path).await;
        return Ok(AssetResolution::Missing);
    };

    let url = texlive_asset_url(&base, request.format, &request.filename)
        .map_err(TexliveAssetError::InvalidConfiguration)?;
    let bytes = fetch_bytes(url.as_str(), limits.max_file_bytes)
        .await
        .map_err(TexliveAssetError::from_upstream)?;
    let Some(bytes) = bytes else {
        write_marker_best_effort(&marker_path).await;
        return Ok(AssetResolution::Missing);
    };
    if let Err(error) = persist(root, &cache_path, &bytes, limits).await {
        warn!(error = ?error, path = %cache_path.display(), "failed to persist TeXLive cache file");
    }
    remove_marker_best_effort(&marker_path).await;
    Ok(AssetResolution::Found(bytes))
}

async fn write_marker_best_effort(marker_path: &Path) {
    if let Err(error) = write_atomic(marker_path, b"missing").await {
        warn!(error = ?error, path = %marker_path.display(), "failed to persist TeXLive negative-cache marker");
    }
}

async fn remove_marker_best_effort(marker_path: &Path) {
    if let Err(error) = remove_if_present(marker_path).await {
        warn!(error = ?error, path = %marker_path.display(), "failed to clear TeXLive negative-cache marker");
    }
}

#[derive(Debug, Error)]
pub(super) enum TexliveAssetError {
    #[error("TeXLive upstream configuration is invalid")]
    InvalidConfiguration(#[source] LatexUpstreamConfigError),
    #[error("TeXLive cache is unavailable")]
    CacheUnavailable(#[source] CacheIoError),
    #[error("TeXLive upstream HTTP client is unavailable")]
    HttpClientUnavailable(#[source] UpstreamFetchError),
    #[error("TeXLive upstream is unavailable")]
    UpstreamUnavailable(#[source] UpstreamFetchError),
    #[error("TeXLive upstream response exceeds the configured limit")]
    UpstreamPayloadTooLarge(#[source] UpstreamFetchError),
}

impl TexliveAssetError {
    fn from_upstream(source: UpstreamFetchError) -> Self {
        match source {
            failure @ UpstreamFetchError::PayloadTooLarge { .. } => {
                Self::UpstreamPayloadTooLarge(failure)
            }
            failure @ UpstreamFetchError::BuildClient(_) => Self::HttpClientUnavailable(failure),
            failure @ (UpstreamFetchError::Request { .. }
            | UpstreamFetchError::UnsafeRedirect { .. }
            | UpstreamFetchError::Status { .. }
            | UpstreamFetchError::Body { .. }) => Self::UpstreamUnavailable(failure),
        }
    }
}
