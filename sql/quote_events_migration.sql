-- quote_events — client-facing telemetry for quote lifecycle events.
--
-- Separate from audit_log because:
--   - audit_log is staff-driven and FK'd to staff_profiles (auth.users).
--     Client events have no staff actor.
--   - quote_events is append-only by design — one row per event, no updates.
--
-- Writes are service-role only (edge functions). No insert/update/delete
-- policy is created for authenticated users, so RLS blocks those by default.

create table if not exists quote_events (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references quotes(id) on delete cascade,
  event_type text not null check (event_type in (
    'delivered',
    'opened',
    'clicked_review',
    'accepted',
    'bounced',
    'complained'
  )),
  client_email text,
  client_ip text,
  user_agent text,
  resend_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_quote_events_quote_created
  on quote_events (quote_id, created_at desc);

create index if not exists idx_quote_events_resend
  on quote_events (resend_id)
  where resend_id is not null;

alter table quote_events enable row level security;

-- Staff with can_view_quotes can read. Intentionally no insert/update/delete
-- policies: those go via the service role from edge functions only.
drop policy if exists "Staff can read quote events" on quote_events;
create policy "Staff can read quote events"
  on quote_events for select
  using (
    exists (
      select 1 from staff_profiles
      where staff_profiles.id = auth.uid()
        and staff_profiles.can_view_quotes = true
    )
  );
