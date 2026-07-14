use super::local_repository::project_repository_path;
use super::state::GitSyncState;
use super::{GitRepositoryConfig, GitSyncStatus, LiveRevisionSyncState};
use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

pub(crate) async fn load_live_sync_state(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Option<LiveRevisionSyncState>, sqlx::Error> {
    let row = sqlx::query(
        "select pending_sync, last_server_sync_at
         from git_repositories
         where project_id = $1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| LiveRevisionSyncState {
        pending_sync: row.get("pending_sync"),
        last_server_sync_at: row.get("last_server_sync_at"),
    }))
}

pub(crate) async fn load_repository(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Option<GitRepositoryConfig>, sqlx::Error> {
    sqlx::query_as::<_, GitRepositoryConfig>(
        "select local_path, default_branch, pending_sync
         from git_repositories
         where project_id = $1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await
}

pub(crate) async fn ensure_repository(
    db: &PgPool,
    project_id: Uuid,
    now: DateTime<Utc>,
) -> Result<Option<String>, sqlx::Error> {
    let local_path = project_repository_path(project_id)
        .to_string_lossy()
        .to_string();
    sqlx::query(
        "insert into git_repositories (
             project_id, remote_url, local_path, default_branch, pending_sync, updated_at
         ) values ($1, null, $2, 'main', true, $3)
         on conflict (project_id) do nothing",
    )
    .bind(project_id)
    .bind(local_path)
    .bind(now)
    .execute(db)
    .await?;
    sqlx::query_scalar::<_, String>("select local_path from git_repositories where project_id = $1")
        .bind(project_id)
        .fetch_optional(db)
        .await
}

pub(crate) async fn mark_repository_pending(
    db: &PgPool,
    project_id: Uuid,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update git_repositories
         set pending_sync = true, updated_at = $2
         where project_id = $1",
    )
    .bind(project_id)
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}

pub(crate) async fn repository_pending_sync(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<Option<bool>, sqlx::Error> {
    sqlx::query_scalar::<_, bool>("select pending_sync from git_repositories where project_id = $1")
        .bind(project_id)
        .fetch_optional(connection)
        .await
}

pub(crate) async fn find_sync_state(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Option<GitSyncState>, sqlx::Error> {
    let row = sqlx::query(
        "select project_id, branch, last_pull_at, last_push_at, has_conflicts, status
         from git_sync_states
         where project_id = $1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    row.map(|value| {
        Ok(GitSyncState {
            project_id: value.try_get("project_id")?,
            branch: value.try_get("branch")?,
            last_pull_at: value.try_get("last_pull_at")?,
            last_push_at: value.try_get("last_push_at")?,
            has_conflicts: value.try_get("has_conflicts")?,
            status: value.try_get("status")?,
        })
    })
    .transpose()
}

pub(crate) async fn pending_author_ids(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Vec<Uuid>, sqlx::Error> {
    sqlx::query_scalar(
        "select user_id
         from git_pending_authors
         where project_id = $1
         order by touched_at asc",
    )
    .bind(project_id)
    .fetch_all(db)
    .await
}

pub(crate) async fn pending_guest_names(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar::<_, String>(
        "select display_name
         from git_pending_guest_authors
         where project_id = $1
         order by touched_at asc",
    )
    .bind(project_id)
    .fetch_all(db)
    .await
}

pub(crate) async fn mark_repository_synced(
    connection: &mut PgConnection,
    project_id: Uuid,
    synced_at: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update git_repositories
         set pending_sync = false, last_server_sync_at = $2
         where project_id = $1",
    )
    .bind(project_id)
    .bind(synced_at)
    .execute(connection)
    .await?;
    Ok(())
}

pub(crate) async fn set_repository_sync_state(
    connection: &mut PgConnection,
    project_id: Uuid,
    pending_sync: bool,
    synced_at: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update git_repositories
         set pending_sync = $2, last_server_sync_at = $3
         where project_id = $1",
    )
    .bind(project_id)
    .bind(pending_sync)
    .bind(synced_at)
    .execute(connection)
    .await?;
    Ok(())
}

pub(crate) async fn update_sync_state(
    connection: &mut PgConnection,
    project_id: Uuid,
    status: GitSyncStatus,
    has_conflicts: bool,
    last_pull_at: Option<DateTime<Utc>>,
    last_push_at: Option<DateTime<Utc>>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update git_sync_states
         set status = $2,
             has_conflicts = $3,
             last_pull_at = coalesce($4, last_pull_at),
             last_push_at = coalesce($5, last_push_at)
         where project_id = $1",
    )
    .bind(project_id)
    .bind(status)
    .bind(has_conflicts)
    .bind(last_pull_at)
    .bind(last_push_at)
    .execute(connection)
    .await?;
    Ok(())
}

pub(crate) async fn clear_pending_authors(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("delete from git_pending_authors where project_id = $1")
        .bind(project_id)
        .execute(&mut *connection)
        .await?;
    sqlx::query("delete from git_pending_guest_authors where project_id = $1")
        .bind(project_id)
        .execute(connection)
        .await?;
    Ok(())
}

pub(crate) async fn clear_queue_item(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("delete from project_sync_queue where project_id = $1")
        .bind(project_id)
        .execute(connection)
        .await?;
    Ok(())
}

pub(crate) async fn list_due_projects(
    db: &PgPool,
    limit: i64,
    due_before: DateTime<Utc>,
) -> Result<Vec<Uuid>, sqlx::Error> {
    sqlx::query_scalar::<_, Uuid>(
        "select project_id
         from project_sync_queue
         where dirty_since <= $2
         order by dirty_since asc
         limit $1",
    )
    .bind(limit)
    .bind(due_before)
    .fetch_all(db)
    .await
}

pub(crate) async fn mark_sync_attempt(
    db: &PgPool,
    project_id: Uuid,
    attempted_at: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update project_sync_queue
         set last_attempt_at = $2,
             attempt_count = attempt_count + 1
         where project_id = $1",
    )
    .bind(project_id)
    .bind(attempted_at)
    .execute(db)
    .await?;
    Ok(())
}

