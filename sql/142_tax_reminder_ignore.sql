-- 142: "Never remind" ignore-list for tax-payment reminders. Keyed by the
-- 10-digit UTR. Use for people whose Self Assessment return the practice
-- files on TaxCalc but who are NOT clients (never in Bright Manager) — so
-- their POA rows must never be matched or emailed. TaxCalc import
-- auto-excludes any row whose UTR is here; staff add to it from the
-- Client Reminders page ("never remind").

create table if not exists public.tax_reminder_ignore (
  utr        text primary key,
  reason     text,
  created_by uuid references public.staff_profiles(id),
  created_at timestamptz not null default now()
);

alter table public.tax_reminder_ignore enable row level security;

drop policy if exists tax_reminder_ignore_read on public.tax_reminder_ignore;
create policy tax_reminder_ignore_read on public.tax_reminder_ignore
  for select using (public.is_active_staff());

drop policy if exists tax_reminder_ignore_write on public.tax_reminder_ignore;
create policy tax_reminder_ignore_write on public.tax_reminder_ignore
  for all
  using (exists (select 1 from public.staff_profiles p where p.id = auth.uid() and (p.can_manage_portal or p.is_portal_admin)))
  with check (exists (select 1 from public.staff_profiles p where p.id = auth.uid() and (p.can_manage_portal or p.is_portal_admin)));
