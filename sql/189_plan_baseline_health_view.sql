-- 189: v_plan_baseline_health — the Planning module's data-trust layer.
--
-- Phase 1 of the Planning overhaul (agreed with Bobby 2026-08-06): before
-- any projection is worth reading, the module must PROVE its baseline.
-- One row of aggregates over active live_billing, splitting the recurring
-- base into:
--   contracted : rows linked to a QBO recurring template — a signed
--                instruction QBO will actually execute. Fact.
--   inferred   : rows built by qbo-pull's invoice-inference (no template)
--                — monthly (seen in consecutive months) or annual (seen
--                once in 12mo, spread /12). Estimate, not fact.
-- plus the health signals that caught real corruption this week:
-- duplicate template sets (the sql/188 bug class) and stale rows.
--
-- security_invoker: live_billing is fee-gated by RLS (can_view_client_fees);
-- the view must not become a side door around that.

create or replace view public.v_plan_baseline_health
with (security_invoker = true) as
with active as (
  select * from live_billing where status = 'active'
)
select
  count(*)::int                                                   as active_rows,
  count(distinct entity_id)::int                                  as active_clients,
  round(coalesce(sum(monthly_net), 0), 2)                         as total_monthly,

  count(*) filter (where qbo_recurring_txn_id is not null)::int   as contracted_rows,
  (count(distinct entity_id) filter (where qbo_recurring_txn_id is not null))::int
                                                                  as contracted_clients,
  round(coalesce(sum(monthly_net) filter (where qbo_recurring_txn_id is not null), 0), 2)
                                                                  as contracted_monthly,

  (count(*) filter (where qbo_recurring_txn_id is null and billing_type = 'recurring'))::int
                                                                  as inferred_monthly_rows,
  round(coalesce(sum(monthly_net) filter (where qbo_recurring_txn_id is null and billing_type = 'recurring'), 0), 2)
                                                                  as inferred_monthly_amount,
  (count(*) filter (where qbo_recurring_txn_id is null and billing_type = 'annual'))::int
                                                                  as inferred_annual_rows,
  round(coalesce(sum(monthly_net) filter (where qbo_recurring_txn_id is null and billing_type = 'annual'), 0), 2)
                                                                  as inferred_annual_amount,

  (select count(*) from (
     select qbo_recurring_txn_id from active
     where qbo_recurring_txn_id is not null
     group by 1 having count(*) > 1) d)::int                      as duplicate_template_sets,
  (count(*) filter (where last_synced_qbo < now() - interval '3 days'
                       or last_synced_qbo is null))::int          as stale_rows,
  max(last_synced_qbo)                                            as newest_sync,
  min(last_synced_qbo)                                            as oldest_sync
from active;

grant select on public.v_plan_baseline_health to authenticated;
