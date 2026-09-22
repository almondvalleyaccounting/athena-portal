-- 282_hmrc_cis_credit_reconciliation.sql
--
-- The CIS credit pot per client, and what happened to the rest of the claim.
--
-- The question this answers is Bobby's, in his words: we apply for the credit to
-- be allocated or repaid, weeks later HMRC decides -- use it against other
-- bills, reallocate it, or refund it -- "they are a law unto themselves so we
-- just need to wait and see what they eventually do and then we are left putting
-- the pieces together and checking it's right". This is the pieces, together.
--
-- THE ONE FIGURE THAT IS NOT INFERRED is `pot_cis`: HMRC's own statement of
-- unallocated CIS credit, read off the PAYE overdue-payments page (sql/281).
-- Everything else here is arithmetic over the credits history.
--
-- WHY `not_allocated_label` IS IN THIS VIEW AT ALL. It is the obvious figure to
-- reach for and it is wrong. HMRC's credits page keeps the label `Not allocated`
-- after the money has gone: LJM Gas Glasgow's 2024-25 still reads GBP 19,173.29
-- not allocated, which is precisely the sum that left for Corporation Tax on
-- 18 Dec 2025. Across the book on 22 Sep 2026 it summed to GBP 863,724.55
-- against a stated pot of GBP 118,671.51 -- an overstatement of about GBP 745k.
-- It is carried here beside the real figure so that anyone who reaches for it
-- sees the two side by side, rather than finding it alone somewhere else.
--
-- `left_the_paye_account` IS INFERENCE and is named as such. It is what was
-- posted, less what was consumed on PAYE bills, less what HMRC still holds. It
-- lumps together credit reallocated to another tax and credit refunded in cash,
-- because the PAYE account distinguishes neither:
--
--   * a reallocation shows up on the RECEIVING tax, as a "Miscellaneous
--     transfer" that does not name its source. v_hmrc_money_movements has them,
--     and matching one back to PAYE is by amount and date, not by anything HMRC
--     told us.
--   * a cash refund appears NOWHERE on HMRC. The PAYE account has no repayments
--     screen. LJM's GBP 27,649.48 of 15 Jul 2026 was found only as a credit to
--     the client's own QuickBooks nominal, off the bank feed.
--
-- So the split between those two is not derivable here and this view does not
-- pretend to it. The client's ledger decides, via wp-qbo-ledger against their
-- CIS suffered nominal.

create or replace view public.v_hmrc_cis_credit
with (security_invoker = false) as
with
-- Every child table is appended per run, so both of these scope to the latest
-- run rather than summing across scrapes (sql/198 is what that costs).
credit_scope as (
  select client_id, tax_year, max(run_id) as run_id
    from hmrc.credit group by client_id, tax_year
),
consumed as (
  select cr.client_id,
         sum(cr.amount)                                                     as cis_posted,
         sum(cr.amount) filter (where cr.allocated_to ~* 'PAYE bill')        as cis_used_on_paye,
         sum(cr.amount) filter (where cr.allocated_to ilike '%not allocated%')
                                                                            as not_allocated_label,
         sum(cr.amount) filter (where cr.allocated_to !~* 'PAYE bill'
                                  and cr.allocated_to not ilike '%not allocated%')
                                                                            as cis_used_elsewhere,
         min(cr.tax_year)                                                   as first_year,
         max(cr.tax_year)                                                   as last_year
    from hmrc.credit cr
    join credit_scope s
      on s.client_id = cr.client_id and s.tax_year = cr.tax_year and s.run_id = cr.run_id
   where cr.credit_type ilike '%CIS%'
   group by cr.client_id
),
pot_scope as (
  select client_id, max(run_id) as run_id from hmrc.unallocated_credit group by client_id
),
pot as (
  select u.client_id,
         sum(u.amount) filter (where u.kind = 'credit' and u.credit_type ilike '%CIS%')
                                                                            as pot_cis,
         sum(u.amount) filter (where u.kind = 'credit' and u.credit_type not ilike '%CIS%')
                                                                            as pot_other_credits,
         sum(u.amount) filter (where u.kind = 'payment')                    as unallocated_payments,
         -- False on any row means the client's block did not add up. One
         -- doubtful line makes the whole client doubtful.
         bool_and(coalesce(u.detail_ties, true))                            as pot_ties
    from hmrc.unallocated_credit u
    join pot_scope s on s.client_id = u.client_id and s.run_id = u.run_id
   group by u.client_id
)
select c.entity_id,
       c.name     as hmrc_name,
       c.paye_ref,
       -- HMRC's own, current, and the only figure here that is not arithmetic.
       round(coalesce(p.pot_cis, 0)::numeric / 100.0, 2)              as pot_cis,
       round(coalesce(p.pot_other_credits, 0)::numeric / 100.0, 2)    as pot_other_credits,
       round(coalesce(p.unallocated_payments, 0)::numeric / 100.0, 2) as unallocated_payments,
       p.pot_ties,
       round(coalesce(k.cis_posted, 0)::numeric / 100.0, 2)           as cis_posted,
       round(coalesce(k.cis_used_on_paye, 0)::numeric / 100.0, 2)     as cis_used_on_paye,
       round(coalesce(k.cis_used_elsewhere, 0)::numeric / 100.0, 2)   as cis_used_elsewhere,
       -- Kept beside the real pot on purpose. See the header.
       round(coalesce(k.not_allocated_label, 0)::numeric / 100.0, 2)  as not_allocated_label,
       -- INFERENCE. Reallocated to another tax, or refunded in cash, with no way
       -- here to say which. Negative means HMRC holds more than our credit
       -- history explains, which is a scrape-depth problem: credits are only as
       -- deep as the years fetched, and the pot reaches back further.
       round((coalesce(k.cis_posted, 0)
              - coalesce(k.cis_used_on_paye, 0)
              - coalesce(k.cis_used_elsewhere, 0)
              - coalesce(p.pot_cis, 0))::numeric / 100.0, 2)          as left_the_paye_account,
       k.first_year,
       k.last_year
  from hmrc.client c
  left join consumed k on k.client_id = c.id
  left join pot      p on p.client_id = c.id
 where (k.client_id is not null or p.client_id is not null)
   and public.hmrc_can_read();

comment on view public.v_hmrc_cis_credit is
  'CIS credit per client: the pot HMRC states, what was consumed, and what left the PAYE account. pot_cis is HMRC''s own figure; left_the_paye_account is inference and cannot separate a reallocation from a cash refund. not_allocated_label is HMRC''s stale column, carried only so nobody reads it alone.';

-- A definer view over the private hmrc schema. `authenticated` is revoked before
-- being granted select: a default privilege on the public schema grants anon AND
-- authenticated arwdDxtm on everything created here, so a bare grant would leave
-- the write bits from creation in place.
revoke all on public.v_hmrc_cis_credit from public, anon, authenticated;
grant select on public.v_hmrc_cis_credit to authenticated, service_role;
