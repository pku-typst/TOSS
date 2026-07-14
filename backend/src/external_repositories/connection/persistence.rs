//! External repository provider-grant persistence.

use super::super::provider::ProviderInstanceId;
use super::ExternalGitGrantStatus;
use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

pub(super) struct ConnectionGrantRecord {
    pub(super) status: ExternalGitGrantStatus,
    pub(super) account_id: String,
    pub(super) username: Option<String>,
    pub(super) scopes: Vec<String>,
    pub(super) expires_at: Option<DateTime<Utc>>,
    pub(super) login_identity: bool,
    pub(super) login_method_count: i64,
    pub(super) linked_project_count: i64,
}

pub(super) struct OAuthGrantSecretsRecord {
    pub(super) encrypted_access_token: Vec<u8>,
    pub(super) encrypted_refresh_token: Option<Vec<u8>>,
    pub(super) refresh_redirect_uri: String,
    pub(super) expires_at: Option<DateTime<Utc>>,
    pub(super) status: ExternalGitGrantStatus,
}

pub(super) struct UpsertOAuthGrantRecord<'a> {
    pub(super) user_id: Uuid,
    pub(super) provider_instance_id: &'a ProviderInstanceId,
    pub(super) provider_account_id: &'a str,
    pub(super) provider_username: &'a str,
    pub(super) encrypted_access_token: Vec<u8>,
    pub(super) encrypted_refresh_token: Option<Vec<u8>>,
    pub(super) refresh_redirect_uri: &'a str,
    pub(super) scopes: Vec<String>,
    pub(super) expires_at: Option<DateTime<Utc>>,
    pub(super) now: DateTime<Utc>,
}

pub(super) struct RefreshedOAuthGrantRecord<'a> {
    pub(super) user_id: Uuid,
    pub(super) provider_instance_id: &'a ProviderInstanceId,
    pub(super) previous_encrypted_access_token: &'a [u8],
    pub(super) previous_encrypted_refresh_token: Option<&'a [u8]>,
    pub(super) encrypted_access_token: Vec<u8>,
    pub(super) encrypted_refresh_token: Vec<u8>,
    pub(super) expires_at: Option<DateTime<Utc>>,
    pub(super) scopes: Vec<String>,
    pub(super) now: DateTime<Utc>,
}

pub(super) async fn connection_grant(
    db: &PgPool,
    user_id: Uuid,
    provider_instance_id: &ProviderInstanceId,
) -> Result<Option<ConnectionGrantRecord>, sqlx::Error> {
    let row = sqlx::query(
        "select g.provider_account_id, g.provider_username, g.scopes, g.expires_at, g.status,
                exists(
                    select 1 from user_login_identities i
                    where i.user_id = g.user_id
                      and i.authority_kind = 'external_git'
                      and i.authority_id = g.provider_instance_id
                      and i.subject = g.provider_account_id
                ) as login_identity,
                (select count(*) from user_login_identities i where i.user_id = g.user_id)
                  + (select count(*) from local_accounts l where l.user_id = g.user_id)
                  as login_method_count,
                (select count(*) from external_git_project_links p
                 where p.linked_by_user_id = g.user_id
                   and p.provider_instance_id = g.provider_instance_id)
                  as linked_project_count
         from external_git_oauth_grants g
         where g.user_id = $1 and g.provider_instance_id = $2",
    )
    .bind(user_id)
    .bind(provider_instance_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| ConnectionGrantRecord {
        status: row.get("status"),
        account_id: row.get("provider_account_id"),
        username: row.get("provider_username"),
        scopes: row.get("scopes"),
        expires_at: row.get("expires_at"),
        login_identity: row.get("login_identity"),
        login_method_count: row.get("login_method_count"),
        linked_project_count: row.get("linked_project_count"),
    }))
}

pub(super) async fn grant_account_for_update(
    connection: &mut PgConnection,
    user_id: Uuid,
    provider_instance_id: &ProviderInstanceId,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select provider_account_id from external_git_oauth_grants
         where user_id = $1 and provider_instance_id = $2
         for update",
    )
    .bind(user_id)
    .bind(provider_instance_id)
    .fetch_optional(connection)
    .await
}

pub(super) async fn linked_project_count(
    connection: &mut PgConnection,
    user_id: Uuid,
    provider_instance_id: &ProviderInstanceId,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "select count(*) from external_git_project_links
         where linked_by_user_id = $1 and provider_instance_id = $2",
    )
    .bind(user_id)
    .bind(provider_instance_id)
    .fetch_one(connection)
    .await
}

pub(super) async fn delete_oauth_grant(
    connection: &mut PgConnection,
    user_id: Uuid,
    provider_instance_id: &ProviderInstanceId,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "delete from external_git_oauth_grants
         where user_id = $1 and provider_instance_id = $2",
    )
    .bind(user_id)
    .bind(provider_instance_id)
    .execute(connection)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub(super) async fn user_id_for_provider_account(
    db: &PgPool,
    provider_instance_id: &ProviderInstanceId,
    provider_account_id: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar(
        "select user_id from external_git_oauth_grants
         where provider_instance_id = $1 and provider_account_id = $2",
    )
    .bind(provider_instance_id)
    .bind(provider_account_id)
    .fetch_optional(db)
    .await
}

