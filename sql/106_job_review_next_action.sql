-- ============================================================
-- Job Review — 'Next Action' input.
--
-- Adds a structured "what's the next step to progress this job" alongside the
-- existing blocker reason. Mirrors the job_review_reason pattern: an editable
-- lookup of suggested actions + a code column on the item, plus a free-text
-- detail field for specifics ("chase Jane for the bank statements").
--
-- The next action is also surfaced in the Work Planner → Ready Now feedback
-- popup, so whoever is working the job sees the agreed next step.
-- ============================================================

-- ── Suggested next actions (editable buttons, same shape as job_review_reason) ──
create table if not exists job_review_next_action (
  code   text primary key,
  label  text not null,
  sort   int  not null default 0,
  active boolean not null default true
);

insert into job_review_next_action (code, label, sort) values
  ('chase_records',       'Chase client for outstanding records',            10),
  ('send_queries',        'Send outstanding queries to client',              20),
  ('chase_query',         'Chase client for response to queries',            30),
  ('book_client_call',    'Book a call with the client',                     40),
  ('start_prep',          'Start preparing the accounts / return',           50),
  ('continue_prep',       'Continue preparation',                            60),
  ('send_for_review',     'Send to reviewer',                                70),
  ('clear_review_points', 'Clear review points',                             80),
  ('send_for_approval',   'Send to client for approval',                     90),
  ('chase_approval',      'Chase client for approval',                      100),
  ('file_submission',     'File / submit to Companies House / HMRC',        110),
  ('chase_third_party',   'Chase third party (HMRC / bank / prior accountant)', 120),
  ('reassign',            'Reassign to someone with capacity',              130),
  ('escalate',            'Escalate to manager / partner',                  140),
  ('disengage',           'Begin disengagement / strike-off',               150),
  ('other',               'Other (see note)',                               160)
on conflict (code) do nothing;

comment on table job_review_next_action is 'Editable set of suggested "next action" buttons for the monthly job review — the step the team will take to progress the job.';

-- ── Item columns ────────────────────────────────────────────────────────────
alter table job_review_item
  add column if not exists next_action_code text references job_review_next_action(code),
  add column if not exists next_action_note text;

comment on column job_review_item.next_action_code is 'Chosen next action (job_review_next_action.code) — the agreed step to progress the job.';
comment on column job_review_item.next_action_note is 'Optional specifics for the next action (who/what).';

-- ── RLS — read for all active staff, admin-only edits (same as job_review_reason) ──
alter table job_review_next_action enable row level security;

drop policy if exists job_review_next_action_read on job_review_next_action;
create policy job_review_next_action_read on job_review_next_action
  for select to authenticated using (is_active_staff());
drop policy if exists job_review_next_action_write on job_review_next_action;
create policy job_review_next_action_write on job_review_next_action
  for all to authenticated using (is_portal_admin()) with check (is_portal_admin());
