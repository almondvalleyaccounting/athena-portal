-- ============================================================
-- Companies House personal code chase v1
-- Tracks the CH identity-verification "personal code" (11 chars, e.g.
-- FT5-15ED-7JY5) needed from every director/PSC before a Confirmation
-- Statement can be filed via Inform Direct, and entered on BrightManager.
-- Distinct from entities.ch_auth_code (the 6-char COMPANY auth code).
--
-- Directors/PSCs are already modelled + populated by ch-ingest-officers
-- (people.ch_officer_id/ch_psc_id, entity_people.role/role_pct) — this
-- migration only adds the code itself + the chase pipeline on top.
-- One request per PERSON (the code is personal, reusable across their
-- companies), anchored to one entity for chasing/portal context.
-- ============================================================

alter table people add column if not exists ch_personal_code text;

alter table staff_profiles add column if not exists can_view_ch_codes boolean default false;
update staff_profiles
   set can_view_ch_codes = true
 where is_portal_admin is true
    or name in ('Bobby Gallacher','Sophie Laidlaw','Stephanie Campbell','Tracy Mitchell');

create table if not exists ch_code_requests (
  id                uuid primary key default gen_random_uuid(),
  person_id         uuid not null references people(id),
  entity_id         uuid not null references entities(id),
  status            text not null default 'pending_offer' check (status in (
                      'pending_offer','awaiting_decision','awaiting_id_poa','awaiting_code',
                      'code_received','entered_on_bm','stalled')),
  decision          text check (decision in ('paid','self')),
  billing_item_id   uuid references billing_items(id),
  owner_id          uuid references staff_profiles(id),
  chase_count       int not null default 0,
  last_chased_at    date,
  requested_at      date,
  escalation_status text not null default 'none' check (escalation_status in ('none','call_needed','escalated_tracy')),
  escalated_at      date,
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
comment on table ch_code_requests is 'One row per person needing a CH personal code. entity_id is the anchor company used for chasing/portal context; the code itself (people.ch_personal_code) applies across all their companies.';
create index if not exists idx_ch_code_requests_entity on ch_code_requests(entity_id);
create index if not exists idx_ch_code_requests_status on ch_code_requests(status);
-- one open request per person at a time
create unique index if not exists ch_code_requests_open_person_idx on ch_code_requests(person_id)
  where status not in ('entered_on_bm','stalled');

create table if not exists ch_code_documents (
  id               uuid primary key default gen_random_uuid(),
  request_id       uuid not null references ch_code_requests(id) on delete cascade,
  entity_id        uuid not null references entities(id),
  doc_type         text not null default 'other' check (doc_type in ('id','poa','other')),
  uploaded_by_kind text not null default 'client' check (uploaded_by_kind in ('client','staff')),
  uploaded_by      uuid,
  storage_path     text not null, -- same client-documents bucket, {entity_id}/... as onboarding
  original_name    text not null,
  mime_type        text,
  size_bytes       bigint,
  created_at       timestamptz not null default now()
);
comment on table ch_code_documents is 'ID/POA uploads for a CH code request. Reuses the client-documents storage bucket (entity_id-scoped RLS already covers it) — no bucket/policy changes needed.';
create index if not exists idx_ch_code_documents_request on ch_code_documents(request_id);

create table if not exists ch_code_activity (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references ch_code_requests(id) on delete cascade,
  kind        text not null default 'note' check (kind in ('note','status_change','system','email_out','client_reply')),
  body        text not null,
  created_by  uuid references staff_profiles(id),
  created_at  timestamptz not null default now()
);
create index if not exists idx_ch_code_activity_request on ch_code_activity(request_id);

create table if not exists ch_code_chase_config (
  id                     boolean primary key default true check (id),
  sending_enabled        boolean not null default false,
  first_chase_after_days int not null default 3,
  chase_every_days       int not null default 3,
  max_chases             int not null default 2, -- policy: 2 emails then a call
  call_assignee_id       uuid references staff_profiles(id),
  escalate_to_id         uuid references staff_profiles(id),
  stalled_after_days     int not null default 14, -- no movement after the call → escalate to Tracy
  internal_digest_enabled boolean not null default true,
  weekly_enabled         boolean not null default true,
  cron_secret            text not null default gen_random_uuid()::text,
  updated_at             timestamptz not null default now()
);
comment on table ch_code_chase_config is 'Singleton config for the CH personal code chaser. Mirrors onboarding_chase_config: sending_enabled=false blocks all real sends (test_recipient still allowed).';
insert into ch_code_chase_config (id) values (true) on conflict do nothing;

do $$
declare s_sophie uuid; s_tracy uuid;
begin
  select id into s_sophie from staff_profiles where name = 'Sophie Laidlaw';
  select id into s_tracy  from staff_profiles where name = 'Tracy Mitchell';
  update ch_code_chase_config set call_assignee_id = s_sophie, escalate_to_id = s_tracy where id = true;
end $$;

-- admin_tasks: personal codes belong to a PERSON, not an entity field
alter table admin_tasks add column if not exists person_id uuid references people(id);
alter table admin_tasks drop constraint if exists admin_tasks_field_check;
alter table admin_tasks add constraint admin_tasks_field_check
  check (field is null or field in ('ch_auth_code','utr','vat_number','paye_ref','ch_personal_code'));

-- ── RLS: same is_active_staff() pattern as every other staff table ──
alter table ch_code_requests  enable row level security;
alter table ch_code_documents enable row level security;
alter table ch_code_activity  enable row level security;
alter table ch_code_chase_config enable row level security;

drop policy if exists ch_code_requests_staff on ch_code_requests;
create policy ch_code_requests_staff on ch_code_requests for all using (is_active_staff()) with check (is_active_staff());
drop policy if exists ch_code_documents_staff on ch_code_documents;
create policy ch_code_documents_staff on ch_code_documents for all using (is_active_staff()) with check (is_active_staff());
drop policy if exists ch_code_activity_staff on ch_code_activity;
create policy ch_code_activity_staff on ch_code_activity for all using (is_active_staff()) with check (is_active_staff());
drop policy if exists ch_code_chase_config_read on ch_code_chase_config;
create policy ch_code_chase_config_read on ch_code_chase_config for select using (is_active_staff());
drop policy if exists ch_code_chase_config_write on ch_code_chase_config;
create policy ch_code_chase_config_write on ch_code_chase_config for update using (is_active_staff()) with check (is_active_staff());

-- Self-gating cron wrapper — safe to schedule daily; no-ops until sending_enabled flips on
create or replace function run_ch_code_chase()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare cfg ch_code_chase_config%rowtype;
begin
  select * into cfg from ch_code_chase_config where id = true;
  if cfg is null or not cfg.sending_enabled then
    return;
  end if;
  perform net.http_post(
    url := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/ch-code-chase',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', cfg.cron_secret),
    body := jsonb_build_object('dry_run', false)
  );
end;
$$;

create or replace function run_ch_code_weekly()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare cfg ch_code_chase_config%rowtype;
begin
  select * into cfg from ch_code_chase_config where id = true;
  if cfg is null or not cfg.weekly_enabled then
    return;
  end if;
  perform net.http_post(
    url := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/ch-code-weekly',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', cfg.cron_secret),
    body := jsonb_build_object('dry_run', false)
  );
end;
$$;

-- DISARMED: schedule manually once tested, e.g.
--   select cron.schedule('ch-code-chase', '0 8 * * 1-5', $$select run_ch_code_chase()$$);
--   select cron.schedule('ch-code-weekly', '0 9 * * 1', $$select run_ch_code_weekly()$$);
