-- 371_debt_chasing.sql
--
-- Debt chasing moves into the fee engine (/manage/billing/debt), replacing the
-- stand-alone DCM app. Four things:
--
--   1. A client grade Athena can set. entities.grade already exists, but the
--      BrightManager importer rewrites it on every run (import_bm_clients sets
--      grade = EXCLUDED.grade), so an edit made in Athena would last until the
--      next import. grade_override holds Athena's answer and a trigger makes
--      it win on every write, present and future, the importer included. Clear
--      the override and the next import puts BM's grade back.
--
--   2. debt_chases: one row per chaser sent. The stage engine in the
--      debt-chase edge function reads it to decide the next stage, exactly as
--      DCM read its Google Sheet tracker.
--
--   3. debt_chase_pauses: a client on an agreed payment plan, or in dispute,
--      is left out of the queue until a date.
--
--   4. The nine DCM templates, as comm_templates rows (comm_type debt_chase),
--      so they are edited where every other client template is edited.
--
-- Writes go through the debt-chase edge function only. The browser can read
-- the log and the pauses (gated), never write them.

-- ── Who may chase ─────────────────────────────────────────────────────────
-- Invoice balances are fee data, so the fee admins and the billing approvers.
create or replace function public.can_chase_debt()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff_profiles s
    where s.id = auth.uid()
      and s.is_active
      and (s.can_view_client_fees or s.can_approve_billing or s.is_portal_admin)
  );
$$;
revoke execute on function public.can_chase_debt() from public, anon;
grant execute on function public.can_chase_debt() to authenticated, service_role;

-- ── 1. Grade override ─────────────────────────────────────────────────────
alter table public.entities add column if not exists grade_override text;
alter table public.entities drop constraint if exists entities_grade_override_check;
alter table public.entities add constraint entities_grade_override_check
  check (grade_override is null or grade_override = any (array['A+','A','B','C','D','E','F']));

create or replace function public.entities_apply_grade_override()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.grade_override is not null then
    new.grade := new.grade_override;
  end if;
  return new;
end;
$$;
revoke execute on function public.entities_apply_grade_override() from public, anon, authenticated;

drop trigger if exists trg_entities_grade_override on public.entities;
create trigger trg_entities_grade_override
  before insert or update on public.entities
  for each row execute function public.entities_apply_grade_override();

-- ── 2. The chase log ──────────────────────────────────────────────────────
create table if not exists public.debt_chases (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null references public.entities(id) on delete cascade,
  qbo_customer_id  text,
  stage            smallint not null check (stage between 1 and 5),
  tone             text not null check (tone in ('A','B','ESC')),
  template_kind    text not null,
  invoice_numbers  text[] not null default '{}',
  invoice_count    integer not null default 0,
  amount           numeric(12,2) not null default 0,
  to_email         text not null,
  from_mailbox     text not null,
  subject          text not null,
  body_html        text,
  stage_reason     text,
  -- sent → the client's next step decides; contact/responded reset the next
  -- chase to stage 1, as DCM's tracker did.
  status           text not null default 'sent' check (status in ('sent','contact','responded')),
  status_note      text,
  status_set_by    uuid references public.staff_profiles(id),
  status_set_at    timestamptz,
  gmail_message_id text,
  gmail_thread_id  text,
  sent_by          uuid references public.staff_profiles(id),
  sent_at          timestamptz not null default now()
);
create index if not exists debt_chases_entity_sent on public.debt_chases (entity_id, sent_at desc);

alter table public.debt_chases enable row level security;
drop policy if exists debt_chases_read on public.debt_chases;
create policy debt_chases_read on public.debt_chases
  for select to authenticated using (public.can_chase_debt());
revoke all on public.debt_chases from anon, authenticated;
grant select on public.debt_chases to authenticated;
grant all on public.debt_chases to service_role;

-- ── 3. Pauses ─────────────────────────────────────────────────────────────
create table if not exists public.debt_chase_pauses (
  entity_id   uuid primary key references public.entities(id) on delete cascade,
  until_date  date not null,
  reason      text not null,
  set_by      uuid references public.staff_profiles(id),
  set_at      timestamptz not null default now()
);
alter table public.debt_chase_pauses enable row level security;
drop policy if exists debt_chase_pauses_read on public.debt_chase_pauses;
create policy debt_chase_pauses_read on public.debt_chase_pauses
  for select to authenticated using (public.can_chase_debt());
revoke all on public.debt_chase_pauses from anon, authenticated;
grant select on public.debt_chase_pauses to authenticated;
grant all on public.debt_chase_pauses to service_role;

-- ── 4. Templates ──────────────────────────────────────────────────────────
insert into public.comm_types (id, label, description, active)
values ('debt_chase', 'Debt chasing', 'Overdue invoice chasers: two tones, four stages, then an escalation from the Manager.', true)
on conflict (id) do nothing;

