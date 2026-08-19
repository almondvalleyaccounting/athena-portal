-- 236: single-use nonce store for OAuth state
--
-- The three OAuth flows (QBO, Gmail, Drive) put a base64 blob in the `state`
-- parameter and, on the way back, decoded it "best-effort" and trusted whatever was
-- inside — including the staff id that gets stamped on the connection row. Nothing
-- was signed and nothing was checked, so:
--
--   * anyone could mint a state for any staff id at the unauthenticated
--     ?action=authorize / auth-init endpoints, consent with their OWN Google or
--     Intuit account, and have the callback install their tokens as ours. For Gmail
--     that meant the practice-default mailbox — every client reminder and chaser
--     would then route through the attacker's mailbox.
--   * a captured state could be replayed.
--
-- Signing the state (supabase/functions/_shared/oauth-state.ts) fixes forgery. This
-- table fixes replay: the nonce is recorded when the flow starts and consumed when
-- the callback lands, so a state works exactly once. Signature alone would not do
-- it — a valid state is valid forever until it expires.
--
-- Service-role only. RLS on with no policies, so the API roles get nothing even
-- though the table sits in `public`.

create table if not exists public.oauth_state_nonces (
  nonce       text primary key,
  purpose     text not null,
  user_id     uuid not null,
  created_at  timestamptz not null default now(),
  consumed_at timestamptz
);

comment on table public.oauth_state_nonces is
  'Single-use nonces for signed OAuth state. Issued by *-auth-init, consumed by *-auth-callback. See sql/236.';

create index if not exists oauth_state_nonces_created_idx
  on public.oauth_state_nonces (created_at);

alter table public.oauth_state_nonces enable row level security;
revoke all on public.oauth_state_nonces from anon, authenticated;
grant select, insert, update, delete on public.oauth_state_nonces to service_role;
