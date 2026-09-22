-- 286_wp_nominal_proposals.sql
--
-- Propose a nominal mapping per client per role, from QuickBooks' own typing.
--
-- The HMRC-vs-QuickBooks comparison needs to know which account in a client's
-- file holds their PAYE, VAT, CT and CIS. wp_nominal_map held FIVE ROWS for ONE
-- client against 134 linked QuickBooks connections, so the comparison had
-- nothing to stand on, and mapping 134 files by hand is why it never happened.
--
-- NAME MATCHING IS NOT THE ANSWER and docs/hmrc-timing-and-cis-rules.md says so:
-- "PAYE" appears as a control account, as an employer-NIC expense line, and in
-- at least one file as a bank account somebody created by mistake. So these
-- proposals come from AccountSubType, which QuickBooks sets itself when a
-- feature is switched on, not from what anyone typed in the name field.
--
-- Measured across 127 pulled charts on 22 Sep 2026:
--
--   cis_suffered   WithholdingAssetAmount        24 realms, 1 account each  100%
--   cis_withheld   WithholdingLiabilityAmount    24 realms, 1 account each  100%
--   vat_control    GlobalTaxPayable              89 exact, 2 ambiguous       98%
--   ct_liability   CurrentTaxLiability           94 exact, 11 ambiguous      90%
--   paye_control   PayrollTaxPayable             20 exact, 61 ambiguous      25%
--   net_wages      PayrollClearing               23 exact, 82 ambiguous      22%
--
-- WHY PAYE AND NET WAGES NEVER AUTO-CONFIRM. PayrollTaxPayable averages three
-- accounts per realm, and they are not one control split into sub-accounts -
-- they are DIFFERENT CREDITORS. Across the book: "Tax and National Insurance"
-- (62 realms, and the one we want), "Other Deductions" (38), "Attachment Order
-- Deductions" (37, court orders), "Total Pension Contributions" (36, which goes
-- to the pension provider). Summing the sub-type would post pensions and
-- attachment orders to the PAYE liability. A name shortlist gets it to 78%, but
-- at that point the NAME is doing the work, which is the trap. So those two
-- roles are always 'choose': candidates are ranked and a person picks.
--
-- Nothing here writes. It proposes; wp_nominal_map is still the record, and it
-- carries created_by so every mapping says who accepted it.

create or replace view public.v_wp_nominal_proposals
with (security_invoker = true) as
with roles(role, sub_type, keep, drop_it, auto_ok, label) as (values
  ('cis_suffered', 'WithholdingAssetAmount',     null, null, true,
   'CIS suffered (asset) — CIS deducted from the client''s own sales'),
  ('cis_withheld', 'WithholdingLiabilityAmount', null, null, true,
   'CIS withheld — CIS the client deducted from subcontractors'),
  ('vat_control',  'GlobalTaxPayable',           null, null, true,
   'VAT control'),
  ('ct_liability', 'CurrentTaxLiability',        null, null, true,
   'Corporation Tax liability'),
  -- Candidates are narrowed for readability, never to justify auto-confirming.
  ('paye_control', 'PayrollTaxPayable',
   '(tax and national insurance|^paye|:paye|hmrc)',
   '(pension|attachment|other deduction|nest|net wages)', false,
   'PAYE control — HMRC only, not pensions or attachment orders'),
  ('net_wages',    'PayrollClearing', null, null, false,
   'Net wages control')
),
-- One realm per entity. A client with two connections is not guessed at.
conn as (
  select entity_id, min(realm_id) as realm_id, count(*) as connections
    from qbo_report_connections
   where status = 'active' and not is_practice and entity_id is not null
   group by entity_id
),
cand as (
  select c.entity_id, c.realm_id, c.connections, r.role, r.label, r.auto_ok,
         a.account_id, a.fully_qualified, a.account_sub_type,
         -- Ranked so the likely one is first in the picker. Ordering is a
         -- convenience; it never decides anything.
         row_number() over (
           partition by c.entity_id, r.role
           order by (case when r.keep is not null
                           and a.fully_qualified ~* r.keep then 0 else 1 end),
                    a.fully_qualified) as rank
    from conn c
    join roles r on true
    join wp_qbo_account a
      on a.realm_id = c.realm_id and a.active and a.account_sub_type = r.sub_type
     and (r.drop_it is null or a.fully_qualified !~* r.drop_it)
),
agg as (
  select entity_id, realm_id, connections, role, label, auto_ok,
         count(*) as n_candidates,
         (array_agg(account_id      order by rank))[1] as top_account_id,
         (array_agg(fully_qualified order by rank))[1] as top_account_name,
         jsonb_agg(jsonb_build_object(
           'account_id', account_id, 'name', fully_qualified,
           'sub_type', account_sub_type) order by rank) as candidates
    from cand
   group by entity_id, realm_id, connections, role, label, auto_ok
)
select e.id                      as entity_id,
       e.name                    as entity_name,
       a.realm_id,
       a.connections,
       a.role,
       a.label,
       a.n_candidates,
       a.top_account_id,
       a.top_account_name,
       a.candidates,
       m.qbo_account_id          as mapped_account_id,
       m.qbo_account_name        as mapped_account_name,
       case
         when m.id is not null                      then 'mapped'
         when a.n_candidates = 1 and a.auto_ok      then 'auto'
         when a.n_candidates >= 1                   then 'choose'
         else 'none'
       end                       as status
  from agg a
  join entities e on e.id = a.entity_id and e.entity_status = 'active'
  left join wp_nominal_map m on m.entity_id = a.entity_id and m.role = a.role;

comment on view public.v_wp_nominal_proposals is
  'Proposed nominal mappings from QuickBooks AccountSubType, which QBO sets itself - never from account names, which the working-papers doc records as a trap. status auto means one typed candidate and safe to accept in bulk; choose means a person picks. paye_control and net_wages are never auto: PayrollTaxPayable and PayrollClearing hold several different creditors per file, including pensions and attachment orders.';

-- security_invoker: this reads only public tables that carry their own RLS
-- (wp_qbo_account, wp_nominal_map, qbo_report_connections, entities), so the
-- base-table policies do the work rather than a predicate bolted on here.
revoke all on public.v_wp_nominal_proposals from public, anon, authenticated;
grant select on public.v_wp_nominal_proposals to authenticated, service_role;
