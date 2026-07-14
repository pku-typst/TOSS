alter table external_git_checkpoint_queue
  add constraint external_git_checkpoint_queue_phase_check
  check (phase in ('queued', 'snapshot', 'commit_local', 'push_git'));

alter table external_git_inbound_jobs
  add constraint external_git_inbound_jobs_phase_check
  check (phase in ('queued', 'fetch', 'lfs', 'validate', 'assets', 'apply', 'revision', 'complete'));
