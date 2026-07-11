-- Role profiles for the CPD Tracker skills graph.
-- A central template groups skill CATEGORIES (the radar axes) with a target
-- level per category. Each staff member is assigned one role profile as their
-- baseline and can augment it individually (add categories / override targets).
-- Also: auto-log a CPD achievement whenever a skill's current level increases.

create table if not exists pd_role_profiles (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  description   text,
  active        boolean not null default true,
  display_order int not null default 0,
  created_at    timestamptz not null default now()
);

-- The categories (axes) + target for a role. category matches pd_skills.category.
create table if not exists pd_role_profile_categories (
  id              uuid primary key default gen_random_uuid(),
  role_profile_id uuid not null references pd_role_profiles(id) on delete cascade,
  category        text not null,
  target_level    smallint not null default 3,
  display_order   int not null default 0,
  unique (role_profile_id, category)
);

-- A staff member's assigned baseline role.
alter table staff_profiles
  add column if not exists pd_role_profile_id uuid references pd_role_profiles(id) on delete set null;

-- Individual augmentation on top of the assigned role:
--   included = false  → hide a category the role includes
--   included = true + category not in role → add an extra axis
--   target_level not null → override the role's target for that category
create table if not exists pd_staff_category_overrides (
  id           uuid primary key default gen_random_uuid(),
  staff_id     uuid not null references staff_profiles(id) on delete cascade,
  category     text not null,
  target_level smallint,
  included     boolean not null default true,
  updated_at   timestamptz not null default now(),
  unique (staff_id, category)
);

-- ── Seed one example role (existing categories) — editable/deletable in-app ──
do $$
declare v_role uuid;
begin
  if not exists (select 1 from pd_role_profiles) then
    insert into pd_role_profiles (name, description, display_order)
      values ('Accountant', 'Accounts & tax delivery role', 10)
      returning id into v_role;
    insert into pd_role_profile_categories (role_profile_id, category, target_level, display_order)
    values
      (v_role, 'Tax Knowledge', 4, 10),
      (v_role, 'Working Papers', 4, 20),
      (v_role, 'TaxCalc', 3, 30),
      (v_role, 'Companies House & HMRC', 4, 40),
      (v_role, 'Soft Skills', 4, 50),
      (v_role, 'Excel', 3, 60);
  end if;
end $$;

-- ── Auto-CPD: log an achievement when a skill's current level rises ──
create or replace function pd_log_skill_improvement() returns trigger
language plpgsql as $$
declare v_name text;
begin
  if new.current_level > old.current_level then
    select name into v_name from pd_skills where id = new.skill_id;
    insert into pd_cpd_entries (staff_id, entry_date, title, type, hours, reflection, linked_skill_id)
    values (
      new.staff_id, current_date,
      'Skill improved: ' || coalesce(v_name, 'skill') || ' (level ' || old.current_level || ' → ' || new.current_level || ')',
      'on_the_job', 0,
      'Auto-logged from the skills matrix.', new.skill_id
    );
  end if;
  return new;
end;
$$;

drop trigger if exists pd_skill_improvement on pd_skill_levels;
create trigger pd_skill_improvement
  after update of current_level on pd_skill_levels
  for each row execute function pd_log_skill_improvement();

-- ── RLS — consistent with the other pd_* tables (any active staff) ──
alter table pd_role_profiles            enable row level security;
alter table pd_role_profile_categories  enable row level security;
alter table pd_staff_category_overrides enable row level security;

drop policy if exists pd_role_profiles_all on pd_role_profiles;
create policy pd_role_profiles_all on pd_role_profiles
  for all to authenticated using (is_active_staff()) with check (is_active_staff());

drop policy if exists pd_role_profile_categories_all on pd_role_profile_categories;
create policy pd_role_profile_categories_all on pd_role_profile_categories
  for all to authenticated using (is_active_staff()) with check (is_active_staff());

drop policy if exists pd_staff_category_overrides_all on pd_staff_category_overrides;
create policy pd_staff_category_overrides_all on pd_staff_category_overrides
  for all to authenticated using (is_active_staff()) with check (is_active_staff());

comment on table pd_role_profiles is 'Central role templates (Accountant, Bookkeeper, ...) grouping skill categories with per-category targets for the CPD skills graph.';
comment on table pd_staff_category_overrides is 'Per-staff augmentation of the assigned role profile (add/hide categories, override targets).';
