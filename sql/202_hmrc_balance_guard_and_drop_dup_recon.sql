-- 202 — Close a read hole on v_hmrc_paye_balance, and drop my duplicate recon view.
--
-- Two separate sessions built on the hmrc schema at once. This reconciles them.
--
-- 1. SECURITY — v_hmrc_paye_balance shipped without the `hmrc_can_read()` guard
--    AND granted to `anon`. `anon` is the unauthenticated role whose key ships
--    inside the frontend bundle (VITE_SUPABASE_ANON_KEY), so anybody holding it
--    could read every client's PAYE debt without logging in. The view is a
--    definer view, so the guard is the only thing standing between it and the
--    world — exactly the reason every other v_hmrc_* view carries it.
--
--    v_hmrc_paye_charge_lines already had the guard, so it returned nothing to
--    anon; the anon grant is revoked there too as defence in depth.
--
--    The balance logic is otherwise UNCHANGED — same CTEs, same columns, same
--    arithmetic. Only the guard and the grants move.
--
-- 2. DUPLICATION — I built v_hmrc_paye_recon before spotting that
--    v_hmrc_paye_balance already existed and does the same job better
--    (brought_forward / cumulative_due, plus detail_reconciles from the new
--    charge_line detail). Two definitions of one number is the failure mode
--    this codebase keeps designing away from, so mine goes and the module reads
--    v_hmrc_paye_balance.

-- ── 1. the guard ───────────────────────────────────────────────────
create or replace view public.v_hmrc_paye_balance as
with latest as (
  select distinct on (p.client_id) p.client_id, p.run_id
  from hmrc."position" p
  order by p.client_id, p.scraped_at desc
), per_year as (
  select
    c.paye_ref,
    c.entity_id,
    c.name as hmrc_name,
    ch.tax_year,
    sum(ch.charges)                                        as charges,
    sum(ch.credits)                                        as credits,
    sum(ch.payments)                                       as payments,
    sum(ch.amount_due)                                     as still_due,
    count(*) filter (where ch.overdue)                     as overdue_months,
    count(*) filter (where ch.charges > 0)                 as charged_months,
    bool_and(coalesce(ch.detail_reconciles, true))         as detail_reconciles,
    count(*) filter (where ch.detail_reconciles is not null) as months_with_detail
  from hmrc.charge ch
  join hmrc.client c on c.id = ch.client_id
  join latest l      on l.client_id = ch.client_id and l.run_id = ch.run_id
  group by c.paye_ref, c.entity_id, c.name, ch.tax_year
)
select
  paye_ref,
  entity_id,
  hmrc_name,
  tax_year,
  round(charges / 100.0, 2)              as charges,
  round(credits / 100.0, 2)              as credits,
  round((charges - credits) / 100.0, 2)  as net_charged,
  round(payments / 100.0, 2)             as payments,
  round(still_due / 100.0, 2)            as still_due,
  round(sum(still_due) over (partition by paye_ref order by tax_year
        rows between unbounded preceding and current row) / 100.0, 2) as cumulative_due,
  round((sum(still_due) over (partition by paye_ref order by tax_year
        rows between unbounded preceding and current row) - still_due) / 100.0, 2) as brought_forward,
  overdue_months,
  charged_months,
  detail_reconciles,
  months_with_detail
from per_year
-- The predicate is row-independent, so it is all-or-nothing for the query and
-- the running totals above are unaffected when it passes.
where public.hmrc_can_read();

-- ── 2. grants ──────────────────────────────────────────────────────
revoke all on public.v_hmrc_paye_balance      from public, anon;
revoke all on public.v_hmrc_paye_charge_lines from public, anon;

grant select on public.v_hmrc_paye_balance      to authenticated, service_role;
grant select on public.v_hmrc_paye_charge_lines to authenticated, service_role;

-- ── 3. the duplicate ───────────────────────────────────────────────
drop view if exists public.v_hmrc_paye_recon;
