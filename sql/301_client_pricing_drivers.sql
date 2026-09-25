-- 301 — A client's pricing drivers, kept.
--
-- Standard pricing (src/modules/billing/standardPricing.js) depends on
-- facts about the client: turnover (the accounts band), accounts type,
-- number of properties and directors, and how many monthly- and weekly-paid
-- employees are on the payroll. The single-client fee review asked for them
-- but only ever prefilled from the last quote and Companies House, so
-- anything staff typed was lost on close. This keeps them, one row per
-- client, updated whenever the fee review is saved.
--
-- Not fee data, so any active staff member can read it. Writes go through
-- the fee-proposal edge function (action save_drivers) as the service role.

create table if not exists public.client_pricing_drivers (
  entity_id          uuid primary key references public.entities(id) on delete cascade,
  turnover           numeric check (turnover is null or turnover >= 0),
  accounts_type      text check (accounts_type is null or accounts_type in ('trading', 'dormant', 'property')),
  properties         integer check (properties is null or properties >= 0),
  directors          integer check (directors is null or directors >= 0),
  monthly_employees  integer check (monthly_employees is null or monthly_employees >= 0),
  weekly_employees   integer check (weekly_employees is null or weekly_employees >= 0),
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.staff_profiles(id)
);

alter table public.client_pricing_drivers enable row level security;

drop policy if exists client_pricing_drivers_read on public.client_pricing_drivers;
create policy client_pricing_drivers_read on public.client_pricing_drivers
  for select to authenticated using (public.is_active_staff());

revoke all on public.client_pricing_drivers from public, anon, authenticated;
grant select on public.client_pricing_drivers to authenticated;
grant all on public.client_pricing_drivers to service_role;

comment on table public.client_pricing_drivers is
  'Per-client drivers for standard pricing (turnover, accounts type, properties, directors, employees), saved from the fee review. See sql/301.';
