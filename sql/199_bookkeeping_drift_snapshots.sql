-- 199_bookkeeping_drift_snapshots.sql
--
-- Where the nightly sweep records what it measured, and how that becomes a
-- severity.
--
-- One row per client per day, kept rather than overwritten. Drift is only
-- meaningful over time: "reconciled to 12 May" says little on its own, but
-- "reconciled to 12 May, and it was 12 May a fortnight ago too" is the whole
-- story. The history is also what "drifting since" and the recovering/worsening
-- arrow are read from.
--
-- Scoring is deliberately TWO axes, not one:
--   drift   — days past tolerance on the worst frontier
--   hygiene — the suspense/uncategorised weight
-- A file can be current but messy, or spotless and six weeks behind. Those need
-- different actions, and a single RAG light destroys the distinction.

/* ── Runs ────────────────────────────────────────────────────────────────── */

create table if not exists public.bk_drift_runs (
  id             bigserial primary key,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  realms_total   int not null default 0,
  realms_checked int not null default 0,
  realms_error   int not null default 0,
  trigger        text
);

/* ── Baselines: what "normal" looks like for each client ─────────────────── */
-- Recomputed roughly monthly by the sweep (13 months of transactions is the one
-- heavy call). Held per realm rather than per client because it describes the
-- QuickBooks file, not the engagement.

create table if not exists public.bk_drift_baselines (
  realm_id    text primary key,
  data        jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now()
);

/* ── Snapshots ───────────────────────────────────────────────────────────── */

create table if not exists public.bk_drift_snapshots (
  id                   bigserial primary key,
  run_id               bigint references public.bk_drift_runs(id) on delete set null,
  realm_id             text not null,
  entity_id            uuid references public.entities(id) on delete cascade,
  company_name         text,
  snapshot_date        date not null,

  -- status='error' means the pull failed. It must render as "unknown" wherever
  -- it appears: a realm whose token quietly expired reading as green is the
  -- failure mode that makes a watch worthless.
  status               text not null default 'ok',
  error                text,

  -- Frontiers
  posted_to            date,
  reconciled_to        date,
  reconciled_within_6m boolean,
  touched_at           timestamptz,

  -- Backlog
  oldest_uncleared     date,
  uncleared_count      int,
  uncleared_total      numeric,

  -- Volume and shape
  txn_this_month       int,
  txn_30d              int,
  txn_90d              int,
  longest_gap_90d      int,
  normal_gap_days      int,
  baseline_monthly     numeric,
  volume_ratio         numeric,      -- month-to-date annualised ÷ baseline median
  missing_recurring    jsonb,        -- counterparties normally seen monthly, absent this month

  bank_accounts        jsonb,        -- per-account last txn / last reconciled
  hygiene              jsonb,
  notes                jsonb,
  api_calls            int,
  pulled_at            timestamptz not null default now(),

  constraint bk_snap_status_ck check (status in ('ok', 'error'))
);

create unique index if not exists bk_snap_realm_day  on public.bk_drift_snapshots (realm_id, snapshot_date);
create index if not exists        bk_snap_entity_idx on public.bk_drift_snapshots (entity_id, snapshot_date desc);
create index if not exists        bk_snap_date_idx   on public.bk_drift_snapshots (snapshot_date desc);

/* ── Scoring ─────────────────────────────────────────────────────────────── */

