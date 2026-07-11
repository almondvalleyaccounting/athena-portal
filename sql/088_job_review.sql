-- Monthly job-review feedback loop.
--
-- Purpose: help management stay on top of stalled jobs ahead of the workflow
-- meeting. BrightManager stays the source of truth for job STATUS; Athena
-- captures only the "over and above" management layer BM can't hold
-- (a personal commitment date, blocker reason, confidence, help flag) and
-- snapshots BM status each cycle so we can measure movement over time.
--
-- Cohort comes from the shared ready_now_jobs view (sql/087). Setting a
-- "done by" date raises a bm_target change request in ready_now_change_requests
-- (sql/076) so Sophie updates BM's target date and BM integrity stays high.

-- ── Config (single row) ──────────────────────────────────────────────────
create table if not exists job_review_config (
  id                   boolean primary key default true check (id),          -- singleton guard
  services             text[] not null default array['Annual Accounts'],
  boxes                text[] not null default array['deprioritised','urgent','expedite','normal'],
  normal_min_days_past int   not null default 90,
  urgent_within_days   int   not null default 14,
  cadence_day_of_month int   not null default 1 check (cadence_day_of_month between 1 and 28),
  chase_after_days     int   not null default 5,
  reminder_max         int   not null default 2,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references auth.users(id) on delete set null
);
insert into job_review_config (id) values (true) on conflict (id) do nothing;

comment on table job_review_config is 'Single-row config for the monthly job-review cycle: which services/boxes feed the list, thresholds, cadence, chase policy.';

-- ── Reason lookup (editable buttons) ───────────────────────────────────────
create table if not exists job_review_reason (
  code                  text primary key,
  label                 text not null,
  sort                  int  not null default 0,
  triggers_client_chase boolean not null default false,
  active                boolean not null default true
);

-- Seed: extends the Ready Now deprioritise vocabulary (Client Unresponsive /
-- Being Struck Off / Awaiting Client / Other) with progress + blocker reasons.
-- triggers_client_chase = feeds the Phase 2 escalating client chasers.
insert into job_review_reason (code, label, sort, triggers_client_chase) values
  ('awaiting_client_records', 'Awaiting records from client',                 10, true),
  ('awaiting_client_query',   'Awaiting client response to a query',          20, true),
  ('client_unresponsive',     'Client unresponsive / not engaging',           30, true),
  ('awaiting_third_party',    'Awaiting third party (HMRC / bank / prior accountant)', 40, false),
  ('in_progress',             'In progress / on track',                       50, false),
  ('my_capacity',             'Not got to it yet — capacity',                 60, false),
  ('complex_job',             'Complex — needs more time',                    70, false),
  ('needs_reassign',          'Needs reassigning',                            80, false),
  ('being_struck_off',        'Being struck off / dormant',                   90, false),
  ('fees_or_engagement',      'On hold — fees / engagement',                 100, false),
  ('other',                   'Other (see note)',                            110, false)
on conflict (code) do nothing;

comment on table job_review_reason is 'Editable set of blocker-reason buttons for the monthly job review. triggers_client_chase reasons feed Phase 2 client chasers.';

-- ── Cycle (one per month) ──────────────────────────────────────────────────
create table if not exists job_review_cycle (
  id              uuid primary key default gen_random_uuid(),
  period_month    date not null,                        -- first of the month
  status          text not null default 'open' check (status in ('open','closed')),
  config_snapshot jsonb,                                 -- services/boxes/thresholds used at open time
  opened_at       timestamptz not null default now(),
  opened_by       uuid references auth.users(id) on delete set null,
  closed_at       timestamptz,
  closed_by       uuid references auth.users(id) on delete set null,
  unique (period_month)
);

comment on table job_review_cycle is 'One monthly job-review cycle. A snapshot of the stalled cohort is taken into job_review_item when a cycle opens.';

