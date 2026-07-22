-- 150: an offer (opt-in invite / promo) is ONE PER BATCH for a client with
-- no decision recorded — not one-ever. A client still undecided at the next
-- run gets another offer; as soon as they opt in or out they never receive
-- an offer again (the auto-queue only ever offers to the undecided, so a
-- decided client no longer reaches the offer branch at all).
--
-- Corrects sql/149, which made the offer once-ever. Applied to prod
-- 2026-07-22.

-- Attribute the existing (manually-sent) July opt-in campaign to the July
-- batch so it is batch-scoped like auto-queued offers. (Prod had 127 promos
-- with a null batch_id; a fresh DB has none, so this is a no-op there.)
update public.reminder_emails
  set batch_id = (select id from public.tax_payment_batches order by created_at desc limit 1)
  where kind = 'promo' and batch_id is null;

-- Swap the once-ever offer index for a once-per-batch one.
drop index if exists public.reminder_emails_one_promo_ever;
create unique index if not exists reminder_emails_one_promo_per_batch
  on public.reminder_emails (entity_id, batch_id)
  where kind = 'promo' and status in ('queued', 'sent');
