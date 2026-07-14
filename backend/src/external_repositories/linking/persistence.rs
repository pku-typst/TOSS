//! Repository-link persistence and project-status projection.

use super::ExternalGitLinkStatus;
use crate::external_repositories::{
    ExternalGitCheckpointPhase, ExternalGitCheckpointState, ExternalGitFailureCode,
    ExternalGitGrantStatus, ProviderInstanceId,
};
use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

pub(super) struct UnlinkedRepositoryRecord {
    pub(super) provider_instance_id: ProviderInstanceId,
    pub(super) repository_id: String,
    pub(super) full_path: String,
}

pub(super) struct LinkedRepositoryRecord {
    pub(super) provider_instance_id: ProviderInstanceId,
    pub(super) repository_id: String,
    pub(super) linked_by_user_id: Uuid,
}

pub(super) struct InsertRepositoryLinkRecord<'a> {
    pub(super) project_id: Uuid,
    pub(super) provider_instance_id: ProviderInstanceId,
    pub(super) repository_id: &'a str,
    pub(super) full_path: &'a str,
    pub(super) web_url: &'a str,
    pub(super) clone_url: &'a str,
    pub(super) default_branch: &'a str,
    pub(super) checkpoint_branch: &'a str,
    pub(super) actor_user_id: Uuid,
    pub(super) now: DateTime<Utc>,
}

#[derive(Default)]
pub(super) struct ProjectStatusRecord {
    pub(super) provider_instance_id: Option<ProviderInstanceId>,
    pub(super) repository_id: Option<String>,
    pub(super) full_path: Option<String>,
    pub(super) web_url: Option<String>,
    pub(super) default_branch: Option<String>,
    pub(super) checkpoint_branch: Option<String>,
    pub(super) synced_workspace_version: i64,
    pub(super) link_status: Option<ExternalGitLinkStatus>,
    pub(super) last_remote_sha: Option<String>,
    pub(super) last_import_branch: Option<String>,
    pub(super) last_import_sha: Option<String>,
    pub(super) last_import_at: Option<DateTime<Utc>>,
    pub(super) last_import_error: Option<ExternalGitFailureCode>,
    pub(super) last_error: Option<ExternalGitFailureCode>,
    pub(super) updated_at: Option<DateTime<Utc>>,
    pub(super) grant_status: Option<ExternalGitGrantStatus>,
    pub(super) connector_username: Option<String>,
    pub(super) queue_state: Option<ExternalGitCheckpointState>,
    pub(super) sync_phase: Option<ExternalGitCheckpointPhase>,
    pub(super) next_attempt_at: Option<DateTime<Utc>>,
}

pub(super) struct UpsertRepositoryLinkRecord<'a> {
    pub(super) project_id: Uuid,
    pub(super) provider_instance_id: ProviderInstanceId,
    pub(super) repository_id: &'a str,
    pub(super) full_path: &'a str,
    pub(super) web_url: &'a str,
    pub(super) clone_url: &'a str,
    pub(super) default_branch: &'a str,
    pub(super) checkpoint_branch: &'a str,
    pub(super) actor_user_id: Uuid,
    pub(super) now: DateTime<Utc>,
}

pub(super) async fn resume_reauthorized_links(
    connection: &mut PgConnection,
    user_id: Uuid,
    provider_instance_id: &ProviderInstanceId,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update external_git_project_links
         set status = case
               when synced_workspace_version > 0 then 'active'
               else 'linking'
             end,
             last_error = null,
             updated_at = $2
         where linked_by_user_id = $1
           and provider_instance_id = $3
           and status = 'reauth_required'",
    )
    .bind(user_id)
    .bind(now)
    .bind(provider_instance_id)
    .execute(connection)
    .await?;
    Ok(())
}

pub(super) async fn repository_link_exists(
    db: &PgPool,
    project_id: Uuid,
) -> Result<bool, sqlx::Error> {
    Ok(
        sqlx::query("select 1 from external_git_project_links where project_id = $1")
            .bind(project_id)
            .fetch_optional(db)
            .await?
            .is_some(),
    )
}

pub(super) async fn repository_link(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Option<LinkedRepositoryRecord>, sqlx::Error> {
    let row = sqlx::query(
        "select provider_instance_id, provider_repository_id, linked_by_user_id
         from external_git_project_links
         where project_id = $1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| LinkedRepositoryRecord {
        provider_instance_id: row.get("provider_instance_id"),
        repository_id: row.get("provider_repository_id"),
        linked_by_user_id: row.get("linked_by_user_id"),
    }))
}

