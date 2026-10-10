-- 373_email_template_library.sql
--
-- The email template library: one modal (Templates, in Communications and on
-- the client record) holding every client email template, in groups.
--
-- comm_templates becomes the library's store rather than a new table, so a
-- template the automations already send (Workflows, Client Tax Reminders,
-- Onboarding, Debt chasing) is edited in exactly one place: the library row
-- IS the row the automation reads. library_group / label / sort place a row
-- in the library; a row without library_group (the SA opt-in email, which
-- needs tokened links, and the onboarding signature block) stays out.
--
-- New, library-only templates use comm_type 'library'. Their wording is the
-- reviewed copy in "Email template library — proposed wording" (2026-10-10).
-- Existing automation templates keep their live wording: changing what an
-- automation sends is decided template by template.
--
-- The Companies House ID-verification emails stay in ch_code_email_templates,
-- which the CH Codes queue reads; the library reads and writes them there.
--
-- Writes: comm_templates is already editable by active staff (sql/173), and
-- the library edits it on that same path. No new grant.

alter table public.comm_templates add column if not exists library_group text;
alter table public.comm_templates add column if not exists label text;
alter table public.comm_templates add column if not exists sort integer not null default 100;
alter table public.comm_templates add column if not exists description text;

-- kind was a closed list so a typo could not orphan an automation. Library
-- templates are added from the modal, so the list becomes a format rule; the
-- automations look their kinds up by name and fail loudly if one is missing.
alter table public.comm_templates drop constraint if exists comm_templates_kind_check;
alter table public.comm_templates add constraint comm_templates_kind_check
  check (kind ~ '^[a-z0-9_]{2,60}$');

alter table public.comm_templates drop constraint if exists comm_templates_library_group_check;
alter table public.comm_templates add constraint comm_templates_library_group_check
  check (library_group is null or library_group = any (array[
    'onboarding','tax_payments','records_year_end','triage','billing_update',
    'financial_overview','companies_house','payroll','general','debt_chasing']));

insert into public.comm_types (id, label, description, active)
values ('library', 'Template library', 'Templates sent by hand from the Templates modal.', true)
on conflict (id) do nothing;

-- ── Existing templates join the library (wording untouched) ─────────────
update public.comm_templates t set library_group = v.g, label = v.l, sort = v.s, description = v.d
from (values
  ('onboarding',    'ob_request',       'onboarding',         'What we need from you',             20, 'Also sent from Onboarding.'),
  ('onboarding',    'ob_follow_up',     'onboarding',         'Follow-up',                         30, 'Also sent from Onboarding.'),
  ('onboarding',    'ob_final_chase',   'onboarding',         'Final chase',                       40, 'Also sent from Onboarding.'),
  ('tax_reminders', 'reminder',         'tax_payments',       'Self Assessment: amount and how to pay', 10, 'Also sent from Client Tax Reminders, to clients who opted in.'),
  ('tax_reminders', 'no_utr',           'tax_payments',       'Self Assessment: not yet registered', 20, 'Also sent from Client Tax Reminders.'),
  ('job_plan',      'records_request',  'records_year_end',   'Year-end records request',          10, 'Also sent from Workflows. Workflows sends plain text.'),
  ('job_plan',      'gap_request',      'records_year_end',   'What''s left to finish the accounts', 20, 'Also sent from Workflows. Workflows sends plain text.'),
  ('job_plan',      'records_chase',    'records_year_end',   'Records reminder',                  30, 'Also sent from Workflows. Workflows sends plain text.'),
  ('job_plan',      'approval_chase',   'records_year_end',   'Accounts ready to approve',         40, 'Also sent from Workflows. Workflows sends plain text.'),
  ('job_plan',      'meeting_proposal', 'financial_overview', 'Review meeting offer',              30, 'Also sent from Workflows. Workflows sends plain text.'),
  ('job_plan',      'meeting_invite',   'financial_overview', 'Annual review meeting',             40, 'Also sent from Workflows. Workflows sends plain text.'),
  ('debt_chase',    'dc_a1',  'debt_chasing', 'Gentle, stage 1: reminder',        10, 'Sent from Fee Engine → Debt chasing.'),
  ('debt_chase',    'dc_a2',  'debt_chasing', 'Gentle, stage 2: follow-up',       20, 'Sent from Fee Engine → Debt chasing.'),
  ('debt_chase',    'dc_a3',  'debt_chasing', 'Gentle, stage 3: firm but fair',   30, 'Sent from Fee Engine → Debt chasing.'),
  ('debt_chase',    'dc_a4',  'debt_chasing', 'Gentle, stage 4: work paused',     40, 'Sent from Fee Engine → Debt chasing.'),
  ('debt_chase',    'dc_b1',  'debt_chasing', 'Factual, stage 1: notice',         50, 'Sent from Fee Engine → Debt chasing.'),
  ('debt_chase',    'dc_b2',  'debt_chasing', 'Factual, stage 2: second notice',  60, 'Sent from Fee Engine → Debt chasing.'),
  ('debt_chase',    'dc_b3',  'debt_chasing', 'Factual, stage 3: services on hold', 70, 'Sent from Fee Engine → Debt chasing.'),
  ('debt_chase',    'dc_b4',  'debt_chasing', 'Factual, stage 4: final notice',   80, 'Sent from Fee Engine → Debt chasing.'),
  ('debt_chase',    'dc_esc', 'debt_chasing', 'Escalation from the Manager',      90, 'Sent from Fee Engine → Debt chasing.')
) as v(ct, k, g, l, s, d)
where t.comm_type = v.ct and t.kind = v.k;