pub(crate) async fn record_sync_failure(
    db: &PgPool,
    project_id: Uuid,
    error_message: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update project_sync_queue
         set last_error = $2
         where project_id = $1",
    )
    .bind(project_id)
    .bind(error_message)
    .execute(db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::versioning::{
        MaterializedWorkspaceCompletion, WorkspaceChangeKind, WorkspaceContributor,
    };
    use crate::workspace::{LatexEngine, ProjectType};

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
    async fn stale_materialization_keeps_new_workspace_activity_pending(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let user_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        let now = Utc::now();
        let username_suffix = user_id
            .simple()
            .to_string()
            .chars()
            .take(8)
            .collect::<String>();
        let mut transaction = pool.begin().await?;
        sqlx::query(
            "insert into users (id, email, username, display_name, created_at)
             values ($1, $2, $3, 'Versioning Owner', $4)",
        )
        .bind(user_id)
        .bind(format!("{user_id}@example.test"))
        .bind(format!("user-{username_suffix}"))
        .bind(now)
        .execute(&mut *transaction)
        .await?;
        let project_name = crate::workspace::ProjectName::parse("Versioning CAS test")?;
        let project = crate::workspace::CreateProjectGraph::empty(
            project_id,
            user_id,
            &project_name,
            ProjectType::Typst,
            LatexEngine::Pdftex,
            now,
        );
        crate::workspace::provision_project(&mut transaction, &project).await?;
        crate::workspace::advance_workspace_version(&mut transaction, project_id).await?;
        crate::versioning::record_workspace_change(
            &mut transaction,
            project_id,
            WorkspaceContributor::User(user_id),
            WorkspaceChangeKind::Incremental,
            now,
        )
        .await?;
        transaction.commit().await?;

        assert_eq!(
            crate::versioning::complete_materialized_workspace_sync(&pool, project_id, 0).await?,
            MaterializedWorkspaceCompletion::WorkspaceChanged
        );
        let pending_after_stale = sqlx::query_as::<_, (bool, i64, i64)>(
            "select repository.pending_sync,
                    (select count(*) from project_sync_queue queue where queue.project_id = $1),
                    (select count(*) from git_pending_authors author where author.project_id = $1)
             from git_repositories repository
             where repository.project_id = $1",
        )
        .bind(project_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(pending_after_stale, (true, 1, 1));

        assert_eq!(
            crate::versioning::complete_materialized_workspace_sync(&pool, project_id, 1).await?,
            MaterializedWorkspaceCompletion::Completed
        );
        let pending_after_current = sqlx::query_as::<_, (bool, i64, i64)>(
            "select repository.pending_sync,
                    (select count(*) from project_sync_queue queue where queue.project_id = $1),
                    (select count(*) from git_pending_authors author where author.project_id = $1)
             from git_repositories repository
             where repository.project_id = $1",
        )
        .bind(project_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(pending_after_current, (false, 0, 0));

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
