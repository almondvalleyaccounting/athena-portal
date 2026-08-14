-- Utilities and premises insurance move from the overheads module into
-- premises.
--
-- The module boundary is the trigger: premises costs start at OCCUPANCY,
-- overheads start at OPENING, and pre-opening is the window between the two.
-- Utilities and buildings cover attach when you take the building, so they
-- belong with rent, service charge, rates and maintenance — not sitting in
-- overheads being special-cased on their label.
--
-- Values carry across unchanged. General insurance stays in overheads: it is
-- a cost of trading and still waits for opening.
--
-- Idempotent.

begin;

-- ── Create the premises-side drivers, mirroring the entity scope ─────
insert into fc_driver (scenario_id, entity_id, module_key, driver_key, label, unit, kind)
select old.scenario_id, old.entity_id, 'premises', m.new_key, m.new_label, 'gbp_p', 'scalar'
from fc_driver old
join (values
  ('overhead.utilities_p',          'premises.utilities_p', 'Utilities (monthly)'),
  ('overhead.premises_insurance_p', 'premises.insurance_p', 'Premises insurance (monthly)')
) as m(old_key, new_key, new_label) on m.old_key = old.driver_key
where old.module_key = 'overheads'
on conflict (scenario_id, entity_id, module_key, driver_key) do nothing;

-- ── Carry the values over ────────────────────────────────────────────
insert into fc_driver_value (driver_id, period, value)
select nd.id, ov.period, ov.value
from fc_driver nd
join (values
  ('premises.utilities_p', 'overhead.utilities_p'),
  ('premises.insurance_p', 'overhead.premises_insurance_p')
) as m(new_key, old_key) on m.new_key = nd.driver_key
join fc_driver od
  on od.scenario_id = nd.scenario_id
 and od.entity_id is not distinct from nd.entity_id
 and od.module_key = 'overheads'
 and od.driver_key = m.old_key
join fc_driver_value ov on ov.driver_id = od.id
where nd.module_key = 'premises'
  and not exists (
    select 1 from fc_driver_value dv
    where dv.driver_id = nd.id and dv.period = ov.period
  );

-- ── Drop the overheads-side originals ────────────────────────────────
delete from fc_driver_value
where driver_id in (
  select id from fc_driver
  where module_key = 'overheads'
    and driver_key in ('overhead.utilities_p', 'overhead.premises_insurance_p')
);
delete from fc_driver
where module_key = 'overheads'
  and driver_key in ('overhead.utilities_p', 'overhead.premises_insurance_p');

commit;
