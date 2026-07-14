alter table project_roles
  add column source text;

update project_roles
set source = 'direct_role'
where source is null;

alter table project_roles
  alter column source set default 'direct_role',
  alter column source set not null;

alter table project_roles
  add constraint project_roles_source_check
  check (source in ('direct_role', 'share_link_invite'));