alter table public.comm_templates drop constraint if exists comm_templates_kind_check;
alter table public.comm_templates add constraint comm_templates_kind_check
  check (kind = any (array[
    'promo','reminder','no_utr','records_request','gap_request','records_chase',
    'meeting_invite','approval_chase','meeting_proposal','ob_request','ob_follow_up',
    'ob_final_chase','ob_signature',
    'dc_a1','dc_a2','dc_a3','dc_a4','dc_b1','dc_b2','dc_b3','dc_b4','dc_esc'
  ]));

-- Placeholders: {{first_name}} {{client_name}} {{invoice_table}} {{pay_by}}
-- {{last_chase_date}} {{chase_count}} {{final_date}}. {{invoice_table}} is
-- built HTML; every other value is escaped. The sender's signature follows
-- "Kind regards," / "Regards," automatically.
insert into public.comm_templates (comm_type, kind, subject, body_html, body_text) values
('debt_chase', 'dc_a1', '{{client_name}}: overdue invoices',
 '<p>Hi {{first_name}},</p><p>These invoices on your account are overdue:</p>{{invoice_table}}<p>Please pay by {{pay_by}}. If you''ve already paid, tell us the date and we''ll check our side.</p><p>We can also set up a Direct Debit for this balance and future invoices, if that would be easier. Reply and we''ll arrange it.</p><p>Kind regards,</p>', ''),
('debt_chase', 'dc_a2', '{{client_name}}: overdue invoices, second reminder',
 '<p>Hi {{first_name}},</p><p>We wrote on {{last_chase_date}} about the overdue balance on your account. It''s still outstanding:</p>{{invoice_table}}<p>If something is stopping payment, or you''d rather pay in instalments, reply and we''ll agree a plan with you. We can also set up a Direct Debit for this balance and future invoices.</p><p>Kind regards,</p>', ''),
('debt_chase', 'dc_a3', '{{client_name}}: overdue invoices, third reminder',
 '<p>Hi {{first_name}},</p><p>We''ve written {{chase_count}} times about the overdue balance below and haven''t heard back:</p>{{invoice_table}}<p>We can agree a payment plan, but we need to hear from you by {{pay_by}} to avoid putting your services on hold.</p><p>Kind regards,</p>', ''),
('debt_chase', 'dc_a4', '{{client_name}}: overdue balance, work paused',
 '<p>Dear {{first_name}},</p><p>We''ve been in touch {{chase_count}} times about the balance below and haven''t had a reply:</p>{{invoice_table}}<p>We want to keep working with you, but we need to be paid for the work we''ve done. Until we hear from you, we have paused any further work for {{client_name}}. A short reply is enough to start putting it right.</p><p>Kind regards,</p>', ''),
('debt_chase', 'dc_b1', '{{client_name}}: overdue invoices',
 '<p>Hi {{first_name}},</p><p>Our records show these invoices on your account are overdue:</p>{{invoice_table}}<p>Please pay by {{pay_by}}. If you''ve already paid, tell us the date and we''ll check.</p><p>We also ask that you set up a Direct Debit for future invoices, so they''re paid on time. Reply and we''ll set it up.</p><p>Kind regards,</p>', ''),
('debt_chase', 'dc_b2', '{{client_name}}: overdue invoices, second notice',
 '<p>Hi {{first_name}},</p><p>This balance is still outstanding after our email of {{last_chase_date}}:</p>{{invoice_table}}<p>We need it paid by {{pay_by}} to keep providing services. If you''re having difficulty paying, contact us now to agree an arrangement.</p><p>We also require a Direct Debit for future invoices, and will set it up with you.</p><p>Regards,</p>', ''),
('debt_chase', 'dc_b3', '{{client_name}}: services on hold, overdue balance',
 '<p>Dear {{first_name}},</p><p>Despite our reminders, this balance is still unpaid:</p>{{invoice_table}}<p>We have put your services on hold until it is paid. Please contact us to arrange payment.</p><p>Once the balance is cleared, we will need a Direct Debit in place for future invoices.</p><p>Regards,</p>', ''),
('debt_chase', 'dc_b4', 'FINAL NOTICE: {{client_name}}, overdue balance',
 '<p>Dear {{first_name}},</p><p><strong>Final notice.</strong> We have written {{chase_count}} times about this overdue balance:</p>{{invoice_table}}<p>If the full amount is not paid by {{final_date}}, 7 days from this notice, we will refer the debt to our collection partner. You can still avoid this by contacting us before then to agree a way forward.</p><p>Regards,</p>', ''),
('debt_chase', 'dc_esc', '{{client_name}}: your account with us',
 '<p>Hi {{first_name}},</p><p>The team hasn''t been able to resolve the overdue balance on your account, so I''m getting in touch myself:</p>{{invoice_table}}<p>I''d like to understand what has happened and agree how to settle it, so we don''t have to put your services on hold. Please reply, or call me on 0141 471 4255.</p><p>Kind regards,</p>', '')
on conflict (comm_type, kind) do nothing;
