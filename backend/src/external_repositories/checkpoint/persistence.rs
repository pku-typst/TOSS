//! Outbound checkpoint queue and repository-link persistence.

use super::super::provider::ProviderInstanceId;
use super::{ExternalGitCheckpointPhase, ExternalGitCheckpointState};
use crate::external_repositories::{ExternalGitFailureCode, ExternalGitLinkStatus};
use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

#[derive(Debug)]
pub(crate) struct ClaimedCheckpoint {
    pub project_id: Uuid,
    pub attempt_count: i32,
}

pub(crate) struct CheckpointTarget {
    pub synced_workspace_version: Option<i64>,
    pub last_remote_sha: Option<String>,
    pub inbound_active: bool,
    pub queued_version: Option<i64>,
}

#[derive(Debug)]
pub(crate) struct CheckpointLink {
    pub linked_by_user_id: Uuid,
    pub clone_url: String,
    pub checkpoint_branch: String,
    pub last_remote_sha: Option<String>,
    pub captured_workspace_version: Option<i64>,
    pub checkpoint_sha: Option<String>,
    pub captured_at: Option<DateTime<Utc>>,
}

pub(crate) async fn record_project_activity(
    connection: &mut PgConnection,
    project_id: Uuid,
    actor_user_id: Option<Uuid>,
    guest_display_name: Option<&str>,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    if let Some(user_id) = actor_user_id {
        sqlx::query(
            "insert into external_git_pending_authors (project_id, user_id, touched_at)
             select link.project_id, $2, $3
             from external_git_project_links link
             where link.project_id = $1
             on conflict (project_id, user_id) do update set touched_at = excluded.touched_at",
        )
        .bind(project_id)
        .bind(user_id)
        .bind(now)
        .execute(&mut *connection)
        .await?;
    } else if let Some(display_name) = guest_display_name
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        sqlx::query(
            "insert into external_git_pending_guest_authors (project_id, display_name, touched_at)
             select link.project_id, $2, $3
             from external_git_project_links link
             where link.project_id = $1
             on conflict (project_id, display_name) do update set touched_at = excluded.touched_at",
        )
        .bind(project_id)
        .bind(display_name)
        .bind(now)
        .execute(connection)
        .await?;
    }
    Ok(())
}

pub(crate) async fn checkpoint_operation_exists(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<bool, sqlx::Error> {
    Ok(
        sqlx::query("select 1 from external_git_checkpoint_queue where project_id = $1")
            .bind(project_id)
            .fetch_optional(connection)
            .await?
            .is_some(),
    )
}

pub(crate) async fn checkpoint_operation_exists_for_update(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<bool, sqlx::Error> {
    Ok(
        sqlx::query("select 1 from external_git_checkpoint_queue where project_id = $1 for update")
            .bind(project_id)
            .fetch_optional(connection)
            .await?
            .is_some(),
    )
}

pub(crate) async fn resume_reauthorized_checkpoints(
    connection: &mut PgConnection,
    user_id: Uuid,
    provider_instance_id: &ProviderInstanceId,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update external_git_checkpoint_queue q
         set state = 'pending', phase = 'queued',
             next_attempt_at = $2, locked_at = null, last_error = null,
             updated_at = $2
         from external_git_project_links link
         where q.project_id = link.project_id
           and link.linked_by_user_id = $1
           and link.provider_instance_id = $3
           and q.state = 'paused'
           and q.last_error = $4",
    )
    .bind(user_id)
    .bind(now)
    .bind(provider_instance_id)
    .bind(ExternalGitFailureCode::GitAuthorizationRequired)
    .execute(connection)
    .await?;
    Ok(())
}

pub(crate) async fn claim_due(
    db: &PgPool,
    provider_instance_id: &ProviderInstanceId,
    now: DateTime<Utc>,
    stale_before: DateTime<Utc>,
) -> Result<Option<ClaimedCheckpoint>, sqlx::Error> {
    let row = sqlx::query(
        "with candidate as (
             select queue.project_id
             from external_git_checkpoint_queue queue
             join external_git_project_links link on link.project_id = queue.project_id
             where link.provider_instance_id = $3
               and ((queue.state = 'pending' and queue.next_attempt_at <= $1)
                 or (queue.state = 'retry_wait' and queue.next_attempt_at <= $1)
                 or (queue.state = 'processing' and queue.locked_at <= $2))
             order by queue.next_attempt_at asc, queue.created_at asc
             for update of queue skip locked
             limit 1
         )
         update external_git_checkpoint_queue q
         set state = 'processing', phase = 'snapshot',
             attempt_count = q.attempt_count + 1, last_attempt_at = $1,
             locked_at = $1, updated_at = $1
         from candidate c
         where q.project_id = c.project_id
         returning q.project_id, q.attempt_count",
    )
    .bind(now)
    .bind(stale_before)
    .bind(provider_instance_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| ClaimedCheckpoint {
        project_id: row.get("project_id"),
        attempt_count: row.get("attempt_count"),
    }))
}

