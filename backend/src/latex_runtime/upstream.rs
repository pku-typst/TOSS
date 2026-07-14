use super::config::is_loopback_host;
use futures::StreamExt;
use std::sync::OnceLock;
use std::time::Duration;
use thiserror::Error;

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn http_client() -> Result<&'static reqwest::Client, reqwest::Error> {
    if let Some(client) = HTTP_CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let url = attempt.url();
            let safe_target = url.scheme() == "https"
                || (url.scheme() == "http" && url.host_str().is_some_and(is_loopback_host));
            if attempt.previous().len() >= 5 || !safe_target {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .user_agent("Typst-Collaboration-TexLive/1.0")
        .build()?;
    Ok(HTTP_CLIENT.get_or_init(|| client))
}

pub(super) async fn fetch_bytes(
    url: &str,
    max_bytes: u64,
) -> Result<Option<Vec<u8>>, UpstreamFetchError> {
    let response = http_client()
        .map_err(UpstreamFetchError::BuildClient)?
        .get(url)
        .header(reqwest::header::ACCEPT, "*/*")
        .send()
        .await
        .map_err(|source| UpstreamFetchError::Request {
            url: url.to_string(),
            source,
        })?;
    if response.url().scheme() != "https"
        && !(response.url().scheme() == "http"
            && response.url().host_str().is_some_and(is_loopback_host))
    {
        return Err(UpstreamFetchError::UnsafeRedirect {
            url: response.url().to_string(),
        });
    }
    if response.status() == reqwest::StatusCode::NOT_FOUND
        || response.status() == reqwest::StatusCode::MOVED_PERMANENTLY
    {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(UpstreamFetchError::Status {
            url: url.to_string(),
            status: response.status(),
        });
    }
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes)
    {
        return Err(UpstreamFetchError::PayloadTooLarge { limit: max_bytes });
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|source| UpstreamFetchError::Body {
            url: url.to_string(),
            source,
        })?;
        let next_size = u64::try_from(bytes.len())
            .ok()
            .and_then(|size| size.checked_add(u64::try_from(chunk.len()).ok()?))
            .ok_or(UpstreamFetchError::PayloadTooLarge { limit: max_bytes })?;
        if next_size > max_bytes {
            return Err(UpstreamFetchError::PayloadTooLarge { limit: max_bytes });
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Some(bytes))
}

#[derive(Debug, Error)]
pub(super) enum UpstreamFetchError {
    #[error("could not build TeXLive HTTP client")]
    BuildClient(#[source] reqwest::Error),
    #[error("TeXLive upstream request failed for {url}")]
    Request {
        url: String,
        #[source]
        source: reqwest::Error,
    },
    #[error("TeXLive upstream redirected to unsafe URL {url}")]
    UnsafeRedirect { url: String },
    #[error("TeXLive upstream returned {status} for {url}")]
    Status {
        url: String,
        status: reqwest::StatusCode,
    },
    #[error("TeXLive upstream payload exceeds the {limit}-byte limit")]
    PayloadTooLarge { limit: u64 },
    #[error("TeXLive upstream response body failed for {url}")]
    Body {
        url: String,
        #[source]
        source: reqwest::Error,
    },
}
