-- 156: Recruitment phases 2–6 — comms, interviews, offers, contracts, induction.
--
-- All of these concern a specific applicant, so they sit in the PII tier:
-- readable/writable only by staff cleared for applicant data
-- (can_see_recruitment_pii — see sql/155).

-- ── Applicant communications log (P2) ───────────────────────────────
-- Unified outbound/inbound timeline. Email is sent + logged server-side by
-- the recruitment-email edge function (Resend); SMS/WhatsApp ride the shared
-- sms-send function and a mirror row is written here so the applicant's
-- timeline is complete without touching the shared sms_messages table.
create table if not exists public.recruitment_messages (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.recruitment_applications(id) on delete cascade,
  candidate_id uuid references public.recruitment_candidates(id) on delete set null,
  channel text not null default 'email' check (channel in ('email','sms','whatsapp')),
  direction text not null default 'out' check (direction in ('out','in')),
  subject text,
  body text,
  status text not null default 'sent' check (status in ('sent','failed','received')),
  to_addr text,
  from_addr text,
  provider_id text,
  error text,
  created_by uuid references public.staff_profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists recruitment_messages_application_idx on public.recruitment_messages(application_id, created_at);

-- ── Interviews (P3) ──────────────────────────────────────────────────
create table if not exists public.recruitment_interviews (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.recruitment_applications(id) on delete cascade,
  kind text not null default 'video' check (kind in ('phone','video','in_person','task')),
  scheduled_at timestamptz,
  duration_mins int not null default 45,
  location text,                        -- address, or a video/meeting link
  interviewers uuid[] not null default '{}',   -- staff_profiles ids
  status text not null default 'scheduled' check (status in ('scheduled','completed','cancelled','no_show')),
  feedback text,
  score int check (score between 0 and 5),
  created_by uuid references public.staff_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists recruitment_interviews_application_idx on public.recruitment_interviews(application_id);
create index if not exists recruitment_interviews_when_idx on public.recruitment_interviews(scheduled_at);

-- ── Offers (P5) ──────────────────────────────────────────────────────
create table if not exists public.recruitment_offers (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.recruitment_applications(id) on delete cascade,
  salary numeric,
  salary_period text not null default 'year' check (salary_period in ('year','day','hour')),
  start_date date,
  status text not null default 'draft' check (status in ('draft','sent','accepted','declined','withdrawn')),
  letter_url text,
  notes text,
  sent_at timestamptz,
  responded_at timestamptz,
  created_by uuid references public.staff_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists recruitment_offers_application_idx on public.recruitment_offers(application_id);

-- ── Contracts (P5) ───────────────────────────────────────────────────
create table if not exists public.recruitment_contracts (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.recruitment_applications(id) on delete cascade,
  offer_id uuid references public.recruitment_offers(id) on delete set null,
  contract_url text,
  status text not null default 'draft' check (status in ('draft','sent','signed','declined')),
  sent_at timestamptz,
  signed_at timestamptz,
  notes text,
  created_by uuid references public.staff_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists recruitment_contracts_application_idx on public.recruitment_contracts(application_id);

-- ── Induction checklist (P6) ─────────────────────────────────────────
-- Seeded from a default set when a hire's induction is started (human-in-the-
-- loop). Deliberately NOT auto-provisioning an Athena login — creating a
-- staff account stays a separate manual admin action.
create table if not exists public.recruitment_induction_items (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.recruitment_applications(id) on delete cascade,
  label text not null,
  category text,
  done boolean not null default false,
  done_at timestamptz,
  done_by uuid references public.staff_profiles(id),
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists recruitment_induction_application_idx on public.recruitment_induction_items(application_id, sort);

-- ── RLS (all PII tier) ───────────────────────────────────────────────
alter table public.recruitment_messages enable row level security;
alter table public.recruitment_interviews enable row level security;
alter table public.recruitment_offers enable row level security;
alter table public.recruitment_contracts enable row level security;
alter table public.recruitment_induction_items enable row level security;

drop policy if exists recruitment_messages_rw on public.recruitment_messages;
create policy recruitment_messages_rw on public.recruitment_messages for all
  using (can_see_recruitment_pii()) with check (can_see_recruitment_pii());

drop policy if exists recruitment_interviews_rw on public.recruitment_interviews;
create policy recruitment_interviews_rw on public.recruitment_interviews for all
  using (can_see_recruitment_pii()) with check (can_see_recruitment_pii());

drop policy if exists recruitment_offers_rw on public.recruitment_offers;
create policy recruitment_offers_rw on public.recruitment_offers for all
  using (can_see_recruitment_pii()) with check (can_see_recruitment_pii());

drop policy if exists recruitment_contracts_rw on public.recruitment_contracts;
create policy recruitment_contracts_rw on public.recruitment_contracts for all
  using (can_see_recruitment_pii()) with check (can_see_recruitment_pii());

drop policy if exists recruitment_induction_rw on public.recruitment_induction_items;
create policy recruitment_induction_rw on public.recruitment_induction_items for all
  using (can_see_recruitment_pii()) with check (can_see_recruitment_pii());
