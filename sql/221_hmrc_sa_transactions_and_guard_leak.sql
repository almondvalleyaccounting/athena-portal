-- 221 — Self Assessment payments and credits, and a cross-client leak.
--
-- PART 1: THE LEAK. Found while checking whether sa_transaction was already
-- exposed. Every v_hmrc_* view is owned by postgres and therefore bypasses RLS,
-- so `where public.hmrc_can_read()` IS the access control (sql/197). Five views
-- never had it. Proved by setting request.jwt.claims to a non-staff uuid — a
-- logged-in CLIENT PORTAL user, who holds an `authenticated` session just like
-- staff — and counting rows:
--
--   v_hmrc_money_movements   8,194 rows   every client's payments, repayments and
--                                         transfers, with names, references, dates
--                                         and amounts. The serious one.
--   v_hmrc_charge_scope        987 rows   internal ids only (client_id, tax_year, run_id)
--   v_hmrc_ct_scope            222 rows   internal ids only
--   v_hmrc_sa_scope             89 rows   internal ids only
--   v_hmrc_vat_scope            86 rows   internal ids only
--
-- Not reachable anonymously — it needs a login — but any portal client could read
-- the whole practice's HMRC money history. Third instance of this same mistake
-- after sql/202 (v_hmrc_paye_balance granted to anon) and sql/220
-- (hmrc_request_refresh executable by anon).
--
-- Checked before adding the guard, because hmrc_can_read() is FALSE for
-- service_role: no edge function, no cron job and nothing in the scraper repo
-- reads any v_hmrc_* view, so nothing server-side breaks.
--
-- v_hmrc_client_totals and v_hmrc_paye_trend_monthly also lack a literal guard but
-- return 0 rows to a non-staff session because they select from guarded views.
-- Left alone rather than retyped: correct today, but only transitively, so anyone
-- editing their source must keep the guard.
--
-- PART 2: SELF ASSESSMENT PAYMENTS. hmrc.sa_transaction was already read by
-- v_hmrc_money_movements (so it fed the Client tab ledger) but nothing showed it
-- on the SA tab, and its classification there was wrong in a way that mattered:
--
--   when direction = 'from_hmrc' then 'cash_to_client'
--   when direction = 'to_hmrc'   then 'paid_by_client'
--
-- Every to_hmrc row became "paid by client". But direction does not mean "a
-- payment" — it means which side of the account the money landed. Reading the
-- actual descriptions, to_hmrc covers four different things:
--
--   Payment                                  542 rows  £688,904.10   real money in
--   Overpayment from tax return for ...      243 rows  £358,872.22   credit from the return
--   Repayment supplement (interest)          284 rows    £2,067.85   interest HMRC adds
--   Credit transfer in                        10 rows   £11,031.46   moved from another tax
--
-- So the ledger was calling ~£372k of credits "client payments" against £689k of
-- genuine ones — and worst of all it buried "Credit transfer in" as a payment.
-- That transfer IS the CIS story: credit built on PAYE, reallocated across, refund
-- of the difference. It now classifies as from_another_tax, which is what the
-- Client tab's "credit moved in" tile counts.
--
-- Money out is bank/card/cheque repayment: 254 rows, £447,795.08.
--
-- ALL FIGURES ABOVE ARE RUN-SCOPED. Raw hmrc.sa_transaction holds 3,999 rows
-- across 3 runs for 1,333 real ones — the scraper appends per run (sql/198), so an
-- unscoped read triples the money. Every figure here goes through v_hmrc_sa_scope.
-- Unlike hmrc.payment, every row carries a real txn_date, so no hmrc_safe_date
-- is needed.

-- ---------------------------------------------------------------- part 1: guards

create or replace view public.v_hmrc_charge_scope as
select client_id, tax_year, max(run_id) as run_id
from hmrc.charge
where public.hmrc_can_read()
group by client_id, tax_year;

create or replace view public.v_hmrc_ct_scope as
select client_id, max(run_id) as run_id
from (
  select client_id, run_id from hmrc.ct_period
  union all
  select client_id, run_id from hmrc.ct_transaction
) s
where public.hmrc_can_read()
group by client_id;

