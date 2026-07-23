-- 166: Client Forecast — seed funded_only_pct.{band} drivers.
--
-- New per-band services assumption: the share of funded take-up made up
-- of part-time, funded-only children (~2 per FTE place, so the place
-- bills wholly at the LA rate); the balance are full-timers who use
-- 1140 funded hours and top up at private rates. Engine treats a
-- missing/0 value as "all funded children top up" (previous behaviour),
-- so existing versions are unchanged. Seed explicit 0 values so the
-- Services panel shows the column filled in.

insert into fc_driver (scenario_id, entity_id, module_key, driver_key, label, unit, kind)
select s.id, e.id, 'services_childcare', k.driver_key, k.label, 'pct', 'scalar'
from fc_scenario s
join fc_version v on v.id = s.version_id
join fc_forecast f on f.id = v.forecast_id
join fc_entity e on e.forecast_id = f.id
cross join (values
  ('funded_only_pct.babies',        'Funded-only families % (0-2)'),
  ('funded_only_pct.twos',          'Funded-only families % (2-3)'),
  ('funded_only_pct.three_to_five', 'Funded-only families % (3-5)'),
  ('funded_only_pct.after_school',  'Funded-only families % (After-school)')
) as k(driver_key, label)
where not exists (
  select 1 from fc_driver d
  where d.scenario_id = s.id and d.entity_id = e.id
    and d.module_key = 'services_childcare' and d.driver_key = k.driver_key
);

insert into fc_driver_value (driver_id, period, value)
select d.id, -1, 0
from fc_driver d
where d.module_key = 'services_childcare' and d.driver_key like 'funded_only_pct.%'
  and not exists (select 1 from fc_driver_value v where v.driver_id = d.id and v.period = -1);