-- The latest snapshot per client, joined to the watch config and to the next
-- filing deadline, scored.
--
-- Tolerance TIGHTENS as a deadline approaches. Six weeks behind is fine in
-- month one of a VAT quarter and an emergency three weeks before filing, and a
-- fixed threshold can't say both.
create or replace view public.v_bk_drift_current as
with latest as (
  select distinct on (entity_id) *
  from public.bk_drift_snapshots
  where entity_id is not null
  order by entity_id, snapshot_date desc, id desc
),
-- Next VAT or accounts deadline, from the work schedule. Former clients are
-- already excluded upstream (134), but the filter is repeated here because this
-- view is read directly by operational surfaces.
next_due as (
  select bts.entity_id, min(bts.bm_deadline) as next_deadline
  from public.bm_task_schedule bts
  join public.entities e on e.id = bts.entity_id
  where bts.bm_deadline >= current_date
    and coalesce(bts.state, 'committed') <> 'discarded'
    and bts.service in ('VAT', 'Bookkeeping')
    and coalesce(e.entity_status::text, 'active') not in ('nlac', 'archived')
  group by bts.entity_id
),
base as (
  select
    l.*,
    e.name as entity_name,
    w.books_owner, w.tier, w.cadence as cadence_override, w.tolerance_days as tolerance_override,
    w.assignee_id, w.manager_id, w.paused_until, w.pause_reason, w.watch_enabled,
    w.tier_suggested, w.tier_suggested_why,
    coalesce(w.cadence, c.cadence, 'quarterly') as cadence,
    d.next_deadline,
    -- Frontier ages. A null reconciliation frontier means nothing has been
    -- reconciled in six months (or the file refused the query) — treated as
    -- 190 days behind, which is past every tolerance on the ladder.
    case when l.reconciled_to is null then 190
         else (current_date - l.reconciled_to) end as recon_age_days,
    case when l.posted_to is null then 190
         else (current_date - l.posted_to) end as posted_age_days,
    case when l.touched_at is null then 30
         else (current_date - l.touched_at::date) end as touched_age_days
  from latest l
  join public.entities e on e.id = l.entity_id
  join public.bk_watch_config w on w.entity_id = l.entity_id
  left join (
    select entity_id, min(cadence) cadence
    from public.v_service_cadence
    where canonical_service_id in ('bookkeeping', 'vat_review')
    group by entity_id
  ) c on c.entity_id = l.entity_id
  left join next_due d on d.entity_id = l.entity_id
  where coalesce(e.entity_status::text, 'active') not in ('nlac', 'archived')
),
scored as (
  select
    b.*,
    -- Base tolerance from cadence and tier, then tightened by proximity to the
    -- next filing deadline: inside 21 days it halves, inside 45 it drops a
    -- quarter. Never below 14 days — under that the noise swamps the signal.
    greatest(14, (
      coalesce(b.tolerance_override, public.bk_tolerance_days(b.cadence, b.tier))
      * case
          when b.next_deadline is null then 1.0
          when b.next_deadline - current_date <= 21 then 0.5
          when b.next_deadline - current_date <= 45 then 0.75
          else 1.0
        end
    )::int) as tolerance_days
  from base b
)
select
  s.*,
  (s.recon_age_days - s.tolerance_days) as days_over_tolerance,

  -- Timeliness. 'unknown' is a first-class outcome, not a shade of green.
  case
    when s.status = 'error'                                   then 'unknown'
    when s.paused_until is not null
     and s.paused_until >= current_date                       then 'paused'
    when s.recon_age_days <= s.tolerance_days                 then 'ok'
    when s.recon_age_days <= s.tolerance_days * 1.5           then 'watch'
    when s.recon_age_days <= s.tolerance_days * 2.5           then 'breach'
    else 'critical'
  end as drift_status,

  -- Hygiene, scored on the suspense balances and the uncleared backlog.
  -- Levels alone are noise; what earns a flag is a balance that shouldn't
  -- exist at all, or a backlog with age on it.
  (
    (case when abs(coalesce((s.hygiene->>'uncategorised_asset')::numeric, 0)) > 0.005 then 1 else 0 end) +
    (case when abs(coalesce((s.hygiene->>'undeposited_funds')::numeric, 0)) > 0.005 then 1 else 0 end) +
    (case when abs(coalesce((s.hygiene->>'opening_balance_equity')::numeric, 0)) > 0.005 then 1 else 0 end) +
    (case when abs(coalesce((s.hygiene->>'ask_my_accountant')::numeric, 0)) > 0.005 then 1 else 0 end) +
    (case when abs(coalesce((s.hygiene->>'reconciliation_discrepancies')::numeric, 0)) > 0.005 then 1 else 0 end) +
    (case when s.oldest_uncleared is not null
           and s.oldest_uncleared < current_date - 180 then 1 else 0 end)
  ) as hygiene_score,

  -- Soft signals: the only read on what was never posted.
  --   volume_ratio  — this month annualised against the client's own median
  --   longest_gap   — a run of silent days longer than this file's normal
  --   untouched     — nobody has opened the file in a month
  (s.volume_ratio is not null and s.volume_ratio < 0.5)                    as volume_shortfall,
  (s.normal_gap_days is not null and s.longest_gap_90d > greatest(14, s.normal_gap_days * 2)) as feed_gap,
  (s.touched_at is null)                                                   as untouched_30d,
  coalesce(jsonb_array_length(s.missing_recurring), 0)                     as missing_recurring_count
from scored s;

comment on view public.v_bk_drift_current is
  'Latest drift snapshot per client, scored against a cadence- and deadline-aware tolerance. drift_status: ok | watch | breach | critical | paused | unknown.';

-- Trend: is a client's reconciliation frontier moving forward or stuck?
-- "Stuck" is the more actionable state — a file that has been reconciled to the
-- same date for three weeks is not slowly catching up, it is abandoned.
create or replace view public.v_bk_drift_trend as
select
  entity_id,
  max(snapshot_date) filter (where status = 'ok')                          as last_ok_snapshot,
  count(*) filter (where status = 'error')                                 as error_days,
  min(reconciled_to) filter (where snapshot_date >= current_date - 21)     as recon_21d_ago,
  max(reconciled_to) filter (where snapshot_date >= current_date - 21)     as recon_now,
  (max(reconciled_to) filter (where snapshot_date >= current_date - 21)
   = min(reconciled_to) filter (where snapshot_date >= current_date - 21)) as recon_stuck_21d
from public.bk_drift_snapshots
where snapshot_date >= current_date - 60
group by entity_id;

/* ── RLS ─────────────────────────────────────────────────────────────────── */
-- Snapshots carry no fee data — transaction counts, dates and suspense
-- balances only — so they sit inside the ordinary staff boundary rather than
-- the fee-confidentiality one.

alter table public.bk_drift_runs      enable row level security;
alter table public.bk_drift_snapshots enable row level security;
alter table public.bk_drift_baselines enable row level security;

drop policy if exists "staff read drift runs"      on public.bk_drift_runs;
drop policy if exists "staff read drift snapshots" on public.bk_drift_snapshots;

create policy "staff read drift runs" on public.bk_drift_runs
  for select to authenticated using (public.is_active_staff());

create policy "staff read drift snapshots" on public.bk_drift_snapshots
  for select to authenticated using (public.is_active_staff());

-- bk_drift_baselines: no policies. Service-role (the sweep) only — it holds
-- per-counterparty history that nothing in the UI needs to read directly.
