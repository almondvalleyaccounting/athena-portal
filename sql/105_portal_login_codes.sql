-- ============================================================
-- Client portal sign-in — throttle table for the custom code login.
--
-- The portal-send-code edge function emails a 6-digit Supabase OTP (minted via
-- the admin API, delivered through Resend for inbox deliverability) to invited
-- clients. This table rate-limits repeat requests so the endpoint can't be used
-- to email-bomb an invited address. The OTP itself is NOT stored here — Supabase
-- Auth owns the code; verifyOtp on the portal establishes the session.
--
-- Written/read only by the edge function (service role, bypasses RLS). RLS is
-- enabled with no policies = deny to anon/authenticated.
-- ============================================================

create table if not exists portal_login_attempts (
  email        text primary key,
  last_sent_at timestamptz,
  send_count   int not null default 0,
  updated_at   timestamptz not null default now()
);
comment on table portal_login_attempts is 'Rate-limit state for client portal sign-in code requests (portal-send-code edge function). Not a store of codes — Supabase Auth owns the OTP.';

alter table portal_login_attempts enable row level security;
-- No policies: only the service role (edge function) touches this table.
