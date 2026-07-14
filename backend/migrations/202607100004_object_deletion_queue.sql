create table object_deletion_queue (
  object_key text primary key,
  next_attempt_at timestamptz not null,
  attempt_count integer not null default 0,
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint object_deletion_queue_attempt_count_check
    check (attempt_count >= 0),
  constraint object_deletion_queue_object_key_check
    check (length(btrim(object_key)) > 0)
);

create index object_deletion_queue_due
  on object_deletion_queue(next_attempt_at, created_at);
