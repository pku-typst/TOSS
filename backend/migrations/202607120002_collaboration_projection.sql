alter table collab_doc_updates
  add column guest_display_name text;

alter table collab_doc_updates
  add constraint collab_doc_updates_actor_check
  check (user_id is null or guest_display_name is null);
