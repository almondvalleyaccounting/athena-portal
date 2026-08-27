-- 263 — a recurring bill nobody emails is a bill the client never sees
--
-- A QBO recurring template needs TWO things to actually reach the client:
--   * BillEmail.Address  — somewhere to send it
--   * EmailStatus = 'NeedToSend' — what the QBO UI calls
--     "Automatically send emails"
--
-- Neither was recorded anywhere in Athena. live_billing carried the amounts,
-- the schedule and the next run date, so a template that billed the client
-- every month and never told them looked identical on every Athena surface to
-- one that emailed perfectly. Bonny Braes ran that way from its 2026-05-27
-- commit; the client accumulated a balance and never received an invoice.
--
-- qbo-push has required a client email since v24 and sets EmailStatus on
-- everything it writes, so new commits are safe. That fixes the door, not the
-- 156 templates already through it — of the 143 that will run, 12 will not
-- email: 3 have no address at all, 9 carry an address QBO was never told to
-- send to. This migration is the part that makes that state legible, so the
-- nightly pull surfaces it instead of a client noticing months later.

alter table public.live_billing
  add column if not exists qbo_bill_email      text,
  add column if not exists qbo_email_status    text,
  add column if not exists qbo_email_checked_at timestamptz;

comment on column public.live_billing.qbo_bill_email is
  'BillEmail.Address on the linked QBO recurring template, as of qbo_email_checked_at. Null = QBO has nowhere to send this client''s invoices.';
comment on column public.live_billing.qbo_email_status is
  'EmailStatus on the linked QBO recurring template. ''NeedToSend'' = QBO auto-emails each generated invoice; ''NotSet'' (or null) = it does not.';
comment on column public.live_billing.qbo_email_checked_at is
  'When qbo_bill_email / qbo_email_status were last read from QBO. Stale means unverified, not fine.';

-- The one question worth asking of the estate: which running templates bill a
-- client who will never hear about it? Invoker view — live_billing''s own
-- policies decide who sees it (fees are confidential, see sql/134 lineage).
create or replace view public.v_recurring_delivery_gaps
with (security_invoker = true) as
select
  lb.id                     as billing_id,
  lb.entity_id,
  e.name                    as entity_name,
  lb.qbo_recurring_txn_id,
  lb.qbo_customer_id,
  lb.monthly_net,
  lb.qbo_next_run_date,
  lb.qbo_bill_email,
  lb.qbo_email_status,
  lb.qbo_email_checked_at,
  -- Athena's own best-known address, for the repair to fall back on.
  coalesce(e.billing_email, e.prospect_email) as athena_email,
  case
    when lb.qbo_bill_email is null and coalesce(lb.qbo_email_status, 'NotSet') <> 'NeedToSend'
      then 'no email address and auto-send off'
    when lb.qbo_bill_email is null
      then 'auto-send on but no email address'
    else 'email address set but auto-send off'
  end                       as problem,
  -- Can the repair fix this unattended, or does someone have to find an
  -- address first? A gap we cannot close is worth showing differently from
  -- one that is a button press away.
  (lb.qbo_bill_email is not null
   or coalesce(e.billing_email, e.prospect_email) is not null) as repairable
from public.live_billing lb
join public.entities e on e.id = lb.entity_id
where lb.status = 'active'
  and lb.qbo_recurring_txn_id is not null
  -- Unchecked is not the same as broken. A row the delivery sweep has never
  -- read says nothing about QBO, so it does not belong in a gap list.
  and lb.qbo_email_checked_at is not null
  and (lb.qbo_bill_email is null or coalesce(lb.qbo_email_status, 'NotSet') <> 'NeedToSend');

comment on view public.v_recurring_delivery_gaps is
  'Active recurring templates that QBO will bill but not email. One row = one client accruing a balance with no invoice in their inbox.';

grant select on public.v_recurring_delivery_gaps to authenticated, service_role;
revoke all on public.v_recurring_delivery_gaps from public;
