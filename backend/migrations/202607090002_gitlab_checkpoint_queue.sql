update projects
set workspace_version = 1
where workspace_version = 0;

create table if not exists gitlab_checkpoint_queue (
  project_id uuid primary key references gitlab_project_links(project_id) on delete cascade,
  target_workspace_version bigint not null,
  captured_workspace_version bigint,
  checkpoint_sha text,
  captured_at timestamptz,
  next_attempt_at timestamptz not null,
  state text not null default 'pending',
  phase text not null default 'queued',
  attempt_count integer not null default 0,
  last_attempt_at timestamptz,
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint gitlab_checkpoint_queue_state_check
    check (state in ('pending', 'processing', 'retry_wait', 'paused'))
);

create index if not exists idx_gitlab_checkpoint_queue_due
  on gitlab_checkpoint_queue(state, next_attempt_at);

create table if not exists gitlab_pending_authors (
  project_id uuid not null references gitlab_project_links(project_id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  touched_at timestamptz not null,
  primary key (project_id, user_id)
);

create table if not exists gitlab_pending_guest_authors (
  project_id uuid not null references gitlab_project_links(project_id) on delete cascade,
  display_name text not null,
  touched_at timestamptz not null,
  primary key (project_id, display_name)
);
