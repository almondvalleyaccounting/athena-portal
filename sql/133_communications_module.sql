-- 133: Communications module — multi-mailbox Gmail + SMS/WhatsApp channels.
--
-- Implements COMMS_INTEGRATIONS.md Option A: gmail_connections stops being a
-- single-row table and becomes one row per mailbox, keyed by address.
--   kind: 'personal' (a team member's own inbox, visible to them alone in the
--         Communications module) or 'shared' (info@, payroll@ — visible to all
--         staff).
--   is_practice_default: the row the existing automation senders
--         (reminders-send, chase-reply-scan, gmail-create-draft) use when no
--         mailbox is specified. Exactly one active default at a time.
--
-- Deploy order matters: the old _shared/gmail-client.ts does
-- .eq(status,'active').maybeSingle(), which errors as soon as a second active
-- row exists. The consumers must be redeployed with the mailbox-aware helper
-- before anyone connects a second mailbox. This migration alone is safe — it
-- doesn't create extra rows.

-- 1) Multi-mailbox columns
alter table public.gmail_connections
  add column if not exists kind text not null default 'shared',
  add column if not exists owner_staff_id uuid references public.staff_profiles(id),
  add column if not exists display_name text,
  add column if not exists is_practice_default boolean not null default false;

alter table public.gmail_connections drop constraint if exists gmail_connections_kind_check;
alter table public.gmail_connections
  add constraint gmail_connections_kind_check check (kind in ('personal', 'shared'));

-- One active row per mailbox address — replaces the single-active-row rule.
drop index if exists gmail_connections_one_active_idx;
create unique index if not exists gmail_connections_active_email_idx
  on public.gmail_connections (lower(account_email)) where status = 'active';

-- Exactly one practice default among active rows.
create unique index if not exists gmail_connections_one_default_idx
  on public.gmail_connections (is_practice_default)
  where is_practice_default and status = 'active';

-- The existing active connection (info@) becomes the shared practice default.
update public.gmail_connections
   set is_practice_default = true,
       kind = 'shared',
       display_name = coalesce(display_name, initcap(split_part(account_email, '@', 1)))
 where status = 'active';

-- 2) OAuth tokens stop being staff-readable. Staff UI reads this view instead;
-- it runs as owner (bypasses RLS) and gates inside its own where-clause.
drop policy if exists gmail_connections_staff_read on public.gmail_connections;

create or replace view public.v_gmail_connections as
select id, account_email, display_name, kind, owner_staff_id, is_practice_default,
       status, error_message, scope, connected_by, connected_at, last_refreshed_at
  from public.gmail_connections
 where is_active_staff();

revoke all on public.v_gmail_connections from anon, public;
grant select on public.v_gmail_connections to authenticated;

-- 3) sms_messages learns which channel a message travelled on. The WhatsApp
-- number already lives at Telnyx; inbound events arrive on the same webhook.
alter table public.sms_messages
  add column if not exists channel text not null default 'sms';
alter table public.sms_messages drop constraint if exists sms_messages_channel_check;
alter table public.sms_messages
  add constraint sms_messages_channel_check check (channel in ('sms', 'whatsapp'));
create index if not exists sms_messages_channel_created_idx
  on public.sms_messages (channel, created_at desc);
