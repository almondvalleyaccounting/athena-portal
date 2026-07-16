-- ============================================================
-- Weekly deadline digest — Monday-morning email to Bobby + Tracy.
--
-- Companies House ACCOUNTS filing deadlines (service = Annual Accounts) that
-- are still open (bm_task_schedule.state = 'planned' = not yet filed / still in
-- the BM export), plus the Self Assessment pile due 31 Jan. Source of truth is
-- the work module, ultimately from BrightManager.
--
-- The email carries:
--   1. CH accounts deadlines grouped by calendar month (this month + next two),
--      listed per client.
--   2. A count of submissions needed for each of the next 6 calendar months
--      (including current), with the week-on-week change.
--   3. A count of Self Assessment returns due at the end of January, w/w change.
--   4. A working-week run-rate target to clear each pile by its deadline.
--
-- Week-on-week deltas come from deadline_digest_snapshots: the edge function
-- writes one row per real send and compares against the previous one. The first
-- real send has no prior snapshot, so it shows a baseline with no deltas.
--
-- Edge function: deadline-digest.
-- Safety: sending_enabled = false by default (test_recipient always allowed).
--         Cron is left DISARMED (unscheduled) until tested — see the tail.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── 1. Singleton config ──────────────────────────────────────
create table if not exists deadline_digest_config (
  id               boolean primary key default true check (id),
  weekly_enabled   boolean not null default true,
  sending_enabled  boolean not null default false,  -- gate for real team-wide sends
  cron_secret      text    not null default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  recipient_ids    uuid[],                          -- resolved to emails in the edge fn; empty = all active staff
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on table deadline_digest_config is 'Singleton config for the weekly deadline digest. sending_enabled=false blocks real team-wide sends (test_recipient still allowed).';

insert into deadline_digest_config (id) values (true) on conflict do nothing;

-- Seed recipients = Bobby + Tracy, resolved by name so no hardcoded ids.
update deadline_digest_config
   set recipient_ids = (
         select array_agg(id) from staff_profiles
          where name in ('Bobby Gallacher', 'Tracy Mitchell') and is_active
       )
 where id = true;

-- ── 2. Weekly snapshots (for week-on-week deltas) ────────────
create table if not exists deadline_digest_snapshots (
  id            uuid primary key default uuid_generate_v4(),
  snapshot_date date not null unique,
  payload       jsonb not null,      -- { ch: {"2026-07": 24, ...}, sa_jan: 261, personal_tax_jan: 94, generated_at }
  created_at    timestamptz not null default now()
);
comment on table deadline_digest_snapshots is 'One row per weekly deadline-digest send. payload holds the per-bucket counts the email compares week-on-week.';

-- ── 3. RLS — same is_active_staff() pattern as other staff tables ──
alter table deadline_digest_config    enable row level security;
alter table deadline_digest_snapshots enable row level security;

drop policy if exists deadline_digest_config_read on deadline_digest_config;
create policy deadline_digest_config_read on deadline_digest_config for select using (is_active_staff());
drop policy if exists deadline_digest_config_write on deadline_digest_config;
create policy deadline_digest_config_write on deadline_digest_config for update using (is_active_staff()) with check (is_active_staff());

drop policy if exists deadline_digest_snapshots_read on deadline_digest_snapshots;
create policy deadline_digest_snapshots_read on deadline_digest_snapshots for select using (is_active_staff());
-- Writes are service-role only (edge function) — no staff write policy needed.

-- ── 4. Self-gating cron wrapper ──────────────────────────────
create or replace function run_deadline_digest()
returns void
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare cfg deadline_digest_config%rowtype;
begin
  select * into cfg from deadline_digest_config where id = true;
  if cfg is null or not cfg.weekly_enabled then
    return;
  end if;
  perform net.http_post(
    url     := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/deadline-digest',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', cfg.cron_secret),
    body    := jsonb_build_object('dry_run', false)
  );
end;
$$;

-- ── 5. Schedule (DISARMED) ───────────────────────────────────
-- Monday 07:00 UTC = 08:00 UK (BST) / 07:00 UK (GMT) — a proper morning email.
-- run_deadline_digest() self-gates on weekly_enabled, so it is safe to leave
-- scheduled. ARM ONLY AFTER: (a) the deadline-digest edge function is deployed,
-- (b) a test_recipient run looks right, (c) sending_enabled = true. Then run:
--   select cron.schedule('deadline-digest', '0 7 * * 1', $$select run_deadline_digest()$$);
