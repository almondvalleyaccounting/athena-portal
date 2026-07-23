-- 165: Client Forecast — fc_output.amount_p bigint → numeric.
--
-- Fractional driver values (e.g. 0.2 FTE senior manager) are legitimate
-- and fc_driver_value.value is already numeric, but the recompute then
-- emits fractional metric rows (metric.headcount_total 4.2, occupancy
-- pct×100) which the bigint amount_p column rejected with
-- "invalid input syntax for type bigint: \"4.2\"". Money rows are
-- Math.round()ed at emit and unaffected.

alter table fc_output alter column amount_p type numeric using amount_p::numeric;
