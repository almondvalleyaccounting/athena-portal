-- 151: click-tracking for payment-reminder links. We deliberately do NOT
-- use open-tracking pixels (unreliable + privacy/deliverability cost); a
-- link click is the honest "engaged" signal. clicked_at already exists (set
-- by comm-optin for offer emails); this adds which link was clicked on a
-- reminder ('pay' = how-to-pay, 'pta' = view-balance), stamped by the new
-- comm-click redirect edge function. Applied to prod 2026-07-22.
alter table public.reminder_emails
  add column if not exists clicked_link text;
