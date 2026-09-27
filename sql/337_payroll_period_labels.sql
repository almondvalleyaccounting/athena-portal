-- ============================================================
-- 337 — Payroll periods: tax year label fix; imported ticks dated by period
--
-- sql/333 wrote the tax year as to_char(y + 1, 'FM00'), which overflows to
-- '##' (2026/##). It is the last two digits: 2026/27.
--
-- Imported ticks took the insert time as their "at", so the sheet read as
-- if Sophie had ticked two years of history at 18:20 today. An imported
-- tick is dated at the end of its period, and the UI says "from the
-- spreadsheet" instead of quoting a time.
-- ============================================================

update public.payroll_periods
   set tax_year = format('%s/%s', substring(tax_year from 1 for 4), to_char(mod(substring(tax_year from 1 for 4)::int + 1, 100), 'FM00'))
 where tax_year like '%/##';

update public.payroll_ticks t
   set at = (p.end_date::timestamp + interval '12 hours') at time zone 'Europe/London'
  from public.payroll_periods p
 where p.id = t.period_id and t.source = 'import';

update public.payroll_period_notes n
   set at = (p.end_date::timestamp + interval '12 hours') at time zone 'Europe/London'
  from public.payroll_periods p
 where p.id = n.period_id and n.source = 'import';
