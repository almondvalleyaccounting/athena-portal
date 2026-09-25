-- 303 — Approving a go-live date before push; catch-up invoices; sent mail.
--
-- 1. A fee change reaches QuickBooks only after staff approve the date the
--    new fees start (decided 2026-09-25). Approve on Push uplifts is now that
--    step: it writes the date onto every staged line of the row and records
--    who approved it and when. qbo-push-recurring refuses a row whose staged
--    lines no longer carry the approved date — re-staging voids it.
--
-- 2. If the approved date is already past — invoices have gone out at the
--    old fee since then — staff can raise a one-off catch-up invoice for the
--    difference, and must say why: the client's approval came late, the
--    invoice template wasn't updated in time, or another reason. It is a
--    draft billing_items row, approved and pushed through the Billing module
--    like any other one-off bill; the row keeps a link to it.
--
-- 3. The fee review can send the email from Athena rather than leave a
--    Gmail draft; fee_proposals records when, by whom and from which inbox.

alter table public.live_billing
  add column if not exists uplift_go_live_date date,
  add column if not exists uplift_go_live_approved_at timestamptz,
  add column if not exists uplift_go_live_approved_by uuid references public.staff_profiles(id),
  add column if not exists uplift_catchup_billing_item_id uuid references public.billing_items(id) on delete set null;

alter table public.billing_items
  add column if not exists catchup_reason text
    check (catchup_reason is null or catchup_reason in ('approval_late', 'template_late', 'other')),
  add column if not exists catchup_note text,
  add column if not exists catchup_for_billing_id uuid references public.live_billing(id) on delete set null;

alter table public.billing_items drop constraint if exists billing_items_catchup_explained;
alter table public.billing_items add constraint billing_items_catchup_explained
  check (catchup_for_billing_id is null or (
    catchup_reason is not null
    and (catchup_reason <> 'other' or length(trim(coalesce(catchup_note, ''))) > 2)
  ));

alter table public.fee_proposals
  add column if not exists sent_at timestamptz,
  add column if not exists sent_by uuid references public.staff_profiles(id),
  add column if not exists sent_from text,
  add column if not exists reminder_notified_at timestamptz;