-- ── New library templates ────────────────────────────────────────────────
insert into public.comm_templates (comm_type, kind, library_group, label, sort, description, subject, body_html, body_text) values
-- Onboarding
('library','lib_welcome','onboarding','Welcome',10,null,
 'Welcome to Almond Valley: what we need to set up {{client_name}}',
 '<p>Hi {{first_name}},</p><p>Thank you for choosing us for {{client_name}}. Your client portal shows where your setup is up to and what we still need from you.</p><p>Open your portal: {{portal_url}}<br>Sign in with this email address. We''ll email you a link, so there''s no password.</p><p>To start, we need these by {{due_by}}:</p>{{items}}<p>We''ll then register you with HMRC and set up our authority to act for you. The portal shows each step as we finish it.</p><p>Kind regards,</p>',''),
('library','lib_setup_paused','onboarding','Setup paused',50,null,
 '{{client_name}}: setup paused',
 '<p>Hi {{first_name}},</p><p>We''ve emailed you {{chase_count}} times about setting up {{client_name}} without a reply, so we''ve stopped the reminders.</p><p>When you''re ready, reply or sign in to your portal ({{portal_url}}) and we''ll carry on from where we stopped. Nothing you''ve already sent is lost.</p><p>Kind regards,</p>',''),
('library','lib_portal_invite','onboarding','Portal invitation',60,null,
 'Your Almond Valley client portal',
 '<p>Hi {{first_name}},</p><p>Your client portal for {{client_name}} is ready. It shows where your work is up to, what we need from you, and your figures once we''ve released them.</p><p>Open it here: {{portal_url}}<br>Sign in with this email address. We''ll email you a link each time, so there''s no password.</p><p>Kind regards,</p>',''),
('library','lib_checkin','onboarding','Three-month check-in',70,null,
 '{{client_name}}: anything you''d like us to change?',
 '<p>Hi {{first_name}},</p><p>{{client_name}} has been with us for three months. Is there anything you''d like us to do differently?</p><p>For example, how often we''re in touch, how we ask for records, or anything in the portal that isn''t clear. Reply to this email; one line is enough.</p><p>Kind regards,</p>',''),
-- Tax payments
('library','lib_ct_due','tax_payments','Corporation Tax due',30,'The CT payment reference is typed from the payslip until the HMRC scrape collects it.',
 '{{client_name}}: Corporation Tax due {{due_date}}',
 '<p>Hi {{first_name}},</p><p>The Corporation Tax for {{client_name}} for the year to {{period_end}} is £{{amount}}, due by {{due_date}}.</p><p>To pay by bank transfer:<br>Account name: HMRC Cumbernauld<br>Sort code: 08 32 10<br>Account number: 12001039<br>Payment reference: {{ct_payment_ref}}</p><p>Please use this reference exactly, so HMRC puts the payment against the right year. Interest runs from the day after the due date.</p><p>If you''ve already paid, please ignore this.</p><p>Kind regards,</p>',''),
('library','lib_vat_due','tax_payments','VAT payment due',40,null,
 '{{client_name}}: VAT return for {{vat_period}}, £{{amount}} to pay',
 '<p>Hi {{first_name}},</p><p>We submitted the VAT return for {{vat_period}} on {{submitted_date}}. The amount to pay is £{{amount}}, and it needs to reach HMRC by {{due_date}}.</p><p>If you pay by Direct Debit, HMRC will collect it automatically a few days after the due date and you don''t need to do anything.</p><p>Otherwise, to pay by bank transfer:<br>Account name: HMRC VAT<br>Sort code: 08 32 00<br>Account number: 11963155<br>Payment reference: {{vat_number}}</p><p>Kind regards,</p>',''),
