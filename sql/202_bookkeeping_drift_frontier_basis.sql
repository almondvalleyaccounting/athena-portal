-- 202_bookkeeping_drift_frontier_basis.sql
--
-- Revises v_bk_drift_current from 199 after the first live sweep (12 clients,
-- 9 Aug 2026). Supersedes the view definition in 199; everything else there
-- still stands.
--
-- What the first run showed: a null reconciliation frontier was carrying two
-- completely different meanings, and scoring them identically made most of the
-- board red for no useful reason.
--
--   a) The file HAS reconciled items, but a specific still-trading account has
--      none in six months — "Current Account", "Business Credit Cards",
--      "PayPal Bank". That is real, precise, actionable drift. It stays scored
--      on the reconciliation frontier, and the sweep names the account.
--
--   b) The file has NEVER been reconciled. On a client-kept file that is a
--      standing characteristic, not an event: plenty of clients simply never
--      use the reconcile function. Scoring it as drift pins them to critical
--      permanently, which is noise, and noise is how a watch dies. Those are
--      scored on the POSTING frontier instead, and "never reconciled" moves to
--      the hygiene axis where it belongs.
--
-- The exception is a file WE keep. We are paid to reconcile it, so never having
-- done so is our failure rather than a characteristic — those stay on the
-- reconciliation frontier and stay red.
--
-- Effect on the first 12: Barnarlo Design went critical → ok (posts to 12 July,
-- simply never reconciles), while Apex Properties stayed critical because
-- nothing has been posted to it at all in 120 days. Every remaining red now has
-- a named reason in the snapshot notes.
--
-- The posting frontier also gets a tighter tolerance (×0.6): posted work should
-- be considerably fresher than reconciled work.

drop view if exists public.v_bk_drift_board;
drop view if exists public.v_bk_drift_current;

create view public.v_bk_drift_current as
with latest as (
  select distinct on (entity_id) *
  from public.bk_drift_snapshots
  where entity_id is not null
  order by entity_id, snapshot_date desc, id desc
),
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
    case when l.reconciled_to is null then 190 else (current_date - l.reconciled_to) end as recon_age_days,
    case when l.posted_to is null then 190 else (current_date - l.posted_to) end as posted_age_days,
    case when l.touched_at is null then 30 else (current_date - l.touched_at::date) end as touched_age_days,
    (not coalesce(l.reconciled_within_6m, false)) as never_reconciled
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
basis as (
  select b.*,
    case when b.never_reconciled and b.books_owner <> 'us' then 'posted' else 'reconciled' end as frontier_basis
  from base b
),
scored as (
  select
    b.*,
    case when b.frontier_basis = 'posted' then b.posted_age_days else b.recon_age_days end as frontier_age_days,
    -- Cadence and tier set the base; proximity to the next filing deadline
    -- tightens it (inside 21 days it halves, inside 45 it drops a quarter);
    -- the posting frontier tightens it again. Never below 14 days — under that
    -- the noise swamps the signal.
    greatest(14, (
      coalesce(b.tolerance_override, public.bk_tolerance_days(b.cadence, b.tier))
      * case
          when b.next_deadline is null then 1.0
          when b.next_deadline - current_date <= 21 then 0.5
          when b.next_deadline - current_date <= 45 then 0.75
          else 1.0
        end
      * case when b.frontier_basis = 'posted' then 0.6 else 1.0 end
    )::int) as tolerance_days
  from basis b
)
select
  s.*,
  (s.frontier_age_days - s.tolerance_days) as days_over_tolerance,
  case
    when s.status = 'error'                                     then 'unknown'
    when s.paused_until is not null
     and s.paused_until >= current_date                         then 'paused'
    when s.frontier_age_days <= s.tolerance_days                then 'ok'
    when s.frontier_age_days <= s.tolerance_days * 1.5          then 'watch'
    when s.frontier_age_days <= s.tolerance_days * 2.5          then 'breach'
    else 'critical'
  end as drift_status,
  (
    (case when abs(coalesce((s.hygiene->>'uncategorised_asset')::numeric, 0)) > 0.005 then 1 else 0 end) +
    (case when abs(coalesce((s.hygiene->>'undeposited_funds')::numeric, 0)) > 0.005 then 1 else 0 end) +
    (case when abs(coalesce((s.hygiene->>'opening_balance_equity')::numeric, 0)) > 0.005 then 1 else 0 end) +
    (case when abs(coalesce((s.hygiene->>'ask_my_accountant')::numeric, 0)) > 0.005 then 1 else 0 end) +
    (case when abs(coalesce((s.hygiene->>'reconciliation_discrepancies')::numeric, 0)) > 0.005 then 1 else 0 end) +
    (case when s.oldest_uncleared is not null and s.oldest_uncleared < current_date - 180 then 1 else 0 end) +
    -- A file nobody ever reconciles is a hygiene problem even when it is not a
    -- timeliness one. This is where it lands once it stops driving drift.
    (case when s.never_reconciled then 1 else 0 end)
  ) as hygiene_score,
  (s.volume_ratio is not null and s.volume_ratio < 0.5)                    as volume_shortfall,
  (s.normal_gap_days is not null and s.longest_gap_90d > greatest(14, s.normal_gap_days * 2)) as feed_gap,
  (s.touched_at is null)                                                   as untouched_30d,
  coalesce(jsonb_array_length(s.missing_recurring), 0)                     as missing_recurring_count
from scored s;

comment on view public.v_bk_drift_current is
  'Latest drift snapshot per client, scored against a cadence- and deadline-aware tolerance. frontier_basis says whether the score is on the reconciliation or the posting frontier. drift_status: ok | watch | breach | critical | paused | unknown.';

-- Rebuilt unchanged from 201 — it selects d.* and so had to be dropped with the
-- view underneath it.
create view public.v_bk_drift_board as
select
  d.*,
  c.id            as case_id,
  c.state         as case_state,
  c.opened_on     as case_opened_on,
  c.reason_code   as case_reason,
  c.reason_note   as case_note,
  c.promised_by   as case_promised_by,
  c.nudge_count   as case_nudges,
  sa.name         as assignee_name,
  sm.name         as manager_name,
  t.recon_stuck_21d,
  t.error_days,
  (select count(*) from public.bk_drift_nudges n where n.case_id = c.id and n.state = 'queued') as nudges_queued
from public.v_bk_drift_current d
left join public.bk_drift_cases c on c.entity_id = d.entity_id and c.state not in ('resolved', 'dismissed')
left join public.staff_profiles sa on sa.id = d.assignee_id
left join public.staff_profiles sm on sm.id = d.manager_id
left join public.v_bk_drift_trend t on t.entity_id = d.entity_id;

comment on view public.v_bk_drift_board is
  'One row per watched client for the Work → Drifting board. books_owner splits it: "us" is our action, "client" is information.';
