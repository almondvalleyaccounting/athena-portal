-- ============================================================
-- 309 — Client comms on job-plan stages
--
-- The comms stages of a committed plan (request records, gap request,
-- chase, meeting invite, approval chase) can now be sent: by a person from
-- Today ("Preview & send"), or by the nightly tick when Client comms is
-- armed in Scheduled Jobs. Templates live in comm_templates like the tax
-- reminders, so the wording is edited in Athena. Every send is logged on the
-- client page through client_communications and leaves a Sent item, because
-- it goes through the Gmail connection.
-- ============================================================

alter table public.job_milestones
  add column if not exists comms_sent_at    timestamptz,
  add column if not exists comms_to         text,
  add column if not exists comms_message_id text,
  add column if not exists comms_thread_id  text,
  add column if not exists comms_sent_by    uuid references public.staff_profiles(id) on delete set null;

alter table public.job_plan_settings
  add column if not exists comms_armed   boolean not null default false,
  add column if not exists comms_from    text check (comms_from is null or comms_from ~ '^\d{4}-\d{2}-\d{2}$'),
  add column if not exists comms_mailbox text;

comment on column public.job_plan_settings.comms_armed is
  'When true (and past comms_from) the nightly tick sends the due comms stages itself. Off: staff send each from Today.';

insert into public.scheduled_job_settings
  (job_key, setting_key, label, help, value_type, target_table, target_column, id_kind, touch_updated_at, min_value, max_value, risk, risk_note, sort_order)
values
('job-plan-tick', 'comms_armed',
 'Send client comms automatically',
 'Records requests, gap requests, chases, meeting invites and approval chases go out on their stage date without anyone pressing Send. Off: each one waits on Today with a Preview & send button.',
 'boolean', 'job_plan_settings', 'comms_armed', 'bool_true', true, null, null,
 'client_facing', 'Arming this emails clients. Every send is logged on the client page and lands in the mailbox''s Sent folder.', 40),
('job-plan-tick', 'comms_from',
 'Start sending client comms from (YYYY-MM-DD)',
 'Even when armed, nothing goes to a client before this date. Blank means straight away.',
 'text', 'job_plan_settings', 'comms_from', 'bool_true', true, null, null,
 'internal', null, 45),
('job-plan-tick', 'comms_mailbox',
 'Mailbox client comms leave from',
 'A connected Gmail address. Blank = the practice default mailbox.',
 'text', 'job_plan_settings', 'comms_mailbox', 'bool_true', true, null, null,
 'internal', null, 50)
on conflict (job_key, setting_key) do update set
  label = excluded.label, help = excluded.help, risk = excluded.risk, risk_note = excluded.risk_note, sort_order = excluded.sort_order;

-- ── Templates ───────────────────────────────────────────────────────────────
-- comm_templates was built for the tax reminders: a comm type row and a
-- CHECK on kind. Add the job-plan type and widen the kinds.
insert into public.comm_types (id, label, description, active)
values ('job_plan', 'Job plan client comms',
        'Records requests, chases, meeting invites and approval chases sent from a committed accounts job plan.', true)
on conflict (id) do nothing;

alter table public.comm_templates drop constraint if exists comm_templates_kind_check;
alter table public.comm_templates add constraint comm_templates_kind_check
  check (kind in ('promo', 'reminder', 'no_utr',
                  'records_request', 'gap_request', 'records_chase', 'meeting_invite', 'approval_chase'));