pub(crate) async fn target_for_update(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<Option<CheckpointTarget>, sqlx::Error> {
    let row = sqlx::query(
        "select l.synced_workspace_version, l.last_remote_sha,
                exists (
                  select 1 from external_git_inbound_jobs inbound
                  where inbound.project_id = l.project_id
                    and inbound.state in ('pending', 'processing', 'retry_wait', 'paused')
                ) as inbound_active,
                q.target_workspace_version as queued_version
         from external_git_project_links l
         left join external_git_checkpoint_queue q on q.project_id = l.project_id
         where l.project_id = $1
         for update of l",
    )
    .bind(project_id)
    .fetch_optional(connection)
    .await?;
    Ok(row.map(|row| CheckpointTarget {
        synced_workspace_version: row.get("synced_workspace_version"),
        last_remote_sha: row.get("last_remote_sha"),
        inbound_active: row.get("inbound_active"),
        queued_version: row.get("queued_version"),
    }))
}

pub(crate) async fn resume_queue(
    connection: &mut PgConnection,
    project_id: Uuid,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update external_git_checkpoint_queue
         set state = 'pending', phase = case
               when checkpoint_sha is null then 'queued'
               else 'push_git'
             end,
             next_attempt_at = $2,
             locked_at = null, last_error = null, updated_at = $2
         where project_id = $1",
    )
    .bind(project_id)
    .bind(now)
    .execute(&mut *connection)
    .await?;
    sqlx::query(
        "update external_git_project_links
         set last_error = null, updated_at = $2
         where project_id = $1",
    )
    .bind(project_id)
    .bind(now)
    .execute(connection)
    .await?;
    Ok(())
}

pub(crate) async fn insert_queue(
    connection: &mut PgConnection,
    project_id: Uuid,
    target_workspace_version: i64,
    now: DateTime<Utc>,
) -> Result<Option<i64>, sqlx::Error> {
    sqlx::query_scalar(
        "insert into external_git_checkpoint_queue (
             project_id, target_workspace_version, next_attempt_at,
             state, phase, attempt_count,
             last_attempt_at, locked_at, last_error, created_at, updated_at
         )
         select l.project_id, $2, $3, 'pending', 'queued', 0,
                null, null, null, $3, $3
         from external_git_project_links l where l.project_id = $1
         on conflict (project_id) do update
         set state = 'pending',
             next_attempt_at = excluded.next_attempt_at,
             locked_at = null, last_error = null,
             updated_at = excluded.updated_at
         returning target_workspace_version",
    )
    .bind(project_id)
    .bind(target_workspace_version)
    .bind(now)
    .fetch_optional(connection)
    .await
}

pub(crate) async fn checkpoint_link(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Option<CheckpointLink>, sqlx::Error> {
    let row = sqlx::query(
        "select l.linked_by_user_id, l.clone_url,
                l.checkpoint_branch, l.last_remote_sha,
                q.captured_workspace_version, q.checkpoint_sha, q.captured_at
         from external_git_project_links l
         join external_git_checkpoint_queue q on q.project_id = l.project_id
         where l.project_id = $1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| CheckpointLink {
        linked_by_user_id: row.get("linked_by_user_id"),
        clone_url: row.get("clone_url"),
        checkpoint_branch: row.get("checkpoint_branch"),
        last_remote_sha: row.get("last_remote_sha"),
        captured_workspace_version: row.get("captured_workspace_version"),
        checkpoint_sha: row.get("checkpoint_sha"),
        captured_at: row.get("captured_at"),
    }))
}

