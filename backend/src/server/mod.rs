use crate::access::OidcProviderDefaults;
use crate::app_state::AppState;
use crate::collaboration::CollaborationContext;
use crate::distribution::DistributionConfig;
use crate::document_processing::{
    spawn_processing_maintenance, DocumentProcessingContext, ProcessingConfig,
};
use crate::external_repositories::{
    external_git_provider_registry_from_env, spawn_external_git_checkpoint_worker,
    spawn_external_git_inbound_worker,
};
use crate::object_cleanup::spawn_object_cleanup_worker;
use crate::object_storage::init_object_storage_from_env;
use axum::extract::DefaultBodyLimit;
use axum::routing::get_service;
use sqlx::postgres::PgPoolOptions;
use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing::info;

mod routes;
mod runtime;

use runtime::run_migrations;
pub(crate) use runtime::HealthResponse;

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

fn render_spa_index(
    static_dir: &str,
    data_dir: &std::path::Path,
    distribution: &DistributionConfig,
) -> Result<(Arc<[u8]>, PathBuf), String> {
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

    let distribution = Arc::new(
        DistributionConfig::load_from_env()
            .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidInput, message))?,
    );
    info!(
        "distribution {} loaded from {}",
        distribution.id,
        distribution.source_label()
    );

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
    let external_git_providers = external_git_provider_registry_from_env()
        .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidInput, message))?;
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
    std::fs::create_dir_all(data_dir.join("git"))?;
    std::fs::create_dir_all(data_dir.join("thumbnails"))?;
    let static_dir = env::var("WEB_STATIC_DIR").unwrap_or_else(|_| "./web-dist".to_string());
    let (spa_index_html, branded_index_path) =
        render_spa_index(&static_dir, &data_dir, &distribution)
            .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidData, message))?;
    let max_request_body_bytes = env::var("MAX_REQUEST_BODY_BYTES")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v >= 1024 * 1024)
        .unwrap_or(64 * 1024 * 1024);
    let collaboration = CollaborationContext::new(db.clone());
    let processing_config = ProcessingConfig::from_env()
        .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidInput, message))?;
    let processing = DocumentProcessingContext::new(db.clone(), processing_config);
    let state = AppState {
        db,
        oidc_defaults,
        external_git_providers,
        data_dir,
        typst_builtin_dir,
        storage,
        distribution,
        spa_index_html,
        collaboration,
        versioning: crate::versioning::VersioningContext::default(),
        processing,
    };
    crate::versioning::spawn_git_flush_worker(
        state.db.clone(),
        state.storage.clone(),
        state.distribution.clone(),
        state.versioning.clone(),
    );
    spawn_object_cleanup_worker(state.db.clone(), state.storage.clone());
    spawn_processing_maintenance(state.processing.clone());
    crate::collaboration::spawn_collaboration_projection_worker(state.collaboration.clone());
    spawn_external_git_checkpoint_worker(state.clone());
    spawn_external_git_inbound_worker(state.clone());
    let static_service = get_service(
        ServeDir::new(&static_dir)
            .precompressed_gzip()
            .append_index_html_on_directories(true)
            .fallback(ServeFile::new(branded_index_path)),
    );
    let app = routes::build_router()
        .layer(DefaultBodyLimit::max(max_request_body_bytes))
        .fallback_service(static_service)
        .layer(PropagateRequestIdLayer::x_request_id())
        .layer(TraceLayer::new_for_http())
        .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
        .with_state(state);

    let port = env::var("CORE_API_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(8080);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("core-api listening on {}", addr);
    info!("max request body bytes: {}", max_request_body_bytes);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