pub(super) async fn upsert_oauth_grant(
    connection: &mut PgConnection,
    record: UpsertOAuthGrantRecord<'_>,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "insert into external_git_oauth_grants (
             user_id, provider_instance_id, provider_account_id, provider_username,
             encrypted_access_token, encrypted_refresh_token,
             refresh_redirect_uri, scopes, expires_at, status, last_error, created_at, updated_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', null, $10, $10)
         on conflict (user_id, provider_instance_id) do update set
             provider_username = excluded.provider_username,
             encrypted_access_token = excluded.encrypted_access_token,
             encrypted_refresh_token = excluded.encrypted_refresh_token,
             refresh_redirect_uri = excluded.refresh_redirect_uri,
             scopes = excluded.scopes,
             expires_at = excluded.expires_at,
             status = 'active',
             last_error = null,
             updated_at = excluded.updated_at
         where external_git_oauth_grants.provider_account_id = excluded.provider_account_id",
    )
    .bind(record.user_id)
    .bind(record.provider_instance_id)
    .bind(record.provider_account_id)
    .bind(record.provider_username)
    .bind(record.encrypted_access_token)
    .bind(record.encrypted_refresh_token)
    .bind(record.refresh_redirect_uri)
    .bind(record.scopes)
    .bind(record.expires_at)
    .bind(record.now)
    .execute(connection)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub(super) async fn oauth_grant(
    db: &PgPool,
    user_id: Uuid,
    provider_instance_id: &ProviderInstanceId,
) -> Result<Option<OAuthGrantSecretsRecord>, sqlx::Error> {
    let row = sqlx::query(
        "select encrypted_access_token, encrypted_refresh_token, refresh_redirect_uri,
                expires_at, status
         from external_git_oauth_grants
         where user_id = $1 and provider_instance_id = $2",
    )
    .bind(user_id)
    .bind(provider_instance_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| OAuthGrantSecretsRecord {
        encrypted_access_token: row.get("encrypted_access_token"),
        encrypted_refresh_token: row.get("encrypted_refresh_token"),
        refresh_redirect_uri: row.get("refresh_redirect_uri"),
        expires_at: row.get("expires_at"),
        status: row.get("status"),
    }))
}

pub(super) async fn mark_grant_reauthorization_required_if_current(
    db: &PgPool,
    user_id: Uuid,
    provider_instance_id: &ProviderInstanceId,
    previous_encrypted_access_token: &[u8],
    previous_encrypted_refresh_token: Option<&[u8]>,
    reason: &str,
    now: DateTime<Utc>,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "update external_git_oauth_grants
         set status = 'reauth_required', last_error = $2, updated_at = $3
         where user_id = $1 and provider_instance_id = $4 and status = 'active'
           and encrypted_access_token = $5
           and encrypted_refresh_token is not distinct from $6",
    )
    .bind(user_id)
    .bind(reason)
    .bind(now)
    .bind(provider_instance_id)
    .bind(previous_encrypted_access_token)
    .bind(previous_encrypted_refresh_token)
    .execute(db)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub(super) async fn mark_grant_reauthorization_required_in_pool(
    db: &PgPool,
    user_id: Uuid,
    provider_instance_id: &ProviderInstanceId,
    reason: &str,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update external_git_oauth_grants
         set status = 'reauth_required', last_error = $2, updated_at = $3
         where user_id = $1 and provider_instance_id = $4",
    )
    .bind(user_id)
    .bind(reason)
    .bind(now)
    .bind(provider_instance_id)
    .execute(db)
    .await?;
    Ok(())
}

