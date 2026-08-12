-- ══════════════════════════════════════════════════════════════
-- 201_fc_forecast_currency.sql
--
-- A forecast is denominated in one currency. Amounts stay in integer minor
-- units everywhere (the `_p` suffix) — only presentation changes.
--
-- Prompted by Foursite: the group has a UK Ltd (GBP) and a Florida C-Corp
-- (USD), and rendering a dollar business with "£" would be quietly wrong on
-- every screen and every export.
-- ══════════════════════════════════════════════════════════════

ALTER TABLE public.fc_forecast
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'GBP';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fc_forecast_currency_check'
  ) THEN
    ALTER TABLE public.fc_forecast
      ADD CONSTRAINT fc_forecast_currency_check CHECK (currency IN ('GBP', 'USD', 'EUR'));
  END IF;
END $$;
