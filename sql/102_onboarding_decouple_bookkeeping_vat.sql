-- 102: Decouple bookkeeping from VAT as independent services.
--
-- Previously one 'vat' condition + a "Bookkeeping & VAT" service option and a
-- single "Bookkeeping" handover area (conditioned on vat). Now Bookkeeping and
-- VAT are separate services (SERVICE_OPTIONS keys 'bookkeeping' + 'vat'). VAT
-- template steps stay on 'vat'; bookkeeping has no onboarding steps of its own.

-- Bookkeeping handover default now keys off the new 'bookkeeping' condition,
-- and a separate "VAT" area (same default owner) is added so VAT-only clients
-- still get a task owner + 3-month check-in tile.
update onboarding_handover_defaults set service_condition = 'bookkeeping' where area = 'Bookkeeping';
update onboarding_handover_defaults set sort = 4 where area = 'Accounts';
update onboarding_handover_defaults set sort = 5 where area = 'Payroll';
insert into onboarding_handover_defaults (area, service_condition, default_owner_id, active, sort)
select 'VAT', 'vat', default_owner_id, true, 3
  from onboarding_handover_defaults where area = 'Bookkeeping'
on conflict (area) do nothing;

-- Existing per-onboarding "Bookkeeping" handover rows were vat-conditioned.
update onboarding_handovers set service_condition = 'bookkeeping' where area = 'Bookkeeping';

-- The old combined 'vat' selection meant "Bookkeeping & VAT"; preserve that by
-- adding 'bookkeeping' alongside it. Untick per client where only one applies.
update onboardings
   set service_conditions = array_append(service_conditions, 'bookkeeping')
 where 'vat' = any(service_conditions)
   and not ('bookkeeping' = any(service_conditions));
