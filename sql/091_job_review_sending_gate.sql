-- Safety gate: no team-wide job-review emails until this is explicitly enabled.
-- Test sends (test_recipient) and dry-runs are always allowed; only real
-- sends to the whole team require sending_enabled = true. Defaults OFF so the
-- feature can be tested end-to-end by one person before it ever emails staff.
alter table job_review_config
  add column if not exists sending_enabled boolean not null default false;

comment on column job_review_config.sending_enabled is
  'Master switch for team-wide job-review emails. false = only test_recipient/dry-run sends allowed. Flip to true once end-to-end tested.';
