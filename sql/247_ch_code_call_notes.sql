-- ============================================================
-- CH personal code — call notes, and escalation as a permanent state.
--
-- Two things were wrong with the comms ladder:
--
-- 1. A logged call recorded only a timestamp. Sophie needs to record what
--    actually happened — no answer, client working on it, client sending ID —
--    so whoever picks the chase up next knows where it stands without
--    reading the whole activity log.
--
-- 2. `escalation_status` carried BOTH the call flag ('call_needed') and the
--    escalation ('escalated_tracy') in one column, so logging a call on an
--    escalated request overwrote the escalation and it silently vanished.
--    Escalation is a permanent state once applied: it survives a call, a
--    cleared call flag and a stage advance, and only comes off deliberately.
--
-- The column keeps its three values, because every edge-function guard reads
-- them (ch-code-queue-fill's `!== 'none'` skip, ch-code-chase's ladder,
-- ch-code-calls' Wednesday list). What changes is that 'escalated_tracy' is
-- now ABSORBING — nothing but an explicit un-escalate writes over it.
-- ============================================================

-- ── 1. Call history ──────────────────────────────────────────
create table if not exists ch_code_calls (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references ch_code_requests(id) on delete cascade,
  called_at   timestamptz not null,
  outcome     text not null default 'other' check (outcome in (
                'no_answer','client_working_on_it','client_sending_id','other')),
  note        text,
  created_by  uuid references staff_profiles(id),
  created_at  timestamptz not null default now()
);
comment on table ch_code_calls is 'One row per phone call logged against a CH personal-code chase. ch_code_requests.called_at / last_call_outcome / last_call_note mirror the most recent row here so the pipeline board can show it without a per-tile join.';
create index if not exists idx_ch_code_calls_request on ch_code_calls(request_id, called_at desc);

alter table ch_code_calls enable row level security;
drop policy if exists ch_code_calls_staff on ch_code_calls;
create policy ch_code_calls_staff on ch_code_calls for all using (is_active_staff()) with check (is_active_staff());

-- Backfill the calls we already have: one row per request that carries a
-- called_at, outcome unknown, so the history doesn't start empty.
insert into ch_code_calls (request_id, called_at, outcome, note)
select r.id, r.called_at, 'other', 'Logged before call outcomes existed.'
  from ch_code_requests r
 where r.called_at is not null
   and not exists (select 1 from ch_code_calls c where c.request_id = r.id);

-- ── 2. Denormalised "last call" on the request, for the tiles ─
alter table ch_code_requests add column if not exists last_call_outcome text;
alter table ch_code_requests add column if not exists last_call_note text;
comment on column ch_code_requests.last_call_outcome is 'Outcome of the most recent ch_code_calls row. Denormalised for the pipeline board. Cleared alongside called_at when the stage advances.';

-- ── 3. Escalation is permanent ───────────────────────────────
-- Repair the rows the old setComms damaged: an escalation followed by a call
-- left escalation_status at 'call_needed' with the escalation lost. The
-- activity log still holds it, so re-flag any still-chasing request whose
-- most recent escalation-axis event was an escalation rather than a
-- deliberate clear or a stage move.
with axis as (
  select a.request_id,
         max(a.created_at) filter (where a.body = 'Escalated.')                    as escalated_at,
         max(a.created_at) filter (where a.body = 'Call / escalation cleared.')    as cleared_at,
         max(a.created_at) filter (where a.kind = 'status_change'
                                     and a.body not like 'Call logged%')           as staged_at
    from ch_code_activity a
   group by a.request_id
)
update ch_code_requests r
   set escalation_status = 'escalated_tracy',
       escalated_at      = coalesce(r.escalated_at, axis.escalated_at::date)
  from axis
 where axis.request_id = r.id
   and axis.escalated_at is not null
   and r.escalation_status <> 'escalated_tracy'
   and r.stage not in ('s6_submitted','s7_rejected')
   and axis.escalated_at > coalesce(axis.cleared_at, '-infinity'::timestamptz)
   and axis.escalated_at > coalesce(axis.staged_at,  '-infinity'::timestamptz);

comment on column ch_code_requests.escalation_status is 'none | call_needed | escalated_tracy. ''escalated_tracy'' is ABSORBING — logging a call, clearing the call flag and advancing a stage all leave it in place; only an explicit un-escalate removes it. ''call_needed'' is the call flag, written only when the request is not already escalated.';
