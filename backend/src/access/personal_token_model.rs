//! Personal access token read contracts and creation outcomes owned by Access.

use chrono::{DateTime, Utc};
use uuid::Uuid;

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct PersonalAccessTokenInfo {
    pub id: Uuid,
    pub label: String,
    pub token_prefix: String,
    pub created_at: DateTime<Utc>,
    #[schema(required)]
    pub expires_at: Option<DateTime<Utc>>,
    #[schema(required)]
    pub last_used_at: Option<DateTime<Utc>>,
    #[schema(required)]
    pub revoked_at: Option<DateTime<Utc>>,
}

pub(crate) struct CreatedPersonalAccessToken {
    pub id: Uuid,
    pub label: String,
    pub token: String,
    pub token_prefix: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
}
