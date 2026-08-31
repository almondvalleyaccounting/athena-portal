-- ============================================================
-- Call Needed: stuck on us, not on them.
--
-- sql/270 added Client Unresponsive and gave it a group of its own, "Stuck",
-- for the chase not moving. That group had one member and one reason: the
-- client has gone quiet. There is a second reason, and it is the more useful
-- one, because somebody can act on it today — the next thing this statement
-- needs is a phone call, and nobody has made it.
--
-- The two belong together. Both mean the statement has fallen out of the
-- five-step line; they differ in who it is waiting on. Call Needed is stalled
-- on us, Client Unresponsive is stalled on them. Kept apart they would read as
-- unrelated; kept together the group answers one question — why has this
-- stopped — with the only two answers there are.
--
-- Call Needed is listed FIRST. Sophie scans this list for work she can do, and
-- the actionable state should be the one her eye lands on. The progression
-- also runs that way: call needed, then client unresponsive when the call does
-- not land, then Allow to Drift if that lasts.
--
-- Teal, because the palette's alarm colours are spoken for and this is not an
-- alarm — it is a task. Like everything outside the five steps it leaves the
-- row on the list and leaves it overdue. Owing somebody a phone call does not
-- reduce what Companies House is owed.
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
      -- Stuck: on us, then on them.
      'call_needed',
      'client_unresponsive',
      -- Not filing this one.
      'allow_to_drift',
      'apply_to_close'
    )
  );

comment on column public.confirmation_statement_progress.status is
  'Five steps of the filing chase (awaiting_ch_code -> to_be_filed), the chase '
  'stalled on us (call_needed) or on the client (client_unresponsive), or one '
  'of two decisions not to file (allow_to_drift, apply_to_close). null means '
  'nobody has picked it up. Nothing outside the five steps removes the row '
  'from v_confirmation_statements_due or clears its overdue flag - Companies '
  'House is still owed the statement either way.';
