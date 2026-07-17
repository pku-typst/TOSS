//! Inbound import and synchronization persistence.

use super::super::provider::ProviderInstanceId;
use super::{ExternalGitInboundOperation, ExternalGitInboundPhase, ExternalGitJobState};
use crate::external_repositories::ExternalGitFailureCode;
use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

pub(crate) struct InboundJobRecord {
    pub id: Uuid,
    pub project_id: Uuid,
    pub provider_instance_id: ProviderInstanceId,
    pub operation: ExternalGitInboundOperation,
    pub source_branch: String,
    pub state: ExternalGitJobState,
    pub phase: ExternalGitInboundPhase,
    pub attempt_count: i32,
    pub remote_sha: Option<String>,
    pub last_error: Option<ExternalGitFailureCode>,
    pub next_attempt_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug)]
pub(crate) struct ClaimedInboundJob {
    pub id: Uuid,
    pub project_id: Uuid,
    pub attempt_count: i32,
    pub phase: ExternalGitInboundPhase,
    pub remote_sha: Option<String>,
    pub applied_workspace_version: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AppliedInboundJob {
    pub remote_sha: String,
    pub workspace_version: i64,
}

impl ClaimedInboundJob {
    pub(crate) fn applied_state(&self) -> Option<AppliedInboundJob> {
        if self.phase != ExternalGitInboundPhase::Revision {
            return None;
        }
        Some(AppliedInboundJob {
            remote_sha: self.remote_sha.clone()?,
            workspace_version: self.applied_workspace_version?,
        })
    }
}

#[derive(Debug)]
pub(crate) struct InboundJobLink {
    pub id: Uuid,
    pub project_id: Uuid,
    pub operation: ExternalGitInboundOperation,
    pub source_branch: String,
    pub requested_by_user_id: Uuid,
    pub linked_by_user_id: Uuid,
    pub clone_url: String,
    pub full_path: String,
}

pub(crate) struct InsertInboundJobRecord<'a> {
    pub job_id: Uuid,
    pub project_id: Uuid,
    pub provider_instance_id: &'a ProviderInstanceId,
    pub operation: ExternalGitInboundOperation,
    pub source_branch: &'a str,
    pub requested_by_user_id: Uuid,
    pub now: DateTime<Utc>,
}

pub(crate) async fn resume_reauthorized_jobs(
    connection: &mut PgConnection,
    user_id: Uuid,
    provider_instance_id: &ProviderInstanceId,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update external_git_inbound_jobs job
         set state = 'pending', phase = 'queued', next_attempt_at = $2,
             locked_at = null, last_error = null, updated_at = $2
         from external_git_project_links link
         where job.project_id = link.project_id
           and link.linked_by_user_id = $1
           and link.provider_instance_id = $3
           and job.state = 'paused'
           and job.last_error = $4",
    )
    .bind(user_id)
    .bind(now)
    .bind(provider_instance_id)
    .bind(ExternalGitFailureCode::GitAuthorizationRequired)
    .execute(connection)
    .await?;
    Ok(())
}

pub(crate) async fn active_job_exists(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let row = sqlx::query(
        "select exists (
             select 1 from external_git_inbound_jobs
             where project_id = $1
               and state in ('pending', 'processing', 'retry_wait', 'paused')
         ) as active",
    )
    .bind(project_id)
    .fetch_one(connection)
    .await?;
    Ok(row.get("active"))
}

pub(crate) async fn insert_inbound_job(
    connection: &mut PgConnection,
    record: InsertInboundJobRecord<'_>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into external_git_inbound_jobs (
             id, project_id, provider_instance_id, operation, source_branch, requested_by_user_id,
             state, phase, attempt_count, next_attempt_at, created_at, updated_at
         ) values ($1, $2, $3, $4, $5, $6, 'pending', 'queued', 0, $7, $7, $7)",
    )
    .bind(record.job_id)
    .bind(record.project_id)
    .bind(record.provider_instance_id)
    .bind(record.operation)
    .bind(record.source_branch)
    .bind(record.requested_by_user_id)
    .bind(record.now)
    .execute(connection)
    .await?;
    Ok(())
}

pub(crate) async fn clear_last_import_error(
    connection: &mut PgConnection,
    project_id: Uuid,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update external_git_project_links
         set last_import_error = null, updated_at = $2
         where project_id = $1",
    )
    .bind(project_id)
    .bind(now)
    .execute(connection)
    .await?;
    Ok(())
}

