use super::auth_settings_persistence;
use super::organization;
use super::principal::{cookie_value, header_value, request_user_id, RequestAuthenticationError};
use super::resolution_persistence;
use super::sharing_persistence;
use super::{AnonymousMode, ProjectPermission, ProjectRole};
use axum::http::HeaderMap;
use chrono::Utc;
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool};
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
enum ProjectAuthorizationQuery {
    AnonymousMode,
    GuestSession,
    ShareLink,
    UserAccess,
}

#[derive(Debug, Error)]
#[error("project authorization query {query:?} failed")]
pub(crate) struct ProjectAuthorizationStoreError {
    query: ProjectAuthorizationQuery,
    #[source]
    source: sqlx::Error,
}

#[derive(Debug, Error)]
pub(crate) enum ProjectAuthorizationError {
    #[error("authentication is required")]
    AuthenticationRequired,
    #[error("project access is forbidden")]
    PermissionDenied,
    #[error(transparent)]
    Authentication(#[from] RequestAuthenticationError),
    #[error(transparent)]
    Store(#[from] ProjectAuthorizationStoreError),
}

impl ProjectAuthorizationError {
    pub(crate) const fn is_permission_denied(&self) -> bool {
        matches!(self, Self::PermissionDenied)
    }
}

#[derive(Debug, Error)]
pub(crate) enum SiteAdminAuthorizationError {
    #[error("authentication is required")]
    AuthenticationRequired,
    #[error("site administrator access is required")]
    PermissionDenied,
    #[error(transparent)]
    Authentication(#[from] RequestAuthenticationError),
    #[error("site administrator authorization lookup failed")]
    Store(#[source] sqlx::Error),
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum AccessNeed {
    Read,
    Write,
    Manage,
    GitSync,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProjectAccessEpochMatch {
    Current,
    Changed,
    ProjectNotFound,
}

pub(crate) async fn project_access_epoch(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Option<i64>, sqlx::Error> {
    super::grant_persistence::project_access_epoch(db, project_id).await
}

pub(crate) async fn lock_project_access_mutation(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<(), sqlx::Error> {
    super::grant_persistence::lock_project_access_epoch_for_write(connection, project_id).await
}

pub(crate) async fn lock_project_access_epoch(
    connection: &mut PgConnection,
    project_id: Uuid,
    expected_epoch: i64,
) -> Result<ProjectAccessEpochMatch, sqlx::Error> {
    let current_epoch =
        super::grant_persistence::lock_project_access_epoch_for_read(connection, project_id)
            .await?;
    Ok(match current_epoch {
        Some(current_epoch) if current_epoch == expected_epoch => ProjectAccessEpochMatch::Current,
        Some(_) => ProjectAccessEpochMatch::Changed,
        None => ProjectAccessEpochMatch::ProjectNotFound,
    })
}

pub(crate) struct ProjectCatalogAccess {
    project_id: Uuid,
    direct_role: Option<ProjectRole>,
    organization_permission: Option<ProjectPermission>,
    has_template_access: bool,
}

impl ProjectCatalogAccess {
    pub(crate) const fn project_id(&self) -> Uuid {
        self.project_id
    }

    pub(crate) fn permits_catalog_entry(&self, is_template: bool) -> bool {
        self.can_read() || (is_template && self.has_template_access)
    }

    pub(crate) fn effective_role(&self) -> ProjectRole {
        let direct_role = self.direct_role.unwrap_or(ProjectRole::ReadOnly);
        let organization_role = self
            .organization_permission
            .map(ProjectPermission::project_role)
            .unwrap_or(ProjectRole::ReadOnly);
        if organization_role.rank() > direct_role.rank() {
            organization_role
        } else {
            direct_role
        }
    }

    pub(crate) const fn can_read(&self) -> bool {
        self.direct_role.is_some() || self.organization_permission.is_some()
    }
}

impl AccessNeed {
    const fn allows_role(self, role: ProjectRole) -> bool {
        match self {
            Self::Read => true,
            Self::Write => matches!(role, ProjectRole::Owner | ProjectRole::ReadWrite),
            Self::Manage | Self::GitSync => matches!(role, ProjectRole::Owner),
        }
    }

    const fn allows_organization_permission(self, permission: ProjectPermission) -> bool {
        match self {
            Self::Read => true,
            Self::Write => permission.can_write(),
            Self::Manage | Self::GitSync => false,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ProjectAccessPrincipal {
    pub(crate) user_id: Option<Uuid>,
    pub(crate) guest_session_id: Option<Uuid>,
    pub(crate) guest_display_name: Option<String>,
    pub(crate) can_write: bool,
}

async fn load_anonymous_mode(db: &PgPool) -> Result<AnonymousMode, ProjectAuthorizationError> {
    auth_settings_persistence::anonymous_mode(db)
        .await
        .map_err(|source| ProjectAuthorizationStoreError {
            query: ProjectAuthorizationQuery::AnonymousMode,
            source,
        })
        .map_err(Into::into)
}

async fn project_readable_via_share_token(
    db: &PgPool,
    project_id: Uuid,
    share_token: &str,
) -> Result<Option<ProjectPermission>, ProjectAuthorizationError> {
    sharing_persistence::share_link_permission(db, project_id, share_token)
        .await
        .map_err(|source| ProjectAuthorizationStoreError {
            query: ProjectAuthorizationQuery::ShareLink,
            source,
        })
        .map_err(Into::into)
}

async fn project_access_via_guest_session(
    db: &PgPool,
    project_id: Uuid,
    guest_session_token: &str,
) -> Result<Option<ProjectAccessPrincipal>, ProjectAuthorizationError> {
    let token_fingerprint = Sha256::digest(guest_session_token.as_bytes());
    let access =
        sharing_persistence::guest_session_access(db, project_id, token_fingerprint.as_ref())
            .await
            .map_err(|source| ProjectAuthorizationStoreError {
                query: ProjectAuthorizationQuery::GuestSession,
                source,
            })?;
    let Some(access) = access else {
        return Ok(None);
    };
    if let Err(database_error) =
        sharing_persistence::touch_guest_session(db, access.session_id, Utc::now()).await
    {
        tracing::warn!(%database_error, session_id = %access.session_id, "guest session last-used update failed");
    }
    Ok(Some(ProjectAccessPrincipal {
        user_id: None,
        guest_session_id: Some(access.session_id),
        guest_display_name: Some(access.display_name),
        can_write: access.permission.can_write(),
    }))
}

pub(crate) async fn ensure_project_access(
    db: &PgPool,
    headers: &HeaderMap,
    project_id: Uuid,
    need: AccessNeed,
) -> Result<ProjectAccessPrincipal, ProjectAuthorizationError> {
    if let Some(actor) = request_user_id(db, headers).await? {
        ensure_project_role_for_user(db, actor, project_id, need).await?;
        let required_access_can_write = matches!(
            need,
            AccessNeed::Write | AccessNeed::Manage | AccessNeed::GitSync
        );
        let can_write = if required_access_can_write {
            true
        } else {
            match ensure_project_role_for_user(db, actor, project_id, AccessNeed::Write).await {
                Ok(()) => true,
                Err(ProjectAuthorizationError::PermissionDenied) => false,
                Err(error) => return Err(error),
            }
        };
        return Ok(ProjectAccessPrincipal {
            user_id: Some(actor),
            guest_session_id: None,
            guest_display_name: None,
            can_write,
        });
    }

    let mode = load_anonymous_mode(db).await?;
    if mode == AnonymousMode::Off {
        return Err(ProjectAuthorizationError::AuthenticationRequired);
    }

    if let Some(guest_session_token) = header_value(headers, "x-guest-session") {
        if let Some(principal) =
            project_access_via_guest_session(db, project_id, &guest_session_token).await?
        {
            if !mode.allows_read() {
                return Err(ProjectAuthorizationError::AuthenticationRequired);
            }
            if matches!(need, AccessNeed::Write)
                && (!mode.allows_guest_write() || !principal.can_write)
            {
                return Err(ProjectAuthorizationError::PermissionDenied);
            }
            if matches!(need, AccessNeed::Manage | AccessNeed::GitSync) {
                return Err(ProjectAuthorizationError::PermissionDenied);
            }
            return Ok(principal);
        }
    }

    let share_token = header_value(headers, "x-share-token")
        .or_else(|| cookie_value(headers, "typst_share_token"));
    let Some(share_token) = share_token else {
        return Err(ProjectAuthorizationError::AuthenticationRequired);
    };
    let permission = project_readable_via_share_token(db, project_id, &share_token)
        .await?
        .ok_or(ProjectAuthorizationError::PermissionDenied)?;
    if !mode.allows_read() {
        return Err(ProjectAuthorizationError::AuthenticationRequired);
    }
    if matches!(
        need,
        AccessNeed::Write | AccessNeed::Manage | AccessNeed::GitSync
    ) {
        return Err(ProjectAuthorizationError::PermissionDenied);
    }
    Ok(ProjectAccessPrincipal {
        user_id: None,
        guest_session_id: None,
        guest_display_name: None,
        can_write: permission.can_write(),
    })
}

pub(crate) async fn ensure_project_role(
    db: &PgPool,
    headers: &HeaderMap,
    project_id: Uuid,
    need: AccessNeed,
) -> Result<Uuid, ProjectAuthorizationError> {
    let Some(actor) = request_user_id(db, headers).await? else {
        return Err(ProjectAuthorizationError::AuthenticationRequired);
    };
    ensure_project_role_for_user(db, actor, project_id, need).await?;
    Ok(actor)
}

pub(crate) async fn ensure_project_role_for_user(
    db: &PgPool,
    actor: Uuid,
    project_id: Uuid,
    need: AccessNeed,
) -> Result<(), ProjectAuthorizationError> {
    let access = resolution_persistence::project_user_access(db, actor, project_id)
        .await
        .map_err(|source| ProjectAuthorizationStoreError {
            query: ProjectAuthorizationQuery::UserAccess,
            source,
        })?;
    if project_user_access_allows(access.direct_role, access.organization_permission, need) {
        Ok(())
    } else {
        Err(ProjectAuthorizationError::PermissionDenied)
    }
}

pub(crate) async fn list_project_catalog_access(
    db: &PgPool,
    actor: Uuid,
) -> Result<Vec<ProjectCatalogAccess>, sqlx::Error> {
    resolution_persistence::list_project_catalog_access(db, actor)
        .await
        .map(|records| {
            records
                .into_iter()
                .map(|record| ProjectCatalogAccess {
                    project_id: record.project_id,
                    direct_role: record.direct_role,
                    organization_permission: record.organization_permission,
                    has_template_access: record.has_template_access,
                })
                .collect()
        })
}

pub(crate) async fn project_user_has_catalog_access(
    db: &PgPool,
    actor: Uuid,
    project_id: Uuid,
    include_template_access: bool,
) -> Result<bool, sqlx::Error> {
    resolution_persistence::project_user_has_catalog_access(
        db,
        actor,
        project_id,
        include_template_access,
    )
    .await
}

fn project_user_access_allows(
    direct_role: Option<ProjectRole>,
    organization_permission: Option<ProjectPermission>,
    need: AccessNeed,
) -> bool {
    direct_role.is_some_and(|role| need.allows_role(role))
        || organization_permission
            .is_some_and(|permission| need.allows_organization_permission(permission))
}

async fn is_site_admin(db: &PgPool, user_id: Uuid) -> Result<bool, SiteAdminAuthorizationError> {
    organization::organization_user_is_site_admin(db, user_id)
        .await
        .map_err(SiteAdminAuthorizationError::Store)
}

pub(crate) async fn ensure_site_admin(
    db: &PgPool,
    headers: &HeaderMap,
) -> Result<Uuid, SiteAdminAuthorizationError> {
    let Some(actor) = request_user_id(db, headers).await? else {
        return Err(SiteAdminAuthorizationError::AuthenticationRequired);
    };
    if !is_site_admin(db, actor).await? {
        return Err(SiteAdminAuthorizationError::PermissionDenied);
    }
    Ok(actor)
}

#[cfg(test)]
mod tests {
    use super::{
        lock_project_access_epoch, project_user_access_allows, AccessNeed, ProjectAccessEpochMatch,
        ProjectCatalogAccess,
    };
    use crate::access::{ProjectPermission, ProjectRole};
    use chrono::Utc;
    use sqlx::PgPool;
    use std::time::Duration;
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

    #[test]
    fn organization_write_access_can_raise_a_direct_read_only_role() {
        assert!(project_user_access_allows(
            Some(ProjectRole::ReadOnly),
            Some(ProjectPermission::Write),
            AccessNeed::Write,
        ));
    }

    #[test]
    fn organization_access_cannot_grant_project_management() {
        assert!(!project_user_access_allows(
            None,
            Some(ProjectPermission::Write),
            AccessNeed::Manage,
        ));
        assert!(!project_user_access_allows(
            None,
            Some(ProjectPermission::Write),
            AccessNeed::GitSync,
        ));
    }

    #[test]
    fn direct_owner_can_satisfy_every_access_need() {
        for need in [
            AccessNeed::Read,
            AccessNeed::Write,
            AccessNeed::Manage,
            AccessNeed::GitSync,
        ] {
            assert!(project_user_access_allows(
                Some(ProjectRole::Owner),
                None,
                need,
            ));
        }
    }

    #[test]
    fn template_catalog_access_only_exposes_active_templates() {
        let access = ProjectCatalogAccess {
            project_id: Uuid::nil(),
            direct_role: None,
            organization_permission: None,
            has_template_access: true,
        };
        assert!(access.permits_catalog_entry(true));
        assert!(!access.permits_catalog_entry(false));
        assert!(!access.can_read());
        assert_eq!(access.effective_role(), ProjectRole::ReadOnly);
    }

    #[test]
    fn catalog_access_reports_the_strongest_effective_role() {
        let access = ProjectCatalogAccess {
            project_id: Uuid::nil(),
            direct_role: Some(ProjectRole::ReadOnly),
            organization_permission: Some(ProjectPermission::Write),
            has_template_access: false,
        };
        assert_eq!(access.effective_role(), ProjectRole::ReadWrite);
        assert!(access.can_read());
    }

    #[tokio::test]
    async fn access_epoch_change_waits_for_admitted_writes(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let project_id = Uuid::new_v4();
        sqlx::query(
            "insert into projects (id, name, created_at, project_type)
             values ($1, 'Access epoch lock test', $2, 'typst')",
        )
        .bind(project_id)
        .bind(Utc::now())
        .execute(&pool)
        .await?;

        let mut admitted_write = pool.begin().await?;
        assert_eq!(
            lock_project_access_epoch(&mut admitted_write, project_id, 0).await?,
            ProjectAccessEpochMatch::Current
        );

        let mutation_pool = pool.clone();
        let epoch_change = tokio::spawn(async move {
            let mut transaction = mutation_pool.begin().await?;
            let epoch = super::super::grant_persistence::advance_project_access_epoch(
                &mut transaction,
                project_id,
            )
            .await?;
            transaction.commit().await?;
            Ok::<_, sqlx::Error>(epoch)
        });
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert!(!epoch_change.is_finished());

        admitted_write.commit().await?;
        assert_eq!(epoch_change.await??, 1);
        sqlx::query("delete from projects where id = $1")
            .bind(project_id)
            .execute(&pool)
            .await?;
        Ok(())
    }
}