create or replace view public.v_hmrc_sa_scope as
select client_id, max(run_id) as run_id
from (
  select client_id, run_id from hmrc.sa_position
  union all
  select client_id, run_id from hmrc.sa_transaction
) s
where public.hmrc_can_read()
group by client_id;

create or replace view public.v_hmrc_vat_scope as
select client_id, max(run_id) as run_id
from (
  select client_id, run_id from hmrc.vat_owed
  union all
  select client_id, run_id from hmrc.vat_payment
) s
where public.hmrc_can_read()
group by client_id;

revoke all on public.v_hmrc_charge_scope, public.v_hmrc_ct_scope,
              public.v_hmrc_sa_scope,     public.v_hmrc_vat_scope from public, anon;
grant select on public.v_hmrc_charge_scope, public.v_hmrc_ct_scope,
                public.v_hmrc_sa_scope,     public.v_hmrc_vat_scope to authenticated, service_role;

-- ------------------------------------------------- part 2: the SA movement ledger

create or replace view public.v_hmrc_sa_transactions as
select
  sc.entity_id,
  sc.utr,
  sc.name                                  as hmrc_name,
  t.txn_date,
  t.description,
  t.kind,
  t.direction,
  -- Same vocabulary as v_hmrc_money_movements, so the two agree. Order matters:
  -- a genuine payment first, then anything leaving HMRC, then a transfer in
  -- (which is direction to_hmrc), and only then the non-cash credits.
  case
    when t.kind = 'payment'        then 'paid_by_client'
    when t.direction = 'from_hmrc' then 'cash_to_client'
    when t.kind = 'transfer'       then 'from_another_tax'
    else 'other'
  end                                      as movement,
  -- Plain English, because "other / to_hmrc" tells a human nothing.
  case
    when t.kind = 'payment'                                          then 'Payment'
    when t.direction = 'from_hmrc'                                   then 'Repaid to client'
    when t.kind = 'transfer'                                         then 'Credit in from another tax'
    when t.kind = 'repayment_interest'                               then 'Repayment supplement (interest)'
    when t.description ilike 'Overpayment from tax return%'          then 'Overpayment from return'
    when t.description ilike 'Amount collected through tax code%'    then 'Collected through tax code'
    else 'Other credit'
  end                                      as label,
  -- Cash that actually moved through a bank, as against a credit arising on the
  -- account. The distinction the old classification lost.
  (t.kind = 'payment' or t.direction = 'from_hmrc') as is_cash,
  -- Which year the credit belongs to, where HMRC says so in the description.
  nullif(substring(t.description from 'ending [0-9]{2} [A-Za-z]{3} ([0-9]{4})'), '') as tax_year_ending,
  round(abs(t.amount)::numeric / 100.0, 2) as amount
from hmrc.sa_transaction t
join public.v_hmrc_sa_scope s on s.client_id = t.client_id and s.run_id = t.run_id
join hmrc.sa_client sc        on sc.id = t.client_id
where public.hmrc_can_read();

comment on view public.v_hmrc_sa_transactions is
  'Self Assessment payments and credits, run-scoped and in pounds. `direction` is which side of the HMRC '
  'account the money landed, NOT whether it was a payment — to_hmrc covers real payments, overpayments '
  'arising from the return, repayment supplement interest and credit transferred in from another tax. Use '
  '`movement` (shared vocabulary with v_hmrc_money_movements), `label` for display, and `is_cash` to '
  'separate money that moved through a bank from a credit raised on the account.';

revoke all on public.v_hmrc_sa_transactions from public, anon;
grant select on public.v_hmrc_sa_transactions to authenticated, service_role;

-- --------------------- part 2b: money_movements — guard, and one SA definition

