-- ============================================================
-- 310 — Records picker, contact greeting, plain emails
--
-- Bobby, 2026-09-26: the client emails should read like a normal email from
-- the team member, not a system message — short, friendly, fairly generic —
-- with a picker so the sender can ask that client for specific things. And
-- what we asked a client for should be kept, so next year starts from it.
--
--   records_items         the catalogue the picker offers (company records,
--                         the director's personal tax pack, free text)
--   client_records_items  what each client has been asked for, and when
--
-- Templates are rewritten as plain text with an {{items}} slot and a
-- {{greeting}} that is the primary contact's preferred name.
-- ============================================================

create table if not exists public.records_items (
  key          text primary key,
  label        text not null,
  grp          text not null check (grp in ('company', 'personal', 'other')),
  default_full boolean not null default false,   -- ticked on a full request
  default_gap  boolean not null default false,   -- ticked on a gap request
  sort_order   integer not null default 100,
  active       boolean not null default true
);
comment on table public.records_items is
  'What a year-end records request can ask for. The picker on Today ticks the defaults for the request kind and whatever the client was asked for last year.';

insert into public.records_items (key, label, grp, default_full, default_gap, sort_order) values
  ('bank_statements',   'Bank statements for the year (and the first month after the year end)', 'company', true,  false, 10),
  ('card_statements',   'Credit card statements',                                               'company', true,  false, 20),
  ('sales_invoices',    'Sales invoices for the year',                                          'company', true,  false, 30),
  ('purchase_invoices', 'Purchase invoices and receipts',                                       'company', true,  false, 40),
  ('cash_expenses',     'Anything paid personally on behalf of the business',                   'company', true,  false, 50),
  ('loan_statements',   'Loan statements at the year end',                                      'company', true,  true,  60),
  ('hp_agreements',     'Any new HP or finance agreements',                                     'company', true,  true,  70),
  ('payroll_summaries', 'Payroll summaries (if payroll is run elsewhere)',                      'company', true,  true,  80),
  ('stock_count',       'Stock count at the year end',                                          'company', false, false, 90),
  ('fixed_assets',      'Details of equipment or vehicles bought or sold',                      'company', false, false, 100),
  ('p60_p45_p11d',      'P60 / P45 / P11D',                                                     'personal', false, false, 200),
  ('savings_interest',  'Savings interest received',                                            'personal', false, false, 210),
  ('rental_income',     'Rental income and expenses',                                           'personal', false, false, 220),
  ('home_office',       'Home office costs',                                                    'personal', false, false, 230),
  ('other_dividends',   'Dividends from other companies',                                       'personal', false, false, 240),
  ('trust_income',      'Trust income',                                                         'personal', false, false, 250),
  ('state_pension',     'State pension received',                                               'personal', false, false, 260),
  ('child_benefit',     'Child benefit received',                                               'personal', false, false, 270),
  ('student_loan',      'Student loan balance',                                                 'personal', false, false, 280)
on conflict (key) do update set label = excluded.label, grp = excluded.grp,
  default_full = excluded.default_full, default_gap = excluded.default_gap, sort_order = excluded.sort_order;

create table if not exists public.client_records_items (
  id                uuid primary key default gen_random_uuid(),
  entity_id         uuid not null references public.entities(id) on delete cascade,
  item_key          text references public.records_items(key) on delete cascade,
  custom_text       text,                       -- a free-text item, when item_key is null
  last_period_end   date,
  last_requested_at timestamptz,
  requested_by      uuid references public.staff_profiles(id) on delete set null,
  active            boolean not null default true,
  check (item_key is not null or nullif(btrim(custom_text), '') is not null)
);
create unique index if not exists client_records_items_key_uq
  on public.client_records_items (entity_id, item_key) where item_key is not null;
create index if not exists client_records_items_entity_idx on public.client_records_items (entity_id);
comment on table public.client_records_items is
  'What each client has been asked for at year end, so next year''s request starts from it.';

alter table public.records_items        enable row level security;
alter table public.client_records_items enable row level security;
drop policy if exists records_items_select_staff on public.records_items;
create policy records_items_select_staff on public.records_items
  for select to authenticated using (is_active_staff());
drop policy if exists client_records_items_select_staff on public.client_records_items;
create policy client_records_items_select_staff on public.client_records_items
  for select to authenticated using (is_active_staff());
revoke all on public.records_items, public.client_records_items from public, anon;
revoke insert, update, delete, truncate, references, trigger on public.records_items, public.client_records_items from authenticated;
grant select on public.records_items, public.client_records_items to authenticated;
grant select, insert, update, delete on public.records_items, public.client_records_items to service_role;

-- ── Templates: plain, short, from a person ──────────────────────────────────
-- {{greeting}} = the primary contact's preferred name; {{items}} = the
-- picked list, one per line; {{sender_first_name}} signs off.
update public.comm_templates set
  subject   = '{{client_name}} – year end records',
  body_text = E'Hi {{greeting}},\n\nHope you’re well. Now that the year to {{year_end}} is behind us, could you send over the records for the accounts when you get a chance? For this year we need:\n\n{{items}}\n\nIf you could get them to us by {{records_due}} that would be great – upload them to the portal or just reply to this email.\n\nThanks,\n{{sender_first_name}}',
  body_html = ''
where comm_type = 'job_plan' and kind = 'records_request';

update public.comm_templates set
  subject   = '{{client_name}} – a few bits to finish the accounts',
  body_text = E'Hi {{greeting}},\n\nHope all’s well. We’ve got most of what we need for the year to {{year_end}} already through the VAT returns, so just a few bits to finish off the accounts:\n\n{{items}}\n\nBy {{records_due}} if you can – portal or reply to this email, whichever is easier.\n\nThanks,\n{{sender_first_name}}',
  body_html = ''
where comm_type = 'job_plan' and kind = 'gap_request';

update public.comm_templates set
  subject   = '{{client_name}} – year end records',
  body_text = E'Hi {{greeting}},\n\nJust a quick nudge on the year end records for {{year_end}} – we’re still waiting on:\n\n{{items}}\n\nIf they’re on the way, ignore this. If anything’s tricky to get hold of, let me know and we’ll work around it.\n\nThanks,\n{{sender_first_name}}',
  body_html = ''
where comm_type = 'job_plan' and kind = 'records_chase';

update public.comm_templates set
  subject   = 'Your annual review meeting',
  body_text = E'Hi {{greeting}},\n\nTime to get your annual review meeting in the diary – a chance to go through the year to {{year_end}} and talk about what’s coming up. I’ve got the week of {{meeting_week}} in mind.\n\nCould you let me know a day and time that suits? Happy to do it in person, by video or on the phone.\n\nThanks,\n{{sender_first_name}}',
  body_html = ''
where comm_type = 'job_plan' and kind = 'meeting_invite';

update public.comm_templates set
  subject   = '{{client_name}} – accounts to approve',
  body_text = E'Hi {{greeting}},\n\nJust following up on the accounts for the year to {{year_end}} we sent over on {{sent_date}}. If you’re happy with them, could you approve and sign when you get a moment so we can get them filed (deadline {{filing_date}})? Any questions, just shout.\n\nThanks,\n{{sender_first_name}}',
  body_html = ''
where comm_type = 'job_plan' and kind = 'approval_chase';
