-- 168: Client Forecast — relabel the two staffing drivers that caused a
-- double-count of holiday/sickness cover.
--
-- Driver labels are stored per row in fc_driver, so changing the module
-- spec only affects NEWLY seeded drivers; existing forecasts keep the old
-- wording. These are the two drivers that both looked like they funded
-- absence:
--   standard_hours_per_year — ACTUALLY funds absence (productive hours are
--     net of leave, so dividing by it buys the cover contracts)
--   overstaff_pct — must cover ON-FLOOR dilution only (paid breaks,
--     above-ratio quality). Using it for holiday cover charges twice.
--
-- Labels only. No values change, so no recompute is required.

update fc_driver
set label = 'Productive hours per employee / year (net of holiday & sickness)'
where driver_key = 'standard_hours_per_year';

update fc_driver
set label = 'Over-staffing % — on-floor only (breaks/quality, NOT holiday cover)'
where driver_key = 'overstaff_pct';