('library','lib_paye_due','tax_payments','PAYE payment due',50,'The PAYE reference is the Accounts Office reference plus the tax year and month, e.g. …2607.',
 '{{client_name}}: PAYE payment for {{tax_month_label}}',
 '<p>Hi {{first_name}},</p><p>The PAYE and National Insurance for {{tax_month_label}} is £{{amount}}, due to HMRC by {{due_date}}.</p><p>To pay by bank transfer:<br>Account name: HMRC Cumbernauld<br>Sort code: 08 32 10<br>Account number: 12001039<br>Payment reference: {{paye_payment_ref}}</p><p>Please use this reference exactly: it tells HMRC which month the payment is for. If you''ve already paid, please ignore this.</p><p>Kind regards,</p>',''),
-- Records & year end
('library','lib_records_received','records_year_end','Records received',50,null,
 '{{client_name}}: thanks, we have your records',
 '<p>Hi {{first_name}},</p><p>We have your records for the year to {{year_end}}. We''ll send you draft accounts by {{target_date}}.</p><p>You don''t need to do anything until then, unless we ask for something.</p><p>Kind regards,</p>',''),
('library','lib_accounts_filed','records_year_end','Accounts filed',60,'Leave tax_line blank, or say what tax is due and when.',
 '{{client_name}}: accounts filed',
 '<p>Hi {{first_name}},</p><p>The accounts for {{client_name}} for the year to {{year_end}} were filed at Companies House on {{filed_date}}. A copy is in your portal.</p><p>{{tax_line}}</p><p>Kind regards,</p>',''),
-- Triage
('library','lib_triage_received','triage','Received, with a reply date',10,null,
 'Re: {{topic}}',
 '<p>Hi {{first_name}},</p><p>We''ve received this and will reply by {{reply_by}}.</p><p>If it''s urgent in the meantime, call us on 0141 471 4255.</p><p>Kind regards,</p>',''),
('library','lib_triage_need_more','triage','What we need from you',20,null,
 'Re: {{topic}}: what we need from you',
 '<p>Hi {{first_name}},</p><p>Before we can deal with this, we need:</p>{{questions}}<p>Reply to this email or upload them to your portal.</p><p>Kind regards,</p>',''),
('library','lib_triage_done','triage','Done',30,null,
 'Re: {{topic}}: done',
 '<p>Hi {{first_name}},</p><p>We''ve dealt with this. {{outcome}}</p><p>You don''t need to do anything. If anything else arrives about it, forward it to us.</p><p>Kind regards,</p>',''),
('library','lib_triage_call','triage','Needs a call',40,'call_reason finishes the sentence, e.g. "HMRC''s letter asks about two years and the answer depends on which one".',
 'Re: {{topic}}: 15-minute call needed',
 '<p>Hi {{first_name}},</p><p>We need a 15-minute call about this, because {{call_reason}}. Please reply with two or three times that suit you before {{call_by}}.</p><p>Kind regards,</p>',''),
-- Billing update
('library','lib_statement','billing_update','Statement of account',10,'Attach the PDF statement from the client dashboard before sending.',
 '{{client_name}}: statement of account at {{statement_date}}',
 '<p>Hi {{first_name}},</p><p>Please find attached your statement of account at {{statement_date}}. It shows a balance of £{{balance}}, of which £{{overdue}} is overdue.</p><p>If it doesn''t match your records, reply with the difference and we''ll check it.</p><p>Kind regards,</p>',''),
-- Financial overview
('library','lib_figures_updated','financial_overview','Your figures have been updated',10,null,
 '{{client_name}}: your figures have been updated',
 '<p>Hi {{first_name}},</p><p>We''ve updated the figures for {{client_name}} in your portal, now covering up to {{released_to}}.</p><p>See them here: {{portal_url}}</p><p>{{highlight}}</p><p>Kind regards,</p>',''),
('library','lib_management_accounts','financial_overview','Management accounts ready',20,null,
 '{{client_name}}: management accounts to {{period_end}}',
 '<p>Hi {{first_name}},</p><p>Your management accounts to {{period_end}} are ready and in your portal: {{portal_url}}</p><p>The main points:</p>{{key_points}}<p>If you''d like to go through them, reply with a time that suits.</p><p>Kind regards,</p>',''),
-- Companies House (the ID-verification five live in ch_code_email_templates)
('library','lib_cs_due','companies_house','Confirmation statement due',60,null,
 '{{client_name}}: confirmation statement due {{cs_due_date}}',
 '<p>Hi {{first_name}},</p><p>{{client_name}}''s confirmation statement is due at Companies House by {{cs_due_date}}. Please tell us by {{confirm_by}} if any of these have changed since last year:</p><ul><li>directors or their addresses</li><li>shareholders or shareholdings</li><li>people with significant control</li><li>the registered office address or the nature of the business</li></ul><p>If nothing has changed, reply "no changes" and we''ll file it. Companies House''s filing fee of £{{ch_fee}} is added to your next invoice at cost.</p><p>Kind regards,</p>',''),
