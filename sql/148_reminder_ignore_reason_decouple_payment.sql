-- 148: decouple manual reminder-exclusion from payment status.
--
-- Two separate concepts were previously conflated on tax_payments_due.status
-- (unpaid → paid → excluded):
--   * "paid"     — they've paid, so no reminder is needed (payment fact).
--   * "excluded" — a human decision NOT to remind them (client relationship).
-- The second doesn't belong on the payment row: it isn't a payment state, it
-- must persist across TaxCalc re-imports (which rebuild tax_payments_due), and
-- we need to know WHY (not a client vs a client we've chosen not to remind).
--
-- So exclusion now lives entirely on tax_reminder_ignore (keyed by UTR, which
-- survives re-imports), gaining a reason + free-text note. Payment status is
-- reduced to paid/unpaid only. Applied to prod 2026-07-22.

-- 1. reason + note on the ignore list. reason is NOT NULL with a default so
--    existing rows (people we'd flagged as "not a client") get the right label.
alter table public.tax_reminder_ignore
  add column if not exists reason text not null default 'not_client',
  add column if not exists note text;

-- (defensive: if the column pre-existed nullable, backfill + enforce)
update public.tax_reminder_ignore set reason = 'not_client' where reason is null;
alter table public.tax_reminder_ignore alter column reason set default 'not_client';
alter table public.tax_reminder_ignore alter column reason set not null;

alter table public.tax_reminder_ignore drop constraint if exists tax_reminder_ignore_reason_check;
alter table public.tax_reminder_ignore
  add constraint tax_reminder_ignore_reason_check
  check (reason in ('not_client', 'client_excluded'));

-- 2. Migrate any rows previously excluded on the payment table into the ignore
--    list as client_excluded (they were clients we chose not to remind), then
--    convert those payment rows back to unpaid so payment status is binary.
insert into public.tax_reminder_ignore (utr, reason, note)
select distinct pd.reference_raw, 'client_excluded', 'migrated from payment status'
from public.tax_payments_due pd
where pd.status = 'excluded'
  and pd.reference_raw ~ '^[0-9]{10}$'
on conflict (utr) do nothing;

update public.tax_payments_due set status = 'unpaid' where status = 'excluded';
