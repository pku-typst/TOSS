use super::{
    load_dynamic_package, package_cache_config, read_cached_package, read_catalog_package,
    sanitize_builtin_asset_path, universe_config, CatalogPackageError, FetchPackageError,
    LoadDynamicPackageError, PackagePayload, PackageSpec, PackageValidationError,
    UniverseConfigError,
};
use crate::access::required_request_user_id;
use crate::app_state::AppState;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
#[error("built-in Typst asset read failed at {path:?}")]
struct BuiltinAssetReadError {
    path: PathBuf,
    #[source]
    source: std::io::Error,
}

fn package_response(payload: PackagePayload) -> Response {
    let mut response = payload.bytes.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/gzip"),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    response.headers_mut().insert(
        header::HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    response.headers_mut().insert(
        header::HeaderName::from_static("x-typst-package-cache"),
        HeaderValue::from_static(payload.cache_status),
    );
    if let Ok(value) = HeaderValue::from_str(&payload.sha256) {
        response.headers_mut().insert(
            header::HeaderName::from_static("x-typst-package-sha256"),
            value,
        );
    }
    if let Ok(value) = HeaderValue::from_str(&format!("\"{}\"", payload.sha256)) {
        response.headers_mut().insert(header::ETAG, value);
    }
    response
}

fn universe_config_error_response(failure: UniverseConfigError) -> Response {
    let message = match &failure {
        UniverseConfigError::InvalidBaseUrl { .. } => "Typst Universe base URL is invalid",
        UniverseConfigError::UnsafeBaseUrl => {
            "Typst Universe base URL must be a credential-free HTTPS origin or path"
        }
    };
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        ApiErrorCode::InternalError,
        message,
    )
    .with_diagnostic("Typst Universe configuration is invalid", failure)
    .into_response()
}

fn catalog_package_error_response(failure: CatalogPackageError) -> Response {
    let (status, code, message) = match &failure {
        CatalogPackageError::ReadCatalog { .. } => (
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "Built-in Typst catalog is unavailable",
        ),
        CatalogPackageError::ParseCatalog { .. } => (
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "Built-in Typst catalog is invalid",
        ),
        CatalogPackageError::UnsupportedCatalogSchema { .. } => (
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "Built-in Typst catalog schema is unsupported",
        ),
        CatalogPackageError::InvalidArtifactPath { .. } => (
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "Typst package catalog artifact path is invalid",
        ),
        CatalogPackageError::ReadArtifact { .. } => (
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "Typst package catalog artifact is unavailable",
        ),
        CatalogPackageError::SizeMismatch { .. } => (
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "Typst package artifact size does not match its catalog",
        ),
        CatalogPackageError::Validation(PackageValidationError::ArchiveSize { .. }) => (
            StatusCode::PAYLOAD_TOO_LARGE,
            ApiErrorCode::PayloadTooLarge,
            "Typst package archive exceeds the configured limit",
        ),
        CatalogPackageError::Validation(PackageValidationError::InvalidArchive { .. }) => (
            StatusCode::BAD_GATEWAY,
            ApiErrorCode::BadGateway,
            "Typst package archive is invalid",
        ),
        CatalogPackageError::Validation(PackageValidationError::Worker { .. }) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "Typst package validation failed",
        ),
        CatalogPackageError::ChecksumMismatch => (
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "Typst package artifact checksum does not match its catalog",
        ),
    };
    ApiError::new(status, code, message)
        .with_diagnostic("catalog Typst package resolution failed", failure)
        .into_response()
}

