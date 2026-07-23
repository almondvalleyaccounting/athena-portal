-- 163: Client Forecast — Cook staff role, seeded into existing scenarios.
--
-- New role in staff.js: salary (group driver, default £22,000) + cooks
-- per site (entity driver, spec default 1 for NEW forecasts). Existing
-- scenarios seed headcount at 0 so their numbers don't change until a
-- headcount is typed (driver edits auto-recompute). Cook is direct site
-- staff in the P&L split but never counts toward the statutory ratio.

insert into fc_driver (scenario_id, entity_id, module_key, driver_key, label, unit, kind)
select s.id, null, 'staff', 'base_salary_p.cook', 'Cook — salary', 'gbp_p', 'scalar'
from fc_scenario s
where not exists (
  select 1 from fc_driver d
  where d.scenario_id = s.id and d.entity_id is null
    and d.module_key = 'staff' and d.driver_key = 'base_salary_p.cook'
);

insert into fc_driver_value (driver_id, period, value)
select d.id, -1, 2200000
from fc_driver d
where d.module_key = 'staff' and d.driver_key = 'base_salary_p.cook'
  and not exists (select 1 from fc_driver_value v where v.driver_id = d.id);

insert into fc_driver (scenario_id, entity_id, module_key, driver_key, label, unit, kind)
select s.id, e.id, 'staff', 'headcount.cooks_per_site', 'Cooks — per site', 'count', 'scalar'
from fc_scenario s
join fc_version v on v.id = s.version_id
join fc_forecast f on f.id = v.forecast_id
join fc_entity e on e.forecast_id = f.id
where not exists (
  select 1 from fc_driver d
  where d.scenario_id = s.id and d.entity_id = e.id
    and d.module_key = 'staff' and d.driver_key = 'headcount.cooks_per_site'
);

insert into fc_driver_value (driver_id, period, value)
select d.id, -1, 0
from fc_driver d
where d.module_key = 'staff' and d.driver_key = 'headcount.cooks_per_site'
  and not exists (select 1 from fc_driver_value v where v.driver_id = d.id);
