use std::env;
use std::time::Duration;
use thiserror::Error;

const DEFAULT_TEXLIVE_BASE_URL: &str = "https://texlive2026.texlyre.org";
pub(super) const CACHE_NAMESPACE: &str = "busytex-tl2026-d7f4e922";
const DEFAULT_MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const DEFAULT_CACHE_MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const DEFAULT_MISSING_TTL_SECONDS: u64 = 300;

#[derive(Clone, Copy)]
pub(super) struct LatexCacheLimits {
    pub(super) max_file_bytes: u64,
    pub(super) cache_max_bytes: u64,
    pub(super) missing_ttl: Duration,
}

fn env_u64(name: &str, fallback: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn env_bool(name: &str, fallback: bool) -> bool {
    env::var(name)
        .ok()
        .and_then(|value| match value.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        })
        .unwrap_or(fallback)
}

pub(super) fn cache_limits() -> LatexCacheLimits {
    LatexCacheLimits {
        max_file_bytes: env_u64("LATEX_TEXLIVE_MAX_FILE_BYTES", DEFAULT_MAX_FILE_BYTES),
        cache_max_bytes: env_u64("LATEX_TEXLIVE_CACHE_MAX_BYTES", DEFAULT_CACHE_MAX_BYTES),
        missing_ttl: Duration::from_secs(env_u64(
            "LATEX_TEXLIVE_MISSING_TTL_SECONDS",
            DEFAULT_MISSING_TTL_SECONDS,
        )),
    }
}

pub(super) fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .map(|address| address.is_loopback())
            .unwrap_or(false)
}

fn normalize_upstream_base(
    raw: &str,
    variable: &'static str,
) -> Result<String, LatexUpstreamConfigError> {
    let mut url = reqwest::Url::parse(raw)
        .map_err(|source| LatexUpstreamConfigError::InvalidUrl { variable, source })?;
    let secure_scheme = url.scheme() == "https";
    let loopback_http = url.scheme() == "http" && url.host_str().is_some_and(is_loopback_host);
    if !secure_scheme && !loopback_http {
        return Err(LatexUpstreamConfigError::InsecureScheme { variable });
    }
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(LatexUpstreamConfigError::UnsafeUrl { variable });
    }
    let normalized_path = url.path().trim_end_matches('/').to_string();
    url.set_path(if normalized_path.is_empty() {
        "/"
    } else {
        &normalized_path
    });
    Ok(url.as_str().trim_end_matches('/').to_string())
}

#[derive(Debug, Error)]
pub(super) enum LatexUpstreamConfigError {
    #[error("{variable} is not a valid URL")]
    InvalidUrl {
        variable: &'static str,
        #[source]
        source: url::ParseError,
    },
    #[error("{variable} must use HTTPS unless it targets a loopback development host")]
    InsecureScheme { variable: &'static str },
    #[error("{variable} must be an absolute URL without credentials, query, or fragment")]
    UnsafeUrl { variable: &'static str },
}

pub(super) fn texlive_base_url() -> Result<Option<String>, LatexUpstreamConfigError> {
    if !env_bool("LATEX_TEXLIVE_UPSTREAM_ENABLED", true) {
        return Ok(None);
    }
    let raw = env::var("LATEX_TEXLIVE_BASE_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_TEXLIVE_BASE_URL.to_string());
    normalize_upstream_base(&raw, "LATEX_TEXLIVE_BASE_URL").map(Some)
}

pub(super) fn texlive_asset_url(
    base: &str,
    format: u8,
    filename: &str,
) -> Result<reqwest::Url, LatexUpstreamConfigError> {
    let mut url =
        reqwest::Url::parse(base).map_err(|source| LatexUpstreamConfigError::InvalidUrl {
            variable: "LATEX_TEXLIVE_BASE_URL",
            source,
        })?;
    let Ok(mut segments) = url.path_segments_mut() else {
        return Err(LatexUpstreamConfigError::UnsafeUrl {
            variable: "LATEX_TEXLIVE_BASE_URL",
        });
    };
    segments.push(&format.to_string()).push(filename);
    drop(segments);
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::{normalize_upstream_base, texlive_asset_url};

    #[test]
    fn upstream_urls_require_safe_https_or_loopback_http() {
        assert_eq!(
            normalize_upstream_base("https://example.com/texlive/", "TEST")
                .ok()
                .as_deref(),
            Some("https://example.com/texlive")
        );
        assert!(normalize_upstream_base("http://127.0.0.1:8080/files", "TEST").is_ok());
        assert!(normalize_upstream_base("http://example.com/files", "TEST").is_err());
        assert!(normalize_upstream_base("https://user@example.com/files", "TEST").is_err());
        assert!(normalize_upstream_base("https://example.com/files?token=secret", "TEST").is_err());
    }

    #[test]
    fn asset_urls_encode_the_filename_as_one_path_segment() {
        assert_eq!(
            texlive_asset_url("https://example.com/texlive", 26, "file #1.sty")
                .map(|url| url.to_string())
                .ok()
                .as_deref(),
            Some("https://example.com/texlive/26/file%20%231.sty")
        );
    }
}
