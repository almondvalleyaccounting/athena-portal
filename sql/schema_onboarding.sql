-- ============================================================
-- Onboarding module v1
-- Internal tracking of new-client / new-service onboarding.
-- Templates seeded from the four active BrightManager workflow
-- templates (captured 11/07/2026) plus billing steps from the
-- manual "Client On Boarding.xlsx" tracker.
--
-- owner_type: who the ball is with by default
--   staff  — an AV team action
--   client — the client must do/provide something (surfaces on
--            the client portal in a later phase; client_label is
--            the friendly wording shown there)
--   system — Athena can verify it automatically (auto_check key)
-- service_condition: step only applies if the client's committed
--   quote includes a matching service (resolved at initiation;
--   unmet conditions default the step to 'na', toggleable).
-- expected_days: typical external turnaround once requested_at is
--   set (drives "overdue" flags and, in Phase 2, auto-chasers).
-- ============================================================

alter table staff_profiles add column if not exists can_view_onboarding boolean default false;

update staff_profiles
   set can_view_onboarding = true
 where is_portal_admin is true
    or name in ('Bobby Gallacher','Sophie Laidlaw','Stephanie Campbell','Tracy Mitchell');

-- ── Templates ────────────────────────────────────────────────
create table if not exists onboarding_templates (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,
  name        text not null,
  description text,
  client_type text,                      -- company | individual | any
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
comment on table onboarding_templates is 'Onboarding workflow templates. Seeded from BrightManager active templates; editable in Athena going forward.';

create table if not exists onboarding_template_steps (
  id                uuid primary key default gen_random_uuid(),
  template_id       uuid not null references onboarding_templates(id) on delete cascade,
  group_name        text not null,
  group_sort        int not null default 0,
  sort              int not null default 0,
  name              text not null,
  description       text,
  assignee_id       uuid references staff_profiles(id),
  owner_type        text not null default 'staff' check (owner_type in ('staff','client','system')),
  service_condition text,
  expected_days     int,
  chase_after_days  int,
  auto_check        text,
  client_label      text
);
comment on table onboarding_template_steps is 'Steps within an onboarding template. assignee_id null = falls back to the onboarding owner.';

-- ── Instances ────────────────────────────────────────────────
create table if not exists onboardings (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entities(id),
  template_id  uuid references onboarding_templates(id),
  quote_id     uuid references quotes(id),
  status       text not null default 'active' check (status in ('active','on_hold','issues','complete','cancelled')),
  owner_id     uuid references staff_profiles(id),
  lead_id      uuid references staff_profiles(id),
  target_date  date,
  started_at   date not null default current_date,
  completed_at timestamptz,
  notes        text,
  created_by   uuid references staff_profiles(id),
  created_at   timestamptz not null default now()
);
comment on table onboardings is 'One onboarding run per client (entity). owner = who drives it (usually Sophie); lead = who brought the client in.';
create index if not exists idx_onboardings_entity on onboardings(entity_id);
create index if not exists idx_onboardings_status on onboardings(status);

create table if not exists onboarding_steps (
  id               uuid primary key default gen_random_uuid(),
  onboarding_id    uuid not null references onboardings(id) on delete cascade,
  template_step_id uuid references onboarding_template_steps(id),
  group_name       text not null,
  group_sort       int not null default 0,
  sort             int not null default 0,
  name             text not null,
  description      text,
  owner_type       text not null default 'staff' check (owner_type in ('staff','client','system')),
  assignee_id      uuid references staff_profiles(id),
  status           text not null default 'pending' check (status in ('pending','waiting_client','waiting_external','blocked','complete','na')),
  requested_at     date,
  expected_days    int,
  chase_after_days int,
  auto_check       text,
  client_label     text,
  note             text,
  completed_at     timestamptz,
  completed_by     uuid references staff_profiles(id),
  updated_at       timestamptz not null default now()
);
comment on table onboarding_steps is 'Instantiated checklist steps (copied from template at initiation so templates can evolve independently). requested_at + expected_days drive overdue/chase logic.';
create index if not exists idx_onboarding_steps_ob on onboarding_steps(onboarding_id);

create table if not exists onboarding_activity (
  id            uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null references onboardings(id) on delete cascade,
  step_id       uuid references onboarding_steps(id) on delete set null,
  kind          text not null default 'note' check (kind in ('note','status_change','system','email_out','client_reply')),
  body          text not null,
  created_by    uuid references staff_profiles(id),
  created_at    timestamptz not null default now()
);
comment on table onboarding_activity is 'Timeline per onboarding: manual notes plus automatic entries (status changes, emails, client replies).';
create index if not exists idx_onboarding_activity_ob on onboarding_activity(onboarding_id);

-- ── RLS: staff-only (client portal gets its own scoped policies in a later phase) ──
alter table onboarding_templates      enable row level security;
alter table onboarding_template_steps enable row level security;
alter table onboardings               enable row level security;
alter table onboarding_steps          enable row level security;
alter table onboarding_activity       enable row level security;

do $$
declare t text;
begin
  foreach t in array array['onboarding_templates','onboarding_template_steps','onboardings','onboarding_steps','onboarding_activity']
  loop
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select using (is_active_staff())', t || '_read', t);
    execute format('drop policy if exists %I on %I', t || '_write', t);
    execute format('create policy %I on %I for all using (is_active_staff()) with check (is_active_staff())', t || '_write', t);
  end loop;
end $$;

-- ── Seed: four BrightManager templates ───────────────────────
do $$
declare
  t uuid;
  s_sophie uuid; s_bobby uuid; s_steph uuid; s_tracy uuid;
begin
  if exists (select 1 from onboarding_templates where code = 'company') then
    return; -- already seeded
  end if;

  select id into s_sophie from staff_profiles where name = 'Sophie Laidlaw';
  select id into s_bobby  from staff_profiles where name = 'Bobby Gallacher';
  select id into s_steph  from staff_profiles where name = 'Stephanie Campbell';
  select id into s_tracy  from staff_profiles where name = 'Tracy Mitchell';

  -- ═══ 1. New Client Setup — Company (BM template 7 + billing group) ═══
  insert into onboarding_templates (code, name, description, client_type)
  values ('company', 'New Client Setup — Company',
          'Full setup and engagement of a new limited company client. Seeded from BrightManager template 7, plus the billing steps tracked on the manual onboarding spreadsheet.',
          'company')
  returning id into t;

  insert into onboarding_template_steps
    (template_id, group_name, group_sort, sort, name, description, assignee_id, owner_type, service_condition, expected_days, chase_after_days, auto_check, client_label) values
  (t,'Onboarding',1,1,'Add client to BM (add individual or company & link if req''d)',null,s_sophie,'staff',null,null,null,null,null),
  (t,'Onboarding',1,2,'Companies House search',null,s_sophie,'staff',null,null,null,null,null),
  (t,'Onboarding',1,3,'Select list of services required / update accounting deadlines',null,s_sophie,'staff',null,null,null,null,null),
  (t,'Onboarding',1,4,'Professional clearance request','Do professional request email/letter to old accountant',s_sophie,'staff',null,14,null,null,null),
  (t,'Onboarding',1,5,'Check received professional clearance and upload to AM',null,s_sophie,'staff',null,null,null,null,null),
  (t,'Onboarding',1,6,'Issue Letter of Engagement from BM',null,s_sophie,'staff',null,null,null,null,null),
  (t,'Onboarding',1,7,'Letter of Engagement signed and returned',null,s_sophie,'client',null,null,3,null,'Sign and return your Letter of Engagement'),
  (t,'Onboarding',1,8,'Received 2 forms of ID',null,s_sophie,'client',null,null,3,null,'Send us two forms of ID (e.g. passport or driving licence, plus a recent utility bill)'),
  (t,'Onboarding',1,9,'Assign QB licence to client (if applicable)',null,s_bobby,'staff','software',null,null,null,null),
  (t,'Onboarding',1,10,'Assign staff tasks',null,s_bobby,'staff',null,null,null,null,null),
  (t,'Onboarding',1,11,'Companies House authentication code entered',null,s_sophie,'client',null,null,5,null,'Provide your Companies House authentication code'),
  (t,'Onboarding',1,12,'Accepted quote',null,s_bobby,'system',null,null,null,'quote_accepted',null),
  (t,'SA',2,1,'Register for self assessment (if req)',null,s_sophie,'staff','sa',null,null,null,null),
  (t,'SA',2,2,'Received personal UTR',null,s_sophie,'client','sa',14,5,null,'Forward your personal UTR letter when it arrives from HMRC'),
  (t,'SA',2,3,'Submit Self-Assessment 64-8','Once UTR received, submit SA 64-8',s_sophie,'staff','sa',null,null,null,null),
  (t,'SA',2,4,'Received agent code and switched on BM',null,s_sophie,'staff','sa',28,null,null,null),
  (t,'CT',3,1,'Company UTR received and logged on BM',null,s_sophie,'client','ct',14,5,null,'Forward your company UTR (Corporation Tax) letter when it arrives from HMRC — usually within 14 days of incorporation'),
  (t,'CT',3,2,'Submit CT 64-8',null,s_sophie,'staff','ct',null,null,null,null),
  (t,'CT',3,3,'Received CT agent code and switched on BM',null,s_sophie,'staff','ct',28,null,null,null),
  (t,'VAT',4,1,'Register for VAT (if req)',null,s_sophie,'staff','vat',30,null,null,null),
  (t,'VAT',4,2,'Enter VAT number on BM and validate',null,s_sophie,'staff','vat',null,null,null,null),
  (t,'VAT',4,3,'Send VAT agent link',null,s_sophie,'staff','vat',28,null,null,null),
  (t,'VAT',4,4,'Once we are agents — check dates on HMRC and put on BM (quarters)',null,s_sophie,'staff','vat',null,null,null,null),
  (t,'VAT',4,5,'Switch on agent code on BM',null,s_sophie,'staff','vat',null,null,null,null),
  (t,'PAYE',5,1,'Register PAYE (if req)',null,s_sophie,'staff','paye',null,null,null,null),
  (t,'PAYE',5,2,'Receive PAYE ref / accounts office ref','Update in BM — PAYE Accounts Office Reference AND PAYE Employers Reference',s_sophie,'staff','paye',14,null,null,null),
  (t,'PAYE',5,3,'Submit PAYE 64-8',null,s_sophie,'staff','paye',null,null,null,null),
  (t,'PAYE',5,4,'Received agent code and switched on BM',null,s_sophie,'staff','paye',28,null,null,null),
  (t,'PAYE',5,5,'Setup on Brightpay',null,s_steph,'staff','paye',null,null,null,null),
  (t,'CIS',6,1,'Register CIS (if req)',null,s_sophie,'staff','cis',null,null,null,null),
  (t,'CIS',6,2,'Submit CIS 64-8',null,s_sophie,'staff','cis',null,null,null,null),
  (t,'CIS',6,3,'Receive CIS code and switched on BM',null,s_sophie,'staff','cis',28,null,null,null),
  (t,'Tax Calc',7,1,'Add company to Tax Calc',null,s_sophie,'staff',null,null,null,null,null),
  (t,'Tax Calc',7,2,'Set up tax return for individual on Tax Calc (if required)',null,s_sophie,'staff','sa',null,null,null,null),
  (t,'Inform Direct',8,1,'Add to Inform Direct',null,null,'staff','confirmation_statement',null,null,null,null),
  (t,'Billing',9,1,'Committed to live billing (QB invoice / recurring in place)',null,s_tracy,'system',null,null,null,'live_billing',null),
  (t,'Billing',9,2,'Direct Debit mandate completed',null,s_tracy,'client',null,null,5,null,'Set up your Direct Debit using the link we send from QuickBooks');

  -- ═══ 2. New Client Setup — Self Assessment (BM template 13) ═══
  insert into onboarding_templates (code, name, description, client_type)
  values ('sa_individual', 'New Client Setup — Self Assessment',
          'Setup and engagement of a new personal tax / self-assessment client. Seeded from BrightManager template 13.',
          'individual')
  returning id into t;

  insert into onboarding_template_steps
    (template_id, group_name, group_sort, sort, name, description, assignee_id, owner_type, service_condition, expected_days, chase_after_days, auto_check, client_label) values
  (t,'Onboarding',1,1,'Add client to BM',null,null,'staff',null,null,null,null,null),
  (t,'Onboarding',1,2,'Select list of services required / update accounting deadlines',null,null,'staff',null,null,null,null,null),
  (t,'Onboarding',1,3,'Professional clearance request','Do professional request email/letter to old accountant',null,'staff',null,14,null,null,null),
  (t,'Onboarding',1,4,'Check received professional clearance and upload to AM',null,null,'staff',null,null,null,null,null),
  (t,'Onboarding',1,5,'Issue Letter of Engagement from BM',null,null,'staff',null,null,null,null,null),
  (t,'Onboarding',1,6,'Letter of Engagement signed and returned',null,null,'client',null,null,3,null,'Sign and return your Letter of Engagement'),
  (t,'Onboarding',1,7,'Received 2 forms of ID',null,null,'client',null,null,3,null,'Send us two forms of ID (e.g. passport or driving licence, plus a recent utility bill)'),
  (t,'Onboarding',1,8,'Assign QB licence to client (if applicable)',null,null,'staff','software',null,null,null,null),
  (t,'Onboarding',1,9,'Assign staff tasks',null,s_bobby,'staff',null,null,null,null,null),
  (t,'SA',2,1,'Register for self assessment — send canned email for them to register',null,null,'client',null,null,5,null,'Register for Self Assessment using the link we email you'),
  (t,'SA',2,2,'Received personal UTR',null,null,'client',null,14,5,null,'Forward your personal UTR letter when it arrives from HMRC'),
  (t,'SA',2,3,'Submit Self-Assessment 64-8','Once UTR received, submit SA 64-8',null,'staff',null,null,null,null,null),
  (t,'SA',2,4,'Received agent code and switched on BM',null,null,'staff',null,28,null,null,null),
  (t,'SA',2,5,'Added to billing tracker',null,null,'system',null,null,null,'live_billing',null),
  (t,'Tax Calc',3,1,'Set up tax return for individual on Tax Calc (if required)',null,null,'staff',null,null,null,null,null);

  -- ═══ 3. PAYE Registration — existing client (BM template 8) ═══
  insert into onboarding_templates (code, name, description, client_type)
  values ('paye_reg', 'PAYE Registration',
          'Registering an existing client with HMRC for PAYE and setting up payroll. Seeded from BrightManager template 8.',
          'any')
  returning id into t;

  insert into onboarding_template_steps
    (template_id, group_name, group_sort, sort, name, description, assignee_id, owner_type, service_condition, expected_days, chase_after_days, auto_check, client_label) values
  (t,'PAYE Registration',1,1,'Register for PAYE','Need directors NI number',s_sophie,'staff',null,null,null,null,null),
  (t,'PAYE Registration',1,2,'Send new starter forms to employer',null,s_sophie,'staff',null,null,null,null,null),
  (t,'PAYE Registration',1,3,'Received PAYE ref from client — save to BM',null,s_sophie,'client',null,14,5,null,'Forward your PAYE reference letters when they arrive from HMRC'),
  (t,'PAYE Registration',1,4,'Set up on Brightpay',null,s_steph,'staff',null,null,null,null,null),
  (t,'PAYE Registration',1,5,'Request agent code',null,s_sophie,'staff',null,28,null,null,null),
  (t,'PAYE Registration',1,6,'Received agent code and switched on BM',null,s_sophie,'staff',null,null,null,null,null),
  (t,'Billing',2,1,'Added to the billing sheet',null,s_sophie,'staff',null,null,null,null,null);

  -- ═══ 4. VAT Registration — existing client (BM template 10) ═══
  insert into onboarding_templates (code, name, description, client_type)
  values ('vat_reg', 'VAT Registration',
          'Registering an existing client with HMRC for VAT. Seeded from BrightManager template 10.',
          'any')
  returning id into t;

  insert into onboarding_template_steps
    (template_id, group_name, group_sort, sort, name, description, assignee_id, owner_type, service_condition, expected_days, chase_after_days, auto_check, client_label) values
  (t,'VAT Registration',1,1,'Register for VAT','Do we have UTR? Has the client changed surname? (Will need maiden name and date they got married.) Have they lived at address for less than 3 years? (Will need previous address and date they moved.)',null,'staff',null,30,null,null,null),
  (t,'VAT Registration',1,2,'Received VAT number',null,null,'staff',null,null,null,null,null),
  (t,'VAT Registration',1,3,'Send VAT agent link','64-8 registrations online are problematic — HMRC can''t see authorisations on their screens and you can no longer speak to HMRC agents',null,'staff',null,28,null,null,null),
  (t,'VAT Registration',1,4,'Once received agent link, fill in dates on BM',null,null,'staff',null,null,null,null,null),
  (t,'Billing',2,1,'Add new client to QuickBooks',null,s_tracy,'staff',null,null,null,null,null),
  (t,'Billing',2,2,'Check billing frequency',null,s_tracy,'staff',null,null,null,null,null),
  (t,'Billing',2,3,'Send DD request for recurring payments (from QB)',null,s_tracy,'staff',null,null,null,null,null),
  (t,'Billing',2,4,'Draft & send first invoice (if one-off request)',null,s_tracy,'staff',null,null,null,null,null),
  (t,'Billing',2,5,'Setup recurring invoice in QB',null,s_tracy,'staff',null,null,null,null,null);
end $$;
