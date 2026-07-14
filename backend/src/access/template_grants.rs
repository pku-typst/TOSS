//! Template organization-grant interfaces owned by Identity and Access.

use super::template_grant_persistence;
use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct TemplateOrganizationGrant {
    pub project_id: Uuid,
    pub organization_id: Uuid,
    pub organization_name: String,
    #[schema(required)]
    pub granted_by: Option<Uuid>,
    pub granted_at: DateTime<Utc>,
}

pub(crate) async fn list_template_organization_grants(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Vec<TemplateOrganizationGrant>, sqlx::Error> {
    template_grant_persistence::list(db, project_id)
        .await
        .map(|records| {
            records
                .into_iter()
                .map(template_organization_grant)
                .collect()
        })
}

pub(crate) async fn grant_template_organization_access(
    connection: &mut PgConnection,
    project_id: Uuid,
    organization_id: Uuid,
    granted_by: Uuid,
    granted_at: DateTime<Utc>,
) -> Result<TemplateOrganizationGrant, sqlx::Error> {
    template_grant_persistence::upsert(
        connection,
        project_id,
        organization_id,
        granted_by,
        granted_at,
    )
    .await
    .map(template_organization_grant)
}

pub(crate) async fn revoke_template_organization_access(
    db: &PgPool,
    project_id: Uuid,
    organization_id: Uuid,
) -> Result<bool, sqlx::Error> {
    template_grant_persistence::delete(db, project_id, organization_id).await
}

pub(crate) async fn revoke_all_template_organization_access(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<(), sqlx::Error> {
    template_grant_persistence::delete_all(connection, project_id).await
}

fn template_organization_grant(
    record: template_grant_persistence::TemplateOrganizationGrantRecord,
) -> TemplateOrganizationGrant {
    TemplateOrganizationGrant {
        project_id: record.project_id,
        organization_id: record.organization_id,
        organization_name: record.organization_name,
        granted_by: record.granted_by,
        granted_at: record.granted_at,
    }
}
