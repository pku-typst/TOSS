alter table external_git_inbound_jobs
  add column applied_workspace_version bigint;

update external_git_inbound_jobs job
set phase = 'revision',
    remote_sha = link.last_import_sha,
    applied_workspace_version = project.workspace_version,
    updated_at = now()
from external_git_project_links link,
     projects project
where job.project_id = link.project_id
  and project.id = job.project_id
  and job.state in ('processing', 'retry_wait')
  and job.phase in ('apply', 'revision')
  and link.last_import_sha is not null
  and link.last_import_at >= coalesce(job.last_attempt_at, job.created_at);

update external_git_inbound_jobs
set state = 'failed',
    phase = 'queued',
    locked_at = null,
    last_error = 'repository_import_state_failed',
    updated_at = now(),
    completed_at = now()
where phase = 'revision'
  and (remote_sha is null or applied_workspace_version is null);

alter table external_git_inbound_jobs
  add constraint external_git_inbound_jobs_revision_recovery_check
  check (
    phase <> 'revision'
    or (remote_sha is not null and applied_workspace_version is not null)
  );
