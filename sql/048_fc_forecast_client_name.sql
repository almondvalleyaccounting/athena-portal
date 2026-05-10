-- ══════════════════════════════════════════════════════════════
-- 048_fc_forecast_client_name.sql
--
-- Adds client_name to fc_forecast.
--
-- Forecasts are organised by client. Future consolidation feature
-- will roll up multiple forecasts (e.g. nursery + accountancy +
-- property rental) for the same client into one summary deck.
-- Indexed because the forecast picker groups by client.
-- ══════════════════════════════════════════════════════════════

ALTER TABLE public.fc_forecast
  ADD COLUMN IF NOT EXISTS client_name text;

CREATE INDEX IF NOT EXISTS fc_forecast_client_name_idx
  ON public.fc_forecast (client_name);
