-- Milestones + updates feed, portal step modes, Sophie's admin task list,
-- weekly team emails.
-- Applied as migrations onboarding_milestones_admin_tasks_v1 +
-- client_portal_v3_step_modes (12/07/2026).
--
-- NOTE: client_portal_v3_step_modes redefines portal_my_onboarding (v3),
-- superseding the definition in sql/schema_client_portal_v2.sql. v3 changes:
-- client_steps includes ANY step with a client_label (staff steps the client
-- should see progressing, e.g. professional clearance) and adds owner_type,
-- portal_mode, portal_hint to each step. The portal renders:
--   owner_type <> 'client'  → info-only card ("In hand", message button only)
--   portal_mode = 'external' → no photo/upload (completed in BM e-sign / QBO
--                              DD link); portal_hint explains what to expect.

-- ── 1. Portal step behaviour ─────────────────────────────────
alter table onboarding_template_steps add column if not exists portal_mode text;
alter table onboarding_template_steps add column if not exists portal_hint text;
alter table onboarding_steps add column if not exists portal_mode text;
alter table onboarding_steps add column if not exists portal_hint text;

-- Letter of Engagement: signed on BrightManager via its own email link
update onboarding_template_steps set portal_mode='external',
  portal_hint='You''ll get a separate e-signing email from us (via our engagement system) with your own link — sign there and we''ll tick this off. Nothing to upload here.'
 where name = 'Letter of Engagement signed and returned';
-- Direct Debit: done via the QuickBooks link
update onboarding_template_steps set portal_mode='external',
  portal_hint='Use the Direct Debit link we email you from QuickBooks — nothing to upload here.'
 where name = 'Direct Debit mandate completed';
-- Professional clearance: OUR step, but the client should see it's in hand
update onboarding_template_steps set
  client_label = 'We''ve requested your records and professional clearance from your previous accountant',
  portal_hint = 'Usually takes a couple of weeks. If it drags we chase them — nothing needed from you.'
 where name = 'Professional clearance request';
-- (same three updates applied to in-flight onboarding_steps by name)

-- ── 2. Milestones (high-level events for updates page + weekly email) ──
alter table onboarding_template_steps add column if not exists milestone boolean not null default false;
alter table onboarding_steps add column if not exists milestone boolean not null default false;
-- milestone=true on: LoE signed, ID received, CH auth code, quote accepted,
-- personal/company UTR, agent codes (SA/CT/CIS), VAT number, PAYE ref,
-- QB licence, Brightpay setup, live billing, billing tracker.
-- (see migration for the exact name list; propagated to live steps via
--  template_step_id)

-- ── 3. Updates feed ──────────────────────────────────────────
create or replace view v_onboarding_updates with (security_invoker = true) as
  select o.id as onboarding_id, e.id as entity_id, e.name as entity_name,
         'milestone'::text as kind, s.name as title, s.completed_at as happened_at
    from onboarding_steps s
    join onboardings o on o.id = s.onboarding_id
    join entities e on e.id = o.entity_id
   where s.milestone and s.status = 'complete' and s.completed_at is not null
  union all
  select r.onboarding_id, e.id, e.name, 'service_request',
         'Client requested a new service: ' || coalesce(r.service_title, r.service_id), r.created_at
    from portal_service_requests r
    join entities e on e.id = r.entity_id
  union all
  select o.id, e.id, e.name, 'started', 'Onboarding started', o.created_at
    from onboardings o join entities e on e.id = o.entity_id
   where o.status <> 'cancelled'
  union all
  select o.id, e.id, e.name, 'completed', 'Onboarding complete 🎉', o.completed_at
    from onboardings o join entities e on e.id = o.entity_id
   where o.completed_at is not null;

-- ── 4. Sophie's unified admin task list ──────────────────────
create table if not exists admin_tasks (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null default 'manual' check (kind in ('bm_code','manual')),
  entity_id     uuid references entities(id) on delete cascade,
  onboarding_id uuid references onboardings(id) on delete set null,
  field         text check (field is null or field in ('ch_auth_code','utr','vat_number','paye_ref')),
  value         text,
  title         text not null,
  detail        text,
  source        text,
  created_by    uuid references staff_profiles(id),
  created_at    timestamptz not null default now(),
  done_at       timestamptz,   -- Sophie's tick: "entered in BM, awaiting upload confirmation"
  confirmed_at  timestamptz,   -- verified by BM data on the entity → drops off the list
  dismissed_at  timestamptz
);
comment on table admin_tasks is 'Single admin to-do list (Sophie): data captured in Athena that must be entered in BrightManager, plus manual actions. bm_code tasks auto-confirm when a BM upload lands the value on the entity.';
create index if not exists idx_admin_tasks_open on admin_tasks(created_at) where confirmed_at is null and dismissed_at is null;
alter table admin_tasks enable row level security;
drop policy if exists admin_tasks_staff on admin_tasks;
create policy admin_tasks_staff on admin_tasks for all using (is_active_staff()) with check (is_active_staff());

-- Trigger admin_task_from_extract() on onboarding_documents (extract_status →
-- 'done'): maps doc_type → entity field (hmrc_utr_letter→utr, hmrc_vat_letter→
-- vat_number, hmrc_paye_letter→paye_ref, companies_house_letter→ch_auth_code
-- via a fields[] label ~* 'auth'; hmrc_agent_code_letter→field-less task),
-- dedupes against open tasks, skips values BM already holds. See migration
-- onboarding_milestones_admin_tasks_v1 for the full body.

-- admin_tasks_confirm_from_bm(): confirms open bm_code tasks whose entity
-- field now matches the captured value (normalised alphanumeric compare;
-- value-less tasks confirm when the field is populated at all). Called on
-- Admin Task List page load AND after every BM client import
-- (src/modules/data-import/lib/writers/bmClients.js).

-- ── 5. Weekly team emails (Monday morning) ───────────────────
alter table onboarding_chase_config add column if not exists weekly_enabled boolean not null default true;
-- run_onboarding_weekly(): self-gating pg_net wrapper → onboarding-weekly
-- edge fn (updates email to all active staff + issues email when non-empty).
-- Scheduled LIVE: cron.schedule('onboarding-weekly', '0 9 * * 1', ...)
-- (09:00 UTC Monday = 10:00 UK in summer, 09:00 in winter).