pub(crate) async fn record_link_import(
    connection: &mut PgConnection,
    project_id: Uuid,
    source_branch: &str,
    remote_sha: &str,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update external_git_project_links
         set last_import_branch = $2,
             last_import_sha = $3,
             last_import_at = $4,
             last_import_error = null,
             updated_at = $4
         where project_id = $1",
    )
    .bind(project_id)
    .bind(source_branch)
    .bind(remote_sha)
    .bind(now)
    .execute(connection)
    .await?;
    Ok(())
}

pub(crate) async fn inbound_job(
    db: &PgPool,
    job_id: Uuid,
) -> Result<Option<InboundJobRecord>, sqlx::Error> {
    let row = sqlx::query(
        "select id, project_id, provider_instance_id, operation, source_branch, state, phase,
                attempt_count, remote_sha, last_error, next_attempt_at,
                created_at, updated_at, completed_at
         from external_git_inbound_jobs
         where id = $1",
    )
    .bind(job_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(inbound_job_from_row))
}

pub(crate) async fn latest_inbound_job(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Option<InboundJobRecord>, sqlx::Error> {
    let row = sqlx::query(
        "select id, project_id, provider_instance_id, operation, source_branch, state, phase,
                attempt_count, remote_sha, last_error, next_attempt_at,
                created_at, updated_at, completed_at
         from external_git_inbound_jobs
         where project_id = $1
         order by created_at desc
         limit 1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(inbound_job_from_row))
}

fn inbound_job_from_row(row: sqlx::postgres::PgRow) -> InboundJobRecord {
    InboundJobRecord {
        id: row.get("id"),
        project_id: row.get("project_id"),
        provider_instance_id: row.get("provider_instance_id"),
        operation: row.get("operation"),
        source_branch: row.get("source_branch"),
        state: row.get("state"),
        phase: row.get("phase"),
        attempt_count: row.get("attempt_count"),
        remote_sha: row.get("remote_sha"),
        last_error: row.get("last_error"),
        next_attempt_at: row.get("next_attempt_at"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        completed_at: row.get("completed_at"),
    }
}

pub(crate) async fn claim_due_job(
    db: &PgPool,
    provider_instance_id: &ProviderInstanceId,
    now: DateTime<Utc>,
    stale_before: DateTime<Utc>,
) -> Result<Option<ClaimedInboundJob>, sqlx::Error> {
    let row = sqlx::query(
        "with candidate as (
             select id
             from external_git_inbound_jobs
             where provider_instance_id = $3
               and ((state = 'pending' and next_attempt_at <= $1)
                 or (state = 'retry_wait' and next_attempt_at <= $1)
                 or (state = 'processing' and locked_at <= $2))
             order by next_attempt_at asc, created_at asc
             for update skip locked
             limit 1
         )
         update external_git_inbound_jobs job
         set state = 'processing',
             phase = case
                 when job.phase = 'revision'
                      and job.remote_sha is not null
                      and job.applied_workspace_version is not null
                 then 'revision'
                 else 'fetch'
             end,
             remote_sha = case
                 when job.phase = 'revision'
                      and job.remote_sha is not null
                      and job.applied_workspace_version is not null
                 then job.remote_sha
                 else null
             end,
             applied_workspace_version = case
                 when job.phase = 'revision'
                      and job.remote_sha is not null
                      and job.applied_workspace_version is not null
                 then job.applied_workspace_version
                 else null
             end,
             attempt_count = job.attempt_count + 1,
             last_attempt_at = $1, locked_at = $1, updated_at = $1
         from candidate
         where job.id = candidate.id
         returning job.id, job.project_id, job.attempt_count, job.phase,
                   job.remote_sha, job.applied_workspace_version",
    )
    .bind(now)
    .bind(stale_before)
    .bind(provider_instance_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| ClaimedInboundJob {
        id: row.get("id"),
        project_id: row.get("project_id"),
        attempt_count: row.get("attempt_count"),
        phase: row.get("phase"),
        remote_sha: row.get("remote_sha"),
        applied_workspace_version: row.get("applied_workspace_version"),
    }))
}

pub(crate) async fn mark_job_applied(
    connection: &mut PgConnection,
    job_id: Uuid,
    remote_sha: &str,
    workspace_version: i64,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    let result = sqlx::query(
        "update external_git_inbound_jobs
         set phase = 'revision', remote_sha = $2, applied_workspace_version = $3,
             locked_at = $4, updated_at = $4
         where id = $1 and state = 'processing'",
    )
    .bind(job_id)
    .bind(remote_sha)
    .bind(workspace_version)
    .bind(now)
    .execute(connection)
    .await?;
    if result.rows_affected() == 1 {
        Ok(())
    } else {
        Err(sqlx::Error::RowNotFound)
    }
}

