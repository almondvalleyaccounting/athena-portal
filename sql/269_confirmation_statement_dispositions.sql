-- ============================================================
-- Two answers that are not a step: Allow to Drift, Apply to Close.
--
-- sql/268 gave a confirmation statement five statuses, all of them points on
-- one line — get the code, get approval, bill, get paid, file. That shape
-- assumes every statement is on its way to being filed. Two of the eighteen
-- rows on the list are companies we are striking off right now, and a run of
-- the overdue ones are deliberate: chased, declined, parked.
--
-- Neither had anywhere to go. Left blank they read as "nobody has looked at
-- this", which is the one thing the status exists to tell apart, and it is the
-- reading that gets somebody chased about a company that is closing.
--
--   allow_to_drift — a decision to stop chasing this one.
--   apply_to_close — the company is on its way out.
--
-- They are dispositions, not steps six and seven. The dropdown puts them under
-- their own heading for that reason; listing them after "To be Filed" would
-- make them look like the end of the same sequence.
--
-- ── What they deliberately do NOT do ────────────────────────────────────────
--
-- Neither takes the row off the list, and neither stops it counting as
-- overdue. Both of those remain literally true — Companies House is still owed
-- the statement, and until the strike-off completes it is still enforceable.
-- The status says what we have decided; it does not get to edit the facts. A
-- statement quietly dropping off the overdue count because somebody picked
-- "Allow to Drift" is how fifteen overdue statements became invisible in the
-- first place.
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
      -- Not filing this one.
      'allow_to_drift',
      'apply_to_close'
    )
  );

comment on column public.confirmation_statement_progress.status is
  'Five steps of the filing chase (awaiting_ch_code → to_be_filed), or one of '
  'two decisions not to file (allow_to_drift, apply_to_close). null means '
  'nobody has picked it up. A decision not to file does not remove the row '
  'from v_confirmation_statements_due or clear its overdue flag — Companies '
  'House is still owed the statement either way.';
