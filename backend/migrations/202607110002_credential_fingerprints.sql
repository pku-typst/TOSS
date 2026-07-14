delete from auth_sessions;

alter table auth_sessions
  drop constraint if exists auth_sessions_pkey;
alter table auth_sessions
  drop column session_token;
alter table auth_sessions
  add column session_token_fingerprint bytea primary key;
alter table auth_sessions
  add constraint auth_sessions_token_fingerprint_length
  check (octet_length(session_token_fingerprint) = 32);

alter table personal_access_tokens
  rename column token_hash to token_fingerprint;
alter table personal_access_tokens
  rename constraint personal_access_tokens_token_hash_key
  to personal_access_tokens_token_fingerprint_key;
alter table personal_access_tokens
  alter column token_fingerprint type bytea
  using decode(token_fingerprint, 'hex');
alter table personal_access_tokens
  add constraint personal_access_tokens_fingerprint_length
  check (octet_length(token_fingerprint) = 32);

alter table anonymous_share_sessions
  rename column session_token_hash to session_token_fingerprint;
alter table anonymous_share_sessions
  rename constraint anonymous_share_sessions_session_token_hash_key
  to anonymous_share_sessions_session_token_fingerprint_key;
alter table anonymous_share_sessions
  alter column session_token_fingerprint type bytea
  using decode(session_token_fingerprint, 'hex');
alter table anonymous_share_sessions
  add constraint anonymous_share_sessions_fingerprint_length
  check (octet_length(session_token_fingerprint) = 32);

delete from project_share_links
where token_value is null;

alter table project_share_links
  alter column token_value set not null;
alter table project_share_links
  drop column token_hash;
alter table project_share_links
  add constraint project_share_links_token_value_key unique (token_value);
