-- 264 — the delivery gap list must not nag about clients who left
--
-- v_recurring_delivery_gaps (sql/263) joined entities without the read-time
-- former-client filter every other operational surface applies (sql/134). It
-- happens to be clean today — all 10 gaps are active clients — but an archived
-- client whose template was deactivated rather than deleted would sit in the
-- list permanently, and a banner that cries about a client who left is a banner
-- people learn to close.
--
-- Found while auditing the staged fee uplifts: Lochview Nursery and Road To Sea
-- are both `entity_status = 'archived'` (Road To Sea is in liquidation) and both
-- still carry status='active' live_billing rows. Their templates going quiet in
-- April and May is correct, not a gap.

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
  coalesce(e.billing_email, e.prospect_email) as athena_email,
  case
    when lb.qbo_bill_email is null and coalesce(lb.qbo_email_status, 'NotSet') <> 'NeedToSend'
      then 'no email address and auto-send off'
    when lb.qbo_bill_email is null
      then 'auto-send on but no email address'
    else 'email address set but auto-send off'
  end                       as problem,
  (lb.qbo_bill_email is not null
   or coalesce(e.billing_email, e.prospect_email) is not null) as repairable
from public.live_billing lb
join public.entities e on e.id = lb.entity_id
where lb.status = 'active'
  -- Former clients are excluded at read time, not by cascade — a BM re-import
  -- wipes anything written downstream (see sql/134).
  and coalesce(e.entity_status, 'active') = 'active'
  and lb.qbo_recurring_txn_id is not null
  -- Unchecked is not the same as broken. A row the delivery sweep has never
  -- read says nothing about QBO, so it does not belong in a gap list.
  and lb.qbo_email_checked_at is not null
  and (lb.qbo_bill_email is null or coalesce(lb.qbo_email_status, 'NotSet') <> 'NeedToSend');

comment on view public.v_recurring_delivery_gaps is
  'Active recurring templates for current clients that QBO will bill but not email. One row = one client accruing a balance with no invoice in their inbox.';

grant select on public.v_recurring_delivery_gaps to authenticated, service_role;
revoke all on public.v_recurring_delivery_gaps from public;