-- Variables: {{greeting}} {{client_name}} {{year_end}} {{records_due}}
-- {{gap_list}} {{meeting_week}} {{sent_date}} {{filing_date}} {{sender_name}}
insert into public.comm_templates (comm_type, kind, subject, body_text, body_html)
select v.comm_type, v.kind, v.subject, v.body_text, v.body_html
from (values
  ('job_plan', 'records_request',
   'Year-end records for {{client_name}} — year to {{year_end}}',
   E'Hi {{greeting}},\n\nThe year to {{year_end}} has now closed, so it’s time to pull together the records for the annual accounts. Could you send us the following by {{records_due}}:\n\n• Bank and credit card statements covering the full year (and the first month after the year end)\n• Sales invoices and purchase invoices/receipts for the year, if they are not already in your bookkeeping software\n• Loan, HP or finance statements as at the year end, and any new agreements taken out\n• Payroll summaries if payroll is run elsewhere\n• Anything unusual you’d like us to know about\n\nIf you use the client portal, upload them there; otherwise reply to this email. If any of this is already with us, just say so.\n\nThanks,\n{{sender_name}}',
   E'<p>Hi {{greeting}},</p><p>The year to {{year_end}} has now closed, so it’s time to pull together the records for the annual accounts. Could you send us the following by <strong>{{records_due}}</strong>:</p><ul><li>Bank and credit card statements covering the full year (and the first month after the year end)</li><li>Sales invoices and purchase invoices/receipts for the year, if they are not already in your bookkeeping software</li><li>Loan, HP or finance statements as at the year end, and any new agreements taken out</li><li>Payroll summaries if payroll is run elsewhere</li><li>Anything unusual you’d like us to know about</li></ul><p>If you use the client portal, upload them there; otherwise reply to this email. If any of this is already with us, just say so.</p><p>Thanks,<br>{{sender_name}}</p>'),
  ('job_plan', 'gap_request',
   'Finishing the accounts for {{client_name}} — year to {{year_end}}',
   E'Hi {{greeting}},\n\nMost of the records for the year to {{year_end}} are already with us through the VAT returns, so we only need a few things to finish the annual accounts. Could you send these by {{records_due}}:\n\n{{gap_list}}\n\nIf you use the client portal, upload them there; otherwise reply to this email.\n\nThanks,\n{{sender_name}}',
   E'<p>Hi {{greeting}},</p><p>Most of the records for the year to {{year_end}} are already with us through the VAT returns, so we only need a few things to finish the annual accounts. Could you send these by <strong>{{records_due}}</strong>:</p><p>{{gap_list}}</p><p>If you use the client portal, upload them there; otherwise reply to this email.</p><p>Thanks,<br>{{sender_name}}</p>'),
  ('job_plan', 'records_chase',
   'Reminder: year-end records for {{client_name}}',
   E'Hi {{greeting}},\n\nA quick reminder that we’re still waiting on the year-end records for the year to {{year_end}}. We’d like them by {{records_due}} so the accounts can be prepared in good time before the filing deadline.\n\nIf they’re on their way, or something is holding them up, just let us know.\n\nThanks,\n{{sender_name}}',
   E'<p>Hi {{greeting}},</p><p>A quick reminder that we’re still waiting on the year-end records for the year to {{year_end}}. We’d like them by <strong>{{records_due}}</strong> so the accounts can be prepared in good time before the filing deadline.</p><p>If they’re on their way, or something is holding them up, just let us know.</p><p>Thanks,<br>{{sender_name}}</p>'),
  ('job_plan', 'meeting_invite',
   'Your annual review meeting — {{client_name}}',
   E'Hi {{greeting}},\n\nWe’d like to book your annual review meeting to go through the accounts for the year to {{year_end}} and look ahead. We have the week of {{meeting_week}} in mind.\n\nCould you reply with a day and time that suits you that week, or a couple of options? We can meet in person, by video or by phone, whichever you prefer.\n\nThanks,\n{{sender_name}}',
   E'<p>Hi {{greeting}},</p><p>We’d like to book your annual review meeting to go through the accounts for the year to {{year_end}} and look ahead. We have the week of <strong>{{meeting_week}}</strong> in mind.</p><p>Could you reply with a day and time that suits you that week, or a couple of options? We can meet in person, by video or by phone, whichever you prefer.</p><p>Thanks,<br>{{sender_name}}</p>'),
  ('job_plan', 'approval_chase',
   'Accounts awaiting your approval — {{client_name}}',
   E'Hi {{greeting}},\n\nThe accounts for the year to {{year_end}} were sent to you for approval on {{sent_date}}. When you’re happy with them, please approve and sign so we can file by {{filing_date}}.\n\nIf you have any questions on them, reply here or give us a call.\n\nThanks,\n{{sender_name}}',
   E'<p>Hi {{greeting}},</p><p>The accounts for the year to {{year_end}} were sent to you for approval on {{sent_date}}. When you’re happy with them, please approve and sign so we can file by <strong>{{filing_date}}</strong>.</p><p>If you have any questions on them, reply here or give us a call.</p><p>Thanks,<br>{{sender_name}}</p>')
) as v(comm_type, kind, subject, body_text, body_html)
where not exists (
  select 1 from public.comm_templates t where t.comm_type = v.comm_type and t.kind = v.kind
);