pub(crate) async fn coauthor_ids(
    db: &PgPool,
    project_id: Uuid,
    connector_user_id: Uuid,
    captured_at: DateTime<Utc>,
) -> Result<Vec<Uuid>, sqlx::Error> {
    sqlx::query_scalar(
        "select a.user_id
         from external_git_pending_authors a
         where a.project_id = $1
           and a.user_id <> $2
           and a.touched_at <= $3
         order by a.touched_at asc
         limit 100",
    )
    .bind(project_id)
    .bind(connector_user_id)
    .bind(captured_at)
    .fetch_all(db)
    .await
}

pub(crate) async fn guest_coauthors(
    db: &PgPool,
    project_id: Uuid,
    captured_at: DateTime<Utc>,
) -> Result<Vec<String>, sqlx::Error> {
    let rows = sqlx::query(
        "select display_name
         from external_git_pending_guest_authors
         where project_id = $1
           and touched_at <= $2
         order by touched_at asc
         limit 100",
    )
    .bind(project_id)
    .bind(captured_at)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| row.get("display_name"))
        .collect())
}

pub(crate) async fn update_queue_phase(
    db: &PgPool,
    project_id: Uuid,
    phase: ExternalGitCheckpointPhase,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update external_git_checkpoint_queue
         set phase = $2, updated_at = $3
         where project_id = $1",
    )
    .bind(project_id)
    .bind(phase)
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}

pub(crate) async fn capture_checkpoint(
    db: &PgPool,
    project_id: Uuid,
    workspace_version: i64,
    checkpoint_sha: &str,
    captured_at: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update external_git_checkpoint_queue
         set phase = 'push_git', captured_workspace_version = $2,
             checkpoint_sha = $3, captured_at = $4, updated_at = $4
         where project_id = $1",
    )
    .bind(project_id)
    .bind(workspace_version)
    .bind(checkpoint_sha)
    .bind(captured_at)
    .execute(db)
    .await?;
    Ok(())
}

pub(crate) async fn complete_checkpoint(
    connection: &mut PgConnection,
    project_id: Uuid,
    workspace_version: i64,
    remote_sha: &str,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update external_git_project_links
         set status = 'active', synced_workspace_version = greatest(synced_workspace_version, $2),
             last_remote_sha = $3, last_error = null, updated_at = $4
         where project_id = $1",
    )
    .bind(project_id)
    .bind(workspace_version)
    .bind(remote_sha)
    .bind(now)
    .execute(&mut *connection)
    .await?;
    let queue = sqlx::query(
        "select captured_at
         from external_git_checkpoint_queue
         where project_id = $1
         for update",
    )
    .bind(project_id)
    .fetch_optional(&mut *connection)
    .await?;
    if let Some(queue) = queue {
        if let Some(captured_at) = queue.get::<Option<DateTime<Utc>>, _>("captured_at") {
            sqlx::query(
                "delete from external_git_pending_authors
                 where project_id = $1 and touched_at <= $2",
            )
            .bind(project_id)
            .bind(captured_at)
            .execute(&mut *connection)
            .await?;
            sqlx::query(
                "delete from external_git_pending_guest_authors
                 where project_id = $1 and touched_at <= $2",
            )
            .bind(project_id)
            .bind(captured_at)
            .execute(&mut *connection)
            .await?;
        }
        sqlx::query("delete from external_git_checkpoint_queue where project_id = $1")
            .bind(project_id)
            .execute(connection)
            .await?;
    }
    Ok(())
}

