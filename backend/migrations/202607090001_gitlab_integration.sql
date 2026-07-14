alter table users
  add column if not exists gitlab_user_id bigint,
  add column if not exists gitlab_username text;

create unique index if not exists idx_users_gitlab_user_id
  on users(gitlab_user_id)
  where gitlab_user_id is not null;

create table if not exists gitlab_oauth_grants (
  user_id uuid primary key references users(id) on delete cascade,
  gitlab_user_id bigint not null,
  encrypted_access_token bytea not null,
  encrypted_refresh_token bytea,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  status text not null default 'active',
  last_error text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint gitlab_oauth_grants_gitlab_user_id_key unique (gitlab_user_id),
  constraint gitlab_oauth_grants_status_check
    check (status in ('active', 'reauth_required', 'revoked'))
);

create index if not exists idx_gitlab_oauth_grants_status
  on gitlab_oauth_grants(status);

alter table projects
  add column if not exists workspace_version bigint not null default 0;

create table if not exists gitlab_project_links (
  project_id uuid primary key references projects(id) on delete cascade,
  gitlab_project_id bigint not null,
  path_with_namespace text not null,
  web_url text not null,
  http_url_to_repo text not null,
  default_branch text not null,
  checkpoint_branch text not null,
  status text not null default 'linking',
  synced_workspace_version bigint not null default 0,
  last_remote_sha text,
  last_error text,
  linked_by_user_id uuid not null references users(id),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint gitlab_project_links_gitlab_project_id_key unique (gitlab_project_id),
  constraint gitlab_project_links_status_check
    check (status in ('linking', 'active', 'reauth_required', 'conflict', 'error'))
);

create index if not exists idx_gitlab_project_links_status
  on gitlab_project_links(status);
