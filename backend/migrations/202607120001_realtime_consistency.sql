alter table documents
  add column path_revision bigint not null default 0,
  add column collaboration_revision bigint not null default 0;

alter table projects
  add column access_epoch bigint not null default 0;

create sequence documents_change_sequence_seq;

alter table documents
  add column change_sequence bigint not null
  default nextval('documents_change_sequence_seq');

alter sequence documents_change_sequence_seq
  owned by documents.change_sequence;

create index idx_documents_project_change_sequence
  on documents(project_id, change_sequence);

-- Realtime rooms were previously keyed by a mutable path. Document UUIDs are
-- the durable identity now; the canonical SQL content will seed fresh rooms.
delete from collab_doc_updates;
delete from collab_doc_latest_snapshots;

drop index idx_collab_doc_updates_doc;

alter table collab_doc_updates
  drop column doc_id,
  add column document_id uuid not null references documents(id) on delete cascade,
  add column collaboration_revision bigint not null
    constraint collab_doc_updates_collaboration_revision_nonnegative
    check (collaboration_revision >= 0);

create index idx_collab_doc_updates_document
  on collab_doc_updates(
    project_id,
    content_epoch,
    document_id,
    collaboration_revision,
    id
  );

alter table collab_doc_latest_snapshots
  drop constraint collab_doc_latest_snapshots_pkey,
  drop column doc_id,
  add column document_id uuid not null references documents(id) on delete cascade,
  add column collaboration_revision bigint not null
    constraint collab_doc_snapshots_collaboration_revision_nonnegative
    check (collaboration_revision >= 0),
  add primary key (project_id, document_id, collaboration_revision);