pub(crate) async fn fail_checkpoint(
    connection: &mut PgConnection,
    project_id: Uuid,
    queue_state: ExternalGitCheckpointState,
    link_status: ExternalGitLinkStatus,
    next_attempt_at: DateTime<Utc>,
    error_code: ExternalGitFailureCode,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update external_git_project_links
         set status = $2, last_error = $3, updated_at = $4
         where project_id = $1",
    )
    .bind(project_id)
    .bind(link_status)
    .bind(error_code)
    .bind(now)
    .execute(&mut *connection)
    .await?;
    sqlx::query(
        "update external_git_checkpoint_queue
         set state = $2, phase = 'queued', next_attempt_at = $3,
             locked_at = null, last_error = $4, updated_at = $5
         where project_id = $1",
    )
    .bind(project_id)
    .bind(queue_state)
    .bind(next_attempt_at)
    .bind(error_code)
    .bind(now)
    .execute(connection)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::{LatexEngine, ProjectName, ProjectType};

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
    async fn stale_checkpoint_claim_is_reacquired_without_losing_captured_commit(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let user_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        let suffix = user_id.simple().to_string();
        let provider = format!("recovery-{}", &suffix[..12]).parse::<ProviderInstanceId>()?;
        let now = Utc::now();
        let mut transaction = pool.begin().await?;
        sqlx::query(
            "insert into users (id, email, username, display_name, created_at)
             values ($1, $2, $3, 'Checkpoint recovery', $4)",
        )
        .bind(user_id)
        .bind(format!("{user_id}@example.test"))
        .bind(format!("checkpoint-{}", &suffix[..12]))
        .bind(now)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "insert into external_git_oauth_grants (
                 user_id, provider_instance_id, provider_account_id, provider_username,
                 encrypted_access_token, refresh_redirect_uri, scopes, status, created_at, updated_at
             ) values ($1, $2, $3, 'owner', '\\x01',
                       'https://collab.example.test/callback', '{}', 'active', $4, $4)",
        )
        .bind(user_id)
        .bind(&provider)
        .bind(user_id.to_string())
        .bind(now)
        .execute(&mut *transaction)
        .await?;
        let project_name = ProjectName::parse("Checkpoint recovery")?;
        let project = crate::workspace::CreateProjectGraph::empty(
            project_id,
            user_id,
            &project_name,
            ProjectType::Typst,
            LatexEngine::Pdftex,
            now,
        );
        crate::workspace::provision_project(&mut transaction, &project).await?;
        sqlx::query(
            "insert into external_git_project_links (
                 project_id, provider_instance_id, provider_repository_id, full_path,
                 web_url, clone_url, default_branch, checkpoint_branch, status,
                 linked_by_user_id, created_at, updated_at
             ) values ($1, $2, $3, 'tests/recovery',
                       'https://git.example.test/tests/recovery',
                       'https://git.example.test/tests/recovery.git', 'main', 'checkpoint',
                       'active', $4, $5, $5)",
        )
        .bind(project_id)
        .bind(&provider)
        .bind(Uuid::new_v4().to_string())
        .bind(user_id)
        .bind(now)
        .execute(&mut *transaction)
        .await?;
        let checkpoint_sha = "0123456789abcdef0123456789abcdef01234567";
        sqlx::query(
            "insert into external_git_checkpoint_queue (
                 project_id, target_workspace_version, captured_workspace_version,
                 checkpoint_sha, captured_at, next_attempt_at, state, phase,
                 attempt_count, last_attempt_at, locked_at, created_at, updated_at
             ) values ($1, 42, 42, $2, $3, $3, 'processing', 'push_git',
                       1, $3, $3, $3, $3)",
        )
        .bind(project_id)
        .bind(checkpoint_sha)
        .bind(now - chrono::Duration::minutes(5))
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;

        assert!(
            claim_due(&pool, &provider, now, now - chrono::Duration::minutes(10),)
                .await?
                .is_none()
        );
        sqlx::query(
            "update external_git_checkpoint_queue set locked_at = $2 where project_id = $1",
        )
        .bind(project_id)
        .bind(now - chrono::Duration::minutes(11))
        .execute(&pool)
        .await?;
        let claimed = claim_due(&pool, &provider, now, now - chrono::Duration::minutes(10))
            .await?
            .ok_or_else(|| std::io::Error::other("stale checkpoint was not reacquired"))?;
        assert_eq!(claimed.project_id, project_id);
        assert_eq!(claimed.attempt_count, 2);
        let (captured_version, captured_sha) = sqlx::query_as::<_, (Option<i64>, Option<String>)>(
            "select captured_workspace_version, checkpoint_sha
                 from external_git_checkpoint_queue where project_id = $1",
        )
        .bind(project_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(captured_version, Some(42));
        assert_eq!(captured_sha.as_deref(), Some(checkpoint_sha));

        sqlx::query("delete from projects where id = $1")
            .bind(project_id)
            .execute(&pool)
            .await?;
        sqlx::query("delete from users where id = $1")
            .bind(user_id)
            .execute(&pool)
            .await?;
        Ok(())
    }
}