pub(crate) async fn inbound_job_link(
    db: &PgPool,
    job_id: Uuid,
) -> Result<Option<InboundJobLink>, sqlx::Error> {
    let row = sqlx::query(
        "select job.id, job.project_id, job.operation, job.source_branch,
                job.requested_by_user_id, link.linked_by_user_id,
                link.clone_url, link.full_path
         from external_git_inbound_jobs job
         join external_git_project_links link on link.project_id = job.project_id
         where job.id = $1",
    )
    .bind(job_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| InboundJobLink {
        id: row.get("id"),
        project_id: row.get("project_id"),
        operation: row.get("operation"),
        source_branch: row.get("source_branch"),
        requested_by_user_id: row.get("requested_by_user_id"),
        linked_by_user_id: row.get("linked_by_user_id"),
        clone_url: row.get("clone_url"),
        full_path: row.get("full_path"),
    }))
}

pub(crate) async fn update_job_phase(
    db: &PgPool,
    job_id: Uuid,
    phase: ExternalGitInboundPhase,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update external_git_inbound_jobs
         set phase = $2, locked_at = $3, updated_at = $3
         where id = $1 and state = 'processing'",
    )
    .bind(job_id)
    .bind(phase)
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}

pub(crate) async fn complete_job(
    connection: &mut PgConnection,
    job_id: Uuid,
    now: DateTime<Utc>,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "update external_git_inbound_jobs
         set state = 'succeeded', phase = 'complete',
             last_error = null, locked_at = null, updated_at = $2, completed_at = $2
         where id = $1 and state = 'processing' and phase = 'revision'
           and remote_sha is not null and applied_workspace_version is not null",
    )
    .bind(job_id)
    .bind(now)
    .execute(connection)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub(crate) async fn fail_job(
    connection: &mut PgConnection,
    job_id: Uuid,
    state: ExternalGitJobState,
    retry_phase: ExternalGitInboundPhase,
    next_attempt_at: DateTime<Utc>,
    error_code: ExternalGitFailureCode,
    now: DateTime<Utc>,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "update external_git_inbound_jobs
         set state = $2, phase = $3, next_attempt_at = $4,
             remote_sha = case when $3 = 'revision' then remote_sha else null end,
             applied_workspace_version = case
                 when $3 = 'revision' then applied_workspace_version else null
             end,
             locked_at = null, last_error = $5, updated_at = $6,
             completed_at = case when $2 = 'failed' then $6 else null end
         where id = $1 and state = 'processing'",
    )
    .bind(job_id)
    .bind(state)
    .bind(retry_phase)
    .bind(next_attempt_at)
    .bind(error_code)
    .bind(now)
    .execute(connection)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub(crate) async fn update_link_import_error(
    connection: &mut PgConnection,
    project_id: Uuid,
    error_code: ExternalGitFailureCode,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update external_git_project_links
         set last_import_error = $2, updated_at = $3
         where project_id = $1",
    )
    .bind(project_id)
    .bind(error_code)
    .bind(now)
    .execute(connection)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::branch::SourceBranch;
    use super::super::import_creation::{create_import_project, CreateImportProject};
    use super::*;
    use crate::distribution::CheckpointBranchPrefix;
    use crate::workspace::{LatexEngine, ProjectType};
    use sqlx::PgPool;

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

    fn claimed_job(
        phase: ExternalGitInboundPhase,
        remote_sha: Option<&str>,
        workspace_version: Option<i64>,
    ) -> ClaimedInboundJob {
        ClaimedInboundJob {
            id: Uuid::nil(),
            project_id: Uuid::nil(),
            attempt_count: 2,
            phase,
            remote_sha: remote_sha.map(str::to_string),
            applied_workspace_version: workspace_version,
        }
    }

    #[test]
    fn revision_claim_resumes_from_the_persisted_apply_result() {
        let job = claimed_job(
            ExternalGitInboundPhase::Revision,
            Some("0123456789abcdef0123456789abcdef01234567"),
            Some(42),
        );

        assert_eq!(
            job.applied_state(),
            Some(AppliedInboundJob {
                remote_sha: "0123456789abcdef0123456789abcdef01234567".to_string(),
                workspace_version: 42,
            })
        );
    }

    #[test]
    fn incomplete_or_pre_apply_claim_must_fetch_again() {
        assert_eq!(
            claimed_job(ExternalGitInboundPhase::Apply, Some("abc"), Some(42)).applied_state(),
            None
        );
        assert_eq!(
            claimed_job(ExternalGitInboundPhase::Revision, None, Some(42)).applied_state(),
            None
        );
        assert_eq!(
            claimed_job(ExternalGitInboundPhase::Revision, Some("abc"), None).applied_state(),
            None
        );
    }

    #[tokio::test]
    async fn applied_job_retry_reclaims_only_the_revision_phase(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let user_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        let job_id = Uuid::new_v4();
        let now = Utc::now();
        let provider_suffix = user_id.simple().to_string();
        let provider =
            format!("recovery-{}", &provider_suffix[..12]).parse::<ProviderInstanceId>()?;
        let mut transaction = pool.begin().await?;
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
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "insert into external_git_oauth_grants (
                 user_id, provider_instance_id, provider_account_id, provider_username,
                 encrypted_access_token, refresh_redirect_uri, scopes, status, created_at, updated_at
             ) values ($1, $2, $3, 'owner', '\\x01',
                       'https://collab.example.test/callback',
                       '{}', 'active', $4, $4)",
        )
        .bind(user_id)
        .bind(&provider)
        .bind(user_id.to_string())
        .bind(now)
        .execute(&mut *transaction)
        .await?;
        let project_name = crate::workspace::ProjectName::parse("Inbound recovery test")?;
        let project = crate::workspace::CreateProjectGraph::empty(
            project_id,
            user_id,
            &project_name,
            ProjectType::Typst,
            crate::workspace::LatexEngine::Pdftex,
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
        sqlx::query(
            "insert into external_git_inbound_jobs (
                 id, project_id, provider_instance_id, operation, source_branch, requested_by_user_id,
                 state, phase, attempt_count, next_attempt_at, locked_at, created_at, updated_at
             ) values ($1, $2, $3, 'sync', 'main', $4,
                       'processing', 'apply', 1, $5, $5, $5, $5)",
        )
        .bind(job_id)
        .bind(project_id)
        .bind(&provider)
        .bind(user_id)
        .bind(now)
        .execute(&mut *transaction)
        .await?;
        let remote_sha = "0123456789abcdef0123456789abcdef01234567";
        mark_job_applied(&mut transaction, job_id, remote_sha, 17, now).await?;
        assert!(
            fail_job(
                &mut transaction,
                job_id,
                ExternalGitJobState::RetryWait,
                ExternalGitInboundPhase::Revision,
                now,
                ExternalGitFailureCode::RepositoryRevisionFailed,
                now,
            )
            .await?
        );
        let (phase, stored_sha, workspace_version) =
            sqlx::query_as::<_, (ExternalGitInboundPhase, Option<String>, Option<i64>)>(
                "select phase, remote_sha, applied_workspace_version
                 from external_git_inbound_jobs where id = $1",
            )
            .bind(job_id)
            .fetch_one(&mut *transaction)
            .await?;
        assert_eq!(phase, ExternalGitInboundPhase::Revision);
        assert_eq!(stored_sha.as_deref(), Some(remote_sha));
        assert_eq!(workspace_version, Some(17));
        transaction.commit().await?;

        let claimed = claim_due_job(
            &pool,
            &provider,
            now + chrono::Duration::seconds(1),
            now - chrono::Duration::minutes(15),
        )
        .await?
        .ok_or_else(|| std::io::Error::other("revision retry was not reclaimed"))?;
        assert_eq!(claimed.id, job_id);
        assert_eq!(
            claimed.applied_state(),
            Some(AppliedInboundJob {
                remote_sha: remote_sha.to_string(),
                workspace_version: 17,
            })
        );
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

    #[tokio::test]
    async fn import_creation_composes_all_context_records_atomically(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let user_id = Uuid::new_v4();
        let username_suffix = user_id
            .simple()
            .to_string()
            .chars()
            .take(8)
            .collect::<String>();
        let now = Utc::now();
        sqlx::query(
            "insert into users (id, email, username, display_name, created_at)
             values ($1, $2, $3, 'Import Owner', $4)",
        )
        .bind(user_id)
        .bind(format!("{user_id}@example.test"))
        .bind(format!("user-{username_suffix}"))
        .bind(now)
        .execute(&pool)
        .await?;
        let repository_id = Uuid::new_v4().to_string();
        sqlx::query(
            "insert into external_git_oauth_grants (
                 user_id, provider_instance_id, provider_account_id, provider_username,
                 encrypted_access_token, refresh_redirect_uri, scopes, status, created_at, updated_at
             ) values ($1, 'github', $2, 'owner', '\\x01',
                       'https://collab.example.test/v1/external-git/providers/github/callback',
                       '{}', 'active', $3, $3)",
        )
        .bind(user_id)
        .bind(user_id.to_string())
        .bind(now)
        .execute(&pool)
        .await?;
        let mismatched = create_import_project(
            &pool,
            CreateImportProject {
                actor_user_id: user_id,
                name: crate::workspace::ProjectName::parse("Rejected import")?,
                project_type: ProjectType::Typst,
                latex_engine: LatexEngine::Pdftex,
                provider: "gitlab".parse::<ProviderInstanceId>()?,
                repository_id: format!("mismatch-{repository_id}"),
                full_path: format!("tests/mismatch-{repository_id}"),
                web_url: format!("https://git.example.test/tests/mismatch-{repository_id}"),
                clone_url: format!("https://git.example.test/tests/mismatch-{repository_id}.git"),
                default_branch: "main".to_string(),
                checkpoint_branch_prefix: CheckpointBranchPrefix::parse("toss/")?,
                source_branch: SourceBranch::parse("main")?,
            },
        )
        .await;
        assert!(matches!(
            mismatched,
            Err(super::super::import_creation::CreateImportError::Persistence { .. })
        ));
        assert_eq!(
            sqlx::query_scalar::<_, i64>("select count(*) from projects where owner_user_id = $1")
                .bind(user_id)
                .fetch_one(&pool)
                .await?,
            0
        );
        sqlx::query("delete from external_git_oauth_grants where user_id = $1")
            .bind(user_id)
            .execute(&pool)
            .await?;
        sqlx::query(
            "insert into external_git_oauth_grants (
                 user_id, provider_instance_id, provider_account_id, provider_username,
                 encrypted_access_token, refresh_redirect_uri, scopes, status, created_at, updated_at
             ) values ($1, 'gitlab', $2, 'owner', '\\x01',
                       'https://collab.example.test/v1/external-git/providers/gitlab/callback',
                       '{}', 'active', $3, $3)",
        )
        .bind(user_id)
        .bind(user_id.to_string())
        .bind(now)
        .execute(&pool)
        .await?;
        let response = create_import_project(
            &pool,
            CreateImportProject {
                actor_user_id: user_id,
                name: crate::workspace::ProjectName::parse("Imported project")?,
                project_type: ProjectType::Typst,
                latex_engine: LatexEngine::Pdftex,
                provider: "gitlab".parse::<ProviderInstanceId>()?,
                repository_id: repository_id.clone(),
                full_path: format!("tests/{repository_id}"),
                web_url: format!("https://git.example.test/tests/{repository_id}"),
                clone_url: format!("https://git.example.test/tests/{repository_id}.git"),
                default_branch: "main".to_string(),
                checkpoint_branch_prefix: CheckpointBranchPrefix::parse("toss/")?,
                source_branch: SourceBranch::parse("main")?,
            },
        )
        .await
        .map_err(|error| std::io::Error::other(format!("import creation failed: {error:?}")))?;

        let stored = sqlx::query_as::<
            _,
            (
                String,
                String,
                String,
                String,
                String,
                String,
                String,
                String,
            ),
        >(
            "select p.name, p.project_type::text, settings.entry_file_path,
                    role.role::text, sync.branch, sync.status::text,
                    link.provider_instance_id, job.state::text
             from projects p
             join project_settings settings on settings.project_id = p.id
             join project_roles role on role.project_id = p.id and role.user_id = $2
             join git_sync_states sync on sync.project_id = p.id
             join external_git_project_links link on link.project_id = p.id
             join external_git_inbound_jobs job on job.project_id = p.id
             where p.id = $1",
        )
        .bind(response.project_id)
        .bind(user_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(stored.0, "Imported project");
        assert_eq!(stored.1, "typst");
        assert_eq!(stored.2, "main.typ");
        assert_eq!(stored.3, "Owner");
        assert_eq!(stored.4, "main");
        assert_eq!(stored.5, "clean");
        assert_eq!(stored.6, "gitlab");
        assert_eq!(stored.7, "pending");

        sqlx::query("delete from projects where id = $1")
            .bind(response.project_id)
            .execute(&pool)
            .await?;
        sqlx::query("delete from users where id = $1")
            .bind(user_id)
            .execute(&pool)
            .await?;
        Ok(())
    }
}
