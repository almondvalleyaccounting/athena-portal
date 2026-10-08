-- Onboarding emails: a named contact, a default signature, no portal.
--
-- 1. The onboarding contact. Who onboarding emails go to and who they greet
--    ("Hi Marc,"). Nothing stored means the default: the client's main
--    director (or the sole trader / primary contact), resolved by the
--    onboarding-actions edge function each time. Saving the card on the
--    onboarding stores it here and the default stops applying.
-- 2. The signature. One practice-wide plain-text signature appended to every
--    onboarding email, below the sign-off. Edited with the templates.
-- 3. The templates stop mentioning the client portal — it isn't in use yet —
--    and greet by first name.

alter table public.onboardings
  add column if not exists contact_person_id uuid references public.people(id) on delete set null,
  add column if not exists contact_name text,
  add column if not exists contact_first_name text,
  add column if not exists contact_email text,
  add column if not exists contact_phone text,
  add column if not exists contact_set_by uuid references public.staff_profiles(id),
  add column if not exists contact_set_at timestamptz;

alter table public.comm_templates
  drop constraint if exists comm_templates_kind_check;
alter table public.comm_templates
  add constraint comm_templates_kind_check
  check (kind = any (array[
    'promo', 'reminder', 'no_utr', 'records_request', 'gap_request', 'records_chase',
    'meeting_invite', 'approval_chase', 'meeting_proposal',
    'ob_request', 'ob_follow_up', 'ob_final_chase', 'ob_signature'
  ]));

insert into public.comm_templates (comm_type, kind, subject, body_text, body_html)
values ('onboarding', 'ob_signature', '',
 E'{{sender_name}}\nAlmond Valley Accounting\n14 Ellismuir House, Ellismuir Way, Tannochside, G71 5PW\n0141 471 4255 · {{from_email}}',
 '')
on conflict (comm_type, kind) do nothing;

update public.comm_templates set
  body_text = E'Hi {{first_name}},\n\n{{opener}}To finish getting {{client_name}} set up with us, we just need the following from you:\n\n{{items}}\n\nYou can simply reply to this email with them. If anything is unclear, just let me know and I''ll talk you through it.\n\nKind regards,',
  updated_at = now()
where comm_type = 'onboarding' and kind = 'ob_request';

update public.comm_templates set
  body_text = E'Hi {{first_name}},\n\n{{opener}}Just following up on getting {{client_name}} set up. We''re still waiting on:\n\n{{items}}\n\nIf it''s easier, reply with whatever you have and we''ll pick up the rest from there.\n\nKind regards,',
  updated_at = now()
where comm_type = 'onboarding' and kind = 'ob_follow_up';

update public.comm_templates set
  body_text = E'Hi {{first_name}},\n\n{{opener}}We''ve not been able to finish setting up {{client_name}} because we''re still missing:\n\n{{items}}\n\nWithout these we can''t act for you with HMRC, so deadlines could be missed. Could you send them over this week, or give me a call if anything is holding you up?\n\nKind regards,',
  updated_at = now()
where comm_type = 'onboarding' and kind = 'ob_final_chase';
