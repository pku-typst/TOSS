//! Read model for a user's external repository connection.

use super::super::provider::ProviderInstanceId;
use super::{persistence, ExternalGitDisconnectRestriction, ExternalGitGrantStatus};
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

pub(crate) struct ExternalGitProviderMetadata {
    pub provider_id: ProviderInstanceId,
    pub provider_name: String,
    pub base_url: String,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ExternalRepositoryConnectionStatus {
    configured: bool,
    bound: bool,
    connected: bool,
    provider: ProviderInstanceId,
    provider_name: String,
    base_url: String,
    #[schema(required)]
    status: Option<ExternalGitGrantStatus>,
    #[schema(required)]
    account_id: Option<String>,
    #[schema(required)]
    username: Option<String>,
    scopes: Vec<String>,
    #[schema(required)]
    expires_at: Option<DateTime<Utc>>,
    can_disconnect: bool,
    #[schema(required)]
    disconnect_restriction: Option<ExternalGitDisconnectRestriction>,
}

pub(crate) async fn external_git_connection_status(
    db: &PgPool,
    user_id: Uuid,
    metadata: ExternalGitProviderMetadata,
) -> Result<ExternalRepositoryConnectionStatus, sqlx::Error> {
    let grant = persistence::connection_grant(db, user_id, &metadata.provider_id).await?;
    Ok(match grant {
        Some(grant) => {
            let disconnect_restriction = if grant.linked_project_count > 0 {
                Some(ExternalGitDisconnectRestriction::LinkedProjects)
            } else if grant.login_identity && grant.login_method_count <= 1 {
                Some(ExternalGitDisconnectRestriction::LastLoginMethod)
            } else {
                None
            };
            ExternalRepositoryConnectionStatus {
                configured: true,
                bound: true,
                connected: grant.status == ExternalGitGrantStatus::Active,
                provider: metadata.provider_id,
                provider_name: metadata.provider_name,
                base_url: metadata.base_url,
                status: Some(grant.status),
                account_id: Some(grant.account_id),
                username: grant.username,
                scopes: grant.scopes,
                expires_at: grant.expires_at,
                can_disconnect: disconnect_restriction.is_none(),
                disconnect_restriction,
            }
        }
        None => ExternalRepositoryConnectionStatus {
            configured: true,
            bound: false,
            connected: false,
            provider: metadata.provider_id,
            provider_name: metadata.provider_name,
            base_url: metadata.base_url,
            status: None,
            account_id: None,
            username: None,
            scopes: Vec::new(),
            expires_at: None,
            can_disconnect: false,
            disconnect_restriction: None,
        },
    })
}

pub(crate) async fn external_git_user_id_for_provider_account(
    db: &PgPool,
    provider_instance_id: &ProviderInstanceId,
    provider_account_id: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    persistence::user_id_for_provider_account(db, provider_instance_id, provider_account_id).await
}
