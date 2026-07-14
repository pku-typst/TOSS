use super::auth_settings_model::{AnonymousMode, AuthSettings, OidcProviderDefaults};
use super::auth_settings_persistence;
use crate::distribution::DistributionConfig;
use chrono::Utc;
use sqlx::PgPool;
use std::env;
use thiserror::Error;

pub(crate) struct UpdateAuthSettingsCommand {
    pub allow_local_login: bool,
    pub allow_local_registration: bool,
    pub allow_oidc: bool,
    pub anonymous_mode: Option<AnonymousMode>,
    pub site_name: Option<String>,
    pub announcement: Option<String>,
    pub oidc_issuer: Option<String>,
    pub oidc_client_id: Option<String>,
    pub oidc_client_secret: Option<String>,
    pub oidc_redirect_uri: Option<String>,
    pub oidc_groups_claim: Option<String>,
}

pub(crate) struct PreparedAuthSettingsUpdate {
    pub allow_local_login: bool,
    pub allow_local_registration: bool,
    pub allow_oidc: bool,
    pub anonymous_mode: AnonymousMode,
    pub site_name: String,
    pub announcement: String,
    pub oidc_issuer: Option<String>,
    pub oidc_client_id: Option<String>,
    pub oidc_client_secret: Option<String>,
    pub oidc_redirect_uri: Option<String>,
    pub oidc_groups_claim: String,
}

pub(crate) async fn effective_auth_settings(
    db: &PgPool,
    defaults: &OidcProviderDefaults,
) -> Result<AuthSettings, sqlx::Error> {
    let settings = auth_settings_persistence::find(db)
        .await?
        .unwrap_or_else(|| default_auth_settings(defaults));
    Ok(apply_environment_overrides(settings, defaults))
}

pub(crate) fn default_auth_settings(oidc: &OidcProviderDefaults) -> AuthSettings {
    let site_name = env::var("SITE_NAME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Typst Collaboration".to_string());
    AuthSettings {
        allow_local_login: true,
        allow_local_registration: true,
        allow_oidc: true,
        anonymous_mode: AnonymousMode::Off,
        site_name,
        announcement: String::new(),
        oidc_issuer: non_empty_setting(&oidc.issuer),
        oidc_client_id: non_empty_setting(&oidc.client_id),
        oidc_client_secret: non_empty_setting(&oidc.client_secret),
        oidc_redirect_uri: non_empty_setting(&oidc.redirect_uri),
        oidc_groups_claim: if oidc.groups_claim.trim().is_empty() {
            "groups".to_string()
        } else {
            oidc.groups_claim.clone()
        },
        updated_at: Utc::now(),
    }
}

pub(crate) fn apply_distribution_settings(
    distribution: &DistributionConfig,
    mut settings: AuthSettings,
) -> AuthSettings {
    settings.site_name = distribution
        .effective_site_name(&settings.site_name)
        .to_string();
    settings
}

pub(crate) fn distribution_managed_fields(distribution: &DistributionConfig) -> Vec<String> {
    if distribution.product.name_managed {
        vec!["site_name".to_string()]
    } else {
        Vec::new()
    }
}

pub(crate) fn prepare_auth_settings_update(
    distribution: &DistributionConfig,
    command: UpdateAuthSettingsCommand,
) -> PreparedAuthSettingsUpdate {
    let site_name = if distribution.product.name_managed {
        distribution.product.name.clone()
    } else {
        normalized_optional(command.site_name.as_deref())
            .unwrap_or_else(|| "Typst Collaboration".to_string())
    };
    PreparedAuthSettingsUpdate {
        allow_local_login: command.allow_local_login,
        allow_local_registration: command.allow_local_registration,
        allow_oidc: command.allow_oidc,
        anonymous_mode: command.anonymous_mode.unwrap_or(AnonymousMode::Off),
        site_name,
        announcement: command
            .announcement
            .as_deref()
            .map(str::trim)
            .unwrap_or_default()
            .to_string(),
        oidc_issuer: normalized_optional(command.oidc_issuer.as_deref()),
        oidc_client_id: normalized_optional(command.oidc_client_id.as_deref()),
        oidc_client_secret: normalized_optional(command.oidc_client_secret.as_deref()),
        oidc_redirect_uri: normalized_optional(command.oidc_redirect_uri.as_deref()),
        oidc_groups_claim: normalized_optional(command.oidc_groups_claim.as_deref())
            .unwrap_or_else(|| "groups".to_string()),
    }
}

