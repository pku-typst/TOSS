alter table git_sync_states
  add constraint git_sync_states_status_check
  check (status in ('clean', 'receive_pack_import_failed'));
