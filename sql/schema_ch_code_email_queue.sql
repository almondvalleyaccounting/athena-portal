-- ============================================================
-- CH personal-code — manual email queue + editable templates
-- Sits on top of schema_ch_code_chase.sql. Adds:
--   * ch_code_requests.handling  — Sophie's "who's doing it" toggle,
--     independent of the pipeline status/decision.
--   * ch_code_requests.emails_sent — running counter of emails sent for
--     this person. Seeded by Sophie (emails already sent by hand before
--     Athena tracked them) and auto-incremented when a queued email sends.
--   * ch_code_email_templates — editable copy for each email kind, so
--     staff can tweak wording without a deploy. Body is inline-styled HTML
--     with {{person}} / {{entity}} placeholders; the branded shell + text
--     version are added at render time (see emailRender.js).
--   * ch_code_email_queue — Sophie clicks a tile button to QUEUE an email;
--     nothing goes out until someone reviews the queue and hits "Send All"
--     (ch-code-queue-send edge function).
-- ============================================================

-- ── who's-doing-it toggle ──
alter table ch_code_requests add column if not exists handling text not null default 'not_started'
  check (handling in ('not_started','client','us','awaiting_response'));

-- ── emails-sent counter (seedable, auto-incremented on send) ──
alter table ch_code_requests add column if not exists emails_sent int not null default 0;

-- ── editable templates ──
create table if not exists ch_code_email_templates (
  key         text primary key check (key in ('offer','reminder','id_poa','code')),
  label       text not null,
  subject     text not null,
  body_html   text not null,
  updated_by  uuid references staff_profiles(id),
  updated_at  timestamptz not null default now()
);
comment on table ch_code_email_templates is 'Editable CH-code email copy. body_html is the inner content (inline-styled HTML, {{person}}/{{entity}} placeholders); the branded shell and plaintext version are applied by emailRender.js at queue time.';

insert into ch_code_email_templates (key, label, subject, body_html) values
(
  'offer',
  'Offer — ID verification options',
  'Action needed — your Companies House ID verification',
  '<p style="font-size:15px;font-weight:600;color:#0f172a;margin:0 0 10px;">Hi {{person}},</p>'
  || '<p style="font-size:14px;line-height:1.6;color:#1e293b;margin:0 0 16px;">Companies House now requires every director and person with significant control to verify their identity and get a personal code before we can file {{entity}}''s Confirmation Statement. You have two options:</p>'
  || '<div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin-bottom:10px;"><div style="font-weight:700;color:#0f172a;font-size:13.5px;margin-bottom:4px;">Option 1 — We do it for you (£20 + VAT)</div><div style="font-size:13px;color:#475569;line-height:1.5;">Send us a form of photo ID and a recent proof of address — we''ll verify your identity as an authorised agent. Just reply to this email to choose this option.</div></div>'
  || '<div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;"><div style="font-weight:700;color:#0f172a;font-size:13.5px;margin-bottom:4px;">Option 2 — You verify yourself (free)</div><div style="font-size:13px;color:#475569;line-height:1.5;">Verify your identity at <strong>gov.uk</strong> using GOV.UK One Login, then forward us the personal code. Reply to this email to let us know you''re taking this route.</div></div>'
  || '<p style="font-size:13px;line-height:1.6;color:#64748b;margin:16px 0 0;">One important note either way: Companies House emails the code straight to <strong>your own inbox</strong>, never to us — so whichever option you pick, we''ll still need you to forward us the code once you have it.</p>'
),
(
  'reminder',
  'Reminder — chase the decision',
  'Reminder — your Companies House ID verification',
  '<p style="font-size:15px;font-weight:600;color:#0f172a;margin:0 0 10px;">Hi {{person}},</p>'
  || '<p style="font-size:14px;line-height:1.6;color:#1e293b;margin:0 0 14px;">Just a gentle reminder — we still need to know which option you''d like for your Companies House ID verification (we do it for £20+VAT with your ID and proof of address, or you self-verify at gov.uk), so we can keep {{entity}}''s Confirmation Statement on track.</p>'
  || '<p style="font-size:14px;line-height:1.6;color:#1e293b;margin:0;">The easiest way is to simply <strong>reply to this email</strong>.</p>'
),
(
  'id_poa',
  'Reminder — ID & proof of address',
  'Reminder — ID & proof of address for your Companies House verification',
  '<p style="font-size:15px;font-weight:600;color:#0f172a;margin:0 0 10px;">Hi {{person}},</p>'
  || '<p style="font-size:14px;line-height:1.6;color:#1e293b;margin:0 0 14px;">Thanks for asking us to handle your Companies House ID verification. To get started we just need two things from you:</p>'
  || '<ul style="font-size:14px;line-height:1.7;color:#1e293b;margin:0 0 14px;padding-left:20px;"><li>A form of photo ID (passport or driving licence)</li><li>A recent proof of address (utility bill or bank statement, within the last 3 months)</li></ul>'
  || '<p style="font-size:14px;line-height:1.6;color:#1e293b;margin:0;">Just <strong>reply to this email</strong> with the two documents attached and we''ll take it from there for {{entity}}.</p>'
),
(
  'code',
  'Reminder — forward the code',
  'Reminder — your Companies House personal code',
  '<p style="font-size:15px;font-weight:600;color:#0f172a;margin:0 0 10px;">Hi {{person}},</p>'
  || '<p style="font-size:14px;line-height:1.6;color:#1e293b;margin:0 0 14px;">Just a quick reminder — once Companies House has verified your identity they''ll email your <strong>personal code</strong> straight to your own inbox. As soon as it arrives, please <strong>reply to this email</strong> and forward it to us so we can finish {{entity}}''s Confirmation Statement.</p>'
)
on conflict (key) do nothing;

-- ── the queue itself ──
create table if not exists ch_code_email_queue (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references ch_code_requests(id) on delete cascade,
  kind        text not null check (kind in ('offer','reminder','id_poa','code')),
  to_email    text not null,
  subject     text not null,
  html        text not null,
  text        text,
  status      text not null default 'queued' check (status in ('queued','sent','cancelled','failed')),
  resend_id   text,
  error       text,
  created_by  uuid references staff_profiles(id),
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);
comment on table ch_code_email_queue is 'Manually-queued CH-code emails. Rendered from ch_code_email_templates at queue time (what you see is what you send). Nothing sends until ch-code-queue-send is invoked ("Send All").';
create index if not exists idx_ch_code_email_queue_status on ch_code_email_queue(status);
create index if not exists idx_ch_code_email_queue_request on ch_code_email_queue(request_id);

-- ── RLS: same is_active_staff() pattern as the rest of the CH-code tables ──
alter table ch_code_email_templates enable row level security;
alter table ch_code_email_queue     enable row level security;

drop policy if exists ch_code_email_templates_staff on ch_code_email_templates;
create policy ch_code_email_templates_staff on ch_code_email_templates for all using (is_active_staff()) with check (is_active_staff());
drop policy if exists ch_code_email_queue_staff on ch_code_email_queue;
create policy ch_code_email_queue_staff on ch_code_email_queue for all using (is_active_staff()) with check (is_active_staff());
