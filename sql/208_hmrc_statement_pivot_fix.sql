-- 208 — The statement pivot, corrected. Supersedes the view in sql/207.
--
-- sql/207's first cut of v_hmrc_paye_client_statement had two faults, both
-- found while wiring it up. This is the version actually running; 207 is left
-- as-is so the sequence still reads as what happened.
--
-- 1. PERFORMANCE. It called hmrc.line_category(kind, line_type) once per output
--    column. That function is IMMUTABLE but runs up to fifteen ILIKE tests, so
--    eight columns over 18,730 charge_line rows meant ~2.2M pattern matches and
--    the query hit the statement timeout. Categorise once in a CTE, then pivot.
--
-- 2. COMPLETENESS. It pivoted five of line_category()'s values and dropped
--    Apprenticeship levy, CIS withheld, Penalties and Other. The breakdown
--    would have quietly summed to less than HMRC's charge total — the worst kind
--    of wrong, because each column looked right. Every category now lands in a
--    column, with a catch-all per side, so detail reconciles to the total by
--    construction rather than by luck.
--
-- Verified after the change: Puddleduck's charge detail sums exactly to the
-- charge total on all four months of 2026-27, and the balance chains across the
-- 2025-26 boundary (£243.98 closing becomes April's opening).

create or replace view public.v_hmrc_paye_client_statement as
with scoped as (
  select ch.*
  from hmrc.charge ch
  join public.v_hmrc_charge_scope s
    on s.client_id = ch.client_id and s.tax_year = ch.tax_year and s.run_id = ch.run_id
),
line_scope as (
  select client_id, tax_year, tax_month, max(run_id) as run_id
  from hmrc.charge_line group by client_id, tax_year, tax_month
),
categorised as (
  select
    cl.client_id, cl.tax_year, cl.tax_month, cl.kind, cl.amount,
    hmrc.line_category(cl.kind, cl.line_type) as category
  from hmrc.charge_line cl
  join line_scope ls
    on ls.client_id = cl.client_id and ls.tax_year = cl.tax_year
   and ls.tax_month = cl.tax_month and ls.run_id = cl.run_id
),
lines as (
  select
    client_id, tax_year, tax_month,
    sum(amount) filter (where kind = 'charge' and category = 'Income tax')            as l_income_tax,
    sum(amount) filter (where kind = 'charge' and category = 'Employer''s NI')         as l_employer_ni,
    sum(amount) filter (where kind = 'charge' and category = 'Employees'' NI')         as l_employees_ni,
    sum(amount) filter (where kind = 'charge' and category = 'Student loan')           as l_student_loan,
    sum(amount) filter (where kind = 'charge' and category = 'Apprenticeship levy')    as l_levy,
    sum(amount) filter (where kind = 'charge' and category = 'CIS withheld')           as l_cis_withheld,
    sum(amount) filter (where kind = 'charge' and category = 'Interest')               as l_interest,
    sum(amount) filter (where kind = 'charge' and category = 'Penalties')              as l_penalties,
    sum(amount) filter (where kind = 'charge' and category not in (
      'Income tax', 'Employer''s NI', 'Employees'' NI', 'Student loan',
      'Apprenticeship levy', 'CIS withheld', 'Interest', 'Penalties'))                 as l_charge_other,
    sum(amount) filter (where kind = 'credit' and category = 'Employment Allowance')   as l_ea,
    sum(amount) filter (where kind = 'credit' and category = 'CIS suffered')           as l_cis,
    sum(amount) filter (where kind = 'credit' and category = 'Statutory payments')     as l_statutory,
    sum(amount) filter (where kind = 'credit' and category not in (
      'Employment Allowance', 'CIS suffered', 'Statutory payments'))                   as l_credit_other,
    count(*)                                                                           as line_count
  from categorised
  group by client_id, tax_year, tax_month
)
select
  c.paye_ref,
  c.entity_id,
  coalesce(c.entity_name, e.name)                       as entity_name,
  c.name                                                as hmrc_name,
  s.tax_year,
  s.tax_month,
  public.hmrc_tax_period_start(s.tax_year, s.tax_month) as period_start,
  (public.hmrc_tax_period_start(s.tax_year, s.tax_month) + interval '1 month - 1 day')::date
                                                        as period_end,
  (public.hmrc_tax_period_start(s.tax_year, s.tax_month) + interval '1 month 16 days')::date
                                                        as due_date,
  round((sum(s.amount_due) over w - s.amount_due) / 100.0, 2) as opening,
  round(s.charges    / 100.0, 2)                        as charges,
  round(s.credits    / 100.0, 2)                        as credits,
  round(s.payments   / 100.0, 2)                        as payments,
  round(s.amount_due / 100.0, 2)                        as movement,
  round(sum(s.amount_due) over w / 100.0, 2)            as closing,
  round(coalesce(l.l_income_tax, 0)   / 100.0, 2)       as charge_income_tax,
  round(coalesce(l.l_employer_ni, 0)  / 100.0, 2)       as charge_employer_ni,
  round(coalesce(l.l_employees_ni, 0) / 100.0, 2)       as charge_employees_ni,
  round(coalesce(l.l_student_loan, 0) / 100.0, 2)       as charge_student_loan,
  round(coalesce(l.l_levy, 0)         / 100.0, 2)       as charge_apprenticeship_levy,
  round(coalesce(l.l_cis_withheld, 0) / 100.0, 2)       as charge_cis_withheld,
  round(coalesce(l.l_interest, 0)     / 100.0, 2)       as charge_interest,
  round(coalesce(l.l_penalties, 0)    / 100.0, 2)       as charge_penalties,
  round(coalesce(l.l_charge_other, 0) / 100.0, 2)       as charge_other,
  round(coalesce(l.l_ea, 0)           / 100.0, 2)       as credit_employment_allowance,
  round(coalesce(l.l_cis, 0)          / 100.0, 2)       as credit_cis_suffered,
  round(coalesce(l.l_statutory, 0)    / 100.0, 2)       as credit_statutory_payments,
  round(coalesce(l.l_credit_other, 0) / 100.0, 2)       as credit_other,
  coalesce(l.line_count, 0)                             as detail_lines,
  s.detail_reconciles,
  s.overdue,
  s.label
from scoped s
join hmrc.client c        on c.id = s.client_id
join public.entities e    on e.id = c.entity_id
left join lines l         on l.client_id = s.client_id
                         and l.tax_year  = s.tax_year
                         and l.tax_month = s.tax_month
where public.hmrc_can_read()
  and e.entity_status::text = 'active'
window w as (
  partition by c.paye_ref order by s.tax_year, s.tax_month
  rows between unbounded preceding and current row
);

comment on view public.v_hmrc_paye_client_statement is
  'Per client per tax MONTH: opening + charges - credits - payments = closing, with charges and credits '
  'broken to their HMRC categories (every category lands in a column, so detail sums to the total). Real '
  'period_start / period_end / due_date so a filter can cross tax years. Totals come from hmrc.charge; '
  'detail_reconciles says whether the line detail ties. Active clients only. Amounts in POUNDS.';

revoke all on public.v_hmrc_paye_client_statement from public, anon;
grant select on public.v_hmrc_paye_client_statement to authenticated, service_role;
