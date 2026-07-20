//! Personal-template status lifecycle.

use crate::access::{
    lock_project_access_mutation, revoke_all_template_organization_access,
    revoke_project_temporary_sessions,
};
use crate::workspace::set_project_template_status;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct TemplateStatus {
    pub project_id: Uuid,
    pub is_template: bool,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Copy, Debug)]
enum TemplateStatusPersistenceStage {
    Begin,
    LockProjectAccess,
    SetProjectClassification,
    RevokeTemporarySessions,
    ClearOrganizationAccess,
    Commit,
}

#[derive(Debug, Error)]
#[error("template status persistence failed during {stage:?} for project {project_id}")]
pub(super) struct TemplateStatusPersistenceError {
    stage: TemplateStatusPersistenceStage,
    project_id: Uuid,
    #[source]
    source: sqlx::Error,
}

impl TemplateStatusPersistenceError {
    fn new(stage: TemplateStatusPersistenceStage, project_id: Uuid, source: sqlx::Error) -> Self {
        Self {
            stage,
            project_id,
            source,
        }
    }
}

#[derive(Debug, Error)]
pub(super) enum UpdateTemplateStatusError {
    #[error("template project was not found")]
    ProjectNotFound,
    #[error(transparent)]
    Persistence(#[from] TemplateStatusPersistenceError),
}

pub(super) async fn update_project_template(
    db: &PgPool,
    project_id: Uuid,
    is_template: bool,
) -> Result<TemplateStatus, UpdateTemplateStatusError> {
    let updated_at = Utc::now();
    let mut transaction = db.begin().await.map_err(|source| {
        TemplateStatusPersistenceError::new(
            TemplateStatusPersistenceStage::Begin,
            project_id,
            source,
        )
    })?;
    lock_project_access_mutation(&mut transaction, project_id)
        .await
        .map_err(|source| {
            TemplateStatusPersistenceError::new(
                TemplateStatusPersistenceStage::LockProjectAccess,
                project_id,
                source,
            )
        })?;
    let is_template = set_project_template_status(&mut transaction, project_id, is_template)
        .await
        .map_err(|source| {
            TemplateStatusPersistenceError::new(
                TemplateStatusPersistenceStage::SetProjectClassification,
                project_id,
                source,
            )
        })?
        .ok_or(UpdateTemplateStatusError::ProjectNotFound)?;
    if is_template {
        revoke_project_temporary_sessions(&mut transaction, project_id)
            .await
            .map_err(|source| {
                TemplateStatusPersistenceError::new(
                    TemplateStatusPersistenceStage::RevokeTemporarySessions,
                    project_id,
                    source,
                )
            })?;
    } else {
        revoke_all_template_organization_access(&mut transaction, project_id)
            .await
            .map_err(|source| {
                TemplateStatusPersistenceError::new(
                    TemplateStatusPersistenceStage::ClearOrganizationAccess,
                    project_id,
                    source,
                )
            })?;
    }
    transaction.commit().await.map_err(|source| {
        TemplateStatusPersistenceError::new(
            TemplateStatusPersistenceStage::Commit,
            project_id,
            source,
        )
    })?;

    Ok(TemplateStatus {
        project_id,
        is_template,
        updated_at,
    })
}

#[cfg(test)]
mod tests {
    use super::update_project_template;
    use chrono::{Duration, Utc};
    use sqlx::PgPool;
    use uuid::Uuid;

    async fn migrated_test_pool() -> Result<Option<PgPool>, Box<dyn std::error::Error + Send + Sync>>
    {
        let database_url =
            std::env::var("TEST_DATABASE_URL").or_else(|_| std::env::var("DATABASE_URL"));
        let Ok(database_url) = database_url else {
            return Ok(None);
        };
        let pool = PgPool::connect(&database_url).await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Some(pool))
    }

    #[tokio::test]
    async fn marking_a_project_as_a_template_revokes_existing_temporary_guest_sessions(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let owner_user_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        let share_link_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let now = Utc::now();
        let username_suffix = owner_user_id
            .simple()
            .to_string()
            .chars()
            .take(16)
            .collect::<String>();
        let username = format!("owner-{username_suffix}");
        sqlx::query(
            "insert into users (id, email, username, display_name, created_at)
             values ($1, $2, $3, $4, $5)",
        )
        .bind(owner_user_id)
        .bind(format!("{owner_user_id}@example.test"))
        .bind(username)
        .bind("Template owner")
        .bind(now)
        .execute(&pool)
        .await?;
        sqlx::query(
            "insert into projects (id, owner_user_id, name, created_at, project_type)
             values ($1, $2, $3, $4, 'typst')",
        )
        .bind(project_id)
        .bind(owner_user_id)
        .bind("Guest session template status test")
        .bind(now)
        .execute(&pool)
        .await?;
        let token = format!("psh_{}", Uuid::new_v4().simple());
        sqlx::query(
            "insert into project_share_links
               (id, project_id, token_prefix, token_value, permission, created_by,
                created_at, expires_at, revoked_at)
             values ($1, $2, $3, $4, 'write', $5, $6, null, null)",
        )
        .bind(share_link_id)
        .bind(project_id)
        .bind(token.chars().take(12).collect::<String>())
        .bind(token)
        .bind(owner_user_id)
        .bind(now)
        .execute(&pool)
        .await?;
        sqlx::query(
            "insert into anonymous_share_sessions
               (id, project_id, share_link_id, session_token_fingerprint, display_name,
                permission, created_at, expires_at, last_used_at)
             values ($1, $2, $3, $4, $5, 'write', $6, $7, $6)",
        )
        .bind(session_id)
        .bind(project_id)
        .bind(share_link_id)
        .bind(vec![7_u8; 32])
        .bind("Guest editor")
        .bind(now)
        .bind(now + Duration::days(1))
        .execute(&pool)
        .await?;

        let status = update_project_template(&pool, project_id, true).await?;
        assert!(status.is_template);
        let persisted = sqlx::query_as::<_, (bool, i64, i64)>(
            "select project.is_template,
                    (select count(*) from anonymous_share_sessions session
                     where session.project_id = project.id),
                    project.access_epoch
             from projects project
             where project.id = $1",
        )
        .bind(project_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(persisted, (true, 0, 1));

        sqlx::query("delete from projects where id = $1")
            .bind(project_id)
            .execute(&pool)
            .await?;
        sqlx::query("delete from users where id = $1")
            .bind(owner_user_id)
            .execute(&pool)
            .await?;
        Ok(())
    }
}
