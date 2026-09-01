-- ============================================================
-- A status says where it is. It does not say what to do.
--
-- sql/268 through sql/272 built one dropdown and kept widening it: five steps
-- of the chase, then two ways of being stuck, then three ways of not filing.
-- Ten values in one control, and by the end the control was answering two
-- different questions at once.
--
--   "Awaiting Client Approval" is a STATE. Nothing in it says whether the next
--   move is to email them again, ring them, or wait.
--
--   "Call Needed" is an ACTION. It is not a state at all — it is what to do
--   about a state it never records, so a row reading Call Needed cannot tell
--   you what it was doing before somebody decided a call was needed.
--
-- One field cannot hold both without losing one of them, and the one it was
-- losing was the action — which is the half you can actually do something with
-- on a Monday morning. So this splits them.
--
--   status       — where the statement is. Unchanged for nine of the ten.
--   next_action  — what we do next, and when.
--
-- ── Nothing is dropped; every current option lands somewhere ────────────────
--
--   awaiting_ch_code        -> status, relabelled "CH Code(s) Needed"
--   awaiting_client_approval-> status, relabelled "Awaiting Approval"
--   to_be_billed            -> status, unchanged
--   awaiting_payment        -> status, unchanged
--   to_be_filed             -> status, unchanged
--   client_unresponsive     -> status, unchanged (now under "On hold")
--   allow_to_drift          -> status, unchanged (now under "On hold")
--   apply_to_close          -> status, unchanged
--   strike_off_submitted    -> status, unchanged
--   call_needed             -> next_action = 'phone_client', status = 'on_hold'
--
-- The two relabels are labels only. The keys do not move, so no row is
-- rewritten and no history is reinterpreted.
--
-- ── Why call_needed becomes on_hold and not something more specific ─────────
--
-- sql/271 defined Call Needed as the chase stalled on us: nothing moves until
-- somebody rings. That is on hold, and the call is the action. But the status
-- it fell out of — Awaiting CH Code, Awaiting Client Approval, something else
-- — was never recorded, and this migration cannot invent it. So each migrated
-- row also gets a note saying exactly what it used to be, in its own thread,
-- where whoever picks it up can read it and set the real status. Guessing the
-- status would be the one failure mode this whole area exists to avoid: a
-- value that reads as knowledge nobody has.
--
-- ── What a next action still does not do ────────────────────────────────────
--
-- Same as every status before it: it does not take the row off the list and it
-- does not clear the overdue flag. A next action dated next Tuesday on a
-- statement 271 days late is a plan, not an excuse, and the day count keeps
-- saying so. next_action_due is when WE said we would do the thing; due_date
-- is when Companies House needed it. They are not the same date and the row
-- shows both.
-- ============================================================

-- ── 1. What we do next, and when ────────────────────────────────────────────
alter table public.confirmation_statement_progress
  add column if not exists next_action        text,
  add column if not exists next_action_due    date,
  add column if not exists next_action_set_by uuid references public.staff_profiles(id) on delete set null,
  add column if not exists next_action_set_at timestamptz;

alter table public.confirmation_statement_progress
  drop constraint if exists confirmation_statement_progress_next_action_check;

alter table public.confirmation_statement_progress
  add constraint confirmation_statement_progress_next_action_check check (
    next_action is null or next_action in (
      'send_statement',
      'send_email',
      'process_amendments',
      'phone_client'
    )
  );

comment on column public.confirmation_statement_progress.next_action is
  'What we do next on this statement: send_statement, send_email, '
  'process_amendments or phone_client. null means no action is planned, which '
  'is a real answer and the default. Distinct from status, which says where '
  'the statement has got to rather than what to do about it.';

comment on column public.confirmation_statement_progress.next_action_due is
  'When we said we would do next_action. NOT the filing deadline — that is '
  'deadlines.due_date, and a next action dated after it does not make the '
  'statement any less overdue.';

-- ── 2. Move the three Call Needed rows ──────────────────────────────────────
-- The old constraint comes off first, and the new one goes on after the rows
-- have moved. Both values are illegal under exactly one of the two — on_hold
-- under the old, call_needed under the new — so there is no window in which
-- the constraint permits the row being written. Adding the new constraint
-- first would reject the very update meant to satisfy it.
alter table public.confirmation_statement_progress
  drop constraint if exists confirmation_statement_progress_status_check;

-- The note goes in before the update: if the update were to fail, a note
-- saying what a row used to be is harmless, whereas a rewritten row with no
-- record of what it was is the thing this is trying to prevent. author_id is
-- null — nobody typed it, and attributing a migration to a member of staff
-- would be a lie in the one place people go to find out what happened.
insert into public.confirmation_statement_notes (progress_id, author_id, body)
select
  p.id,
  null,
  'Status split into status + next action (sql/273). This row was "Call Needed", '
  'which is an action rather than a state, so it is now: next action = Phone Client, '
  'status = On Hold. The status it was in before somebody decided a call was needed '
  'was never recorded — please set the real status when you pick this up.'
