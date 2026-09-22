-- 287_wp_hmrc_qbo_compare.sql
--
-- What the client's books say, against what HMRC says. Per client, per head.
--
-- This is the point of everything else: the scrape gives HMRC's side, the
-- nominal map (sql/286) says which account holds our side, wp_qbo_balance values
-- it, and this subtracts one from the other.
--
-- VARIANCE = QUICKBOOKS - HMRC, on every row, so one sign means one thing:
-- POSITIVE means the books are carrying more than HMRC agrees. On a liability
-- that is an over-accrual or a payment HMRC has not matched; on the CIS asset it
-- is a claim HMRC is not holding.
--
-- CIS IS NOT A LIABILITY AND IS NOT COMPARED TO ONE. cis_suffered is an ASSET --
-- what the client believes HMRC owes them. Its HMRC counterpart is not a tax
-- balance at all, it is the unallocated credit pot HMRC states on the
-- overdue-payments page (sql/281, classified by sql/284). Comparing it to the
-- PAYE liability, which is the obvious mistake, would net a debtor against a
-- creditor and produce a number meaning nothing.
--
-- PAYE CANNOT TIE AND IS NOT ASKED TO. hmrc.position.total_debt is HMRC's
-- OVERDUE figure, never a creditor, so a month accrued in the ledger and not yet
-- due to HMRC is a difference here by construction. Those rows are flagged
-- hmrc_overdue_only and get status 'timing' rather than 'variance', because the
-- alternative is somebody spending an afternoon on what is simply last month's
-- payroll. hmrc_paye_balance_at is the comparable figure and is an RPC per
-- scheme per date -- the honest next step, not something to fake here.
--
-- ONE ROW PER VALUATION DATE. This first took max(as_at) per realm, which meant
-- valuing a year end AFTER valuing today silently moved every variance on the
-- screen with nothing on HMRC's side having changed. The caller picks the date.
--
-- THE TWO SIDES ARE STILL AS AT DIFFERENT DATES AND THAT IS NOT FIXABLE HERE.
-- HMRC's figures are as at its last scrape, effectively now. Both dates are
-- returned so a reader can see the gap rather than assume there is none -- a
-- December year-end balance against a September HMRC position is a real
-- comparison for some questions and nonsense for others, and only the reader
-- knows which.
--
-- A VARIANCE HERE IS A QUESTION, NOT AN ERROR. HMRC and a ledger legitimately
-- differ: a payment in transit, an EPS HMRC has not processed. The value is in
-- the size and the direction, and in nothing moving when it should.

create or replace view public.v_wp_hmrc_qbo_compare
with (security_invoker = false) as
with
-- Which QuickBooks role answers which HMRC head.
pairing(role, head, what, hmrc_overdue_only) as (values
  ('paye_control', 'paye',            'PAYE/NIC owed to HMRC', true),
  ('vat_control',  'vat',             'VAT owed to HMRC', false),
  ('ct_liability', 'corporation-tax', 'Corporation Tax owed to HMRC', false),
  ('cis_suffered', 'cis',             'CIS suffered — an ASSET, against the credit HMRC holds', false)
),
conn as (
  select entity_id, min(realm_id) as realm_id
    from qbo_report_connections
   where status = 'active' and not is_practice and entity_id is not null
   group by entity_id
),
qbo as (
  select m.entity_id, p.head, p.role, b.as_at,
         sum(b.balance * coalesce(m.sign, 1)) as amount,
         count(*)                             as accounts,
         string_agg(m.qbo_account_name, ', ' order by m.qbo_account_name) as account_names
    from wp_nominal_map m
    join pairing p on p.role = m.role
    join conn c    on c.entity_id = m.entity_id
    join wp_qbo_balance b
      on b.realm_id = c.realm_id and b.account_id = m.qbo_account_id
   group by m.entity_id, p.head, p.role, b.as_at
),
-- HMRC's side. Three heads come from the tax summary; CIS comes from the pot.
hmrc as (
  select s.entity_id, s.tax as head, sum(s.balance) as amount, max(s.scraped_at) as as_at
    from v_hmrc_client_tax_summary s
   where s.tax in ('paye', 'vat', 'corporation-tax')
   group by s.entity_id, s.tax
  union all
  select p.entity_id, 'cis', sum(p.credit_cis), null::timestamptz
    from v_hmrc_cis_pot_status p
   where p.entity_id is not null
   group by p.entity_id
)
select e.id                          as entity_id,
       e.name                        as entity_name,
       cn.realm_id,
       p.head,
       p.role,
       p.what,
       round(coalesce(h.amount, 0), 2)  as hmrc_amount,
       round(q.amount, 2)               as qbo_amount,
       round(q.amount - coalesce(h.amount, 0), 2) as variance,
       q.accounts,
       q.account_names,
       q.as_at                          as qbo_as_at,
       h.as_at                          as hmrc_as_at,
       p.hmrc_overdue_only,
       case
         when q.amount is null                                        then 'not valued'
         when abs(q.amount - coalesce(h.amount, 0)) <= 0.005          then 'ties'
         when p.hmrc_overdue_only                                     then 'timing'
         else 'variance'
       end                              as status
  from pairing p
  join conn cn on true
  join entities e on e.id = cn.entity_id and e.entity_status = 'active'
  left join qbo  q on q.entity_id = e.id and q.head = p.head
  left join hmrc h on h.entity_id = e.id and h.head = p.head
 -- A client with neither a valuation nor an HMRC figure for a head is not a
 -- comparison waiting to happen, it is a head they are not registered for.
 where (q.amount is not null or coalesce(h.amount, 0) <> 0)
   and public.hmrc_can_read();

comment on view public.v_wp_hmrc_qbo_compare is
  'Client books against HMRC, per head, ONE ROW PER VALUATION DATE - the caller picks which, because taking the newest meant a year-end valuation silently moved every variance with nothing on HMRC''s side having changed. variance = QuickBooks less HMRC, so positive always means the books carry more than HMRC agrees. cis compares the CIS suffered ASSET to the unallocated credit pot. PAYE is flagged hmrc_overdue_only: HMRC total_debt is arrears not a creditor, so an accrued month reads as a difference by construction.';

revoke all on public.v_wp_hmrc_qbo_compare from public, anon, authenticated;
grant select on public.v_wp_hmrc_qbo_compare to authenticated, service_role;
