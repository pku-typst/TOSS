//! Authentication-settings persistence owned by the Access context.

use super::auth_settings_model::{AnonymousMode, AuthSettings};
use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool, Row};

pub(crate) async fn find(db: &PgPool) -> Result<Option<AuthSettings>, sqlx::Error> {
    let row = sqlx::query(
        "select allow_local_login, allow_local_registration, allow_oidc, anonymous_mode,
                site_name, announcement, oidc_issuer, oidc_client_id, oidc_client_secret,
                oidc_redirect_uri, oidc_groups_claim, updated_at
         from auth_settings
         where id = 1",
    )
    .fetch_optional(db)
    .await?;
    Ok(row.map(|value| AuthSettings {
        allow_local_login: value.get("allow_local_login"),
        allow_local_registration: value.get("allow_local_registration"),
        allow_oidc: value.get("allow_oidc"),
        anonymous_mode: value.get("anonymous_mode"),
        site_name: value.get("site_name"),
        announcement: value.get("announcement"),
        oidc_issuer: value.get("oidc_issuer"),
        oidc_client_id: value.get("oidc_client_id"),
        oidc_client_secret: value.get("oidc_client_secret"),
        oidc_redirect_uri: value.get("oidc_redirect_uri"),
        oidc_groups_claim: value.get("oidc_groups_claim"),
        updated_at: value.get("updated_at"),
    }))
}

pub(crate) async fn anonymous_mode(db: &PgPool) -> Result<AnonymousMode, sqlx::Error> {
    Ok(
        sqlx::query_scalar("select anonymous_mode from auth_settings where id = 1")
            .fetch_optional(db)
            .await?
            .unwrap_or(AnonymousMode::Off),
    )
}

pub(crate) struct AuthSettingsWrite<'value> {
    pub allow_local_login: bool,
    pub allow_local_registration: bool,
    pub allow_oidc: bool,
    pub anonymous_mode: AnonymousMode,
    pub site_name: &'value str,
    pub announcement: &'value str,
    pub oidc_issuer: Option<&'value str>,
    pub oidc_client_id: Option<&'value str>,
    pub oidc_client_secret: Option<&'value str>,
    pub oidc_redirect_uri: Option<&'value str>,
    pub oidc_groups_claim: &'value str,
    pub updated_at: DateTime<Utc>,
}

pub(crate) async fn upsert(
    connection: &mut PgConnection,
    settings: &AuthSettingsWrite<'_>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into auth_settings
           (id, allow_local_login, allow_local_registration, allow_oidc, anonymous_mode,
            site_name, announcement, oidc_issuer, oidc_client_id, oidc_client_secret,
            oidc_redirect_uri, oidc_groups_claim, updated_at)
         values (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         on conflict (id) do update
         set allow_local_login = excluded.allow_local_login,
             allow_local_registration = excluded.allow_local_registration,
             allow_oidc = excluded.allow_oidc,
             anonymous_mode = excluded.anonymous_mode,
             site_name = excluded.site_name,
             announcement = excluded.announcement,
             oidc_issuer = excluded.oidc_issuer,
             oidc_client_id = excluded.oidc_client_id,
             oidc_client_secret = excluded.oidc_client_secret,
             oidc_redirect_uri = excluded.oidc_redirect_uri,
             oidc_groups_claim = excluded.oidc_groups_claim,
             updated_at = excluded.updated_at",
    )
    .bind(settings.allow_local_login)
    .bind(settings.allow_local_registration)
    .bind(settings.allow_oidc)
    .bind(settings.anonymous_mode)
    .bind(settings.site_name)
    .bind(settings.announcement)
    .bind(settings.oidc_issuer)
    .bind(settings.oidc_client_id)
    .bind(settings.oidc_client_secret)
    .bind(settings.oidc_redirect_uri)
    .bind(settings.oidc_groups_claim)
    .bind(settings.updated_at)
    .execute(connection)
    .await?;
    Ok(())
}
