-- 182: Let live_billing.billing_type hold the values the app actually uses.
--
-- The check constraint allowed only ('recurring', 'one-off') — note the
-- HYPHEN. Everything else in the system speaks 'recurring' | 'annual' |
-- 'one_off' (underscore): qbo-pull writes 'annual' for an all-annual customer,
-- BillingAddNewPage writes 'annual' and 'one_off', and BillingPage filters on
-- both. So those writes were being rejected.
--
-- The damage was invisible because qbo-pull never checked the result of its
-- update and incremented stats.updated regardless. Consequences:
--   * 65 invoice-inferred live_billing rows frozen since 2026-04-19, holding
--     £244,282 of stated annual value — every all-annual-cadence client.
--   * Those frozen rows still carry pre-rebuild product names and the 12x
--     annual overstatement (annual_amount = monthly_amount * 12) that the
--     current pull code would have corrected.
--   * Every row in the table reads 'recurring' because nothing else could
--     ever be written.
--
-- Widening the vocabulary is the right fix rather than mapping 'annual' onto
-- 'recurring': the frontend already distinguishes the three, and the row-level
-- value is meant to carry the dominant cadence while services jsonb carries
-- the true per-service cadence.
--
-- Note for consumers: once the pull succeeds, ~65 rows will change from
-- 'recurring' to 'annual'. Anything filtering billing_type = 'recurring' will
-- stop counting them. BillingPage already handles 'annual'; check any other
-- dashboard that filters on this column.
--
-- 'one-off' is retained so no historic value becomes invalid, even though no
-- row currently uses it.

alter table public.live_billing drop constraint if exists live_billing_billing_type_check;

alter table public.live_billing add constraint live_billing_billing_type_check
  check (billing_type = any (array['recurring'::text, 'annual'::text, 'one_off'::text, 'one-off'::text]));
