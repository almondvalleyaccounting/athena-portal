-- 247 — take the client's year end from BrightManager, where Athena already has it
--
-- sql/239 added an overridable fiscal_year_end_month because QuickBooks so often
-- has no year end recorded, and falling back to Almond Valley's own September
-- would mislabel the client's quarters. That fix was right but incomplete: it
-- left ~120 clients needing manual data entry for a fact Athena already knew.
--
-- BrightManager names it. Every Annual Accounts task carries it in the title:
--   "Accounts Preparation Year End 31/07/2026"
--   "Companies House Submission Year End 31/07/2026"
-- 118 of the 137 connected clients have one.
--
-- RESOLUTION ORDER, everywhere (staff dashboard and client portal alike):
--   1. qbo_report_connections.fiscal_year_end_month — a human decided
--   2. BrightManager's most recent Annual Accounts year end
--   3. the tax year, for sole traders and partnerships — they have no Annual
--      Accounts task carrying a year end because they are on Self Assessment,
--      and since basis-period reform they report to the tax year, so March is
--      very much likelier than the practice's own September
--   4. QuickBooks' own FiscalYearStartMonth
--   5. September, flagged in the UI as a fallback rather than asserted
--
-- READ LIVE, NOT BACKFILLED. A copy would be 118 rows going stale the first time
-- a client changed its year end — and they do: of the two clients whose BM tasks
-- disagree with themselves, both are genuine period changes (June→May,
-- January→September), not bad data. Hence "most recent year end wins", and hence
-- reading through rather than copying, so a BM re-import carries the change
-- straight through instead of Athena quietly holding the old month.
--
-- The view is SECURITY INVOKER: it exists to save three joins, not to grant
-- anything. Whoever queries it sees exactly what they could see querying the
-- tables underneath.

begin;

create or replace view v_client_year_end
with (security_invoker = true) as
with bm as (
  select distinct on (t.entity_id)
         t.entity_id,
         to_date((regexp_match(t.bm_task_name, 'Year End (\d{2}/\d{2}/\d{4})'))[1], 'DD/MM/YYYY') as ye_date,
         (regexp_match(t.bm_task_name, 'Year End (\d{2})/(\d{2})/(\d{4})'))[2]::smallint as ye_month
  from bm_task_schedule t
  where t.service = 'Annual Accounts'
    and t.bm_task_name ~ 'Year End \d{2}/\d{2}/\d{4}'
  -- Most recent year end wins: a client that has changed its accounting date
  -- has tasks for both the old and the new one, and the new one is the truth.
  order by t.entity_id,
           to_date((regexp_match(t.bm_task_name, 'Year End (\d{2}/\d{2}/\d{4})'))[1], 'DD/MM/YYYY') desc
)
select
  c.entity_id,
  c.realm_id,
  c.fiscal_year_end_month                       as override_month,
  bm.ye_month                                   as bm_month,
  bm.ye_date                                    as bm_year_end,
  coalesce(
    c.fiscal_year_end_month,
    bm.ye_month,
    case when e.type in ('sole_trader', 'partnership') then 3::smallint end
  )                                             as month,
  case
    when c.fiscal_year_end_month is not null      then 'override'
    when bm.ye_month is not null                  then 'brightmanager'
    when e.type in ('sole_trader', 'partnership') then 'tax_year'
    else null                                  -- caller falls through to QBO
  end                                           as source
from qbo_report_connections c
join entities e on e.id = c.entity_id
left join bm on bm.entity_id = c.entity_id;

comment on view v_client_year_end is
  'Resolved financial year end per connected client: staff override, else BrightManager''s most recent Annual Accounts year end, else the tax year for unincorporated clients. Null month means neither knows — the caller then tries QuickBooks and finally a flagged fallback. SECURITY INVOKER: saves joins, grants nothing.';

revoke all on v_client_year_end from public, anon;
grant select on v_client_year_end to authenticated, service_role;

commit;
