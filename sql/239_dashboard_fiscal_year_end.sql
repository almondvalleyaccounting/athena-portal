-- 239 — a per-client fiscal year end the dashboard can actually trust
--
-- The Overview's Fiscal / Calendar toggle aligns quarters and years to the
-- client's own year end, read from QuickBooks' FiscalYearStartMonth setting.
--
-- That setting is frequently absent. Puddleduck Nursery — the first client this
-- was tested against — returns null for it, and fyStartMonthIndex() then falls
-- back to October, which is ALMOND VALLEY'S year end, not the client's. The
-- toggle would have drawn quarters ending Dec/Mar/Jun/Sep and labelled them the
-- client's fiscal quarters. Wrong, and wrong silently, which is worse: nothing
-- on screen would have looked odd.
--
-- So the year end becomes an explicit, overridable fact on the connection.
-- Resolution order everywhere (staff dashboard and client portal alike):
--   1. this column, if somebody has set it
--   2. QuickBooks' own FiscalYearStartMonth
--   3. September (October start) — and the UI says it is a fallback rather
--      than pretending it is the client's.
--
-- Stored as the month the year ENDS in (1-12), because that is how an
-- accountant says it: "a July year end". QBO stores the start month; the code
-- converts.

begin;

alter table qbo_report_connections
  add column if not exists fiscal_year_end_month smallint
    check (fiscal_year_end_month between 1 and 12);

comment on column qbo_report_connections.fiscal_year_end_month is
  'Month (1-12) the client''s financial year ends, set by staff. Overrides QuickBooks'' FiscalYearStartMonth, which is often unset — falling back to the practice''s own year end would mislabel the client''s quarters.';

commit;
