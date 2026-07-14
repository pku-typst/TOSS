-- Community releases retain their original migration history. Evolve that
-- history without invalidating SQLx checksums or requiring a clean database.

alter table external_git_inbound_jobs
  drop constraint external_git_inbound_jobs_project_id_fkey,
  drop constraint external_git_inbound_jobs_provider_check;

alter table external_git_inbound_jobs
  rename column provider to provider_instance_id;

alter table external_git_inbound_jobs
  add constraint external_git_inbound_jobs_provider_instance_id_check
  check (provider_instance_id ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$');

alter table external_git_oauth_grants
  drop constraint external_git_oauth_grants_provider_check;

alter table external_git_oauth_grants
  rename column provider to provider_instance_id;

alter table external_git_oauth_grants
  add column refresh_redirect_uri text;

-- Earlier grants did not retain the redirect URI required for token refresh.
-- Keep the account link, but require one explicit reconnection rather than
-- attempting a refresh with invented authorization metadata.
update external_git_oauth_grants
set refresh_redirect_uri = 'urn:toss:legacy-oauth-grant',
    status = 'reauth_required',
    last_error = 'oauth_redirect_uri_upgrade_required',
    updated_at = now();

alter table external_git_oauth_grants
  alter column refresh_redirect_uri set not null,
  add constraint external_git_oauth_grants_provider_instance_id_check
    check (provider_instance_id ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  add constraint external_git_oauth_grants_refresh_redirect_uri_check
    check (length(refresh_redirect_uri) > 0);

alter table external_git_oauth_grants
  rename constraint gitlab_oauth_grants_user_id_fkey
  to external_git_oauth_grants_user_id_fkey;

alter table external_git_project_links
  drop constraint external_git_project_links_provider_check;

alter table external_git_project_links
  rename column provider to provider_instance_id;

alter table external_git_project_links
  add constraint external_git_project_links_provider_instance_id_check
    check (provider_instance_id ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  add constraint external_git_project_links_project_provider_key
    unique (project_id, provider_instance_id);

alter table external_git_project_links
  rename constraint gitlab_project_links_pkey
  to external_git_project_links_pkey;

alter table external_git_project_links
  rename constraint gitlab_project_links_linked_by_user_id_fkey
  to external_git_project_links_linked_by_user_id_fkey;

alter table external_git_project_links
  rename constraint gitlab_project_links_project_id_fkey
  to external_git_project_links_project_id_fkey;

alter table external_git_project_links
  add constraint external_git_project_links_connector_provider_fkey
  foreign key (linked_by_user_id, provider_instance_id)
  references external_git_oauth_grants(user_id, provider_instance_id);

alter table external_git_inbound_jobs
  add constraint external_git_inbound_jobs_project_provider_fkey
  foreign key (project_id, provider_instance_id)
  references external_git_project_links(project_id, provider_instance_id)
  on delete cascade;

alter table external_git_checkpoint_queue
  rename constraint gitlab_checkpoint_queue_pkey
  to external_git_checkpoint_queue_pkey;

alter table external_git_checkpoint_queue
  rename constraint gitlab_checkpoint_queue_project_id_fkey
  to external_git_checkpoint_queue_project_id_fkey;

alter table external_git_pending_authors
  rename constraint gitlab_pending_authors_pkey
  to external_git_pending_authors_pkey;

alter table external_git_pending_authors
  rename constraint gitlab_pending_authors_project_id_fkey
  to external_git_pending_authors_project_id_fkey;

alter table external_git_pending_authors
  rename constraint gitlab_pending_authors_user_id_fkey
  to external_git_pending_authors_user_id_fkey;

alter table external_git_pending_guest_authors
  rename constraint gitlab_pending_guest_authors_pkey
  to external_git_pending_guest_authors_pkey;

alter table external_git_pending_guest_authors
  rename constraint gitlab_pending_guest_authors_project_id_fkey
  to external_git_pending_guest_authors_project_id_fkey;

create table external_git_oauth_attempts (
  state text primary key,
  provider_instance_id text not null,
  purpose text not null,
  user_id uuid references users(id) on delete cascade,
  return_to text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null,
  constraint external_git_oauth_attempts_provider_instance_id_check
    check (provider_instance_id ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  constraint external_git_oauth_attempts_purpose_check
    check (purpose in ('sign_in', 'connect')),
  constraint external_git_oauth_attempts_user_check
    check (
      (purpose = 'sign_in' and user_id is null)
      or (purpose = 'connect' and user_id is not null)
    )
);

create index idx_external_git_oauth_attempts_expiry
  on external_git_oauth_attempts(expires_at);

do $$
begin
  if exists (
    select 1
    from users
    where (oidc_subject is null) <> (oidc_issuer is null)
  ) then
    raise exception 'cannot migrate an incomplete OIDC login identity';
  end if;
end
$$;

create table user_login_identities (
  user_id uuid not null references users(id) on delete cascade,
  authority_kind text not null,
  authority_id text not null,
  subject text not null,
  created_at timestamptz not null,
  last_authenticated_at timestamptz not null,
  constraint user_login_identities_pkey
    primary key (authority_kind, authority_id, subject),
  constraint user_login_identities_user_authority_key
    unique (user_id, authority_kind, authority_id),
  constraint user_login_identities_authority_kind_check
    check (authority_kind in ('oidc', 'external_git'))
);

insert into user_login_identities (
  user_id,
  authority_kind,
  authority_id,
  subject,
  created_at,
  last_authenticated_at
)
select
  id,
  'oidc',
  oidc_issuer,
  oidc_subject,
  created_at,
  created_at
from users
where oidc_subject is not null;

create index idx_user_login_identities_user_id
  on user_login_identities(user_id);

alter table users
  drop constraint users_oidc_subject_key,
  drop constraint users_username_format,
  drop column oidc_subject,
  drop column oidc_issuer,
  add constraint users_username_format
    check (username ~ '^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])$');
