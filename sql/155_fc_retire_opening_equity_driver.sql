-- 155: Client Forecast — retire the bs.opening_equity_p driver.
--
-- Opening equity is now DERIVED from opening cash in financial_core
-- (cash is the only opening balance-sheet position, so equity must equal
-- it for the BS to start balanced). Editing the two drivers apart was the
-- easiest way to throw every period of the balance sheet out of balance.
--
-- The driver spec is removed from financial_core.drivers and the key is
-- listed in InputsView RETIRED_KEYS; this migration clears the leftover
-- per-scenario rows so they stop appearing anywhere.

delete from fc_driver_value
where driver_id in (select id from fc_driver where driver_key = 'bs.opening_equity_p');

delete from fc_driver
where driver_key = 'bs.opening_equity_p';
