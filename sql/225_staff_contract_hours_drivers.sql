-- Staffing: the employment contract becomes the input.
--
-- `standard_hours_per_year` (productive hours) was entered alongside the
-- salaries with nothing tying the two together, so the model could take the
-- generous reading of each: salary ÷ productive hours flattered every
-- hourly-rate test, while the establishment was sized as though nobody took
-- leave. Productive hours are now DERIVED from the contract.
--
-- Seeds the new group-scope drivers into every existing scenario and drops
-- the retired one. Idempotent.

begin;

-- ── New drivers ────────────────────────────────────────────────────
insert into fc_driver (scenario_id, entity_id, module_key, driver_key, label, unit, kind)
select s.id, null, 'staff', d.key, d.label, d.unit, 'scalar'
from fc_scenario s
cross join (values
  ('contracted_hours_per_week', 'Full-time contract (hours/week)',                      'hours'),
  ('holiday_weeks_per_year',    'Annual leave (weeks, incl. public holidays)',           'count'),
  ('absence_days_per_year',     'Sickness / absence (days per employee)',                'count'),
  ('training_days_per_year',    'Training & CPD off the floor (days per employee)',      'count'),
  ('enforce_real_living_wage',  'Enforce Real Living Wage floor (1 = yes)',              'count')
) as d(key, label, unit)
join fc_version v on v.id = s.version_id
join fc_forecast f on f.id = v.forecast_id
where f.vertical_pack = 'childcare_scotland'
on conflict (scenario_id, entity_id, module_key, driver_key) do nothing;

-- ── Default values (only where none exists) ────────────────────────
insert into fc_driver_value (driver_id, period, value)
select d.id, -1, v.val
from fc_driver d
join (values
  ('contracted_hours_per_week', 40),
  ('holiday_weeks_per_year',    5.6),
  ('absence_days_per_year',     9),
  ('training_days_per_year',    5),
  ('enforce_real_living_wage',  1)
) as v(key, val) on v.key = d.driver_key
where d.module_key = 'staff'
  and not exists (
    select 1 from fc_driver_value dv where dv.driver_id = d.id and dv.period = -1
  );

-- ── Retire the old input ───────────────────────────────────────────
delete from fc_driver_value
where driver_id in (select id from fc_driver where driver_key = 'standard_hours_per_year');
delete from fc_driver where driver_key = 'standard_hours_per_year';

commit;