from public.confirmation_statement_progress p
where p.status = 'call_needed';

update public.confirmation_statement_progress
   set status             = 'on_hold',
       next_action        = 'phone_client',
       next_action_set_by = status_set_by,
       next_action_set_at = coalesce(status_set_at, now()),
       updated_at         = now()
 where status = 'call_needed';

-- ── 3. The status list, with call_needed gone and on_hold in ────────────────
alter table public.confirmation_statement_progress
  add constraint confirmation_statement_progress_status_check check (
    status is null or status in (
      -- Working on it, in order.
      'awaiting_ch_code',
      'awaiting_client_approval',
      'to_be_billed',
      'awaiting_payment',
      'to_be_filed',
      -- Parked. on_hold is the general case; the other two say why, and are
      -- kept because "the client will not reply" and "we have decided to stop
      -- chasing" are different facts about different people.
      'on_hold',
      'client_unresponsive',
      'allow_to_drift',
      -- Not filing this one. apply_to_close -> strike_off_submitted is one
      -- path in two stages.
      'apply_to_close',
      'strike_off_submitted'
    )
  );

comment on column public.confirmation_statement_progress.status is
  'Where the statement has got to: the five steps of the chase '
  '(awaiting_ch_code -> to_be_filed), parked (on_hold, client_unresponsive, '
  'allow_to_drift), or a decision not to file (apply_to_close -> '
  'strike_off_submitted). null means nobody has picked it up. What to DO about '
  'it lives in next_action, which is why call_needed is no longer a status. '
  'Nothing here removes the row from v_confirmation_statements_due or clears '
  'its overdue flag - Companies House is owed the statement until it is filed, '
  'or until the company is dissolved and the view stops selecting it.';

-- ── 4. The list carries both halves ─────────────────────────────────────────
-- Same definition as sql/268 (itself sql/267's filter) with the next-action
-- columns added. security_invoker stays true, so both base tables are read
-- under the caller's own policies and this view cannot become a way round
-- either of them.
drop view if exists public.v_confirmation_statements_due;
create view public.v_confirmation_statements_due
with (security_invoker = true) as
select
  d.id                                   as deadline_id,
  e.id                                   as entity_id,
  e.name                                 as entity_name,
  e.company_number,
  e.company_status,
  e.company_status_detail,
  d.due_date,
  (current_date - d.due_date)            as days_late,   -- negative = days to go
  (d.due_date < current_date)            as overdue,
  e.ch_last_refreshed_at,
  p.id                                   as progress_id,
  p.status                               as work_status,
  p.status_set_at                        as work_status_set_at,
  p.status_set_by                        as work_status_set_by,
  p.next_action,
  p.next_action_due,
  p.next_action_set_at,
  p.next_action_set_by,
  -- Whether WE are late on our own plan, which is a different question from
  -- whether the statement is late. Both are on the row for that reason.
  (p.next_action is not null and p.next_action_due is not null
     and p.next_action_due < current_date) as next_action_overdue,
  coalesce(n.note_count, 0)              as note_count,
  n.last_note_at
from public.deadlines d
join public.entities e on e.id = d.entity_id
-- Joined on the period, not on the deadline row: see sql/268.
left join public.confirmation_statement_progress p
  on p.entity_id = e.id and p.due_date = d.due_date
left join lateral (
  select count(*) as note_count, max(created_at) as last_note_at
  from public.confirmation_statement_notes cn
  where cn.progress_id = p.id
) n on true
where d.tag = 'Confirmation Statement'
  and d.status <> 'complete'
  and d.due_date <= current_date + 14
  and coalesce(e.entity_status::text, 'active') = 'active'
  and coalesce(e.company_status, 'active') not in ('dissolved', 'liquidation');

comment on view public.v_confirmation_statements_due is
  'Confirmation statements overdue or due within 14 days, for CURRENT clients '
  '(entity_status = active) whose company is not dissolved or in liquidation. '
  'Allow-list, not deny-list: a new entity_status is excluded until someone '
  'decides it belongs. Due date is from the nightly Companies House refresh, so '
  'a filed statement drops off on the next run. work_status, next_action and '
  'note_count come from confirmation_statement_progress, keyed on (entity, due '
  'date) so they belong to this period only. work_status says where the '
  'statement is; next_action says what to do next and by when, and '
  'next_action_overdue is about OUR plan, not the filing deadline.';

grant select on public.v_confirmation_statements_due to authenticated, service_role;
