alter table external_git_project_links
  rename column path_with_namespace to full_path;

alter table external_git_project_links
  rename column http_url_to_repo to clone_url;
