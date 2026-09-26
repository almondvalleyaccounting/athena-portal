-- ============================================================
-- 316 — Per-person email defaults for client comms
--
-- Bobby, 2026-09-26: the chaser is drafted first, then edited, then sent.
-- On the draft screen the sender chooses whether to include a friendly
-- opener (editable), which sign-off line to use, and whether to sign with
-- their name or their saved signature. Each team member's choices are
-- their defaults next time. The templates carry {{opener}} and {{signoff}}
-- slots instead of hard-coded text so the choice actually lands.
-- ============================================================

create table if not exists public.staff_comms_prefs (
  staff_id        uuid primary key references public.staff_profiles(id) on delete cascade,
  opener_enabled  boolean not null default true,
  opener_text     text not null default 'Hope you’re well.',
  signoff         text not null default 'Thanks' check (signoff in ('Kind regards','Best regards','Thanks','Cheers','Many thanks')),
  signature_mode  text not null default 'name' check (signature_mode in ('name','signature')),
  updated_at      timestamptz not null default now()
);
comment on table public.staff_comms_prefs is 'Per-person defaults for the client comms draft screen (sql/316). Written through job-plan set_comms_prefs.';

alter table public.staff_comms_prefs enable row level security;
drop policy if exists staff_comms_prefs_select_staff on public.staff_comms_prefs;
create policy staff_comms_prefs_select_staff on public.staff_comms_prefs
  for select to authenticated using (is_active_staff());
revoke all on public.staff_comms_prefs from public, anon;
revoke insert, update, delete, truncate, references, trigger on public.staff_comms_prefs from authenticated;
grant select on public.staff_comms_prefs to authenticated;
grant select, insert, update, delete on public.staff_comms_prefs to service_role;

-- Templates: the opener and the sign-off become slots.
update public.comm_templates set body_text = replace(body_text, E'Hi {{greeting}},\n\nHope you’re well. ', E'Hi {{greeting}},\n\n{{opener}}')
  where comm_type = 'job_plan' and kind = 'records_request';
update public.comm_templates set body_text = replace(body_text, E'Hi {{greeting}},\n\nHope all’s well. ', E'Hi {{greeting}},\n\n{{opener}}')
  where comm_type = 'job_plan' and kind = 'gap_request';
update public.comm_templates set body_text = replace(body_text, E'Hi {{greeting}},\n\n', E'Hi {{greeting}},\n\n{{opener}}')
  where comm_type = 'job_plan' and kind in ('records_chase','meeting_invite','approval_chase') and body_text not like '%{{opener}}%';
update public.comm_templates set body_text = replace(body_text, E'Thanks,\n{{sender_first_name}}', '{{signoff}}')
  where comm_type = 'job_plan' and body_text like E'%Thanks,\n{{sender_first_name}}%';
