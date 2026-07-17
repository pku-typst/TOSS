use crate::access::OidcProviderDefaults;
use crate::app_state::AppState;
use crate::collaboration::CollaborationContext;
use crate::deployment_config::DeploymentConfig;
use crate::distribution::{DistributionConfig, FrontendFeature};
use crate::document_processing::{spawn_processing_maintenance, DocumentProcessingContext};
use crate::external_repositories::spawn_external_git_workers;
use crate::object_cleanup::spawn_object_cleanup_worker;
use crate::object_storage::init_object_storage_from_env;
use crate::process_lifecycle::{self, DrainTrigger};
use crate::protocol_compatibility;
use axum::extract::DefaultBodyLimit;
use axum::http::header::{HeaderName, HeaderValue};
use axum::middleware;
use axum::routing::get_service;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use sha2::{Digest, Sha256};
use sqlx::postgres::PgPoolOptions;
use std::env;
use std::future::IntoFuture;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::task::JoinHandle;
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;
use tracing::{info, warn};

mod ai_runtime;
mod routes;
mod runtime;
mod web_build_manifest;

use runtime::run_migrations;
pub(crate) use runtime::HealthResponse;
use web_build_manifest::WebBuildManifest;

const APP_BOOT_SCRIPT_OPEN: &str = "<script>";
const APP_BOOT_SCRIPT_CLOSE: &str = "</script>";
const DEFAULT_DRAIN_TIMEOUT_SECONDS: u64 = 30;
const MAX_DRAIN_TIMEOUT_SECONDS: u64 = 300;

struct ContextTask {
    owner: &'static str,
    handle: JoinHandle<()>,
}

impl ContextTask {
    fn new(owner: &'static str, handle: JoinHandle<()>) -> Self {
        Self { owner, handle }
    }
}

async fn wait_for_context_tasks(tasks: &mut [ContextTask]) {
    for task in tasks {
        if let Err(join_error) = (&mut task.handle).await {
            if !join_error.is_cancelled() {
                warn!(owner = task.owner, %join_error, "context background task failed while draining");
            }
        }
    }
}

fn active_context_owners(tasks: &[ContextTask]) -> Vec<&'static str> {
    let mut owners = tasks
        .iter()
        .filter(|task| !task.handle.is_finished())
        .map(|task| task.owner)
        .collect::<Vec<_>>();
    owners.sort_unstable();
    owners.dedup();
    owners
}

fn parse_drain_timeout(raw: Option<&str>) -> Result<Duration, String> {
    let seconds = match raw {
        Some(raw) => raw
            .trim()
            .parse::<u64>()
            .map_err(|_| "CORE_DRAIN_TIMEOUT_SECONDS must be an integer".to_string())?,
        None => DEFAULT_DRAIN_TIMEOUT_SECONDS,
    };
    if !(1..=MAX_DRAIN_TIMEOUT_SECONDS).contains(&seconds) {
        return Err(format!(
            "CORE_DRAIN_TIMEOUT_SECONDS must be between 1 and {MAX_DRAIN_TIMEOUT_SECONDS}"
        ));
    }
    Ok(Duration::from_secs(seconds))
}

fn drain_timeout_from_env() -> Result<Duration, std::io::Error> {
    let raw = match env::var("CORE_DRAIN_TIMEOUT_SECONDS") {
        Ok(value) => Some(value),
        Err(env::VarError::NotPresent) => None,
        Err(env::VarError::NotUnicode(_)) => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "CORE_DRAIN_TIMEOUT_SECONDS must be valid Unicode",
            ))
        }
    };
    parse_drain_timeout(raw.as_deref())
        .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidInput, message))
}

#[cfg(unix)]
async fn wait_for_shutdown_signal() -> Result<&'static str, std::io::Error> {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! {
        result = tokio::signal::ctrl_c() => {
            result?;
            Ok("interrupt")
        }
        signal = terminate.recv() => {
            signal.ok_or_else(|| std::io::Error::other("termination signal stream closed"))?;
            Ok("terminate")
        }
    }
}

