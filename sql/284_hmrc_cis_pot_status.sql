-- 284_hmrc_cis_pot_status.sql
--
-- What can actually be DONE with the money sitting on a PAYE account.
--
-- "Credit exceeds debt" is not an actionable comparison, and presenting it as
-- one gave three different answers to a single question on 22 Sep 2026:
-- GBP 25,038.48, then GBP 940.51 when re-read against the debt's tax year, then
-- back again when read against the credit's. See
-- docs/hmrc-timing-and-cis-rules.md.
--
-- Two rules decide everything here:
--
--   CASH moves freely. An unallocated payment is money the client actually sent.
--   HMRC will allocate it to any outstanding liability, any year, on request.
--
--   CREDIT does not. A CIS credit offsets the CURRENT year's PAYE bills and
--   cannot go anywhere else -- another year, another tax, or back to the client
--   -- until 6 April. Credit from a CLOSED year is free.
--
-- So the test is the CREDIT'S year. Not the debt's, which is the mistake worth
-- naming: Hawk Eye's GBP 12,648.80 reaches its GBP 7,236.06 of 2024-25 arrears
-- because the CREDIT arose in 2024-25, not because the debt did.
--
-- AND THE STATED POT CARRIES NO AGE. v_hmrc_unallocated_credit is HMRC's own
-- balance with no year on it. The only age signal is the `Not allocated` rows
-- in hmrc.credit by tax_year, and HMRC RESTATES the running balance each year,
-- so those rows frequently double-count. Trefoil's sum to GBP 168,301.11
-- against a stated pot of GBP 46,837.78. They are not a decomposition.
--
-- Hence three states and an explicit fourth for "we cannot tell", rather than a
-- single availability figure that would be wrong for a quarter of the book.

create or replace function public.hmrc_current_tax_year()
returns text language sql stable as $$
  -- UK tax year runs 6 April to 5 April. Labelled the way HMRC labels it.
  select case
    when (extract(month from current_date), extract(day from current_date)) >= (4, 6)
      then extract(year from current_date)::int || '-'
           || right((extract(year from current_date)::int + 1)::text, 2)
    else (extract(year from current_date)::int - 1) || '-'
           || right(extract(year from current_date)::text, 2)
  end;
$$;

revoke all on function public.hmrc_current_tax_year() from public, anon;
grant execute on function public.hmrc_current_tax_year() to authenticated, service_role;

create or replace view public.v_hmrc_cis_pot_status
with (security_invoker = false) as
with
pot_scope as (
  select client_id, max(run_id) as run_id from hmrc.unallocated_credit group by client_id
),
pot as (
  select u.client_id,
         sum(u.amount) filter (where u.kind = 'payment') as cash,
         sum(u.amount) filter (where u.kind = 'credit')  as credit,
         sum(u.amount) filter (where u.kind = 'credit' and u.credit_type ilike '%CIS%')
                                                        as credit_cis
    from hmrc.unallocated_credit u
    join pot_scope s on s.client_id = u.client_id and s.run_id = u.run_id
   group by u.client_id
),
credit_scope as (
  select client_id, tax_year, max(run_id) as run_id from hmrc.credit group by client_id, tax_year
),
-- The only age signal there is. Unreliable by itself; the rules below say when
-- it may be trusted.
by_year as (
  select cr.client_id, cr.tax_year, sum(cr.amount) as amount
    from hmrc.credit cr
    join credit_scope s
      on s.client_id = cr.client_id and s.tax_year = cr.tax_year and s.run_id = cr.run_id
   where cr.allocated_to ilike '%not allocated%'
   group by cr.client_id, cr.tax_year
),
age as (
  select y.client_id,
         sum(y.amount)                                                        as across_years,
         sum(y.amount) filter (where y.tax_year = public.hmrc_current_tax_year())
                                                                             as in_current_year,
         count(*) filter (where y.amount = p.credit)                          as years_matching_pot,
         max(y.tax_year) filter (where y.amount = p.credit)                   as matched_year
    from by_year y
    join pot p on p.client_id = y.client_id
   group by y.client_id
),
verdict as (
  select p.client_id,
         coalesce(p.cash, 0)       as cash,
         coalesce(p.credit, 0)     as credit,
         coalesce(p.credit_cis, 0) as credit_cis,
         case
           -- The years add up to the balance, so they ARE its decomposition.
           when a.across_years = p.credit then 'decomposed'
           -- One year states the balance exactly: HMRC's latest restatement of
           -- the running total, and that year is the one it belongs to.
           when a.years_matching_pot = 1 then 'single year'
           when p.credit is null or p.credit = 0 then 'no credit'
           else 'age unknown'
         end as basis,
         a.in_current_year,
         a.matched_year
    from pot p
    left join age a on a.client_id = p.client_id
)
select c.entity_id,
       c.name     as hmrc_name,
       c.paye_ref,
       v.basis,
       -- Cash needs no test at all.
       round(v.cash::numeric / 100.0, 2)                                as cash_movable,
       round(case v.basis
               when 'decomposed'  then v.credit - coalesce(v.in_current_year, 0)
               when 'single year' then case when v.matched_year = public.hmrc_current_tax_year()
                                            then 0 else v.credit end
               else 0
             end::numeric / 100.0, 2)                                    as credit_movable,
       round(case v.basis
               when 'decomposed'  then coalesce(v.in_current_year, 0)
               when 'single year' then case when v.matched_year = public.hmrc_current_tax_year()
                                            then v.credit else 0 end
               else 0
             end::numeric / 100.0, 2)                                    as credit_locked,
       -- Not a nil. It is credit whose year cannot be read, and saying nothing
       -- is more use than saying a number that might be either.
       round(case when v.basis = 'age unknown' then v.credit else 0 end::numeric / 100.0, 2)
                                                                         as credit_age_unknown,
       round(v.credit::numeric / 100.0, 2)                               as credit_total,
       round(v.credit_cis::numeric / 100.0, 2)                           as credit_cis,
       v.matched_year,
       public.hmrc_current_tax_year()                                    as current_tax_year
  from verdict v
  join hmrc.client c on c.id = v.client_id
 where (v.cash <> 0 or v.credit <> 0)
   and public.hmrc_can_read();

comment on view public.v_hmrc_cis_pot_status is
  'What can be done with a client''s PAYE pot today. Cash is always movable; credit only if it arose in a CLOSED tax year. credit_age_unknown is credit whose year cannot be read from HMRC''s restated yearly rows - it is not nil and must not be presented as available.';

revoke all on public.v_hmrc_cis_pot_status from public, anon, authenticated;
grant select on public.v_hmrc_cis_pot_status to authenticated, service_role;
