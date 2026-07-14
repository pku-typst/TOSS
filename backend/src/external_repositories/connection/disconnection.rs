//! Explicit removal of one user's provider account and repository grant.

use super::super::provider::ProviderInstanceId;
use super::persistence;
use crate::access::{
    remove_federated_identity, LoginAuthorityKind, RemoveFederatedIdentityOutcome,
};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
pub(crate) enum DisconnectExternalGitStage {
    Begin,
    LockGrant,
    InspectLinks,
    RemoveLoginIdentity,
    DeleteGrant,
    Commit,
}

#[derive(Debug, Error)]
pub(crate) enum DisconnectExternalGitError {
    #[error("external Git provider account is not connected")]
    NotConnected,
    #[error("external Git provider account is still used by {count} linked projects")]
    LinkedProjects { count: i64 },
    #[error("the external Git provider is the account's last login method")]
    LastLoginMethod,
    #[error("external Git provider disconnection failed during {stage:?}")]
    Persistence {
        stage: DisconnectExternalGitStage,
        #[source]
        source: sqlx::Error,
    },
}

pub(crate) async fn disconnect_external_git_account(
    db: &PgPool,
    user_id: Uuid,
    provider: &ProviderInstanceId,
) -> Result<(), DisconnectExternalGitError> {
    let mut transaction =
        db.begin()
            .await
            .map_err(|source| DisconnectExternalGitError::Persistence {
                stage: DisconnectExternalGitStage::Begin,
                source,
            })?;
    let provider_account_id =
        persistence::grant_account_for_update(&mut transaction, user_id, provider)
            .await
            .map_err(|source| DisconnectExternalGitError::Persistence {
                stage: DisconnectExternalGitStage::LockGrant,
                source,
            })?
            .ok_or(DisconnectExternalGitError::NotConnected)?;
    let linked_projects = persistence::linked_project_count(&mut transaction, user_id, provider)
        .await
        .map_err(|source| DisconnectExternalGitError::Persistence {
            stage: DisconnectExternalGitStage::InspectLinks,
            source,
        })?;
    if linked_projects > 0 {
        return Err(DisconnectExternalGitError::LinkedProjects {
            count: linked_projects,
        });
    }
    match remove_federated_identity(
        &mut transaction,
        user_id,
        LoginAuthorityKind::ExternalGit,
        provider.as_str(),
        &provider_account_id,
    )
    .await
    .map_err(|source| DisconnectExternalGitError::Persistence {
        stage: DisconnectExternalGitStage::RemoveLoginIdentity,
        source,
    })? {
        RemoveFederatedIdentityOutcome::LastLoginMethod => {
            return Err(DisconnectExternalGitError::LastLoginMethod);
        }
        RemoveFederatedIdentityOutcome::NotBound | RemoveFederatedIdentityOutcome::Removed => {}
    }
    if !persistence::delete_oauth_grant(&mut transaction, user_id, provider)
        .await
        .map_err(|source| DisconnectExternalGitError::Persistence {
            stage: DisconnectExternalGitStage::DeleteGrant,
            source,
        })?
    {
        return Err(DisconnectExternalGitError::NotConnected);
    }
    transaction
        .commit()
        .await
        .map_err(|source| DisconnectExternalGitError::Persistence {
            stage: DisconnectExternalGitStage::Commit,
            source,
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

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

    async fn provider_account(
        pool: &PgPool,
        with_local_login: bool,
    ) -> Result<(Uuid, ProviderInstanceId), Box<dyn std::error::Error + Send + Sync>> {
        let user_id = Uuid::new_v4();
        let suffix = user_id.simple().to_string();
        let provider_suffix = suffix.chars().take(8).collect::<String>();
        let provider = format!("provider-{provider_suffix}").parse::<ProviderInstanceId>()?;
        let now = Utc::now();
        sqlx::query(
            "insert into users (id, email, username, display_name, created_at)
             values ($1, $2, $3, 'Provider user', $4)",
        )
        .bind(user_id)
        .bind(format!("{suffix}@example.test"))
        .bind(format!("user-{suffix}"))
        .bind(now)
        .execute(pool)
        .await?;
        sqlx::query(
            "insert into user_login_identities (
                 user_id, authority_kind, authority_id, subject,
                 created_at, last_authenticated_at
             ) values ($1, 'external_git', $2, 'provider-account', $3, $3)",
        )
        .bind(user_id)
        .bind(&provider)
        .bind(now)
        .execute(pool)
        .await?;
        sqlx::query(
            "insert into external_git_oauth_grants (
                 user_id, provider_instance_id, provider_account_id, provider_username,
                 encrypted_access_token, refresh_redirect_uri, created_at, updated_at
             ) values ($1, $2, 'provider-account', 'provider-user', $3, $4, $5, $5)",
        )
        .bind(user_id)
        .bind(&provider)
        .bind(vec![1_u8])
        .bind("https://app.example.test/callback")
        .bind(now)
        .execute(pool)
        .await?;
        if with_local_login {
            sqlx::query(
                "insert into local_accounts (user_id, password_hash, created_at, updated_at)
                 values ($1, 'test-password-hash', $2, $2)",
            )
            .bind(user_id)
            .bind(now)
            .execute(pool)
            .await?;
        }
        Ok((user_id, provider))
    }

    #[tokio::test]
    async fn last_login_provider_cannot_be_disconnected(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let (user_id, provider) = provider_account(&pool, false).await?;

        let result = disconnect_external_git_account(&pool, user_id, &provider).await;

        assert!(matches!(
            result,
            Err(DisconnectExternalGitError::LastLoginMethod)
        ));
        let grant_count: i64 = sqlx::query_scalar(
            "select count(*) from external_git_oauth_grants
             where user_id = $1 and provider_instance_id = $2",
        )
        .bind(user_id)
        .bind(&provider)
        .fetch_one(&pool)
        .await?;
        assert_eq!(grant_count, 1);
        Ok(())
    }

    #[tokio::test]
    async fn provider_can_be_disconnected_when_local_login_remains(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let (user_id, provider) = provider_account(&pool, true).await?;

        disconnect_external_git_account(&pool, user_id, &provider).await?;

        let grant_count: i64 = sqlx::query_scalar(
            "select count(*) from external_git_oauth_grants
             where user_id = $1 and provider_instance_id = $2",
        )
        .bind(user_id)
        .bind(&provider)
        .fetch_one(&pool)
        .await?;
        assert_eq!(grant_count, 0);
        let identity_count: i64 = sqlx::query_scalar(
            "select count(*) from user_login_identities
             where user_id = $1 and authority_id = $2",
        )
        .bind(user_id)
        .bind(&provider)
        .fetch_one(&pool)
        .await?;
        assert_eq!(identity_count, 0);
        Ok(())
    }

    #[tokio::test]
    async fn concurrent_disconnects_preserve_one_login_method(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let (user_id, first_provider) = provider_account(&pool, false).await?;
        let second_provider = format!(
            "provider-{}",
            Uuid::new_v4()
                .simple()
                .to_string()
                .chars()
                .take(8)
                .collect::<String>()
        )
        .parse::<ProviderInstanceId>()?;
        let now = Utc::now();
        sqlx::query(
            "insert into user_login_identities (
                 user_id, authority_kind, authority_id, subject,
                 created_at, last_authenticated_at
             ) values ($1, 'external_git', $2, 'second-provider-account', $3, $3)",
        )
        .bind(user_id)
        .bind(&second_provider)
        .bind(now)
        .execute(&pool)
        .await?;
        sqlx::query(
            "insert into external_git_oauth_grants (
                 user_id, provider_instance_id, provider_account_id, provider_username,
                 encrypted_access_token, refresh_redirect_uri, created_at, updated_at
             ) values ($1, $2, 'second-provider-account', 'second-provider-user',
                       $3, $4, $5, $5)",
        )
        .bind(user_id)
        .bind(&second_provider)
        .bind(vec![2_u8])
        .bind("https://app.example.test/callback")
        .bind(now)
        .execute(&pool)
        .await?;

        let start = std::sync::Arc::new(tokio::sync::Barrier::new(3));
        let first = {
            let pool = pool.clone();
            let start = start.clone();
            tokio::spawn(async move {
                start.wait().await;
                disconnect_external_git_account(&pool, user_id, &first_provider).await
            })
        };
        let second = {
            let pool = pool.clone();
            let start = start.clone();
            tokio::spawn(async move {
                start.wait().await;
                disconnect_external_git_account(&pool, user_id, &second_provider).await
            })
        };
        start.wait().await;
        let (first_result, second_result) = tokio::join!(first, second);
        let results = [first_result?, second_result?];
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(DisconnectExternalGitError::LastLoginMethod)))
                .count(),
            1
        );
        let identity_count: i64 =
            sqlx::query_scalar("select count(*) from user_login_identities where user_id = $1")
                .bind(user_id)
                .fetch_one(&pool)
                .await?;
        let grant_count: i64 =
            sqlx::query_scalar("select count(*) from external_git_oauth_grants where user_id = $1")
                .bind(user_id)
                .fetch_one(&pool)
                .await?;
        assert_eq!(identity_count, 1);
        assert_eq!(grant_count, 1);
        Ok(())
    }
}
