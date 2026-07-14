alter table external_git_oauth_grants
  add constraint external_git_oauth_grants_provider_check
  check (provider in ('gitlab'));

alter table external_git_project_links
  add constraint external_git_project_links_provider_check
  check (provider in ('gitlab'));

alter table external_git_inbound_jobs
  add constraint external_git_inbound_jobs_provider_check
  check (provider in ('gitlab'));
