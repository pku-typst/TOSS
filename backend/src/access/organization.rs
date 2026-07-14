use super::organization_model::Organization;
use super::{organization_persistence, OrganizationRole};
use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool};
use thiserror::Error;
use uuid::Uuid;

const SITE_ADMIN_ORGANIZATION_ID: Uuid = Uuid::from_u128(1);

pub(crate) async fn organization_user_is_site_admin(
    db: &PgPool,
    user_id: Uuid,
) -> Result<bool, sqlx::Error> {
    organization_persistence::user_is_owner(db, SITE_ADMIN_ORGANIZATION_ID, user_id).await
}

pub(crate) async fn grant_site_admin_membership(
    connection: &mut PgConnection,
    user_id: Uuid,
    granted_at: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    organization_persistence::upsert_organization_membership_role(
        connection,
        SITE_ADMIN_ORGANIZATION_ID,
        user_id,
        OrganizationRole::Owner,
        granted_at,
    )
    .await
}

pub(crate) async fn create_organization(
    db: &PgPool,
    name: &str,
) -> Result<Organization, CreateOrganizationError> {
    let name = normalize_organization_name(name)?;
    let organization_id = Uuid::new_v4();
    let mut transaction =
        db.begin()
            .await
            .map_err(|source| CreateOrganizationError::Persistence {
                stage: CreateOrganizationStage::Begin,
                organization_id,
                source,
            })?;
    let organization =
        organization_persistence::insert(&mut transaction, organization_id, name, Utc::now())
            .await
            .map_err(|source| CreateOrganizationError::Persistence {
                stage: CreateOrganizationStage::Insert,
                organization_id,
                source,
            })?;
    transaction
        .commit()
        .await
        .map_err(|source| CreateOrganizationError::Persistence {
            stage: CreateOrganizationStage::Commit,
            organization_id,
            source,
        })?;
    Ok(organization)
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum CreateOrganizationStage {
    Begin,
    Insert,
    Commit,
}

#[derive(Debug, Error)]
pub(crate) enum CreateOrganizationError {
    #[error("organization name is empty")]
    EmptyName,
    #[error("organization {organization_id} creation failed during {stage:?}")]
    Persistence {
        stage: CreateOrganizationStage,
        organization_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

fn normalize_organization_name(name: &str) -> Result<&str, CreateOrganizationError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CreateOrganizationError::EmptyName);
    }
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::{normalize_organization_name, CreateOrganizationError, SITE_ADMIN_ORGANIZATION_ID};
    use sqlx::postgres::PgPoolOptions;
    use std::error::Error;

    #[test]
    fn organization_names_are_trimmed_and_must_not_be_empty() {
        assert_eq!(
            normalize_organization_name("  Research  ").ok(),
            Some("Research")
        );
        assert!(matches!(
            normalize_organization_name(" \t "),
            Err(CreateOrganizationError::EmptyName)
        ));
    }

    #[tokio::test]
    async fn migrations_seed_the_site_admin_organization() -> Result<(), Box<dyn Error>> {
        let database_url =
            std::env::var("TEST_DATABASE_URL").or_else(|_| std::env::var("DATABASE_URL"));
        let Ok(database_url) = database_url else {
            return Ok(());
        };
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&database_url)
            .await?;
        sqlx::migrate!("./migrations").run(&pool).await?;

        let name = sqlx::query_scalar::<_, String>("SELECT name FROM organizations WHERE id = $1")
            .bind(SITE_ADMIN_ORGANIZATION_ID)
            .fetch_optional(&pool)
            .await?;
        assert_eq!(name.as_deref(), Some("Site Admins"));
        Ok(())
    }
}
