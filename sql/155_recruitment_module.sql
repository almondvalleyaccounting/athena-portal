-- 155: Recruitment module (in-house ATS).
--
-- The firm's own applicant-tracking system for hiring staff:
-- vacancies → adverts (where posted) → applications (the pipeline card,
-- one per candidate per vacancy) → notes. Candidates are a shared person
-- record so re-applicants are recognised across roles.
--
-- HARD RULE (design): recruitment never exposes any public surface that
-- shares this Supabase project. Applications arrive by email (jobs@) and
-- are entered by staff; there is no anon write path here.
--
-- Confidentiality — two tiers, mirroring the fee-confidentiality model:
--   * can_view_recruitment           — see vacancies + adverts + the pipeline
--                                       (stage/rating/dates), the non-PII layer.
--   * can_view_recruitment_applicants — see applicant PII: candidate contact
--                                       details, CVs, cover notes, per-app notes.
--   * can_manage_recruitment          — manage the module (implies both above).
-- A viewer with only can_view_recruitment sees pipeline activity but no
-- candidate identities (candidate rows simply don't return under RLS).

-- ── Permission flags ─────────────────────────────────────────────────
alter table public.staff_profiles add column if not exists can_view_recruitment boolean default false;
alter table public.staff_profiles add column if not exists can_manage_recruitment boolean default false;
alter table public.staff_profiles add column if not exists can_view_recruitment_applicants boolean default false;

-- Seed: portal owners get full recruitment access out of the gate; Bobby can
-- widen the hiring-manager set from Admin. (No emails hardcoded — role-driven.)
update public.staff_profiles
   set can_view_recruitment = true,
       can_manage_recruitment = true,
       can_view_recruitment_applicants = true
 where can_manage_portal = true;

-- ── RLS helpers ──────────────────────────────────────────────────────
-- Module access: active staff who can view or manage recruitment (admins too).
create or replace function public.is_recruitment_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.staff_profiles p
     where p.id = auth.uid() and p.is_active
       and (p.can_view_recruitment or p.can_manage_recruitment or p.is_portal_admin)
  );
$$;

-- PII access: active staff cleared to see candidate identities / CVs.
create or replace function public.can_see_recruitment_pii()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.staff_profiles p
     where p.id = auth.uid() and p.is_active
       and (p.can_view_recruitment_applicants or p.can_manage_recruitment or p.is_portal_admin)
  );
$$;

-- ── Candidates (the person — PII) ────────────────────────────────────
create table if not exists public.recruitment_candidates (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text,
  phone text,
  linkedin_url text,
  location text,
  cv_url text,                         -- link for now; private storage bucket comes in a later phase
  source text,                         -- indeed | linkedin | referral | website | reed | other
  notes text,                          -- free-form summary about the person
  created_by uuid references public.staff_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists recruitment_candidates_email_idx on public.recruitment_candidates(lower(email));

-- ── Vacancies (the role — non-PII metadata) ──────────────────────────
create table if not exists public.recruitment_vacancies (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  department text,
  employment_type text not null default 'full_time'
    check (employment_type in ('full_time','part_time','contract','temporary','apprenticeship')),
  work_mode text not null default 'on_site'
    check (work_mode in ('on_site','hybrid','remote')),
  location text,
  salary_min numeric,
  salary_max numeric,
  salary_period text not null default 'year' check (salary_period in ('year','day','hour')),
  description text,
  requirements text,
  status text not null default 'draft'
    check (status in ('draft','open','on_hold','filled','closed')),
  hiring_manager_id uuid references public.staff_profiles(id),
  public_slug text unique,             -- reserved for the isolated careers microsite (Option B)
  date_posted date,
  valid_through date,
  created_by uuid references public.staff_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists recruitment_vacancies_status_idx on public.recruitment_vacancies(status);

-- ── Adverts (where a vacancy is posted) ──────────────────────────────
create table if not exists public.recruitment_adverts (
  id uuid primary key default gen_random_uuid(),
  vacancy_id uuid not null references public.recruitment_vacancies(id) on delete cascade,
  channel text not null default 'own'
    check (channel in ('own','reed','indeed','linkedin','totaljobs','cv_library','other')),
  external_url text,
  external_ref text,                   -- e.g. Reed job id, for the future Reed API (Phase 7)
  posted_at date,
  cost numeric,
  status text not null default 'draft' check (status in ('draft','live','expired','removed')),
  created_at timestamptz not null default now()
);
create index if not exists recruitment_adverts_vacancy_idx on public.recruitment_adverts(vacancy_id);

-- ── Applications (the pipeline card) ─────────────────────────────────
create table if not exists public.recruitment_applications (
  id uuid primary key default gen_random_uuid(),
  vacancy_id uuid not null references public.recruitment_vacancies(id) on delete cascade,
  candidate_id uuid not null references public.recruitment_candidates(id) on delete cascade,
  stage text not null default 'new'
    check (stage in ('new','screening','interview','offer','hired','rejected','withdrawn')),
  rating int check (rating between 0 and 5),
  assigned_to uuid references public.staff_profiles(id),
  source text,                         -- which advert/channel the application came via
  advert_id uuid references public.recruitment_adverts(id) on delete set null,
  cover_note text,
  applied_at timestamptz not null default now(),
  stage_changed_at timestamptz not null default now(),
  rejected_reason text,
  sort numeric not null default 0,     -- ordering within a kanban column
  created_by uuid references public.staff_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (vacancy_id, candidate_id)    -- one application per candidate per vacancy
);
create index if not exists recruitment_applications_vacancy_idx on public.recruitment_applications(vacancy_id, stage);
create index if not exists recruitment_applications_candidate_idx on public.recruitment_applications(candidate_id);

-- ── Notes (per application — PII-adjacent) ───────────────────────────
create table if not exists public.recruitment_notes (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.recruitment_applications(id) on delete cascade,
  author_id uuid references public.staff_profiles(id),
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists recruitment_notes_application_idx on public.recruitment_notes(application_id);

-- ── RLS ──────────────────────────────────────────────────────────────
alter table public.recruitment_candidates enable row level security;
alter table public.recruitment_vacancies enable row level security;
alter table public.recruitment_adverts enable row level security;
alter table public.recruitment_applications enable row level security;
alter table public.recruitment_notes enable row level security;

-- Non-PII layer: any recruitment staff.
drop policy if exists recruitment_vacancies_rw on public.recruitment_vacancies;
create policy recruitment_vacancies_rw on public.recruitment_vacancies for all
  using (is_recruitment_staff()) with check (is_recruitment_staff());

drop policy if exists recruitment_adverts_rw on public.recruitment_adverts;
create policy recruitment_adverts_rw on public.recruitment_adverts for all
  using (is_recruitment_staff()) with check (is_recruitment_staff());

drop policy if exists recruitment_applications_rw on public.recruitment_applications;
create policy recruitment_applications_rw on public.recruitment_applications for all
  using (is_recruitment_staff()) with check (is_recruitment_staff());

-- PII layer: only applicant-cleared staff.
drop policy if exists recruitment_candidates_rw on public.recruitment_candidates;
create policy recruitment_candidates_rw on public.recruitment_candidates for all
  using (can_see_recruitment_pii()) with check (can_see_recruitment_pii());

drop policy if exists recruitment_notes_rw on public.recruitment_notes;
create policy recruitment_notes_rw on public.recruitment_notes for all
  using (can_see_recruitment_pii()) with check (can_see_recruitment_pii());
