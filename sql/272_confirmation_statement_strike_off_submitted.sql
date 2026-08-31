-- ============================================================
-- Strike Off Submitted: the close path, one stage on.
--
-- sql/269 gave "Apply to Close" for a company on its way out. That covers the
-- intention and the paperwork being prepared, and it stops covering things the
-- moment the DS01 goes in. The difference matters on a list of overdue
-- statements: Apply to Close still has a job attached to it, Strike Off
-- Submitted does not. Left as one status, a company waiting on Companies House
-- looks identical to one waiting on us.
--
-- So they are one path in two stages, and the pill colours say so — Strike Off
-- Submitted is a deeper shade of the same rose.
--
-- ── The one status that clears itself ──────────────────────────────────────
--
-- Every other status ends when the statement is filed and the nightly refresh
-- moves the due date on a year. This one ends the other way. When Companies
-- House processes the strike-off, `entities.company_status` becomes
-- 'dissolved', and sql/267's filter already excludes dissolved and in-liquidation
-- companies — so the row leaves the list on its own, with nothing filed and
-- nobody ticking anything.
--
-- That is worth knowing before somebody wonders where the row went, and it is
-- the reason this does not need a "Closed" status after it. There is nothing
-- left to record once the company is gone.
--
-- ── What it still does not do ──────────────────────────────────────────────
--
-- Until Companies House actually dissolves the company, the row stays and
-- stays overdue. A submitted DS01 can be rejected or objected to, and the
-- statement is legally owed the whole time it is pending. Two of the companies
-- on this list are mid-strike-off right now and the view keeps them for
-- exactly that reason (sql/266). The status records what we submitted; it does
-- not get to assume the outcome.
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
      -- Not filing this one. apply_to_close -> strike_off_submitted is one
      -- path in two stages.
      'allow_to_drift',
      'apply_to_close',
      'strike_off_submitted'
    )
  );

comment on column public.confirmation_statement_progress.status is
  'Five steps of the filing chase (awaiting_ch_code -> to_be_filed), the chase '
  'stalled on us (call_needed) or on the client (client_unresponsive), or a '
  'decision not to file (allow_to_drift, or apply_to_close -> '
  'strike_off_submitted). null means nobody has picked it up. Nothing outside '
  'the five steps removes the row from v_confirmation_statements_due or clears '
  'its overdue flag - Companies House is owed the statement until it is filed, '
  'or until the company is dissolved and the view stops selecting it.';
