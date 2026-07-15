//! Public and administrative HTTP transport for authentication settings.

use super::auth_settings::{
    apply_distribution_settings, default_auth_settings, distribution_managed_fields,
    effective_auth_settings, prepare_auth_settings_update, update_auth_settings,
    UpdateAuthSettingsCommand,
};
use super::oidc_protocol::{validate_provider_discovery, OidcProtocolError};
use super::{ensure_site_admin, AnonymousMode, AuthSettings};
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::distribution::FrontendFeature;
use crate::external_repositories::{
    ExternalGitProviderCapabilities, ProviderBrand, ProviderInstanceId, ProviderKind,
};
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use crate::workspace::ProjectType;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};

#[derive(Serialize, utoipa::ToSchema)]
pub(crate) struct AdminAuthSettingsResponse {
    pub settings: AuthSettings,
    pub managed_fields: Vec<String>,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub(crate) struct UpsertAdminAuthSettingsInput {
    pub allow_local_login: bool,
    pub allow_local_registration: bool,
    pub allow_oidc: bool,
    pub anonymous_mode: Option<AnonymousMode>,
    pub site_name: Option<String>,
    pub announcement: Option<String>,
    pub oidc_discovery_url: Option<String>,
    pub oidc_client_id: Option<String>,
    pub oidc_client_secret: Option<String>,
    pub oidc_redirect_uri: Option<String>,
    pub oidc_groups_claim: Option<String>,
}

#[derive(Serialize, utoipa::ToSchema)]
pub(crate) struct AuthConfigResponse {
    pub allow_local_login: bool,
    pub allow_local_registration: bool,
    pub allow_oidc: bool,
    pub identity_providers: Vec<IdentityProviderResponse>,
    pub external_git_providers: Vec<ExternalGitProviderResponse>,
    pub anonymous_mode: AnonymousMode,
    pub site_name: String,
    pub announcement: String,
    #[schema(required)]
    pub issuer: Option<String>,
    #[schema(required)]
    pub client_id: Option<String>,
    #[schema(required)]
    pub redirect_uri: Option<String>,
    pub groups_claim: String,
    pub distribution_id: String,
    pub enabled_project_types: Vec<ProjectType>,
    pub enabled_frontend_features: Vec<FrontendFeature>,
    pub brand_mark: String,
    pub accent_color: String,
    pub accent_text_color: String,
    pub site_name_managed: bool,
}

#[derive(Serialize, utoipa::ToSchema)]
pub(crate) struct IdentityProviderResponse {
    pub id: String,
    pub display_name: String,
    pub brand: ProviderBrand,
    #[schema(required)]
    pub kind: Option<ProviderKind>,
    pub protocol: &'static str,
    pub login_path: String,
}

#[derive(Serialize, utoipa::ToSchema)]
pub(crate) struct ExternalGitProviderResponse {
    pub id: ProviderInstanceId,
    pub display_name: String,
    pub brand: ProviderBrand,
    pub kind: ProviderKind,
    pub base_url: String,
    #[schema(required)]
    pub authorization_path: Option<String>,
    pub capabilities: ExternalGitProviderCapabilities,
}

pub(crate) async fn auth_config(State(state): State<AppState>) -> Json<AuthConfigResponse> {
    let settings = effective_auth_settings(&state.db, &state.oidc_defaults)
        .await
        .unwrap_or_else(|database_error| {
            tracing::error!(%database_error, "authentication settings lookup failed");
            default_auth_settings(&state.oidc_defaults)
        });
    let settings = apply_distribution_settings(&state.distribution, settings);
    let mut identity_providers = Vec::new();
    if settings.allow_oidc {
        identity_providers.push(IdentityProviderResponse {
            id: state.oidc_defaults.provider_id.clone(),
            display_name: state.oidc_defaults.provider_display_name.clone(),
            brand: ProviderBrand::Identity,
            kind: None,
            protocol: "oidc",
            login_path: "/v1/auth/oidc/login".to_string(),
        });
    }
    identity_providers.extend(state.external_git_providers.iter().filter_map(|provider| {
        provider.login().map(|login| IdentityProviderResponse {
            id: format!("external-git:{}", provider.instance_id()),
            display_name: provider.display_name().to_string(),
            brand: provider.brand(),
            kind: Some(provider.kind()),
            protocol: login.protocol,
            login_path: login.path,
        })
    }));
    let external_git_providers = state
        .external_git_providers
        .iter()
        .map(|provider| ExternalGitProviderResponse {
            id: provider.instance_id().clone(),
            display_name: provider.display_name().to_string(),
            brand: provider.brand(),
            kind: provider.kind(),
            base_url: provider.base_url().to_string(),
            authorization_path: provider.authorization_path(),
            capabilities: provider.capabilities(),
        })
        .collect();
    Json(AuthConfigResponse {
        allow_local_login: settings.allow_local_login,
        allow_local_registration: settings.allow_local_registration,
        allow_oidc: settings.allow_oidc,
        identity_providers,
        external_git_providers,
        anonymous_mode: settings.anonymous_mode,
        site_name: settings.site_name,
        announcement: settings.announcement,
        issuer: settings.oidc_issuer,
        client_id: settings.oidc_client_id,
        redirect_uri: settings.oidc_redirect_uri,
        groups_claim: settings.oidc_groups_claim,
        distribution_id: state.distribution.id.clone(),
        enabled_project_types: state.distribution.project_types.clone(),
        enabled_frontend_features: state.frontend_features.as_ref().clone(),
        brand_mark: state.distribution.product.brand_mark.clone(),
        accent_color: state.distribution.product.accent_color.clone(),
        accent_text_color: state.distribution.product.accent_text_color.clone(),
        site_name_managed: state.distribution.product.name_managed,
    })
}

pub(crate) async fn get_admin_auth_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AdminAuthSettingsResponse>, ApiError> {
    ensure_site_admin(&state.db, &headers).await?;
    admin_auth_settings_response(&state).await.map(Json)
}

pub(crate) async fn upsert_admin_auth_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<UpsertAdminAuthSettingsInput>,
) -> Result<Json<AdminAuthSettingsResponse>, ApiError> {
    let actor = ensure_site_admin(&state.db, &headers).await?;
    let command = prepare_auth_settings_update(
        &state.distribution,
        UpdateAuthSettingsCommand {
            allow_local_login: input.allow_local_login,
            allow_local_registration: input.allow_local_registration,
            allow_oidc: input.allow_oidc,
            anonymous_mode: input.anonymous_mode,
            site_name: input.site_name,
            announcement: input.announcement,
            oidc_issuer: input.oidc_discovery_url,
            oidc_client_id: input.oidc_client_id,
            oidc_client_secret: input.oidc_client_secret,
            oidc_redirect_uri: input.oidc_redirect_uri,
            oidc_groups_claim: input.oidc_groups_claim,
        },
    );
    validate_oidc_settings(command.allow_oidc, command.oidc_issuer.as_deref()).await?;
    update_auth_settings(&state.db, &command)
        .await
        .map_err(|failure| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::AuthServiceUnavailable,
                "Authentication settings are unavailable",
            )
            .with_diagnostic("authentication settings update failed", failure)
        })?;
    record_event(
        &state.db,
        Some(actor),
        "admin.auth_settings.upsert",
        serde_json::json!({
            "allow_local_login": command.allow_local_login,
            "allow_local_registration": command.allow_local_registration,
            "allow_oidc": command.allow_oidc,
            "anonymous_mode": command.anonymous_mode,
            "site_name": command.site_name,
            "announcement": command.announcement
        }),
    )
    .await;
    admin_auth_settings_response(&state).await.map(Json)
}