#[cfg(not(unix))]
async fn wait_for_shutdown_signal() -> Result<&'static str, std::io::Error> {
    tokio::signal::ctrl_c().await?;
    Ok("interrupt")
}

fn escape_html(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

fn replace_index_marker(html: String, marker: &str, replacement: &str) -> Result<String, String> {
    if !html.contains(marker) {
        return Err(format!("web index is missing required marker: {marker}"));
    }
    Ok(html.replacen(marker, replacement, 1))
}

fn application_content_security_policy(index_html: &str) -> Result<String, String> {
    let (_, after_open) = index_html
        .split_once(APP_BOOT_SCRIPT_OPEN)
        .ok_or("web index is missing its inline boot script")?;
    let (boot_script, after_close) = after_open
        .split_once(APP_BOOT_SCRIPT_CLOSE)
        .ok_or("web index has an unterminated inline boot script")?;
    if after_close.contains(APP_BOOT_SCRIPT_OPEN) {
        return Err("web index contains more than one inline script".to_string());
    }
    let boot_script_hash = STANDARD.encode(Sha256::digest(boot_script.as_bytes()));
    Ok(format!(
        "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self' data:; frame-ancestors 'self'; frame-src 'self'; img-src 'self' data: blob:; object-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'sha256-{boot_script_hash}'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; form-action 'self'"
    ))
}

fn render_spa_index(
    static_dir: &str,
    data_dir: &std::path::Path,
    distribution: &DistributionConfig,
) -> Result<(Arc<[u8]>, PathBuf, String), String> {
    let source_path = PathBuf::from(static_dir).join("index.html");
    let mut html = std::fs::read_to_string(&source_path).map_err(|error| {
        format!(
            "failed to read web index template {}: {error}",
            source_path.display()
        )
    })?;
    html = replace_index_marker(
        html,
        "<title>Typst Collaboration</title>",
        &format!("<title>{}</title>", escape_html(&distribution.product.name)),
    )?;
    html = replace_index_marker(
        html,
        "<meta name=\"description\" content=\"A self-hostable collaborative workspace for Typst documents and presentations.\" />",
        &format!(
            "<meta name=\"description\" content=\"{}\" />",
            escape_html(&distribution.product.description.en)
        ),
    )?;
    html = replace_index_marker(
        html,
        "<meta name=\"theme-color\" content=\"#2563eb\" />",
        &format!(
            "<meta name=\"theme-color\" content=\"{}\" />",
            distribution.product.accent_color
        ),
    )?;
    html = replace_index_marker(
        html,
        "<meta name=\"robots\" content=\"index,follow\" />",
        if distribution.product.indexing {
            "<meta name=\"robots\" content=\"index,follow\" />"
        } else {
            "<meta name=\"robots\" content=\"noindex,nofollow\" />"
        },
    )?;
    html = replace_index_marker(
        html,
        ":root { --app-boot-accent: #2563eb; --app-boot-contrast: #ffffff; }",
        &format!(
            ":root {{ --app-boot-accent: {}; --app-boot-contrast: {}; }}",
            distribution.product.accent_color, distribution.product.accent_text_color
        ),
    )?;
    let touch_icon = distribution
        .product
        .touch_icon
        .as_ref()
        .map(|_| "<link rel=\"apple-touch-icon\" href=\"/v1/product-assets/touch-icon\" />")
        .unwrap_or("");
    html = replace_index_marker(html, "<!-- TOSS_TOUCH_ICON -->", touch_icon)?;
    let content_security_policy = application_content_security_policy(&html)?;

    let runtime_dir = data_dir.join("runtime");
    std::fs::create_dir_all(&runtime_dir).map_err(|error| {
        format!(
            "failed to create runtime web directory {}: {error}",
            runtime_dir.display()
        )
    })?;
    let rendered_path = runtime_dir.join("index.html");
    std::fs::write(&rendered_path, html.as_bytes()).map_err(|error| {
        format!(
            "failed to write branded web index {}: {error}",
            rendered_path.display()
        )
    })?;
    Ok((
        Arc::from(html.into_bytes().into_boxed_slice()),
        rendered_path,
        content_security_policy,
    ))
}

pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "core_api=info,tower_http=info".into()),
        )
        .init();
    let drain_trigger = DrainTrigger::new();
    let drain_timeout = drain_timeout_from_env()?;

    let distribution = Arc::new(
        DistributionConfig::load_from_env()
            .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidInput, message))?,
    );
    info!(
        "distribution {} loaded from {}",
        distribution.id,
        distribution.source_label()
    );
    let deployment = DeploymentConfig::load_from_env(&distribution)
        .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidInput, message))?;
    info!("deployment loaded from {}", deployment.source_label());
    let enabled_frontend_features = deployment.frontend_features.clone();
    let enabled_ai_assistant = deployment.ai_assistant.clone();
    let static_dir = env::var("WEB_STATIC_DIR").unwrap_or_else(|_| "./web-dist".to_string());
    let web_build_manifest = WebBuildManifest::load(std::path::Path::new(&static_dir))?;
    web_build_manifest.validate_runtime(&distribution, &enabled_frontend_features)?;
    let runtime_policy = enabled_ai_assistant
        .as_ref()
        .or(distribution.ai_assistant.as_ref());
    let built_ai_runtime = web_build_manifest
        .ai_runtime()
        .map(|manifest| {
            let policy = runtime_policy.ok_or_else(|| {
                "web build contains an AI Runtime but the distribution has no AI policy".to_string()
            })?;
            ai_runtime::AiRuntimeAssets::load(std::path::Path::new(&static_dir), manifest, policy)
        })
        .transpose()?;
    let ai_runtime_assets = if enabled_frontend_features.contains(&FrontendFeature::AiAssistant) {
        Some(built_ai_runtime.ok_or_else(|| {
            "deployment enables ai_assistant but the web build has no AI Runtime artifact"
                .to_string()
        })?)
    } else {
        None
    };

    let database_url = env::var("DATABASE_URL")?;
    let db = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await?;

    run_migrations(&db).await?;

    let identity_provider_id = env::var("IDENTITY_PROVIDER_ID")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "oidc".to_string());
    if !identity_provider_id.chars().all(|character| {
        character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
    }) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "IDENTITY_PROVIDER_ID must contain only lowercase letters, digits, and hyphens",
        )
        .into());
    }
    let identity_provider_display_name = env::var("IDENTITY_PROVIDER_DISPLAY_NAME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            if identity_provider_id == "gitlab" {
                "GitLab".to_string()
            } else {
                "OpenID Connect".to_string()
            }
        });
    let oidc_defaults = OidcProviderDefaults {
        provider_id: identity_provider_id,
        provider_display_name: identity_provider_display_name,
        issuer: env::var("OIDC_ISSUER").unwrap_or_else(|_| "".to_string()),
        client_id: env::var("OIDC_CLIENT_ID").unwrap_or_else(|_| "".to_string()),
        client_secret: env::var("OIDC_CLIENT_SECRET").unwrap_or_else(|_| "".to_string()),
        redirect_uri: env::var("OIDC_REDIRECT_URI").unwrap_or_else(|_| "".to_string()),
        groups_claim: env::var("OIDC_GROUPS_CLAIM").unwrap_or_else(|_| "groups".to_string()),
    };
    let external_git_providers = deployment.external_git_providers;
    info!(
        count = external_git_providers.len(),
        "external Git provider registry loaded"
    );
    for provider in external_git_providers.iter() {
        info!(
            "external Git provider {} enabled for {}",
            provider.instance_id(),
            provider.base_url()
        );
    }

    let storage = init_object_storage_from_env().await;
    let data_dir = env::var("DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("./tmp/data"));
    let git_storage_dir = crate::versioning::storage_root();
    let typst_builtin_dir = env::var("TYPST_BUILTIN_DIR")
        .ok()
        .map(PathBuf::from)
        .or_else(|| distribution.typst_builtin_dir.clone())
        .unwrap_or_else(|| {
            let local = PathBuf::from("../builtin/typst");
            if local.exists() {
                local
            } else {
                PathBuf::from("./builtin/typst")
            }
        });
    std::fs::create_dir_all(&data_dir)?;
    std::fs::create_dir_all(&git_storage_dir)?;
    std::fs::create_dir_all(data_dir.join("thumbnails"))?;
    let (spa_index_html, branded_index_path, application_csp) =
        render_spa_index(&static_dir, &data_dir, &distribution)
            .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidData, message))?;
    let application_csp = HeaderValue::try_from(application_csp).map_err(|error| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("application Content-Security-Policy is invalid: {error}"),
        )
    })?;
    let max_request_body_bytes = env::var("MAX_REQUEST_BODY_BYTES")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v >= 1024 * 1024)
        .unwrap_or(64 * 1024 * 1024);
    let drain = drain_trigger.signal();
    let collaboration = CollaborationContext::new(db.clone(), drain.clone());
    let versioning = crate::versioning::VersioningContext::default();
    let processing = DocumentProcessingContext::new(db.clone(), deployment.processing);
    let state = AppState {
        db,
        oidc_defaults,
        external_git_providers,
        data_dir,
        git_storage_dir,
        typst_builtin_dir,
        storage,
        distribution,
        frontend_features: Arc::new(enabled_frontend_features),
        ai_assistant: Arc::new(enabled_ai_assistant),
        spa_index_html,
        collaboration,
        versioning,
        processing,
        drain: drain.clone(),
    };
    let port = env::var("CORE_API_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(8080);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!("core-api listening on {}", addr);
    info!("max request body bytes: {}", max_request_body_bytes);
    info!(
        drain_timeout_seconds = drain_timeout.as_secs(),
        "process drain timeout configured"
    );

    let mut context_tasks = vec![ContextTask::new(
        "versioning",
        crate::versioning::spawn_git_flush_worker(
            state.db.clone(),
            state.storage.clone(),
            state.distribution.clone(),
            state.versioning.clone(),
            drain.clone(),
        ),
    )];
    if let Some(task) =
        spawn_object_cleanup_worker(state.db.clone(), state.storage.clone(), drain.clone())
    {
        context_tasks.push(ContextTask::new("object_cleanup", task));
    }
    context_tasks.push(ContextTask::new(
        "document_processing",
        spawn_processing_maintenance(state.processing.clone(), drain.clone()),
    ));
    context_tasks.push(ContextTask::new(
        "collaboration",
        crate::collaboration::spawn_collaboration_projection_worker(state.collaboration.clone()),
    ));
    context_tasks.extend(
        spawn_external_git_workers(
            state.db.clone(),
            state.external_git_providers.clone(),
            state.storage.clone(),
            state.distribution.clone(),
            state.collaboration.clone(),
            state.versioning.clone(),
            state.drain.clone(),
        )
        .into_iter()
        .map(|task| ContextTask::new("external_repositories", task)),
    );
    let static_service = get_service(
        ServeDir::new(&static_dir)
            .precompressed_gzip()
            .append_index_html_on_directories(true)
            .fallback(ServeFile::new(branded_index_path)),
    );
    let app = routes::build_router()
        .layer(middleware::from_fn(
            protocol_compatibility::protocol_epoch_fence,
        ))
        .merge(ai_runtime::router(ai_runtime_assets))
        .layer(DefaultBodyLimit::max(max_request_body_bytes))
        .fallback_service(static_service)
        .layer(middleware::from_fn_with_state(
            drain.clone(),
            process_lifecycle::admission_fence,
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("permissions-policy"),
            HeaderValue::from_static(
                "camera=(), microphone=(), geolocation=(), display-capture=()",
            ),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("x-content-type-options"),
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("referrer-policy"),
            HeaderValue::from_static("strict-origin-when-cross-origin"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("content-security-policy"),
            application_csp,
        ))
        .layer(PropagateRequestIdLayer::x_request_id())
        .layer(TraceLayer::new_for_http())
        .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
        .with_state(state.clone());

    let (stop_accepting, accept_shutdown) = tokio::sync::oneshot::channel::<()>();
    let server = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = accept_shutdown.await;
        })
        .into_future();
    tokio::pin!(server);
    let (shutdown_reason, mut completed_server_result, shutdown_signal_error) = tokio::select! {
        result = &mut server => ("server stopped", Some(result), None),
        signal = wait_for_shutdown_signal() => match signal {
            Ok(reason) => (reason, None, None),
            Err(error) => ("shutdown signal unavailable", None, Some(error)),
        },
    };
    let drain_started = tokio::time::Instant::now();
    let drain_deadline = drain_started + drain_timeout;
    drain_trigger.trigger();
    let _ = stop_accepting.send(());
    info!(reason = shutdown_reason, "process entered draining state");

    let drain_result = tokio::time::timeout_at(drain_deadline, async {
        let server_and_realtime = async {
            let server_result = match completed_server_result.take() {
                Some(result) => result,
                None => (&mut server).await,
            };
            state.collaboration.wait_for_connection_quiescence().await;
            server_result
        };
        let ((), server_result) = tokio::join!(
            wait_for_context_tasks(&mut context_tasks),
            server_and_realtime,
        );
        server_result
    })
    .await;
    let drain_elapsed = drain_started.elapsed();
    if let Ok(server_result) = drain_result {
        info!(
            drain_duration_ms = drain_elapsed.as_millis(),
            "process drain completed"
        );
        server_result?;
        if let Some(error) = shutdown_signal_error {
            return Err(error.into());
        }
        return Ok(());
    }

    let active_owners = active_context_owners(&context_tasks);
    for task in &context_tasks {
        if !task.handle.is_finished() {
            task.handle.abort();
        }
    }
    warn!(
        drain_duration_ms = drain_elapsed.as_millis(),
        ?active_owners,
        "process drain deadline exhausted; cancelled remaining background work"
    );
    Err(std::io::Error::new(
        std::io::ErrorKind::TimedOut,
        "process drain deadline exhausted",
    )
    .into())
}

#[cfg(test)]
mod tests {
    use super::{application_content_security_policy, parse_drain_timeout};

    #[test]
    fn application_csp_hashes_the_only_inline_boot_script() -> Result<(), String> {
        let first = application_content_security_policy(
            "<html><script>window.boot = 'first';</script><script type=\"module\" src=\"/app.js\"></script></html>",
        )?;
        let second = application_content_security_policy(
            "<html><script>window.boot = 'second';</script><script type=\"module\" src=\"/app.js\"></script></html>",
        )?;

        assert!(first.contains("script-src 'self' 'wasm-unsafe-eval' 'sha256-"));
        assert_ne!(first, second);
        assert!(application_content_security_policy("<html></html>").is_err());
        Ok(())
    }

    #[test]
    fn drain_timeout_is_bounded_and_strict() {
        assert_eq!(
            parse_drain_timeout(None).map(|duration| duration.as_secs()),
            Ok(30)
        );
        assert_eq!(
            parse_drain_timeout(Some("45")).map(|duration| duration.as_secs()),
            Ok(45)
        );
        assert!(parse_drain_timeout(Some("0")).is_err());
        assert!(parse_drain_timeout(Some("301")).is_err());
        assert!(parse_drain_timeout(Some("soon")).is_err());
    }
}
