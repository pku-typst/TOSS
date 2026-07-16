//! Organization visibility grants for published personal templates.

use crate::access::{
    grant_template_organization_access, list_template_organization_grants,
    organization_user_is_member, revoke_template_organization_access, TemplateOrganizationGrant,
};
use crate::workspace::lock_project_template_status;
use chrono::Utc;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
enum OrganizationGrantPersistenceStage {
    Begin,
    LockProjectClassification,
    CheckOrganizationMembership,
    Grant,
    Commit,
}

#[derive(Debug, Error)]
#[error(
    "template organization grant persistence failed during {stage:?} for project {project_id} and organization {organization_id}"
)]
pub(super) struct GrantTemplateOrganizationAccessPersistenceError {
    stage: OrganizationGrantPersistenceStage,
    project_id: Uuid,
    organization_id: Uuid,
    #[source]
    source: sqlx::Error,
}

impl GrantTemplateOrganizationAccessPersistenceError {
    fn new(
        stage: OrganizationGrantPersistenceStage,
        project_id: Uuid,
        organization_id: Uuid,
        source: sqlx::Error,
    ) -> Self {
        Self {
            stage,
            project_id,
            organization_id,
            source,
        }
    }
}

#[derive(Debug, Error)]
pub(super) enum GrantTemplateOrganizationAccessError {
    #[error("template project was not found")]
    ProjectNotFound,
    #[error("project is not published as a template")]
    ProjectNotPublished,
    #[error("the actor is not a member of the organization")]
    OrganizationMembershipRequired,
    #[error(transparent)]
    Persistence(#[from] GrantTemplateOrganizationAccessPersistenceError),
}

#[derive(Debug, Error)]
pub(super) enum RevokeTemplateOrganizationAccessError {
    #[error("template organization grant was not found")]
    GrantNotFound,
    #[error(
        "template organization grant revocation failed for project {project_id} and organization {organization_id}"
    )]
    Persistence {
        project_id: Uuid,
        organization_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

pub(super) async fn list_project_template_organization_access(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Vec<TemplateOrganizationGrant>, sqlx::Error> {
    list_template_organization_grants(db, project_id).await
}

pub(super) async fn upsert_project_template_organization_access(
    db: &PgPool,
    project_id: Uuid,
    organization_id: Uuid,
    actor_user_id: Uuid,
) -> Result<TemplateOrganizationGrant, GrantTemplateOrganizationAccessError> {
    let mut transaction = db.begin().await.map_err(|source| {
        GrantTemplateOrganizationAccessPersistenceError::new(
            OrganizationGrantPersistenceStage::Begin,
            project_id,
            organization_id,
            source,
        )
    })?;
    match lock_project_template_status(&mut transaction, project_id)
        .await
        .map_err(|source| {
            GrantTemplateOrganizationAccessPersistenceError::new(
                OrganizationGrantPersistenceStage::LockProjectClassification,
                project_id,
                organization_id,
                source,
            )
        })? {
        Some(true) => {}
        Some(false) => return Err(GrantTemplateOrganizationAccessError::ProjectNotPublished),
        None => return Err(GrantTemplateOrganizationAccessError::ProjectNotFound),
    }
    let actor_is_member =
        organization_user_is_member(&mut transaction, actor_user_id, organization_id)
            .await
            .map_err(|source| {
                GrantTemplateOrganizationAccessPersistenceError::new(
                    OrganizationGrantPersistenceStage::CheckOrganizationMembership,
                    project_id,
                    organization_id,
                    source,
                )
            })?;
    if !actor_is_member {
        return Err(GrantTemplateOrganizationAccessError::OrganizationMembershipRequired);
    }
    let access = grant_template_organization_access(
        &mut transaction,
        project_id,
        organization_id,
        actor_user_id,
        Utc::now(),
    )
    .await
    .map_err(|source| {
        GrantTemplateOrganizationAccessPersistenceError::new(
            OrganizationGrantPersistenceStage::Grant,
            project_id,
            organization_id,
            source,
        )
    })?;
    transaction.commit().await.map_err(|source| {
        GrantTemplateOrganizationAccessPersistenceError::new(
            OrganizationGrantPersistenceStage::Commit,
            project_id,
            organization_id,
            source,
        )
    })?;

    Ok(access)
}

pub(super) async fn delete_project_template_organization_access(
    db: &PgPool,
    project_id: Uuid,
    organization_id: Uuid,
) -> Result<(), RevokeTemplateOrganizationAccessError> {
    let deleted = revoke_template_organization_access(db, project_id, organization_id)
        .await
        .map_err(
            |source| RevokeTemplateOrganizationAccessError::Persistence {
                project_id,
                organization_id,
                source,
            },
        )?;
    if !deleted {
        return Err(RevokeTemplateOrganizationAccessError::GrantNotFound);
    }
    Ok(())
}
