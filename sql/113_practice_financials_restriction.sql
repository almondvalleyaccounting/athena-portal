-- 113: Practice-financials security layer.
--
-- AVA's own QuickBooks (realm 123145912118784, "Almond Valley Accounting")
-- sits in qbo_report_connections next to the client companies, and both the
-- connection row and its qbo_dashboard_cache figures were readable by ALL
-- active staff (is_active_staff() policies). Staff should see clients' books,
-- never the practice's own.
--
-- Mechanism: a staff flag (can_view_practice_financials) + a connection flag
-- (is_practice), enforced by RESTRICTIVE policies that AND with the existing
-- permissive staff policies. Edge functions (dashboard-qbo-pull,
-- trigger-report) enforce the same flag imperatively since they run service
-- role.

-- 1. Who may see practice financials (Bobby; toggleable from Admin > Staff).
alter table staff_profiles
  add column if not exists can_view_practice_financials boolean not null default false;

update staff_profiles
  set can_view_practice_financials = true
  where lower(email) = 'bobby@almondvalleyaccounting.co.uk';

-- 2. Which connection is the practice's own books.
alter table qbo_report_connections
  add column if not exists is_practice boolean not null default false;

update qbo_report_connections
  set is_practice = true
  where realm_id = '123145912118784'
     or company_name ilike 'almond valley%';

-- 3. Helpers (SECURITY DEFINER so policies don't recurse through RLS).
create or replace function can_view_practice_financials()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select can_view_practice_financials from staff_profiles where id = auth.uid()),
    false
  );
$$;

create or replace function is_practice_realm(p_realm text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from qbo_report_connections
    where realm_id = p_realm and is_practice
  );
$$;

-- 4. Restrictive policies: AND-ed with the existing is_active_staff() reads.
drop policy if exists "practice books hidden from general staff" on qbo_report_connections;
create policy "practice books hidden from general staff" on qbo_report_connections
  as restrictive for select to authenticated
  using (not is_practice or can_view_practice_financials());

drop policy if exists "practice books not editable by general staff" on qbo_report_connections;
create policy "practice books not editable by general staff" on qbo_report_connections
  as restrictive for update to authenticated
  using (not is_practice or can_view_practice_financials());

drop policy if exists "practice cache hidden from general staff" on qbo_dashboard_cache;
create policy "practice cache hidden from general staff" on qbo_dashboard_cache
  as restrictive for select to authenticated
  using (not is_practice_realm(realm_id) or can_view_practice_financials());
