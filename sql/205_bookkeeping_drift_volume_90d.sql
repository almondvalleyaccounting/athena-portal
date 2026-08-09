-- 205_bookkeeping_drift_volume_90d.sql
--
-- Revises v_bk_drift_current from 202. Supersedes that view definition; the
-- reasoning in 199 and 202 still applies.
--
-- The volume signal was comparing the CURRENT month's postings against the
-- client's monthly median. For a client whose books are written up quarterly
-- — which is most of this portfolio — that is meaningless: the month in
-- progress is empty by design, and the median is inflated by the catch-up
-- months when the quarter is done.
--
-- It flagged 40 of 57 clients. Kidz Out Of School Care read 1% of normal on
-- the month while the trailing quarter was running at 83%.
--
-- Trailing 90 days against three months of the median is robust to write-up
-- timing and still catches a genuine stop. It separates Gsw Maintenance (13%)
-- and Kieran Leary Joinery (26%) from Kidz (83%) and Dionne's (72%), and takes
-- the flag count from 40 to 12.
--
-- The month figure stays on the snapshot as secondary detail — it is the right
-- read for a client genuinely on a monthly cadence, and the client dashboard
-- shows both.

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
    (not coalesce(l.reconciled_within_6m, false)) as never_reconciled,
    -- Trailing quarter against three months of normal.
    case when coalesce(l.baseline_monthly, 0) > 0
         then round((l.txn_90d / (l.baseline_monthly * 3))::numeric, 2) end as volume_ratio_90d
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
    (case when s.never_reconciled then 1 else 0 end)
  ) as hygiene_score,
  (s.volume_ratio_90d is not null and s.volume_ratio_90d < 0.5)            as volume_shortfall,
  (s.normal_gap_days is not null and s.longest_gap_90d > greatest(14, s.normal_gap_days * 2)) as feed_gap,
  (s.touched_at is null)                                                   as untouched_30d,
  coalesce(jsonb_array_length(s.missing_recurring), 0)                     as missing_recurring_count
from scored s;

comment on view public.v_bk_drift_current is
  'Latest drift snapshot per client, scored against a cadence- and deadline-aware tolerance. frontier_basis says whether the score is on the reconciliation or the posting frontier; volume_shortfall compares the trailing quarter, not the month in progress. drift_status: ok | watch | breach | critical | paused | unknown.';

-- Rebuilt unchanged from 201 — it selects d.*, so it drops with the view under it.
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
