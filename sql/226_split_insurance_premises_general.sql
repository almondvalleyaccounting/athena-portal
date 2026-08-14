-- Split `overhead.insurance_p` into premises and general insurance.
--
-- Premises insurance attaches when you take the building, so it starts at
-- the location's occupancy month and lands in the premises cost bucket.
-- General insurance (liability, business interruption) is a cost of trading
-- and starts at opening, as the single combined line always did.
--
-- The whole of the existing value moves to GENERAL, so no forecast changes
-- cost on this migration. Splitting it is a judgement about the policy, not
-- something to guess here — on a lease the landlord often insures the
-- building and recharges it through the service charge, in which case the
-- premises share is genuinely nil.
--
-- Idempotent.

begin;

-- ── New drivers, mirroring the entity scope of the line they replace ──
insert into fc_driver (scenario_id, entity_id, module_key, driver_key, label, unit, kind)
select old.scenario_id, old.entity_id, 'overheads', n.key, n.label, 'gbp_p', 'scalar'
from fc_driver old
cross join (values
  ('overhead.premises_insurance_p', 'Premises insurance'),
  ('overhead.general_insurance_p',  'General insurance')
) as n(key, label)
where old.module_key = 'overheads' and old.driver_key = 'overhead.insurance_p'
on conflict (scenario_id, entity_id, module_key, driver_key) do nothing;

-- ── Carry the old value across to GENERAL; premises starts at nil ─────
insert into fc_driver_value (driver_id, period, value)
select nd.id, -1,
       case when nd.driver_key = 'overhead.general_insurance_p'
            then coalesce(ov.value, 0) else 0 end
from fc_driver nd
join fc_driver od
  on od.scenario_id = nd.scenario_id
 and od.entity_id is not distinct from nd.entity_id
 and od.module_key = 'overheads'
 and od.driver_key = 'overhead.insurance_p'
left join fc_driver_value ov on ov.driver_id = od.id and ov.period = -1
where nd.driver_key in ('overhead.premises_insurance_p', 'overhead.general_insurance_p')
  and not exists (
    select 1 from fc_driver_value dv where dv.driver_id = nd.id and dv.period = -1
  );

-- ── Retire the combined line ─────────────────────────────────────────
delete from fc_driver_value
where driver_id in (select id from fc_driver where driver_key = 'overhead.insurance_p');
delete from fc_driver where driver_key = 'overhead.insurance_p';

commit;
