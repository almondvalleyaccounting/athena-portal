-- ============================================================
-- Client Unresponsive: a chase that has stopped moving.
--
-- sql/268 gave the chase five steps; sql/269 gave it two ways to end without
-- filing. Between them sat the state the overdue rows are actually in. A
-- statement waiting on a client who has gone quiet is not "Awaiting Client
-- Approval" — that says the ball is in their court and the process is working.
-- It is not "Allow to Drift" either, which is a decision we have taken. It is
-- the thing that happens before that decision, and it is the reason a
-- statement goes 271 days past its date.
--
-- Naming it does two things a note in the thread cannot. It shows on the row
-- without opening anything, so a glance at the list says which overdue
-- statements are stalled on the client rather than on us. And it separates
-- "chased, no reply" from "nobody has looked at this", which is the whole
-- point of the column.
--
-- ── Its own group, not a sixth step ────────────────────────────────────────
--
-- The five working statuses are an ordered line. This is where a statement
-- falls OUT of that line, usually from awaiting_ch_code or
-- awaiting_client_approval, and it is what turns into allow_to_drift if it
-- lasts. So it sits between the two groups in the dropdown rather than at the
-- end of the run of five, where it would read as the step after filing.
--
-- Like both dispositions, it leaves the row on the list and leaves it overdue.
-- A client not replying does not reduce what Companies House is owed.
-- ============================================================

alter table public.confirmation_statement_progress
  drop constraint if exists confirmation_statement_progress_status_check;

alter table public.confirmation_statement_progress
  add constraint confirmation_statement_progress_status_check check (
    status is null or status in (
      -- Working on it, in order.
      'awaiting_ch_code',
      'awaiting_client_approval',
      'to_be_billed',
      'awaiting_payment',
      'to_be_filed',
      -- Stuck.
      'client_unresponsive',
      -- Not filing this one.
      'allow_to_drift',
      'apply_to_close'
    )
  );

comment on column public.confirmation_statement_progress.status is
  'Five steps of the filing chase (awaiting_ch_code -> to_be_filed), the chase '
  'stalled (client_unresponsive), or one of two decisions not to file '
  '(allow_to_drift, apply_to_close). null means nobody has picked it up. '
  'Nothing outside the five steps removes the row from '
  'v_confirmation_statements_due or clears its overdue flag - Companies House '
  'is still owed the statement either way.';
