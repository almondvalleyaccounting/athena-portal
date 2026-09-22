-- 285_hmrc_client_position.sql
--
-- One HMRC position per client, because that is how HMRC behaves.
--
-- v_hmrc_client_totals pivots four heads into four columns and calls their sum
-- "total". That total is a sum of DEBTS. It nets nothing, so a client owing
-- £7,865 on PAYE while HMRC sits on £12,648 of their CIS credit reads as a
-- debtor. Across the book: 107 debtors owing £870,995.12 against £228,873.93
-- held, so the headline overstates the real position by 26%.
--
-- WHERE CREDIT WAS HIDING, per head, measured 22 Sep 2026:
--
--   Corporation Tax  nets already -- ct_period.total is signed, and 29 clients
--                    carry £30,532.87 of negative balances.
--   PAYE             INVISIBLE. position.total_debt is HMRC's OVERDUE figure and
--                    is never negative, so no amount of credit could ever show.
--                    The £228,873.93 pot comes from sql/281 instead.
--   Self Assessment  sa_position.available_for_repayment, £14,590.94. The only
--                    head whose credit_available column was ever populated.
--   VAT              NOT CAPTURED AT ALL. hmrc.vat_owed lists what is owed and
--                    nothing else, so a client awaiting a VAT repayment shows a
--                    flat zero. Named in vat_credit_not_captured below rather
--                    than left for someone to discover as a wrong number.
--
-- NET IS NOT THE SAME AS PAYABLE. Netting assumes the credit can be applied, and
-- for current-year CIS credit it cannot -- it offsets this year's PAYE bills and
-- moves nowhere else until 6 April. So this view carries both: `net_position`
-- (everything offset, the true economic position) and `payable_now` (only what
-- can actually be moved today). See docs/hmrc-timing-and-cis-rules.md.

create or replace view public.v_hmrc_client_position
with (security_invoker = false) as
with
-- Signed balances per head, split into what is owed and what is held.
heads as (
  select s.entity_id,
         max(s.entity_name) as entity_name,
         sum(greatest(s.balance, 0)) filter (where s.tax = 'paye')            as owed_paye,
         sum(greatest(s.balance, 0)) filter (where s.tax = 'corporation-tax') as owed_ct,
         sum(greatest(s.balance, 0)) filter (where s.tax = 'vat')             as owed_vat,
         sum(greatest(s.balance, 0)) filter (where s.tax = 'self-assessment') as owed_sa,
         sum(greatest(s.balance, 0))                                          as owed_total,
         -- A negative balance is HMRC holding money on that head. Only CT ever
         -- produces one today.
         sum(greatest(-s.balance, 0))                                         as held_negative_balances,
         sum(s.credit_available)                                              as held_sa,
         bool_or(s.payment_plan)                                              as payment_plan,
         count(distinct s.tax) filter (where s.balance > 0)                   as taxes_owing,
         max(s.scraped_at)                                                    as last_scraped
    from v_hmrc_client_tax_summary s
   group by s.entity_id
),
-- The PAYE pot, already classified by what can be done with it (sql/284).
pot as (
  select p.entity_id,
         sum(p.cash_movable)       as paye_cash,
         sum(p.credit_movable)     as paye_credit_movable,
         sum(p.credit_locked)      as paye_credit_locked,
         sum(p.credit_age_unknown) as paye_credit_unknown,
         sum(p.credit_cis)         as paye_credit_cis
    from v_hmrc_cis_pot_status p
   where p.entity_id is not null
   group by p.entity_id
)
select h.entity_id,
       h.entity_name,
       round(coalesce(h.owed_paye, 0), 2) as owed_paye,
       round(coalesce(h.owed_ct,   0), 2) as owed_ct,
       round(coalesce(h.owed_vat,  0), 2) as owed_vat,
       round(coalesce(h.owed_sa,   0), 2) as owed_sa,
       round(coalesce(h.owed_total, 0), 2) as owed_total,

       round(coalesce(p.paye_cash, 0), 2)           as held_paye_cash,
       round(coalesce(p.paye_credit_movable, 0), 2) as held_paye_credit_movable,
       round(coalesce(p.paye_credit_locked, 0), 2)  as held_paye_credit_locked,
       round(coalesce(p.paye_credit_unknown, 0), 2) as held_paye_credit_unknown,
       round(coalesce(p.paye_credit_cis, 0), 2)     as held_paye_credit_cis,
       round(coalesce(h.held_negative_balances, 0), 2) as held_other_heads,
       round(coalesce(h.held_sa, 0), 2)             as held_sa,

       round(coalesce(p.paye_cash, 0) + coalesce(p.paye_credit_movable, 0)
           + coalesce(p.paye_credit_locked, 0) + coalesce(p.paye_credit_unknown, 0)
           + coalesce(h.held_negative_balances, 0) + coalesce(h.held_sa, 0), 2)
                                                    as held_total,

       -- Everything offset: the true economic position, and what the practice
       -- owes HMRC in any meaningful sense.
       round(coalesce(h.owed_total, 0)
           - (coalesce(p.paye_cash, 0) + coalesce(p.paye_credit_movable, 0)
            + coalesce(p.paye_credit_locked, 0) + coalesce(p.paye_credit_unknown, 0)
            + coalesce(h.held_negative_balances, 0) + coalesce(h.held_sa, 0)), 2)
                                                    as net_position,

       -- What is still owed after applying only what can be moved TODAY. Locked
       -- and age-unknown credit is excluded, because a net position that assumes
       -- an offset HMRC will not make until 6 April is a forecast, not a balance.
       round(coalesce(h.owed_total, 0)
           - (coalesce(p.paye_cash, 0) + coalesce(p.paye_credit_movable, 0)
            + coalesce(h.held_negative_balances, 0) + coalesce(h.held_sa, 0)), 2)
                                                    as payable_now,

       h.taxes_owing,
       h.payment_plan,
       h.last_scraped,
       -- A VAT repayment position is not scraped. hmrc.vat_owed lists what is
       -- owed and holds no negative row anywhere, so a client awaiting a
       -- repayment is indistinguishable from one with a nil position -- and
       -- because the summary only carries clients WITH owed rows, they are
       -- simply absent from the VAT arm rather than showing a zero.
       --
       -- 100 clients are scraped for VAT and 33 have owed rows, so this is true
       -- for 67 of them. Flagged from vat_client, not from the summary: keying
       -- it on owed_vat = 0 never fired, because a client with no VAT debt has
       -- no VAT row to be zero on.
       exists (select 1 from hmrc.vat_client vc
                where vc.entity_id = h.entity_id
                  and not exists (select 1 from v_hmrc_client_tax_summary v
                                   where v.entity_id = h.entity_id and v.tax = 'vat'))
                                                    as vat_credit_not_captured
  from heads h
  left join pot p on p.entity_id = h.entity_id
 where public.hmrc_can_read();

comment on view public.v_hmrc_client_position is
  'One HMRC position per client across all four heads. owed_total sums debts; held_total sums everything HMRC is sitting on; net_position is the true economic position and payable_now applies only credit that can be moved today. PAYE credit comes from sql/281 because position.total_debt is overdue-only and can never be negative. VAT repayment positions are not scraped - vat_credit_not_captured flags where that matters.';

revoke all on public.v_hmrc_client_position from public, anon, authenticated;
grant select on public.v_hmrc_client_position to authenticated, service_role;
