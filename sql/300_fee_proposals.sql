-- 300 — Fee proposals: a fee change issued to a client, and its sign-off.
--
-- The single-client fee review (RepriceClientModal) stages new fees on
-- live_billing and writes to the client. It issues one of two things:
--
--   notice    — we are telling the client their fees change. No sign-off:
--               the change is pushable once its timing is right.
--   proposal  — a change in services the client must agree to. The staged
--               lines carry pending_proposal_id and qbo-push-recurring will
--               not push them until the proposal is accepted.
--
-- Acceptance is recorded by staff, never by the client and never verbally
-- (decided 2026-09-25): the recorder confirms written acceptance arrived by
-- email, the date it arrived and the inbox it arrived in. The CHECK below
-- makes an "accepted" row without those three facts impossible, whichever
-- path writes it.
--
-- lifecycle   issued → accepted → pushed
--                    ↘ declined | withdrawn      (proposal)
--             issued → pushed                    (notice)
--
-- Writes go through the fee-proposal edge function (service role); the
-- browser only reads, and only staff who can see client fees — the same
-- gate as live_billing.

create table if not exists public.fee_proposals (
  id                       uuid primary key default gen_random_uuid(),
  entity_id                uuid not null references public.entities(id) on delete cascade,
  kind                     text not null check (kind in ('notice', 'proposal')),
  status                   text not null default 'issued'
                             check (status in ('issued', 'accepted', 'declined', 'withdrawn', 'pushed')),
  effective_at             date not null,
  billing_ids              uuid[] not null default '{}',
  -- What the client was told: the lines and summary as issued, so the
  -- record survives later edits to live_billing.
  lines                    jsonb not null default '[]'::jsonb,
  summary                  jsonb not null default '{}'::jsonb,
  subject                  text,
  recipient_email          text,
  gmail_draft_id           text,
  issued_at                timestamptz not null default now(),
  issued_by                uuid references public.staff_profiles(id),
  -- Sign-off (proposal only)
  acceptance_email_confirmed boolean not null default false,
  acceptance_received_on   date,
  acceptance_inbox         text,
  acceptance_note          text,
  accepted_at              timestamptz,
  accepted_recorded_by     uuid references public.staff_profiles(id),
  -- Closing
  closed_at                timestamptz,
  closed_by                uuid references public.staff_profiles(id),
  close_note               text,
  pushed_at                timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint fee_proposals_acceptance_is_written
    check (status <> 'accepted' or (
      kind = 'proposal'
      and acceptance_email_confirmed
      and acceptance_received_on is not null
      and acceptance_inbox is not null and length(trim(acceptance_inbox)) > 0
      and accepted_at is not null
    )),
  constraint fee_proposals_received_not_future
    check (acceptance_received_on is null or acceptance_received_on <= (accepted_at at time zone 'Europe/London')::date)
);

create index if not exists fee_proposals_entity_idx on public.fee_proposals (entity_id, issued_at desc);
create index if not exists fee_proposals_open_idx on public.fee_proposals (status) where status in ('issued', 'accepted');

alter table public.fee_proposals enable row level security;

drop policy if exists fee_proposals_read on public.fee_proposals;
create policy fee_proposals_read on public.fee_proposals
  for select to authenticated using (public.can_view_client_fees());

-- Read-only for the browser; the edge function writes as service_role.
revoke all on public.fee_proposals from public, anon, authenticated;
grant select on public.fee_proposals to authenticated;
grant all on public.fee_proposals to service_role;

comment on table public.fee_proposals is
  'A fee change issued to a client from the single-client fee review: a notice (no sign-off) or a proposal (staff-recorded written acceptance required before push). See sql/300.';
