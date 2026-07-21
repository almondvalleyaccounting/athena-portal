-- 138: Admin tasks gain a Service (links to the fee-engine price book).
--
-- service_id references the same service vocabulary as the standard_fees
-- price book (task → service_id → standard_net → QBO product). Selecting a
-- service on a task lets "Add a bill" pull the standard net fee through to the
-- billing_items row, and stamps billing_items.service so it maps to the right
-- QBO product on the invoice.
alter table public.admin_tasks
  add column if not exists service_id text;

comment on column public.admin_tasks.service_id is
  'Fee-engine service (matches standard_fees.service_id) — drives the standard fee pulled into a bill.';
