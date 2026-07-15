use super::web_build_manifest::AiRuntimeBuildManifest;
use axum::body::Body;
use axum::extract::Extension;
use axum::http::header::{
    HeaderName, HeaderValue, ACCESS_CONTROL_ALLOW_ORIGIN, CACHE_CONTROL, CONTENT_TYPE,
};
use axum::http::{Response, StatusCode};
use axum::routing::{any, get, get_service};
use axum::Router;
use serde::Deserialize;
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;
use uuid::Uuid;

const NONCE_MARKER: &str = r#"data-toss-ai-nonce="__TOSS_AI_RUNTIME_NONCE__""#;
const CONTENT_SECURITY_POLICY: &str = "content-security-policy";
const CROSS_ORIGIN_RESOURCE_POLICY: &str = "cross-origin-resource-policy";
const REFERRER_POLICY: &str = "referrer-policy";
const X_CONTENT_TYPE_OPTIONS: &str = "x-content-type-options";
const X_DNS_PREFETCH_CONTROL: &str = "x-dns-prefetch-control";
const PERMISSIONS_POLICY: &str = "permissions-policy";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AiRuntimeBuildDescriptor {
    schema: u32,
    build_id: String,
}

#[derive(Clone)]
pub(super) struct AiRuntimeAssets {
    entry_template: Arc<str>,
    assets_dir: PathBuf,
}

impl AiRuntimeAssets {
    pub(super) fn load(
        static_dir: &Path,
        manifest: &AiRuntimeBuildManifest,
    ) -> Result<Self, String> {
        let entry_path = static_dir.join(&manifest.entry_path);
        let entry_template = std::fs::read_to_string(&entry_path).map_err(|error| {
            format!(
                "AI Runtime entry '{}' could not be read: {error}",
                entry_path.display()
            )
        })?;
        if entry_template.matches(NONCE_MARKER).count() != 1 {
            return Err(format!(
                "AI Runtime entry '{}' must contain exactly one nonce marker",
                entry_path.display()
            ));
        }
        let descriptor_path = static_dir.join("_ai-runtime/runtime-build.json");
        let descriptor: AiRuntimeBuildDescriptor =
            serde_json::from_slice(&std::fs::read(&descriptor_path).map_err(|error| {
                format!(
                    "AI Runtime build descriptor '{}' could not be read: {error}",
                    descriptor_path.display()
                )
            })?)
            .map_err(|error| {
                format!(
                    "AI Runtime build descriptor '{}' is invalid: {error}",
                    descriptor_path.display()
                )
            })?;
        if descriptor.schema != 1 || descriptor.build_id != manifest.build_id {
            return Err(format!(
                "AI Runtime build descriptor '{}' does not match the web build manifest",
                descriptor_path.display()
            ));
        }
        let assets_dir = static_dir.join("_ai-runtime/assets");
        if !assets_dir.is_dir() {
            return Err(format!(
                "AI Runtime asset directory '{}' is missing",
                assets_dir.display()
            ));
        }
        Ok(Self {
            entry_template: Arc::from(entry_template),
            assets_dir,
        })
    }
}

fn header_name(value: &'static str) -> HeaderName {
    HeaderName::from_static(value)
}

fn insert_header(
    response: &mut Response<Body>,
    name: HeaderName,
    value: &str,
) -> Result<(), StatusCode> {
    let value = HeaderValue::from_str(value).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    response.headers_mut().insert(name, value);
    Ok(())
}