pub(super) async fn update_refreshed_oauth_grant(
    db: &PgPool,
    record: RefreshedOAuthGrantRecord<'_>,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "update external_git_oauth_grants
         set encrypted_access_token = $2,
             encrypted_refresh_token = $3,
             expires_at = $4,
             scopes = case when cardinality($5::text[]) = 0 then scopes else $5 end,
             status = 'active', last_error = null, updated_at = $6
         where user_id = $1 and provider_instance_id = $7 and status = 'active'
           and encrypted_access_token = $8
           and encrypted_refresh_token is not distinct from $9",
    )
    .bind(record.user_id)
    .bind(record.encrypted_access_token)
    .bind(record.encrypted_refresh_token)
    .bind(record.expires_at)
    .bind(record.scopes)
    .bind(record.now)
    .bind(record.provider_instance_id)
    .bind(record.previous_encrypted_access_token)
    .bind(record.previous_encrypted_refresh_token)
    .execute(db)
    .await?;
    Ok(result.rows_affected() == 1)
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
    async fn oauth_refresh_compare_and_swap_does_not_overwrite_a_newer_token(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let user_id = Uuid::new_v4();
        let now = Utc::now();
        let username_suffix = user_id
            .simple()
            .to_string()
            .chars()
            .take(8)
            .collect::<String>();
        sqlx::query(
            "insert into users (id, email, username, display_name, created_at)
             values ($1, $2, $3, 'Owner', $4)",
        )
        .bind(user_id)
        .bind(format!("{user_id}@example.test"))
        .bind(format!("user-{username_suffix}"))
        .bind(now)
        .execute(&pool)
        .await?;
        let old_access = vec![1_u8, 2, 3];
        let old_refresh = vec![4_u8, 5, 6];
        let provider_instance_id = "gitlab".parse::<ProviderInstanceId>()?;
        let provider_account_id = user_id.to_string();
        let mut connection = pool.acquire().await?;
        upsert_oauth_grant(
            &mut connection,
            UpsertOAuthGrantRecord {
                user_id,
                provider_instance_id: &provider_instance_id,
                provider_account_id: &provider_account_id,
                provider_username: "owner",
                encrypted_access_token: old_access.clone(),
                encrypted_refresh_token: Some(old_refresh.clone()),
                refresh_redirect_uri:
                    "https://collab.example.test/v1/external-git/providers/gitlab/callback",
                scopes: vec!["api".to_string()],
                expires_at: None,
                now,
            },
        )
        .await?;
        drop(connection);

        let new_access = vec![7_u8, 8, 9];
        let new_refresh = vec![10_u8, 11, 12];
        assert!(
            update_refreshed_oauth_grant(
                &pool,
                RefreshedOAuthGrantRecord {
                    user_id,
                    provider_instance_id: &provider_instance_id,
                    previous_encrypted_access_token: &old_access,
                    previous_encrypted_refresh_token: Some(old_refresh.as_slice()),
                    encrypted_access_token: new_access.clone(),
                    encrypted_refresh_token: new_refresh.clone(),
                    expires_at: None,
                    scopes: vec!["api".to_string()],
                    now,
                },
            )
            .await?
        );
        assert!(
            !update_refreshed_oauth_grant(
                &pool,
                RefreshedOAuthGrantRecord {
                    user_id,
                    provider_instance_id: &provider_instance_id,
                    previous_encrypted_access_token: &old_access,
                    previous_encrypted_refresh_token: Some(old_refresh.as_slice()),
                    encrypted_access_token: vec![13_u8],
                    encrypted_refresh_token: vec![14_u8],
                    expires_at: None,
                    scopes: vec!["api".to_string()],
                    now,
                },
            )
            .await?
        );
        let stored = oauth_grant(&pool, user_id, &provider_instance_id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?;
        assert_eq!(stored.encrypted_access_token, new_access);
        assert_eq!(stored.encrypted_refresh_token, Some(new_refresh.clone()));
        assert!(
            !mark_grant_reauthorization_required_if_current(
                &pool,
                user_id,
                &provider_instance_id,
                &old_access,
                Some(old_refresh.as_slice()),
                "stale_refresh_rejected",
                now,
            )
            .await?
        );
        assert!(
            mark_grant_reauthorization_required_if_current(
                &pool,
                user_id,
                &provider_instance_id,
                &stored.encrypted_access_token,
                stored.encrypted_refresh_token.as_deref(),
                "current_refresh_rejected",
                now,
            )
            .await?
        );
        sqlx::query("delete from users where id = $1")
            .bind(user_id)
            .execute(&pool)
            .await?;
        Ok(())
    }

    #[tokio::test]
    async fn oauth_grants_are_independent_per_provider_instance(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let user_id = Uuid::new_v4();
        let suffix = user_id.simple().to_string();
        let now = Utc::now();
        sqlx::query(
            "insert into users (id, email, username, display_name, created_at)
             values ($1, $2, $3, 'Multi-provider owner', $4)",
        )
        .bind(user_id)
        .bind(format!("grant-{suffix}@example.test"))
        .bind(format!("grant-{suffix}"))
        .bind(now)
        .execute(&pool)
        .await?;
        let first = "gitlab-com".parse::<ProviderInstanceId>()?;
        let second = "codeberg".parse::<ProviderInstanceId>()?;
        let gitlab_account = format!("gitlab-{suffix}");
        let codeberg_account = format!("codeberg-{suffix}");
        let mut connection = pool.acquire().await?;
        for (provider, account) in [
            (&first, gitlab_account.as_str()),
            (&second, codeberg_account.as_str()),
        ] {
            assert!(
                upsert_oauth_grant(
                    &mut connection,
                    UpsertOAuthGrantRecord {
                        user_id,
                        provider_instance_id: provider,
                        provider_account_id: account,
                        provider_username: account,
                        encrypted_access_token: vec![1_u8],
                        encrypted_refresh_token: None,
                        refresh_redirect_uri: "https://app.example.test/callback",
                        scopes: Vec::new(),
                        expires_at: None,
                        now,
                    },
                )
                .await?
            );
        }
        drop(connection);
        let grant_count: i64 =
            sqlx::query_scalar("select count(*) from external_git_oauth_grants where user_id = $1")
                .bind(user_id)
                .fetch_one(&pool)
                .await?;
        assert_eq!(grant_count, 2);
        Ok(())
    }
}
