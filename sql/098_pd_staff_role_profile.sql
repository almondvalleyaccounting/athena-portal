-- Per-staff personalisation of their assigned role profile's narrative.
-- The base text (pd_role_profiles.profile_text) stays central; each person can
-- remove base items (moved to the bottom, marked) and add their own items to
-- any section (marked as additions). Stored as an overlay, not a copy.
create table if not exists pd_staff_role_profile (
  id              uuid primary key default gen_random_uuid(),
  staff_id        uuid not null references staff_profiles(id) on delete cascade,
  role_profile_id uuid not null references pd_role_profiles(id) on delete cascade,
  removed         jsonb not null default '[]'::jsonb,   -- array of removed base item strings
  additions       jsonb not null default '{}'::jsonb,   -- { "Section heading": ["added item", ...] }
  updated_at      timestamptz not null default now(),
  unique (staff_id, role_profile_id)
);

alter table pd_staff_role_profile enable row level security;
drop policy if exists pd_staff_role_profile_all on pd_staff_role_profile;
create policy pd_staff_role_profile_all on pd_staff_role_profile
  for all to authenticated using (is_active_staff()) with check (is_active_staff());

comment on table pd_staff_role_profile is 'Per-staff overlay on their role profile text: removed base items + per-section additions.';
