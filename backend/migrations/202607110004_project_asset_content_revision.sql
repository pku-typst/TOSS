alter table project_assets
  add column content_revision uuid;

update project_assets
set content_revision = id;

alter table project_assets
  alter column content_revision set not null;
