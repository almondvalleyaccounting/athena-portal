-- 135: Client Dashboard fixes.
--   (a) Practice-financials access (AVA's own books) extended from Bobby-only
--       to Bobby + Tracy + Yvonne. Managed thereafter from the Staff &
--       Permissions grid (can_view_practice_financials, sql/113).
--   (b) Favourites (the ⭐ on the Client Dashboard) keyed on realm_id, not
--       entity_id. Every qbo_report_connections row currently has a NULL
--       entity_id, so the entity_id-only favourites table made the star
--       permanently disabled (incl. for AVA). realm_id is the connection's
--       natural key and is always present.

-- ── (a) Practice financials → Bobby, Tracy, Yvonne ──────────────────
update public.staff_profiles set can_view_practice_financials = true
 where email in (
   'bobby@almondvalleyaccounting.co.uk',
   'tracy@almondvalleyaccounting.co.uk',
   'yvonne@almondvalleyaccounting.co.uk'
 );

-- ── (b) Favourites by realm_id ──────────────────────────────────────
alter table public.staff_client_favourites
  add column if not exists realm_id text;

-- entity_id was NOT NULL + part of the PK; drop the PK first, then relax the
-- column so realm-only stars work.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'staff_client_favourites_pkey'
      and conrelid = 'public.staff_client_favourites'::regclass
  ) then
    alter table public.staff_client_favourites drop constraint staff_client_favourites_pkey;
  end if;
end $$;

alter table public.staff_client_favourites
  alter column entity_id drop not null;

-- Backfill realm_id for any existing rows (none expected — the star never
-- worked — but safe).
update public.staff_client_favourites f
   set realm_id = c.realm_id
  from public.qbo_report_connections c
 where c.entity_id = f.entity_id and f.realm_id is null;

-- One star per (staff, realm). entity_id is kept (nullable) so the Portfolio
-- can still show Companies House status when a realm is later linked to an
-- entity.
create unique index if not exists staff_client_fav_staff_realm_idx
  on public.staff_client_favourites (staff_id, realm_id)
  where realm_id is not null;

-- RLS unchanged (own rows only); re-assert in case the table is fresh.
alter table public.staff_client_favourites enable row level security;
drop policy if exists "Own favourites" on public.staff_client_favourites;
create policy "Own favourites" on public.staff_client_favourites
  for all using (staff_id = auth.uid()) with check (staff_id = auth.uid());
