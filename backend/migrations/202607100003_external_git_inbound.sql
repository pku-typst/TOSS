alter table projects
  add column content_epoch bigint not null default 0;

alter table collab_doc_updates
  add column content_epoch bigint not null default 0;

drop index idx_collab_doc_updates_doc;
create index idx_collab_doc_updates_doc
  on collab_doc_updates(project_id, content_epoch, doc_id, id);

alter table collab_doc_latest_snapshots
  add column content_epoch bigint not null default 0;

alter table external_git_project_links
  add column last_import_branch text,
  add column last_import_sha text,
  add column last_import_at timestamptz,
  add column last_import_error text;

create table external_git_inbound_jobs (
  id uuid primary key,
  project_id uuid not null references projects(id) on delete cascade,
  provider text not null,
  operation text not null,
  source_branch text not null,
  requested_by_user_id uuid not null references users(id),
  state text not null default 'pending',
  phase text not null default 'queued',
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null,
  last_attempt_at timestamptz,
  locked_at timestamptz,
  remote_sha text,
  last_error text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz,
  constraint external_git_inbound_jobs_operation_check
    check (operation in ('import', 'sync')),
  constraint external_git_inbound_jobs_state_check
    check (state in ('pending', 'processing', 'retry_wait', 'paused', 'failed', 'succeeded'))
);

create unique index external_git_inbound_jobs_one_active_project
  on external_git_inbound_jobs(project_id)
  where state in ('pending', 'processing', 'retry_wait', 'paused');

create index external_git_inbound_jobs_due
  on external_git_inbound_jobs(state, next_attempt_at, created_at);

create index external_git_inbound_jobs_project_history
  on external_git_inbound_jobs(project_id, created_at desc);
