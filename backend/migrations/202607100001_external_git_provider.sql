alter table gitlab_oauth_grants rename to external_git_oauth_grants;
alter table external_git_oauth_grants rename column gitlab_user_id to provider_account_id;
alter table external_git_oauth_grants
  add column provider text not null default 'gitlab',
  add column provider_username text;
alter table external_git_oauth_grants
  alter column provider_account_id type text using provider_account_id::text;

update external_git_oauth_grants grants
set provider_username = coalesce(users.gitlab_username, grants.provider_account_id::text)
from users
where users.id = grants.user_id;

-- The provider-neutral token envelope uses a new authenticated-data namespace.
-- Existing grants cannot be re-encrypted without plaintext, so require one
-- fresh provider authorization instead of retaining an unreadable active grant.
update external_git_oauth_grants
set status = 'reauth_required',
    last_error = 'authorization_format_changed',
    updated_at = now();

alter table external_git_oauth_grants
  alter column provider_username set not null,
  drop constraint gitlab_oauth_grants_pkey,
  drop constraint gitlab_oauth_grants_gitlab_user_id_key,
  drop constraint gitlab_oauth_grants_status_check,
  add constraint external_git_oauth_grants_pkey primary key (user_id, provider),
  add constraint external_git_oauth_grants_provider_account_key
    unique (provider, provider_account_id),
  add constraint external_git_oauth_grants_status_check
    check (status in ('active', 'reauth_required', 'revoked'));

drop index idx_gitlab_oauth_grants_status;
create index idx_external_git_oauth_grants_status
  on external_git_oauth_grants(provider, status);

drop index idx_users_gitlab_user_id;
alter table users
  drop column gitlab_user_id,
  drop column gitlab_username;

alter table gitlab_project_links rename to external_git_project_links;
alter table external_git_project_links rename column gitlab_project_id to provider_repository_id;
alter table external_git_project_links
  add column provider text not null default 'gitlab',
  drop constraint gitlab_project_links_gitlab_project_id_key,
  drop constraint gitlab_project_links_status_check,
  add constraint external_git_project_links_provider_repository_key
    unique (provider, provider_repository_id),
  add constraint external_git_project_links_status_check
    check (status in ('linking', 'active', 'reauth_required', 'conflict', 'error'));
alter table external_git_project_links
  alter column provider_repository_id type text using provider_repository_id::text;

drop index idx_gitlab_project_links_status;
create index idx_external_git_project_links_status
  on external_git_project_links(provider, status);

alter table gitlab_checkpoint_queue rename to external_git_checkpoint_queue;
alter table external_git_checkpoint_queue
  drop constraint gitlab_checkpoint_queue_state_check,
  add constraint external_git_checkpoint_queue_state_check
    check (state in ('pending', 'processing', 'retry_wait', 'paused'));

drop index idx_gitlab_checkpoint_queue_due;
create index idx_external_git_checkpoint_queue_due
  on external_git_checkpoint_queue(state, next_attempt_at);

alter table gitlab_pending_authors rename to external_git_pending_authors;
alter table gitlab_pending_guest_authors rename to external_git_pending_guest_authors;