async fn bootstrap(
    Extension(assets): Extension<AiRuntimeAssets>,
) -> Result<Response<Body>, StatusCode> {
    let nonce = Uuid::new_v4().simple().to_string();
    let nonce_attribute = format!(r#"nonce="{nonce}""#);
    let html = assets
        .entry_template
        .replacen(NONCE_MARKER, &nonce_attribute, 1);
    let csp = format!(
        "sandbox allow-scripts; default-src 'none'; script-src 'nonce-{nonce}' 'strict-dynamic'; connect-src https: http://localhost:* http://127.0.0.1:*; style-src 'nonce-{nonce}'; worker-src 'none'; img-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
    );
    let mut response = Response::new(Body::from(html));
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    insert_header(&mut response, header_name(CONTENT_SECURITY_POLICY), &csp)?;
    insert_header(&mut response, header_name(REFERRER_POLICY), "no-referrer")?;
    insert_header(
        &mut response,
        header_name(X_CONTENT_TYPE_OPTIONS),
        "nosniff",
    )?;
    insert_header(&mut response, header_name(X_DNS_PREFETCH_CONTROL), "off")?;
    insert_header(
        &mut response,
        header_name(PERMISSIONS_POLICY),
        "camera=(), microphone=(), geolocation=(), display-capture=()",
    )?;
    Ok(response)
}

async fn not_found() -> StatusCode {
    StatusCode::NOT_FOUND
}

pub(super) fn router<S>(assets: Option<AiRuntimeAssets>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    let router = Router::new()
        .route("/_ai-runtime", any(not_found))
        .route("/_ai-runtime/{*path}", any(not_found));
    let Some(assets) = assets else {
        return router;
    };

    let asset_service = get_service(
        ServeDir::new(&assets.assets_dir)
            .precompressed_gzip()
            .append_index_html_on_directories(false),
    )
    .layer::<_, Infallible>(SetResponseHeaderLayer::overriding(
        ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    ))
    .layer::<_, Infallible>(SetResponseHeaderLayer::overriding(
        header_name(CROSS_ORIGIN_RESOURCE_POLICY),
        HeaderValue::from_static("cross-origin"),
    ))
    .layer::<_, Infallible>(SetResponseHeaderLayer::overriding(
        CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    ));

    router
        .route(
            "/_ai-runtime/bootstrap.html",
            get(bootstrap).layer(Extension(assets)),
        )
        .nest_service("/_ai-runtime/assets", asset_service)
}

#[cfg(test)]
mod tests {
    use super::{router, AiRuntimeAssets, NONCE_MARKER};
    use crate::server::web_build_manifest::AiRuntimeBuildManifest;
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    fn runtime_fixture() -> Result<(tempfile::TempDir, AiRuntimeAssets), String> {
        let directory = tempfile::tempdir().map_err(|error| error.to_string())?;
        let runtime_dir = directory.path().join("_ai-runtime");
        let assets_dir = runtime_dir.join("assets");
        std::fs::create_dir_all(&assets_dir).map_err(|error| error.to_string())?;
        std::fs::write(
            runtime_dir.join("bootstrap.html"),
            format!(r#"<script {NONCE_MARKER} src="asset.js"></script>"#),
        )
        .map_err(|error| error.to_string())?;
        std::fs::write(assets_dir.join("asset.js"), "export {};")
            .map_err(|error| error.to_string())?;
        std::fs::write(
            runtime_dir.join("runtime-build.json"),
            r#"{"schema":1,"build_id":"ai-runtime-v1-0123456789abcdef"}"#,
        )
        .map_err(|error| error.to_string())?;
        let manifest = AiRuntimeBuildManifest {
            build_id: "ai-runtime-v1-0123456789abcdef".to_string(),
            entry_path: "_ai-runtime/bootstrap.html".to_string(),
        };
        let assets = AiRuntimeAssets::load(directory.path(), &manifest)?;
        Ok((directory, assets))
    }

    #[tokio::test]
    async fn disabled_runtime_routes_do_not_fall_through() -> Result<(), String> {
        let response = router::<()>(None)
            .oneshot(
                Request::builder()
                    .uri("/_ai-runtime/bootstrap.html")
                    .body(Body::empty())
                    .map_err(|error| error.to_string())?,
            )
            .await
            .map_err(|error| error.to_string())?;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        Ok(())
    }

    #[tokio::test]
    async fn runtime_entry_receives_a_nonce_and_isolation_headers() -> Result<(), String> {
        let (_directory, assets) = runtime_fixture()?;
        let response = router::<()>(Some(assets))
            .oneshot(
                Request::builder()
                    .uri("/_ai-runtime/bootstrap.html")
                    .body(Body::empty())
                    .map_err(|error| error.to_string())?,
            )
            .await
            .map_err(|error| error.to_string())?;
        assert_eq!(response.status(), StatusCode::OK);
        let csp = response
            .headers()
            .get("content-security-policy")
            .and_then(|value| value.to_str().ok())
            .ok_or("missing Content-Security-Policy")?;
        assert!(csp.contains("sandbox allow-scripts"));
        assert!(csp.contains("'strict-dynamic'"));
        assert_eq!(
            response
                .headers()
                .get("cache-control")
                .and_then(|value| value.to_str().ok()),
            Some("no-store")
        );
        let body = to_bytes(response.into_body(), 16 * 1024)
            .await
            .map_err(|error| error.to_string())?;
        let body = String::from_utf8(body.to_vec()).map_err(|error| error.to_string())?;
        assert!(!body.contains(NONCE_MARKER));
        assert!(body.contains("nonce=\""));
        Ok(())
    }

    #[tokio::test]
    async fn runtime_modules_are_public_immutable_cors_assets() -> Result<(), String> {
        let (_directory, assets) = runtime_fixture()?;
        let response = router::<()>(Some(assets))
            .oneshot(
                Request::builder()
                    .uri("/_ai-runtime/assets/asset.js")
                    .body(Body::empty())
                    .map_err(|error| error.to_string())?,
            )
            .await
            .map_err(|error| error.to_string())?;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-origin")
                .and_then(|value| value.to_str().ok()),
            Some("*")
        );
        assert_eq!(
            response
                .headers()
                .get("cross-origin-resource-policy")
                .and_then(|value| value.to_str().ok()),
            Some("cross-origin")
        );
        assert_eq!(
            response
                .headers()
                .get("cache-control")
                .and_then(|value| value.to_str().ok()),
            Some("public, max-age=31536000, immutable")
        );
        Ok(())
    }
}