pub(super) async fn insert_repository_link(
    connection: &mut PgConnection,
    record: InsertRepositoryLinkRecord<'_>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into external_git_project_links (
             project_id, provider_instance_id, provider_repository_id,
             full_path, web_url, clone_url,
             default_branch, checkpoint_branch, status, synced_workspace_version,
             last_remote_sha, last_error, linked_by_user_id, created_at, updated_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'linking', 0, null, null, $9, $10, $10)",
    )
    .bind(record.project_id)
    .bind(record.provider_instance_id)
    .bind(record.repository_id)
    .bind(record.full_path)
    .bind(record.web_url)
    .bind(record.clone_url)
    .bind(record.default_branch)
    .bind(record.checkpoint_branch)
    .bind(record.actor_user_id)
    .bind(record.now)
    .execute(connection)
    .await?;
    Ok(())
}

pub(super) async fn upsert_repository_link(
    db: &PgPool,
    record: UpsertRepositoryLinkRecord<'_>,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "insert into external_git_project_links (
             project_id, provider_instance_id, provider_repository_id,
             full_path, web_url, clone_url,
             default_branch, checkpoint_branch, status, synced_workspace_version,
             last_remote_sha, last_error, linked_by_user_id, created_at, updated_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'linking', 0, null, null, $9, $10, $10)
         on conflict (project_id) do update set
             provider_instance_id = excluded.provider_instance_id,
             provider_repository_id = excluded.provider_repository_id,
             full_path = excluded.full_path,
             web_url = excluded.web_url,
             clone_url = excluded.clone_url,
             default_branch = excluded.default_branch,
             checkpoint_branch = excluded.checkpoint_branch,
             status = 'linking',
             last_error = null,
             linked_by_user_id = excluded.linked_by_user_id,
             updated_at = excluded.updated_at
         where external_git_project_links.provider_instance_id = excluded.provider_instance_id
           and external_git_project_links.provider_repository_id = excluded.provider_repository_id",
    )
    .bind(record.project_id)
    .bind(record.provider_instance_id)
    .bind(record.repository_id)
    .bind(record.full_path)
    .bind(record.web_url)
    .bind(record.clone_url)
    .bind(record.default_branch)
    .bind(record.checkpoint_branch)
    .bind(record.actor_user_id)
    .bind(record.now)
    .execute(db)
    .await?;
    Ok(result.rows_affected() > 0)
}

pub(super) async fn delete_repository_link(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<Option<UnlinkedRepositoryRecord>, sqlx::Error> {
    let row = sqlx::query(
        "delete from external_git_project_links
         where project_id = $1
         returning provider_instance_id, provider_repository_id, full_path",
    )
    .bind(project_id)
    .fetch_optional(connection)
    .await?;
    Ok(row.map(|row| UnlinkedRepositoryRecord {
        provider_instance_id: row.get("provider_instance_id"),
        repository_id: row.get("provider_repository_id"),
        full_path: row.get("full_path"),
    }))
}

pub(super) async fn project_status(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Option<ProjectStatusRecord>, sqlx::Error> {
    let row = sqlx::query(
        "select l.provider_instance_id, l.provider_repository_id, l.full_path, l.web_url, l.default_branch,
                l.checkpoint_branch, l.synced_workspace_version, l.status, l.last_remote_sha,
                l.last_import_branch, l.last_import_sha, l.last_import_at, l.last_import_error,
                l.last_error, l.updated_at, g.status as grant_status,
                g.provider_username as connector_username,
                q.state as queue_state, q.phase as sync_phase, q.next_attempt_at
         from external_git_project_links l
         left join external_git_oauth_grants g
           on g.user_id = l.linked_by_user_id and g.provider_instance_id = l.provider_instance_id
         left join external_git_checkpoint_queue q on q.project_id = l.project_id
         where l.project_id = $1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| ProjectStatusRecord {
        provider_instance_id: row.get("provider_instance_id"),
        repository_id: row.get("provider_repository_id"),
        full_path: row.get("full_path"),
        web_url: row.get("web_url"),
        default_branch: row.get("default_branch"),
        checkpoint_branch: row.get("checkpoint_branch"),
        synced_workspace_version: row
            .get::<Option<i64>, _>("synced_workspace_version")
            .unwrap_or(0),
        link_status: row.get("status"),
        last_remote_sha: row.get("last_remote_sha"),
        last_import_branch: row.get("last_import_branch"),
        last_import_sha: row.get("last_import_sha"),
        last_import_at: row.get("last_import_at"),
        last_import_error: row.get("last_import_error"),
        last_error: row.get("last_error"),
        updated_at: row.get("updated_at"),
        grant_status: row.get("grant_status"),
        connector_username: row.get("connector_username"),
        queue_state: row.get("queue_state"),
        sync_phase: row.get("sync_phase"),
        next_attempt_at: row.get("next_attempt_at"),
    }))
}
