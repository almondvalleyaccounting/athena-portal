-- 162: Client Forecast — remove dead assumptions.
--
-- 1. cohort.moveup_babies_pct / cohort.moveup_twos_pct: continuous
--    age-ups are modelled inside the base ramp curve; the engine
--    resolved these but never used the values. Removed everywhere
--    (specs removed from locations.js too).
-- 2. Legacy flat staffing keys (base_salary_p.practitioner /
--    lead_practitioner / manager, manager_per_n_practitioners): pre-date
--    the role-mix staffing model; nothing computes from them.
-- 3. capacity.* band-curve rows (group AND per-location) for forecasts
--    with NO greenfield locations: acquired sites use their own
--    site-level curve, so these are dead inputs there. Kept for
--    forecasts that have greenfield sites; seedPackDefaults now skips
--    them when no greenfield location exists.
--
-- KEPT deliberately: nmw_*_hourly_p (Staff detail rate-analysis box
-- reads them) and employment_allowance_p (being wired into the NI
-- calculation by the hardening pass).

-- 1 + 2: dead everywhere
delete from fc_driver_value where driver_id in (
  select id from fc_driver where driver_key in (
    'cohort.moveup_babies_pct', 'cohort.moveup_twos_pct',
    'base_salary_p.practitioner', 'base_salary_p.lead_practitioner',
    'base_salary_p.manager', 'manager_per_n_practitioners'
  )
);
delete from fc_driver where driver_key in (
  'cohort.moveup_babies_pct', 'cohort.moveup_twos_pct',
  'base_salary_p.practitioner', 'base_salary_p.lead_practitioner',
  'base_salary_p.manager', 'manager_per_n_practitioners'
);

-- 3: capacity.* rows only where the forecast has no greenfield location
delete from fc_driver_value where driver_id in (
  select d.id from fc_driver d
  join fc_scenario s on s.id = d.scenario_id
  join fc_version v on v.id = s.version_id
  join fc_forecast f on f.id = v.forecast_id
  where d.module_key = 'locations' and d.driver_key like 'capacity.%'
    and not exists (
      select 1 from fc_entity e
      where e.forecast_id = f.id
        and coalesce(e.config->>'acquisition_type', 'greenfield') = 'greenfield'
    )
);
delete from fc_driver d
using fc_scenario s, fc_version v, fc_forecast f
where s.id = d.scenario_id and v.id = s.version_id and f.id = v.forecast_id
  and d.module_key = 'locations' and d.driver_key like 'capacity.%'
  and not exists (
    select 1 from fc_entity e
    where e.forecast_id = f.id
      and coalesce(e.config->>'acquisition_type', 'greenfield') = 'greenfield'
  );
