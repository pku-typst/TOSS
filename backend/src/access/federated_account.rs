//! Provisioning policy for accounts authenticated by an external identity authority.

use super::account_policy::{
    bootstrap_admin_email_matches, federated_username_candidate, sanitize_username_seed,
};
use super::{federated_account_persistence, grant_site_admin_membership};
use crate::database_error::is_unique_constraint_violation;
use chrono::Utc;
use sqlx::{PgConnection, PgPool};
use thiserror::Error;
use uuid::Uuid;

pub(crate) struct ProvisionFederatedAccountCommand<'value> {
    pub email: &'value str,
    pub display_name: &'value str,
    pub authority_kind: LoginAuthorityKind,
    pub authority_id: &'value str,
    pub subject: &'value str,
    pub username_seed: &'value str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, sqlx::Type)]
#[sqlx(type_name = "text", rename_all = "snake_case")]
pub(crate) enum LoginAuthorityKind {
    Oidc,
    ExternalGit,
}

pub(crate) async fn federated_identity_user_id(
    db: &PgPool,
    authority_kind: LoginAuthorityKind,
    authority_id: &str,
    subject: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    federated_account_persistence::user_id(db, authority_kind, authority_id, subject).await
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum ProvisionFederatedAccountStage {
    LookupIdentity,
    TouchIdentity,
    BeginUser,
    InsertUserIdentity,
    RollbackUsernameCollision,
    RollbackIdentityCollision,
    CommitUser,
    BeginAdministratorGrant,
    GrantAdministrator,
    CommitAdministratorGrant,
}

#[derive(Debug, Error)]
pub(crate) enum ProvisionFederatedAccountError {
    #[error("no available username could be allocated for the federated identity")]
    UsernameExhausted,
    #[error("the federated identity email belongs to another platform account")]
    EmailConflict,
    #[error("federated account provisioning failed during {stage:?} for user {user_id:?}")]
    Persistence {
        stage: ProvisionFederatedAccountStage,
        user_id: Option<Uuid>,
        #[source]
        source: sqlx::Error,
    },
}

pub(crate) async fn provision_federated_account(
    db: &PgPool,
    command: ProvisionFederatedAccountCommand<'_>,
) -> Result<Uuid, ProvisionFederatedAccountError> {
    let normalized_email = command.email.trim().to_lowercase();
    let command = ProvisionFederatedAccountCommand {
        email: &normalized_email,
        display_name: command.display_name,
        authority_kind: command.authority_kind,
        authority_id: command.authority_id,
        subject: command.subject,
        username_seed: command.username_seed,
    };
    let bootstrap_administrator = bootstrap_admin_email_matches(command.email);
    let user_id = provision_federated_user(db, &command).await?;
    if bootstrap_administrator {
        grant_site_admin(db, user_id).await?;
    }
    Ok(user_id)
}

async fn provision_federated_user(
    db: &PgPool,
    command: &ProvisionFederatedAccountCommand<'_>,
) -> Result<Uuid, ProvisionFederatedAccountError> {
    if let Some(user_id) = federated_account_persistence::user_id(
        db,
        command.authority_kind,
        command.authority_id,
        command.subject,
    )
    .await
    .map_err(|source| ProvisionFederatedAccountError::Persistence {
        stage: ProvisionFederatedAccountStage::LookupIdentity,
        user_id: None,
        source,
    })? {
        federated_account_persistence::touch_identity(
            db,
            user_id,
            command.authority_kind,
            command.authority_id,
            command.subject,
            Utc::now(),
        )
        .await
        .map_err(|source| ProvisionFederatedAccountError::Persistence {
            stage: ProvisionFederatedAccountStage::TouchIdentity,
            user_id: Some(user_id),
            source,
        })?;
        return Ok(user_id);
    }
    let username_base = sanitize_username_seed(command.username_seed);
    for attempt in 0..6_usize {
        let username = federated_username_candidate(&username_base, attempt);
        let candidate_user_id = Uuid::new_v4();
        let mut transaction =
            db.begin()
                .await
                .map_err(|source| ProvisionFederatedAccountError::Persistence {
                    stage: ProvisionFederatedAccountStage::BeginUser,
                    user_id: Some(candidate_user_id),
                    source,
                })?;
        let result = federated_account_persistence::insert_user_with_identity(
            &mut transaction,
            &federated_account_persistence::FederatedUserWrite {
                id: candidate_user_id,
                email: command.email,
                username: &username,
                display_name: command.display_name,
                created_at: Utc::now(),
                authority_kind: command.authority_kind,
                authority_id: command.authority_id,
                subject: command.subject,
            },
        )
        .await;
        match result {
            Ok(()) => {
                transaction.commit().await.map_err(|source| {
                    ProvisionFederatedAccountError::Persistence {
                        stage: ProvisionFederatedAccountStage::CommitUser,
                        user_id: Some(candidate_user_id),
                        source,
                    }
                })?;
                return Ok(candidate_user_id);
            }
            Err(database_error)
                if is_unique_constraint_violation(&database_error, "users_username_key") =>
            {
                transaction.rollback().await.map_err(|source| {
                    ProvisionFederatedAccountError::Persistence {
                        stage: ProvisionFederatedAccountStage::RollbackUsernameCollision,
                        user_id: Some(candidate_user_id),
                        source,
                    }
                })?;
            }
            Err(database_error)
                if is_unique_constraint_violation(&database_error, "users_email_key") =>
            {
                return Err(ProvisionFederatedAccountError::EmailConflict);
            }
            Err(database_error)
                if is_unique_constraint_violation(
                    &database_error,
                    "user_login_identities_pkey",
                ) =>
            {
                transaction.rollback().await.map_err(|source| {
                    ProvisionFederatedAccountError::Persistence {
                        stage: ProvisionFederatedAccountStage::RollbackIdentityCollision,
                        user_id: Some(candidate_user_id),
                        source,
                    }
                })?;
                if let Some(user_id) = federated_account_persistence::user_id(
                    db,
                    command.authority_kind,
                    command.authority_id,
                    command.subject,
                )
                .await
                .map_err(|source| ProvisionFederatedAccountError::Persistence {
                    stage: ProvisionFederatedAccountStage::LookupIdentity,
                    user_id: None,
                    source,
                })? {
                    return Ok(user_id);
                }
            }
            Err(source) => {
                return Err(ProvisionFederatedAccountError::Persistence {
                    stage: ProvisionFederatedAccountStage::InsertUserIdentity,
                    user_id: Some(candidate_user_id),
                    source,
                });
            }
        }
    }
    Err(ProvisionFederatedAccountError::UsernameExhausted)
}

#[derive(Debug, Error)]
pub(crate) enum BindFederatedIdentityError {
    #[error("the federated identity belongs to another platform account")]
    IdentityConflict,
    #[error("the platform account already has another identity for this authority")]
    AuthorityConflict,
    #[error("federated identity binding persistence failed")]
    Persistence {
        #[source]
        source: sqlx::Error,
    },
}

pub(crate) async fn bind_federated_identity(
    connection: &mut PgConnection,
    user_id: Uuid,
    authority_kind: LoginAuthorityKind,
    authority_id: &str,
    subject: &str,
    now: chrono::DateTime<Utc>,
) -> Result<(), BindFederatedIdentityError> {
    let stored = federated_account_persistence::bind_identity(
        connection,
        user_id,
        authority_kind,
        authority_id,
        subject,
        now,
    )
    .await
    .map_err(|source| {
        if is_unique_constraint_violation(&source, "user_login_identities_user_authority_key") {
            BindFederatedIdentityError::AuthorityConflict
        } else {
            BindFederatedIdentityError::Persistence { source }
        }
    })?;
    if stored {
        Ok(())
    } else {
        Err(BindFederatedIdentityError::IdentityConflict)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RemoveFederatedIdentityOutcome {
    NotBound,
    Removed,
    LastLoginMethod,
}

pub(crate) async fn remove_federated_identity(
    connection: &mut PgConnection,
    user_id: Uuid,
    authority_kind: LoginAuthorityKind,
    authority_id: &str,
    subject: &str,
) -> Result<RemoveFederatedIdentityOutcome, sqlx::Error> {
    federated_account_persistence::remove_identity_if_redundant(
        connection,
        user_id,
        authority_kind,
        authority_id,
        subject,
    )
    .await
}

async fn grant_site_admin(
    db: &PgPool,
    user_id: Uuid,
) -> Result<(), ProvisionFederatedAccountError> {
    let mut transaction =
        db.begin()
            .await
            .map_err(|source| ProvisionFederatedAccountError::Persistence {
                stage: ProvisionFederatedAccountStage::BeginAdministratorGrant,
                user_id: Some(user_id),
                source,
            })?;
    grant_site_admin_membership(&mut transaction, user_id, Utc::now())
        .await
        .map_err(|source| ProvisionFederatedAccountError::Persistence {
            stage: ProvisionFederatedAccountStage::GrantAdministrator,
            user_id: Some(user_id),
            source,
        })?;
    transaction
        .commit()
        .await
        .map_err(|source| ProvisionFederatedAccountError::Persistence {
            stage: ProvisionFederatedAccountStage::CommitAdministratorGrant,
            user_id: Some(user_id),
            source,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

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
    async fn the_same_subject_from_different_identity_authorities_creates_distinct_users(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let suffix = Uuid::new_v4().simple().to_string();
        let subject = format!("shared-subject-{suffix}");
        let first = provision_federated_account(
            &pool,
            ProvisionFederatedAccountCommand {
                email: &format!("first-{suffix}@example.test"),
                display_name: "First identity",
                authority_kind: LoginAuthorityKind::Oidc,
                authority_id: "https://identity-one.example.test",
                subject: &subject,
                username_seed: &format!("first-{suffix}"),
            },
        )
        .await?;
        let second = provision_federated_account(
            &pool,
            ProvisionFederatedAccountCommand {
                email: &format!("second-{suffix}@example.test"),
                display_name: "Second identity",
                authority_kind: LoginAuthorityKind::Oidc,
                authority_id: "https://identity-two.example.test",
                subject: &subject,
                username_seed: &format!("second-{suffix}"),
            },
        )
        .await?;

        assert_ne!(first, second);
        Ok(())
    }

    #[tokio::test]
    async fn email_equality_does_not_merge_distinct_login_identities(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let local_user_id = Uuid::new_v4();
        let suffix = local_user_id.simple().to_string();
        let email = format!("identity-conflict-{suffix}@example.test");
        sqlx::query(
            "insert into users (id, email, username, display_name, created_at)
             values ($1, $2, $3, 'Local identity', $4)",
        )
        .bind(local_user_id)
        .bind(&email)
        .bind(format!("local-{suffix}"))
        .bind(Utc::now())
        .execute(&pool)
        .await?;

        let provider_email = email.to_uppercase();
        let result = provision_federated_account(
            &pool,
            ProvisionFederatedAccountCommand {
                email: &provider_email,
                display_name: "Federated identity",
                authority_kind: LoginAuthorityKind::ExternalGit,
                authority_id: "github",
                subject: &format!("github-{suffix}"),
                username_seed: &format!("github-{suffix}"),
            },
        )
        .await;

        assert!(matches!(
            result,
            Err(ProvisionFederatedAccountError::EmailConflict)
        ));
        Ok(())
    }

    #[tokio::test]
    async fn one_platform_account_can_bind_distinct_identity_authorities(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let user_id = Uuid::new_v4();
        let suffix = user_id.simple().to_string();
        sqlx::query(
            "insert into users (id, email, username, display_name, created_at)
             values ($1, $2, $3, 'Multi-provider user', $4)",
        )
        .bind(user_id)
        .bind(format!("multi-{suffix}@example.test"))
        .bind(format!("multi-{suffix}"))
        .bind(Utc::now())
        .execute(&pool)
        .await?;
        let gitlab_account = format!("gitlab-{suffix}");
        let codeberg_account = format!("codeberg-{suffix}");
        let mut transaction = pool.begin().await?;
        bind_federated_identity(
            &mut transaction,
            user_id,
            LoginAuthorityKind::ExternalGit,
            "gitlab-com",
            &gitlab_account,
            Utc::now(),
        )
        .await?;
        bind_federated_identity(
            &mut transaction,
            user_id,
            LoginAuthorityKind::ExternalGit,
            "codeberg",
            &codeberg_account,
            Utc::now(),
        )
        .await?;
        transaction.commit().await?;
        let mut replacement_transaction = pool.begin().await?;
        let replacement = bind_federated_identity(
            &mut replacement_transaction,
            user_id,
            LoginAuthorityKind::ExternalGit,
            "codeberg",
            &format!("another-codeberg-{suffix}"),
            Utc::now(),
        )
        .await;
        assert!(matches!(
            replacement,
            Err(BindFederatedIdentityError::AuthorityConflict)
        ));
        replacement_transaction.rollback().await?;
        let identity_count: i64 =
            sqlx::query_scalar("select count(*) from user_login_identities where user_id = $1")
                .bind(user_id)
                .fetch_one(&pool)
                .await?;
        assert_eq!(identity_count, 2);
        Ok(())
    }
}
