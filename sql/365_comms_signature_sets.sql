-- ============================================================
-- 365 — Email signatures: named, HTML, chosen per mailbox and per action
--
-- Bobby (2026-10-09): pick where a signature is used — new email, reply,
-- forward — with different signatures for different mailboxes and actions,
-- and keep the format of his existing Gmail signature (HTML: layout, logo,
-- links), which the old one-plain-text-box-per-mailbox comms_signatures
-- (sql/150-ish, never used — 0 rows) couldn't hold.
--
--   comms_signature_templates  my named signatures (HTML)
--   comms_signature_use        (mailbox or '*', action) → which one, or none
--
-- The composer picks: exact mailbox + action, else '*' + action, else none.
-- Writes go through the comms-gmail edge function (CLAUDE.md: a new mutating
-- path is an edge function); the browser reads its own rows.
-- ============================================================

create table if not exists public.comms_signature_templates (
  id         uuid primary key default gen_random_uuid(),
  staff_id   uuid not null references public.staff_profiles(id) on delete cascade,
  name       text not null,
  body_html  text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint comms_signature_templates_size check (length(body_html) <= 100000)
);
create index if not exists comms_signature_templates_staff_idx on public.comms_signature_templates (staff_id);

create table if not exists public.comms_signature_use (
  staff_id      uuid not null references public.staff_profiles(id) on delete cascade,
  mailbox_email text not null default '*',     -- lower(address), or '*' = all my mailboxes
  action        text not null check (action in ('new', 'reply', 'forward')),
  signature_id  uuid references public.comms_signature_templates(id) on delete cascade,  -- null = no signature
  updated_at    timestamptz not null default now(),
  primary key (staff_id, mailbox_email, action)
);

alter table public.comms_signature_templates enable row level security;
alter table public.comms_signature_use enable row level security;
revoke all on public.comms_signature_templates from public, anon, authenticated;
revoke all on public.comms_signature_use from public, anon, authenticated;
grant select on public.comms_signature_templates to authenticated;
grant select on public.comms_signature_use to authenticated;
grant select, insert, update, delete on public.comms_signature_templates to service_role;
grant select, insert, update, delete on public.comms_signature_use to service_role;

drop policy if exists "Staff read own signatures" on public.comms_signature_templates;
create policy "Staff read own signatures" on public.comms_signature_templates
  for select to authenticated using (staff_id = auth.uid() and is_active_staff());
drop policy if exists "Staff read own signature use" on public.comms_signature_use;
create policy "Staff read own signature use" on public.comms_signature_use
  for select to authenticated using (staff_id = auth.uid() and is_active_staff());

comment on table public.comms_signature_templates is
  'Named HTML email signatures, per staff member. Written via comms-gmail (sig_save / sig_delete).';
comment on table public.comms_signature_use is
  'Which signature a staff member uses per mailbox (or * for all) and action (new / reply / forward); null = none. Written via comms-gmail (sig_use).';
