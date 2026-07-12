-- Per-service handovers + 3-month client check-in
-- (applied as migration onboarding_handovers_checkin_v1, 12/07/2026).
--
-- Handover was a single onboardings.handover_to/_due/_done_at; real practice
-- hands over BY SERVICE AREA: Sophie owns admin/onboarding, Margaret owns
-- bookkeeping setup, Tracy owns accounts, Steph owns payroll — then each may
-- hand off to a permanent team member. Defaults are customisable in the
-- HandoverPanel (gear icon); rows are instantiated lazily per onboarding,
-- filtered by the client's services (metConditions in onboarding/api.js).
-- Legacy onboardings.handover_* columns are kept for history but no longer
-- read; existing data was migrated into onboarding_handovers below.
--
-- 3-month check-in: onboardings.checkin_due (started_at + 3 months), staff
-- gather per-area feedback into checkin_feedback (jsonb, internal), then send
-- the client email (onboarding-emails kind=checkin → checkin_sent_at). The
-- daily digest (onboarding-chase) reminds owners of due handovers/check-ins.

-- ── Customisable team defaults ───────────────────────────────
create table if not exists onboarding_handover_defaults (
  id                uuid primary key default gen_random_uuid(),
  area              text not null unique,
  sort              int not null default 0,
  default_owner_id  uuid references staff_profiles(id),
  service_condition text,   -- same keys as template steps (vat/ct/paye/…); null = always applies
  active            boolean not null default true,
  updated_at        timestamptz not null default now()
);
comment on table onboarding_handover_defaults is 'Per-service-area handover defaults: who owns each area during onboarding. Instantiated onto each onboarding (onboarding_handovers); area applies only when its service_condition is met (null = always).';

-- ── Per-onboarding handover rows ─────────────────────────────
create table if not exists onboarding_handovers (
  id            uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null references onboardings(id) on delete cascade,
  area          text not null,
  owner_id      uuid references staff_profiles(id),
  handover_to   uuid references staff_profiles(id),
  due           date,
  done_at       timestamptz,
  created_at    timestamptz not null default now(),
  unique (onboarding_id, area)
);
comment on table onboarding_handovers is 'Service-area handovers per onboarding: area owner settles the client in, then hands to the permanent team member. Replaces the single onboardings.handover_* fields (kept for history).';
create index if not exists idx_onboarding_handovers_ob on onboarding_handovers(onboarding_id);

alter table onboarding_handover_defaults enable row level security;
alter table onboarding_handovers enable row level security;
do $$
declare t text;
begin
  foreach t in array array['onboarding_handover_defaults','onboarding_handovers']
  loop
    execute format('drop policy if exists %I on %I', t || '_staff', t);
    execute format('create policy %I on %I for all using (is_active_staff()) with check (is_active_staff())', t || '_staff', t);
  end loop;
end $$;

-- ── Seed the real defaults (customisable in the UI) ──────────
insert into onboarding_handover_defaults (area, sort, default_owner_id, service_condition)
select v.area, v.sort, sp.id, v.cond
from (values
  ('Admin & onboarding', 1, 'Sophie Laidlaw',     null),
  ('Bookkeeping',        2, 'Margaret Loughrey',  'vat'),
  ('Accounts',           3, 'Tracy Mitchell',     'ct'),
  ('Payroll',            4, 'Stephanie Campbell', 'paye')
) as v(area, sort, owner_name, cond)
left join staff_profiles sp on sp.name = v.owner_name
on conflict (area) do nothing;

-- ── Migrate legacy single-handover data ──────────────────────
insert into onboarding_handovers (onboarding_id, area, owner_id, handover_to, due, done_at)
select o.id, 'Admin & onboarding', o.owner_id, o.handover_to, o.handover_due, o.handover_done_at
from onboardings o
where o.handover_to is not null or o.handover_due is not null
on conflict (onboarding_id, area) do nothing;

-- ── 3-month client check-in ──────────────────────────────────
alter table onboardings add column if not exists checkin_due date;
alter table onboardings add column if not exists checkin_sent_at timestamptz;
alter table onboardings add column if not exists checkin_feedback jsonb;
comment on column onboardings.checkin_due is '3-month client check-in: due date (started_at + 3 months by default). Digest reminds the owner; staff gather per-area feedback then send the check-in email (onboarding-emails kind=checkin).';

update onboardings
   set checkin_due = started_at + interval '3 months'
 where checkin_due is null and status in ('active','on_hold','issues');
