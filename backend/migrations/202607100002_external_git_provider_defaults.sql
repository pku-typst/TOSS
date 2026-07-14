alter table external_git_oauth_grants
  alter column provider drop default;

alter table external_git_project_links
  alter column provider drop default;