-- Payroll
('library','lib_payroll_changes','payroll','Payroll details for this period',10,null,
 '{{client_name}}: payroll for {{pay_period}}',
 '<p>Hi {{first_name}},</p><p>Please send any changes for the {{pay_period}} payroll by {{cutoff_date}}:</p><ul><li>new starters (with their P45 or starter checklist)</li><li>leavers and their last working day</li><li>hours, overtime, bonuses or commission</li><li>sickness, holiday or family leave</li></ul><p>If there are none, reply "no changes".</p><p>Kind regards,</p>',''),
('library','lib_payroll_done','payroll','Payroll done',20,null,
 '{{client_name}}: payroll for {{pay_period}} is done',
 '<p>Hi {{first_name}},</p><p>We''ve run the {{pay_period}} payroll and sent the payslips. The total to pay your staff is £{{net_pay_total}}.</p><p>The PAYE and National Insurance of £{{paye_amount}} is due to HMRC by {{paye_due_date}}, using reference {{paye_payment_ref}}. Pension contributions of £{{pension_amount}} will be collected by {{pension_provider}}.</p><p>Kind regards,</p>',''),
('library','lib_payroll_year_end','payroll','Year-end payroll: P60s and P11Ds',30,null,
 '{{client_name}}: payroll year end {{tax_year}}',
 '<p>Hi {{first_name}},</p><p>We''ve closed the {{tax_year}} payroll year and sent your staff their P60s.</p><p>If you gave any employees or directors benefits during the year (a company car, private medical cover, loans or similar), we need the details by {{p11d_info_due}} to prepare the P11Ds. If there were none, reply "none".</p><p>Kind regards,</p>',''),
('library','lib_new_starter','payroll','New starter details',40,null,
 '{{client_name}}: details for {{employee_name}}',
 '<p>Hi {{first_name}},</p><p>To add {{employee_name}} to the payroll from {{start_date}}, we need these by {{cutoff_date}}:</p><ul><li>full name, date of birth and home address</li><li>National Insurance number</li><li>their P45 from their last job, or a completed HMRC starter checklist if they don''t have one</li><li>pay rate and hours, or annual salary</li><li>bank details for their wages</li></ul><p>The starter checklist is here: {{starter_checklist_url}}</p><p>Kind regards,</p>',''),
('library','lib_leaver','payroll','Leaver and P45',50,null,
 '{{client_name}}: {{employee_name}} leaving',
 '<p>Hi {{first_name}},</p><p>{{employee_name}} leaves on {{leave_date}}. Please tell us by {{cutoff_date}} about any final pay due, such as holiday owed, notice pay or a bonus.</p><p>We''ll process them as a leaver in that payroll and send their P45 to you to pass on.</p><p>Kind regards,</p>',''),
('library','lib_pension_reenrolment','payroll','Pension re-enrolment due',60,null,
 '{{client_name}}: pension re-enrolment due {{reenrolment_date}}',
 '<p>Hi {{first_name}},</p><p>Every three years, employers must re-enrol eligible staff who have opted out of the workplace pension and tell The Pensions Regulator they have done so. {{client_name}}''s re-enrolment date is {{reenrolment_date}}.</p><p>We''ll assess your staff in the payroll for that month and write to anyone re-enrolled. The re-declaration must be filed within five months; we can file it for you, or you can do it yourself. Please reply to say which you''d prefer.</p><p>Kind regards,</p>',''),
-- General
('library','lib_thanks_received','general','Thanks, received',10,null,
 'Re: {{topic}}',
 '<p>Hi {{first_name}},</p><p>We''ve received this and saved it to your file.</p><p>Kind regards,</p>',''),
('library','lib_professional_clearance','general','Professional clearance request',20,'Goes to the previous accountant, not the client: change the To address.',
 'Professional clearance: {{client_name}}',
 '<p>Dear {{previous_accountant_name}},</p><p>We''ve been asked to act for {{client_name}} (UTR {{utr}}) from {{start_date}}, and we ask for professional clearance.</p><p>Please let us know of any reason we shouldn''t accept the appointment. It would also help to have copies of the last set of accounts and tax returns, working papers and any outstanding correspondence with HMRC.</p><p>The client''s signed authority is attached.</p><p>Kind regards,</p>','')
on conflict (comm_type, kind) do nothing;

create index if not exists comm_templates_library on public.comm_templates (library_group, sort) where library_group is not null;
