-- ============================================================
-- Help content — skeleton for the in-app Help button + reusable
-- copy (e.g. email footers). One row per module/sub-page (keyed by
-- the same `id` used in src/modules.config.js), plus extra
-- section_key rows for content reused outside the app shell.
--
-- Phase 1 (this migration): table + placeholder rows so the Help
-- button has something to resolve everywhere. Phase 2 (separate,
-- manual pass with screenshots): replace the placeholder bodies
-- with real copy, module by module.
-- ============================================================

create table if not exists help_content (
  id            uuid primary key default gen_random_uuid(),
  module_id     text not null,
  section_key   text not null default 'overview',
  title         text,
  body          text,
  screenshot_url text,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (module_id, section_key)
);
create index if not exists help_content_module_idx on help_content(module_id);

comment on table help_content is 'Help copy for the Help button + reused elsewhere (e.g. email footers). module_id matches ids in src/modules.config.js (or an ad-hoc id like admin-tasks); section_key defaults to "overview" for the main explanation, other keys hold reused snippets like "email-footer".';

-- ── RLS: active staff read/write (internal tool, matches admin_task_notes convention) ──
alter table help_content enable row level security;
drop policy if exists help_content_staff on help_content;
create policy help_content_staff on help_content
  for all to authenticated using (is_active_staff()) with check (is_active_staff());

-- ── Seed placeholder rows for every module/sub-page in the nav ──
insert into help_content (module_id, section_key, title, body, sort_order) values
  ('fee-engine',   'overview', 'Fee Engine',            'Placeholder — purpose, how to use it, data sources, and outputs to be added.', 0),
  ('fe-dashboard', 'overview', 'Fee Engine · Dashboard', 'Placeholder — purpose, how to use it, data sources, and outputs to be added.', 1),
  ('fe-new-quote', 'overview', 'Fee Engine · New Quote','Placeholder — purpose, how to use it, data sources, and outputs to be added.', 2),
  ('fe-clients',   'overview', 'Fee Engine · Clients',  'Placeholder — purpose, how to use it, data sources, and outputs to be added.', 3),
  ('fe-quotes',    'overview', 'Fee Engine · Quotes',   'Placeholder — purpose, how to use it, data sources, and outputs to be added.', 4),
  ('fe-groups',    'overview', 'Fee Engine · Groups',   'Placeholder — purpose, how to use it, data sources, and outputs to be added.', 5),
  ('fe-billing',   'overview', 'Fee Engine · Billing Review', 'Placeholder — purpose, how to use it, data sources, and outputs to be added.', 6),
  ('fe-pricing',   'overview', 'Fee Engine · Pricing',  'Placeholder — purpose, how to use it, data sources, and outputs to be added.', 7),
  ('billing',      'overview', 'Billing',               'Placeholder — purpose, how to use it, data sources, and outputs to be added.', 8),
  ('clients',      'overview', 'Clients',               'Placeholder — purpose, how to use it, data sources, and outputs to be added.', 9),
  ('onboarding',   'overview', 'Onboarding',             'Placeholder — purpose, how to use it, data sources, and outputs to be added.', 10),
  ('work-planner', 'overview', 'Work Planner',           'Placeholder — purpose, how to use it, data sources, and outputs to be added.', 11),
  ('wp-task',      'overview', 'Work Planner · Planner','Placeholder — purpose, how to use it, data sources, and outputs to be added.', 12),
  ('wp-capacity',  'overview', 'Work Planner · Capacity','Placeholder — purpose, how to use it, data sources, and outputs to be added.', 13),
  ('wp-job-review','overview', 'Work Planner · Job Review', 'Placeholder — purpose, how to use it, data sources, and outputs to be added.', 14),
  ('wp-timesheets','overview', 'Work Planner · Timesheets', 'Placeholder — purpose, how to use it, data sources, and outputs to be added.', 15),
  ('client-work',  'overview', 'Client Work',            'Placeholder — purpose, how to use it, data sources, and outputs to be added.', 16),
  ('cw-dashboard', 'overview', 'Client Work · Client Dashboard', 'Placeholder — purpose, how to use it, data sources, and outputs to be added.', 17),
  ('cw-reports',   'overview', 'Client Work · Client Reports', 'Placeholder — purpose, how to use it, data sources, and outputs to be added.', 18),
  ('cw-forecast',  'overview', 'Client Work · Client Forecast', 'Placeholder — purpose, how to use it, data sources, and outputs to be added.', 19),
  ('planning',     'overview', 'Practice Planning',     'Placeholder — purpose, how to use it, data sources, and outputs to be added.', 20),
  ('pd-tracker',   'overview', 'CPD Tracker',            'Placeholder — purpose, how to use it, data sources, and outputs to be added.', 21),
  ('issues',       'overview', 'Issues Log',             'Placeholder — purpose, how to use it, data sources, and outputs to be added.', 22),
  ('bug-reports',  'overview', 'Bug Reports',            'Placeholder — purpose, how to use it, data sources, and outputs to be added.', 23),
  ('ideas',        'overview', 'Ideas',                  'Placeholder — purpose, how to use it, data sources, and outputs to be added.', 24),
  ('admin-staff',  'overview', 'Admin · Staff & Permissions', 'Placeholder — purpose, how to use it, data sources, and outputs to be added.', 25),
  ('admin-tasks',  'overview', 'Admin · Admin Task List', 'Placeholder — purpose, how to use it, data sources, and outputs to be added.', 26),
  ('admin-import', 'overview', 'Admin · Data Import',   'Placeholder — purpose, how to use it, data sources, and outputs to be added.', 27)
on conflict (module_id, section_key) do nothing;

-- Proof-of-reuse example: a short blurb pulled into the job-review-notify
-- email footer (supabase/functions/job-review-notify/index.ts), demonstrating
-- the same table serving both the in-app Help button and an email.
insert into help_content (module_id, section_key, title, body, sort_order) values
  ('wp-job-review', 'email-footer', null, 'Placeholder — Bobby to replace with the real one-line reason this email exists.', 0)
on conflict (module_id, section_key) do nothing;