-- ── Item (one stalled job per cycle) ───────────────────────────────────────
create table if not exists job_review_item (
  id                uuid primary key default gen_random_uuid(),
  cycle_id          uuid not null references job_review_cycle(id) on delete cascade,
  entity_id         uuid not null references entities(id) on delete cascade,
  service           text not null,
  period_end        date not null,
  -- snapshot from ready_now_jobs at open time
  client_name       text,
  assignee_id       uuid references staff_profiles(id) on delete set null,  -- primary recipient
  assignee_ids      uuid[],                                                 -- all assignees on the job
  bm_status_snapshot text,
  box               text,
  days_past         int,
  bm_deadline       date,
  bm_target_date    date,
  -- movement vs the previous cycle (computed at open time)
  prev_bm_status    text,
  movement          text check (movement in ('new','advanced','unchanged','slipped')),
  -- captured feedback (the "over and above BM" layer)
  done_by           date,
  reason_code       text references job_review_reason(code),
  confidence        text check (confidence in ('green','amber','red')),
  needs_help        boolean not null default false,
  note              text,
  responded_at      timestamptz,
  responded_by      uuid references auth.users(id) on delete set null,
  -- link to the bm_target change request raised from done_by (Sophie → BM)
  change_request_id uuid references ready_now_change_requests(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (cycle_id, entity_id, service, period_end)
);

create index if not exists jri_cycle_idx        on job_review_item(cycle_id);
create index if not exists jri_assignee_idx      on job_review_item(assignee_id, cycle_id);
create index if not exists jri_unanswered_idx    on job_review_item(cycle_id) where responded_at is null;
create index if not exists jri_entity_period_idx on job_review_item(entity_id, service, period_end);

comment on table job_review_item is 'One stalled job in a monthly cycle: a snapshot of BM status/box/aging plus the management feedback captured in Athena (done-by, reason, confidence, needs-help).';

-- ── updated_at touch ────────────────────────────────────────────────────────
create or replace function job_review_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists jri_touch_updated_at on job_review_item;
create trigger jri_touch_updated_at
  before update on job_review_item
  for each row execute function job_review_touch_updated_at();

drop trigger if exists jrc_touch_updated_at on job_review_config;
create trigger jrc_touch_updated_at
  before update on job_review_config
  for each row execute function job_review_touch_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────
-- Staff-internal data → gate on is_active_staff() (see sql/078). Service-role
-- callers (the open/remind edge functions + cron) bypass RLS regardless.
-- Cycle/config/reason writes are admin-only; item feedback is any active staff
-- (the assignee answers their own rows).
alter table job_review_config enable row level security;
alter table job_review_reason enable row level security;
alter table job_review_cycle  enable row level security;
alter table job_review_item   enable row level security;

drop policy if exists job_review_config_read on job_review_config;
create policy job_review_config_read on job_review_config
  for select to authenticated using (is_active_staff());
drop policy if exists job_review_config_write on job_review_config;
create policy job_review_config_write on job_review_config
  for update to authenticated using (is_portal_admin()) with check (is_portal_admin());

drop policy if exists job_review_reason_read on job_review_reason;
create policy job_review_reason_read on job_review_reason
  for select to authenticated using (is_active_staff());
drop policy if exists job_review_reason_write on job_review_reason;
create policy job_review_reason_write on job_review_reason
  for all to authenticated using (is_portal_admin()) with check (is_portal_admin());

drop policy if exists job_review_cycle_read on job_review_cycle;
create policy job_review_cycle_read on job_review_cycle
  for select to authenticated using (is_active_staff());
drop policy if exists job_review_cycle_write on job_review_cycle;
create policy job_review_cycle_write on job_review_cycle
  for all to authenticated using (is_portal_admin()) with check (is_portal_admin());

drop policy if exists job_review_item_read on job_review_item;
create policy job_review_item_read on job_review_item
  for select to authenticated using (is_active_staff());
drop policy if exists job_review_item_write on job_review_item;
create policy job_review_item_write on job_review_item
  for update to authenticated using (is_active_staff()) with check (is_active_staff());