pub(crate) async fn update_auth_settings(
    db: &PgPool,
    command: &PreparedAuthSettingsUpdate,
) -> Result<(), UpdateAuthSettingsError> {
    let mut transaction = db.begin().await.map_err(|source| UpdateAuthSettingsError {
        stage: UpdateAuthSettingsStage::Begin,
        source,
    })?;
    auth_settings_persistence::upsert(
        &mut transaction,
        &auth_settings_persistence::AuthSettingsWrite {
            allow_local_login: command.allow_local_login,
            allow_local_registration: command.allow_local_registration,
            allow_oidc: command.allow_oidc,
            anonymous_mode: command.anonymous_mode,
            site_name: &command.site_name,
            announcement: &command.announcement,
            oidc_issuer: command.oidc_issuer.as_deref(),
            oidc_client_id: command.oidc_client_id.as_deref(),
            oidc_client_secret: command.oidc_client_secret.as_deref(),
            oidc_redirect_uri: command.oidc_redirect_uri.as_deref(),
            oidc_groups_claim: &command.oidc_groups_claim,
            updated_at: Utc::now(),
        },
    )
    .await
    .map_err(|source| UpdateAuthSettingsError {
        stage: UpdateAuthSettingsStage::Upsert,
        source,
    })?;
    transaction
        .commit()
        .await
        .map_err(|source| UpdateAuthSettingsError {
            stage: UpdateAuthSettingsStage::Commit,
            source,
        })?;
    Ok(())
}

#[derive(Clone, Copy, Debug)]
enum UpdateAuthSettingsStage {
    Begin,
    Upsert,
    Commit,
}

#[derive(Debug, Error)]
#[error("authentication settings update failed during {stage:?}")]
pub(crate) struct UpdateAuthSettingsError {
    stage: UpdateAuthSettingsStage,
    #[source]
    source: sqlx::Error,
}

fn non_empty_setting(value: &str) -> Option<String> {
    (!value.trim().is_empty()).then(|| value.to_string())
}

fn normalized_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn parse_bool_override(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn bool_environment_override(name: &str) -> Option<bool> {
    env::var(name).ok().as_deref().and_then(parse_bool_override)
}

fn apply_environment_overrides(
    mut settings: AuthSettings,
    oidc: &OidcProviderDefaults,
) -> AuthSettings {
    if let Some(value) = bool_environment_override("AUTH_ALLOW_LOCAL_LOGIN") {
        settings.allow_local_login = value;
    }
    if let Some(value) = bool_environment_override("AUTH_ALLOW_LOCAL_REGISTRATION") {
        settings.allow_local_registration = value;
    }
    if let Some(value) = bool_environment_override("AUTH_ALLOW_OIDC") {
        settings.allow_oidc = value;
    }
    if let Some(value) = env::var("AUTH_ANONYMOUS_MODE")
        .ok()
        .and_then(|value| value.trim().parse::<AnonymousMode>().ok())
    {
        settings.anonymous_mode = value;
    }
    if let Some(value) = non_empty_setting(&oidc.issuer) {
        settings.oidc_issuer = Some(value);
    }
    if let Some(value) = non_empty_setting(&oidc.client_id) {
        settings.oidc_client_id = Some(value);
    }
    if let Some(value) = non_empty_setting(&oidc.client_secret) {
        settings.oidc_client_secret = Some(value);
    }
    if let Some(value) = non_empty_setting(&oidc.redirect_uri) {
        settings.oidc_redirect_uri = Some(value);
    }
    if !oidc.groups_claim.trim().is_empty() {
        settings.oidc_groups_claim = oidc.groups_claim.clone();
    }
    settings
}

#[cfg(test)]
mod tests {
    use super::{parse_bool_override, prepare_auth_settings_update, UpdateAuthSettingsCommand};
    use crate::access::AnonymousMode;
    use crate::distribution::DistributionConfig;

    #[test]
    fn boolean_environment_overrides_are_strict_and_case_insensitive() {
        assert_eq!(parse_bool_override("true"), Some(true));
        assert_eq!(parse_bool_override(" OFF "), Some(false));
        assert_eq!(parse_bool_override("enabled"), None);
    }

    #[test]
    fn update_preparation_owns_normalization_and_managed_site_names() {
        let mut distribution = DistributionConfig::default();
        distribution.product.name = "Managed Product".to_string();
        distribution.product.name_managed = true;
        let update = prepare_auth_settings_update(
            &distribution,
            UpdateAuthSettingsCommand {
                allow_local_login: true,
                allow_local_registration: false,
                allow_oidc: true,
                anonymous_mode: None,
                site_name: Some(" ignored ".to_string()),
                announcement: Some("  maintenance  ".to_string()),
                oidc_issuer: Some(
                    "  https://identity.example/.well-known/openid-configuration  ".to_string(),
                ),
                oidc_client_id: Some("  client  ".to_string()),
                oidc_client_secret: Some("   ".to_string()),
                oidc_redirect_uri: Some("  https://collab.example/callback  ".to_string()),
                oidc_groups_claim: Some("  ".to_string()),
            },
        );
        assert_eq!(update.site_name, "Managed Product");
        assert_eq!(update.announcement, "maintenance");
        assert_eq!(update.anonymous_mode, AnonymousMode::Off);
        assert_eq!(
            update.oidc_issuer.as_deref(),
            Some("https://identity.example/.well-known/openid-configuration")
        );
        assert_eq!(update.oidc_client_id.as_deref(), Some("client"));
        assert_eq!(update.oidc_client_secret, None);
        assert_eq!(
            update.oidc_redirect_uri.as_deref(),
            Some("https://collab.example/callback")
        );
        assert_eq!(update.oidc_groups_claim, "groups");
    }
}
