-- ══════════════════════════════════════════════════════════════
-- 202_fc_pl_line_cash_timing.sql
--
-- Cash timing per line, beyond a single lag. Two real situations the lag
-- alone could not express:
--
--   CADENCE — a developer invoiced monthly but PAID quarterly. The cost is
--   incurred every month (P&L unchanged); the cash leaves every third month
--   and a creditor builds and clears in between.
--
--   ARREARS — invoices only part-paid for a while, with the balance settled
--   as a lump sum later. The customer pays up to a cap (or a percentage)
--   each month; the shortfall accumulates as a debtor and is received in the
--   settlement month.
--
-- Both matter because they change WHEN cash moves without changing what was
-- invoiced. Doing this with per-month overrides would corrupt the P&L —
-- an override changes the invoice, not the receipt.
--
-- All columns default to today's behaviour: monthly cadence, no cap, no
-- percentage, no settlement.
-- ══════════════════════════════════════════════════════════════

ALTER TABLE public.fc_pl_line
  ADD COLUMN IF NOT EXISTS pay_cadence text NOT NULL DEFAULT 'monthly',
  -- 0-based period of the first bunched payment; then every cycle thereafter.
  ADD COLUMN IF NOT EXISTS cadence_offset integer NOT NULL DEFAULT 0,
  -- Most cash this line moves in a month. NULL = settle in full.
  ADD COLUMN IF NOT EXISTS collect_cap_p numeric,
  -- Share settled on normal terms, 0-100. Used only when no cap is set.
  ADD COLUMN IF NOT EXISTS collect_pct numeric,
  -- Period in which accumulated arrears are settled. NULL = keep building.
  ADD COLUMN IF NOT EXISTS arrears_settle_month integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fc_pl_line_pay_cadence_check') THEN
    ALTER TABLE public.fc_pl_line
      ADD CONSTRAINT fc_pl_line_pay_cadence_check
      CHECK (pay_cadence IN ('monthly', 'quarterly', 'annual'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fc_pl_line_collect_pct_check') THEN
    ALTER TABLE public.fc_pl_line
      ADD CONSTRAINT fc_pl_line_collect_pct_check
      CHECK (collect_pct IS NULL OR (collect_pct >= 0 AND collect_pct <= 100));
  END IF;
END $$;
