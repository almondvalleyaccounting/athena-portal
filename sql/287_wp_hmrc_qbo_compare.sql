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
-- THE TWO SIDES ARE AS AT DIFFERENT DATES AND THAT IS NOT FIXABLE HERE. HMRC's
-- figures are as at its last scrape, effectively now. QuickBooks is valued at
-- whatever date someone asked wp-qbo-accounts for. Both dates are returned so a
-- reader can see the gap rather than assume there is none -- a client's December
-- year-end balance against HMRC's September position is a real comparison for
-- some questions and nonsense for others, and only the reader knows which.
--
-- A VARIANCE HERE IS A QUESTION, NOT AN ERROR. HMRC and a ledger legitimately
-- differ: a month accrued but not yet due, a payment in transit, an EPS HMRC has
-- not processed. The value is in the size and the direction, and in nothing
-- moving when it should.

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
-- The latest valuation per realm. wp_qbo_balance keeps a row per as-at date, so
-- without this the comparison would sum a client's December and March balances.
latest_asat as (
  select realm_id, max(as_at) as as_at from wp_qbo_balance group by realm_id
),
qbo as (
  select m.entity_id, p.head, p.role,
         sum(b.balance * coalesce(m.sign, 1)) as amount,
         count(*)                             as accounts,
         string_agg(m.qbo_account_name, ', ' order by m.qbo_account_name) as account_names,
         max(b.as_at)                         as as_at
    from wp_nominal_map m
    join pairing p   on p.role = m.role
    join conn c      on c.entity_id = m.entity_id
    join latest_asat l on l.realm_id = c.realm_id
    join wp_qbo_balance b
      on b.realm_id = c.realm_id and b.account_id = m.qbo_account_id and b.as_at = l.as_at
   group by m.entity_id, p.head, p.role
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
       -- hmrc.position.total_debt is HMRC OVERDUE figure, never a creditor. A
       -- month accrued in the ledger and not yet due to HMRC is a difference
       -- here by construction, not one worth chasing. hmrc_paye_balance_at is
       -- the comparable figure and is an RPC per scheme per date, so this says
       -- so rather than quietly setting a creditor against an arrears number.
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
  'Client books against HMRC, per head. variance = QuickBooks less HMRC, so positive always means the books carry more than HMRC agrees. cis compares the CIS suffered ASSET to the unallocated credit pot, not to a tax liability. The two sides are as at different dates and both are returned.';

revoke all on public.v_wp_hmrc_qbo_compare from public, anon, authenticated;
grant select on public.v_wp_hmrc_qbo_compare to authenticated, service_role;
