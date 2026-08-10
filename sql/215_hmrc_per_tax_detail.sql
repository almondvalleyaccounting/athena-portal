-- 215 — Per-tax detail for the consolidated client view.
--
-- v_hmrc_client_tax_summary gives one balance per client per tax head. These give
-- what sits behind each of those balances, so a tax head can be opened without
-- leaving the client.
--
-- All three scope to the CLIENT's latest run (sql/214), never the service's, for
-- the reason set out there: a per-client refresh writes a run containing one
-- client.
--
-- PAYE already has its detail surfaces (v_hmrc_paye_client_statement,
-- v_hmrc_paye_overdue, v_hmrc_paye_payment_detail) so it is not repeated here.

-- ── Corporation Tax: one row per accounting period ──────────────────
create or replace view public.v_hmrc_ct_periods as
select
  lk.entity_id,
  lk.utr,
  lk.hmrc_name,
  p.period_end,
  p.period_index,
  p.status,
  round(p.balance                  / 100.0, 2) as balance,
  round(p.tax                      / 100.0, 2) as tax,
  round(p.interest                 / 100.0, 2) as interest,
  round(p.penalties                / 100.0, 2) as penalties,
  round(p.sub_total                / 100.0, 2) as sub_total,
  round(p.less_paid                / 100.0, 2) as less_paid,
  round(p.repayments_reallocations / 100.0, 2) as repayments_reallocations,
  round(p.adjustments              / 100.0, 2) as adjustments,
  round(p.total                    / 100.0, 2) as total,
  p.unreadable
from hmrc.ct_period p
join public.v_hmrc_ct_scope s on s.client_id = p.client_id and s.run_id = p.run_id
join public.v_hmrc_ct_link lk on lk.ct_client_id = p.client_id
where public.hmrc_can_read();

comment on view public.v_hmrc_ct_periods is
  'Corporation Tax by accounting period: tax, interest, penalties, what has been paid, and what reallocations and repayments moved. `unreadable` marks a period the scraper could not parse — treat its figures as unknown, not zero. Amounts in POUNDS.';

-- ── VAT: what is owed, line by line ─────────────────────────────────
create or replace view public.v_hmrc_vat_owed as
select
  vc.entity_id,
  vc.vrn,
  coalesce(vc.hmrc_name, vc.name)  as hmrc_name,
  o.description,
  o.kind,
  o.period_from,
  o.period_to,
  o.overdue,
  o.estimated,
  round(o.amount / 100.0, 2)       as amount
from hmrc.vat_owed o
join public.v_hmrc_vat_scope s on s.client_id = o.client_id and s.run_id = o.run_id
join hmrc.vat_client vc        on vc.id = o.client_id
where public.hmrc_can_read();

comment on view public.v_hmrc_vat_owed is
  'VAT owed, line by line, with the return period it belongs to. `estimated` means HMRC has raised an assessment rather than received a return — a different conversation from a late payment. Amounts in POUNDS.';

-- ── Self Assessment: the current position ───────────────────────────
create or replace view public.v_hmrc_sa_position as
select
  sc.entity_id,
  sc.utr,
  sc.name                            as hmrc_name,
  round(p.tax        / 100.0, 2)     as tax,
  round(p.surcharges / 100.0, 2)     as surcharges,
  round(p.interest   / 100.0, 2)     as interest,
  round(p.penalties  / 100.0, 2)     as penalties,
  round(p.total      / 100.0, 2)     as total,
  p.statement_available,
  p.summary_unavailable,
  p.scraped_at
from hmrc.sa_position p
join public.v_hmrc_sa_scope s on s.client_id = p.client_id and s.run_id = p.run_id
join hmrc.sa_client sc        on sc.id = p.client_id
where public.hmrc_can_read();

comment on view public.v_hmrc_sa_position is
  'Self Assessment position: tax, surcharges, interest and penalties. summary_unavailable means HMRC would not show us the summary, so a zero total is unknown rather than nil. Amounts in POUNDS.';

-- ── practice-wide roll-up, one row per client ────────────────────────
-- The front of the consolidated dashboard: who owes what, across everything.
create or replace view public.v_hmrc_client_totals as
with s as (
  select entity_id, entity_name, tax, balance, scraped_at
  from public.v_hmrc_client_tax_summary
),
piv as (
  select
    entity_id,
    max(entity_name) as entity_name,
    round(coalesce(sum(balance) filter (where tax = 'paye'), 0), 2)            as paye,
    round(coalesce(sum(balance) filter (where tax = 'corporation-tax'), 0), 2)  as corporation_tax,
    round(coalesce(sum(balance) filter (where tax = 'vat'), 0), 2)             as vat,
    round(coalesce(sum(balance) filter (where tax = 'self-assessment'), 0), 2)  as self_assessment,
    round(coalesce(sum(balance), 0), 2)                                        as total,
    count(distinct tax) filter (where balance <> 0)                            as taxes_owing,
    count(distinct tax)                                                        as taxes_known,
    max(scraped_at)                                                            as last_scraped
  from s
  group by entity_id
),
mv as (
  select
    entity_id,
    round(sum(amount) filter (where movement = 'cash_to_client'), 2)   as repaid_to_client,
    round(sum(amount) filter (where movement = 'from_another_tax'), 2)  as credit_in,
    round(sum(amount) filter (where movement = 'to_another_tax'), 2)    as credit_out
  from public.v_hmrc_money_movements
  where entity_id is not null
  group by entity_id
)
select
  p.entity_id,
  p.entity_name,
  p.paye,
  p.corporation_tax,
  p.vat,
  p.self_assessment,
  p.total,
  p.taxes_owing,
  p.taxes_known,
  p.last_scraped,
  coalesce(mv.repaid_to_client, 0) as repaid_to_client,
  coalesce(mv.credit_in, 0)        as credit_in,
  coalesce(mv.credit_out, 0)       as credit_out
from piv p
left join mv on mv.entity_id = p.entity_id;

comment on view public.v_hmrc_client_totals is
  'One row per active client: what they owe HMRC across PAYE, Corporation Tax, VAT and Self Assessment, plus what HMRC has repaid them and credit moved between tax heads. A negative figure is a credit in the client''s favour. Amounts in POUNDS.';

do $$
declare v text;
begin
  foreach v in array array[
    'v_hmrc_ct_periods', 'v_hmrc_vat_owed', 'v_hmrc_sa_position', 'v_hmrc_client_totals'
  ] loop
    execute format('revoke all on public.%I from public, anon', v);
    execute format('grant select on public.%I to authenticated, service_role', v);
  end loop;
end $$;