-- Recreated to add the guard AND to take its Self Assessment arm from the view
-- above, so there is a single classification of an SA movement rather than two
-- that can drift. Every other arm is unchanged from sql/213.
create or replace view public.v_hmrc_money_movements as
with ct_txn as (
  select t.id, t.run_id, t.client_id, t.period_end, t.line, t.txn_date, t.description,
         t.amount, t.kind, t.direction, t.source_period_end, t.source_stated,
         cc.name as client_name, cc.utr
  from hmrc.ct_transaction t
  join public.v_hmrc_ct_scope s on s.client_id = t.client_id and s.run_id = t.run_id
  join hmrc.ct_client cc on cc.id = t.client_id
  where t.line = 'repayment'
),
ct_classified as (
  select o.client_id, o.client_name, o.utr, o.period_end, o.txn_date, o.description,
         abs(o.amount) as amount,
         case
           when o.kind = 'repayment_cash' then 'cash_to_client'
           when o.kind = 'reallocation_ct' then 'internal_ct'
           when o.kind = 'transfer_other_tax' and m.id is not null then 'internal_ct'
           when o.kind = 'transfer_other_tax' and o.direction = 'in'  then 'from_another_tax'
           when o.kind = 'transfer_other_tax' and o.direction = 'out' then 'to_another_tax'
           else 'unclear'
         end as movement
  from ct_txn o
  left join ct_txn m
    on m.client_id = o.client_id and m.txn_date = o.txn_date
   and abs(m.amount) = abs(o.amount) and m.kind = 'reallocation_ct'
   and m.source_period_end = o.period_end
   and o.kind = 'transfer_other_tax' and o.direction = 'out'
)
select lk.entity_id, c.client_name as hmrc_name, 'corporation-tax'::text as tax,
       c.utr as reference, c.txn_date, c.movement, c.description,
       c.period_end::text as period, round(c.amount::numeric / 100.0, 2) as amount
from ct_classified c
join public.v_hmrc_ct_link lk on lk.ct_client_id = c.client_id
where c.movement = any (array['from_another_tax','to_another_tax','cash_to_client','internal_ct'])
  and public.hmrc_can_read()

union all
select vc.entity_id, vc.name, 'vat', vc.vrn, p.txn_date,
       case
         when p.kind = any (array['repayment','repayment_interest']) then 'cash_to_client'
         when p.kind = 'transfer' and p.direction = 'from_hmrc' then 'from_another_tax'
         when p.kind = 'transfer' then 'to_another_tax'
         when p.direction = 'to_hmrc' then 'paid_by_client'
         else 'other'
       end,
       p.description,
       coalesce(p.period_from::text, '') ||
         case when p.period_to is not null then ' to ' || p.period_to::text else '' end,
       round(p.amount::numeric / 100.0, 2)
from hmrc.vat_payment p
join public.v_hmrc_vat_scope s on s.client_id = p.client_id and s.run_id = p.run_id
join hmrc.vat_client vc on vc.id = p.client_id
where public.hmrc_can_read()

union all
-- One definition of an SA movement, shared with the SA tab.
select t.entity_id, t.hmrc_name, 'self-assessment', t.utr, t.txn_date, t.movement,
       t.description, coalesce(t.tax_year_ending, ''), t.amount
from public.v_hmrc_sa_transactions t

union all
select c.entity_id, c.name, 'paye', c.paye_ref,
       public.hmrc_safe_date(p.received_on), 'paid_by_client',
       coalesce(p.allocated_to, 'Unallocated'), coalesce(p.allocated_year, ''),
       round(p.amount::numeric / 100.0, 2)
from hmrc.payment p
join hmrc.client c on c.id = p.client_id
where p.run_id = (select max(p2.run_id) from hmrc.payment p2 where p2.client_id = p.client_id)
  and coalesce(p.received_on, '') <> 'Total payment amount'
  and public.hmrc_can_read();

comment on view public.v_hmrc_money_movements is
  'Every movement of money between a client and HMRC across all four taxes, one row each. The Self '
  'Assessment arm comes from v_hmrc_sa_transactions so there is one classification, not two: it previously '
  'called every to_hmrc row paid_by_client, which mislabelled ~£372k of overpayments, tax-code collections '
  'and repayment supplement as client payments and buried Credit transfer in — the CIS reallocation — among '
  'them.';

revoke all on public.v_hmrc_money_movements from public, anon;
grant select on public.v_hmrc_money_movements to authenticated, service_role;