async fn admin_auth_settings_response(
    state: &AppState,
) -> Result<AdminAuthSettingsResponse, ApiError> {
    let settings = effective_auth_settings(&state.db, &state.oidc_defaults)
        .await
        .map_err(|database_error| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::AuthServiceUnavailable,
                "Authentication settings are unavailable",
            )
            .with_diagnostic("authentication settings lookup failed", database_error)
        })?;
    Ok(AdminAuthSettingsResponse {
        settings: apply_distribution_settings(&state.distribution, settings),
        managed_fields: distribution_managed_fields(&state.distribution),
    })
}

async fn validate_oidc_settings(
    allow_oidc: bool,
    discovery_url: Option<&str>,
) -> Result<(), ApiError> {
    if !allow_oidc {
        return Ok(());
    }
    let discovery_url = discovery_url.ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::BadRequest,
            "OIDC discovery URL is required",
        )
    })?;
    validate_provider_discovery(discovery_url).await.map_err(
        |protocol_error| match protocol_error {
            OidcProtocolError::InvalidIssuer { .. } => ApiError::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::BadRequest,
                "OIDC discovery URL is invalid",
            ),
            failure => ApiError::new(
                StatusCode::BAD_GATEWAY,
                ApiErrorCode::BadGateway,
                "OIDC provider validation failed",
            )
            .with_warning("OIDC provider validation failed", failure),
        },
    )
}