fn dynamic_package_error_response(failure: LoadDynamicPackageError) -> Response {
    match failure {
        LoadDynamicPackageError::Fetch(FetchPackageError::NotFound) => ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::NotFound,
            "Typst package was not found",
        )
        .into_response(),
        failure @ (LoadDynamicPackageError::Fetch(FetchPackageError::ArchiveTooLarge {
            ..
        })
        | LoadDynamicPackageError::Validation(PackageValidationError::ArchiveSize {
            ..
        })) => ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            ApiErrorCode::PayloadTooLarge,
            "Typst package archive exceeds the configured limit",
        )
        .with_warning(
            "Typst package archive exceeded its configured limit",
            failure,
        )
        .into_response(),
        failure @ LoadDynamicPackageError::Fetch(FetchPackageError::InvalidUrl { .. }) => {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Typst package upstream URL is invalid",
            )
            .with_diagnostic("Typst package upstream URL construction failed", failure)
            .into_response()
        }
        failure @ LoadDynamicPackageError::Fetch(FetchPackageError::BuildClient(_)) => {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Typst package client is unavailable",
            )
            .with_diagnostic("Typst package HTTP client construction failed", failure)
            .into_response()
        }
        failure @ LoadDynamicPackageError::Fetch(FetchPackageError::Request { .. }) => {
            ApiError::new(
                StatusCode::BAD_GATEWAY,
                ApiErrorCode::BadGateway,
                "Typst package upstream is unavailable",
            )
            .with_warning("Typst package upstream request failed", failure)
            .into_response()
        }
        failure @ LoadDynamicPackageError::Fetch(FetchPackageError::UpstreamStatus { .. }) => {
            ApiError::new(
                StatusCode::BAD_GATEWAY,
                ApiErrorCode::BadGateway,
                "Typst package upstream returned an error",
            )
            .with_warning("Typst package upstream returned an error", failure)
            .into_response()
        }
        failure @ LoadDynamicPackageError::Fetch(FetchPackageError::ResponseBody { .. }) => {
            ApiError::new(
                StatusCode::BAD_GATEWAY,
                ApiErrorCode::BadGateway,
                "Typst package upstream response failed",
            )
            .with_warning("Typst package upstream response failed", failure)
            .into_response()
        }
        failure @ LoadDynamicPackageError::Validation(PackageValidationError::InvalidArchive {
            ..
        }) => ApiError::new(
            StatusCode::BAD_GATEWAY,
            ApiErrorCode::BadGateway,
            "Typst package archive is invalid",
        )
        .with_warning("Typst package archive validation failed", failure)
        .into_response(),
        failure @ LoadDynamicPackageError::Validation(PackageValidationError::Worker { .. }) => {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Typst package validation failed",
            )
            .with_diagnostic("Typst package validation worker failed", failure)
            .into_response()
        }
    }
}

pub(crate) async fn typst_builtin_asset(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(path): Path<String>,
) -> impl IntoResponse {
    if let Err(error) = required_request_user_id(&state.db, &headers).await {
        return ApiError::from(error).into_response();
    }
    let Some(asset_path) = sanitize_builtin_asset_path(&state.typst_builtin_dir, &path) else {
        return ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::BadRequest,
            "Invalid built-in Typst asset path",
        )
        .into_response();
    };
    let bytes = match tokio::fs::read(&asset_path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::NotFound,
                "Built-in Typst asset not found",
            )
            .into_response()
        }
        Err(error) => {
            let failure = BuiltinAssetReadError {
                path: asset_path,
                source: error,
            };
            return ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Built-in Typst asset read failed",
            )
            .with_diagnostic("built-in Typst asset read failed", failure)
            .into_response();
        }
    };
    let mut response = bytes.into_response();
    let content_type = mime_guess::from_path(&asset_path).first_or_octet_stream();
    let content_type = HeaderValue::from_str(content_type.essence_str())
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, content_type);
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if path == "catalog.json" {
            "private, no-cache"
        } else {
            "private, max-age=31536000, immutable"
        }),
    );
    response.headers_mut().insert(
        header::HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    response
}

pub(crate) async fn typst_package_proxy(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((namespace, name, version)): Path<(String, String, String)>,
) -> impl IntoResponse {
    if let Err(error) = required_request_user_id(&state.db, &headers).await {
        return ApiError::from(error).into_response();
    }
    let Some(spec) = PackageSpec::parse(namespace, name, version) else {
        return ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::BadRequest,
            "Invalid Typst package spec",
        )
        .into_response();
    };
    let package_cache = package_cache_config();
    match read_catalog_package(&state.typst_builtin_dir, &spec, package_cache.limits).await {
        Ok(Some(payload)) => return package_response(payload),
        Ok(None) => {}
        Err(error) => return catalog_package_error_response(error),
    }
    if spec.is_local() {
        return ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::NotFound,
            "Built-in Typst package was not found",
        )
        .into_response();
    }
    let config = match universe_config() {
        Ok(value) => value,
        Err(error) => return universe_config_error_response(error),
    };
    if let Some(payload) = read_cached_package(&config.cache, &spec).await {
        return package_response(payload);
    }
    if !config.enabled {
        return ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::NotFound,
            "Typst Universe packages are disabled",
        )
        .into_response();
    }

    match load_dynamic_package(&config, &spec).await {
        Ok(payload) => package_response(payload),
        Err(error) => dynamic_package_error_response(error),
    }
}
