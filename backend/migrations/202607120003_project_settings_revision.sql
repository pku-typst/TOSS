alter table project_settings
  add column if not exists settings_revision bigint not null default 0;
