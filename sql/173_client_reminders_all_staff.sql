-- 173: Client Tax Reminders becomes a normal Communications sub-module.
--
-- Access is decided ONCE, at the parent module (Communications). Anyone who
-- can open Communications can open Client Tax Reminders and do everything in
-- it: match clients, set preferences, exclude, queue, drop, release, edit the
-- templates, toggle auto-queue. No view-only tier inside the module.
--
-- Previously the tab needed can_manage_portal, and a second can_manage_portal
-- check gated each control. That flag also carries CPD-tracker manager views,
-- portal client access, connections and admin settings — so "let Stephanie
-- send a reminder" could not be granted without handing over all of that.
--
-- Email stays per-account: personal mailboxes are only visible to their owner
-- (comms-gmail owner-gates reads, listMailboxes hides them from the switcher).
-- This migration does not touch that.
--
-- Also fixes a live bug: reminder_emails had RLS on with a SELECT policy and
-- nothing else, so the queue's "Drop selected" updated 0 rows and reported
-- success. Verified before the change — as portal admin, SELECT saw 188 rows
-- and UPDATE touched 0.

-- ── Queue: staff can drop (and re-status) queued emails ────────────────────
-- Sending still goes only through reminders-send under the service role; this
-- is what makes the reviewer's "Drop" button actually drop.
drop policy if exists reminder_emails_staff_update on public.reminder_emails;
create policy reminder_emails_staff_update on public.reminder_emails
  for update to authenticated
  using (is_active_staff())
  with check (is_active_staff());

-- ── Email copy: any staff member in the module may edit the templates ─────
drop policy if exists comm_templates_write on public.comm_templates;
create policy comm_templates_write on public.comm_templates
  for all to authenticated
  using (is_active_staff())
  with check (is_active_staff());

-- ── Reminder exclusions (not-a-client / client-excluded) ──────────────────
drop policy if exists tax_reminder_ignore_write on public.tax_reminder_ignore;
create policy tax_reminder_ignore_write on public.tax_reminder_ignore
  for all to authenticated
  using (is_active_staff())
  with check (is_active_staff());

-- ── Auto-queue on/off ─────────────────────────────────────────────────────
drop policy if exists raqc_write on public.reminder_autoqueue_config;
create policy raqc_write on public.reminder_autoqueue_config
  for update to authenticated
  using (is_active_staff())
  with check (is_active_staff());

-- The toggle goes through this SECURITY DEFINER RPC (a direct table update is
-- blocked and silently no-ops), so its own gate has to widen too.
create or replace function public.set_reminder_autoqueue_enabled(p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_active_staff() then
    raise exception 'not authorised';
  end if;
  update public.reminder_autoqueue_config set enabled = coalesce(p_enabled, false) where id = true;
  return coalesce(p_enabled, false);
end;
$$;

-- NOT widened, deliberately: gmail_connections stays is_portal_admin() only.
-- Connecting and disconnecting mailboxes is account administration, not
-- reminder work, and the tokens live on that table.
