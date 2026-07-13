-- ============================================================
-- CH personal-code — 7-stage lifecycle (migration ch_code_lifecycle_v1)
--
-- Adds an authoritative `stage` axis reflecting the real process, plus the
-- Stage-5/6/7 tracking columns. The comms ladder (emails_sent / called_at /
-- escalation_status) becomes the WITHIN-stage progress and resets each time
-- the stage advances. `status` is kept (and still written) for continuity
-- with the disarmed automated chaser, but is no longer the board's truth.
--
-- Stages: s1_offer, s2_decision, s3a_client, s3b_us, s4_code, s5_entered,
--         s6_submitted (terminal ✓), s7_rejected (terminal exit).
-- ============================================================

alter table ch_code_requests add column if not exists stage text not null default 's1_offer'
  check (stage in ('s1_offer','s2_decision','s3a_client','s3b_us','s4_code','s5_entered','s6_submitted','s7_rejected'));
alter table ch_code_requests add column if not exists entered_inform_direct_at timestamptz;
alter table ch_code_requests add column if not exists entered_bm_at timestamptz;
alter table ch_code_requests add column if not exists bm_code_mismatch text;   -- differing BM value when reconciliation fails, else null
alter table ch_code_requests add column if not exists submitted_at timestamptz;
alter table ch_code_requests add column if not exists rejected_at timestamptz;
alter table ch_code_requests add column if not exists rejected_reason text;

create index if not exists idx_ch_code_requests_stage on ch_code_requests(stage);

-- Backfill stage from the existing status + decision.
update ch_code_requests set stage = case
  when status in ('pending_offer','awaiting_decision') then 's1_offer'
  when status = 'awaiting_id_poa' then 's3b_us'
  when status = 'awaiting_code'   then 's4_code'
  when status = 'code_received'   then 's5_entered'
  when status = 'entered_on_bm'   then 's6_submitted'   -- old "done" = filed
  when status = 'stalled'         then 's7_rejected'
  else 's1_offer' end;

-- Templates + queue: allow the new self_verify (Stage 3a) kind.
alter table ch_code_email_templates drop constraint if exists ch_code_email_templates_key_check;
alter table ch_code_email_templates add constraint ch_code_email_templates_key_check
  check (key in ('offer','reminder','id_poa','code','self_verify'));
alter table ch_code_email_queue drop constraint if exists ch_code_email_queue_kind_check;
alter table ch_code_email_queue add constraint ch_code_email_queue_kind_check
  check (kind in ('offer','reminder','id_poa','code','self_verify'));

insert into ch_code_email_templates (key, label, subject, body_html) values
(
  'self_verify',
  'Reminder — verify yourself at GOV.UK',
  'Reminder — verify your identity for Companies House',
  '<p style="font-size:15px;font-weight:600;color:#0f172a;margin:0 0 10px;">Hi {{person}},</p>'
  || '<p style="font-size:14px;line-height:1.6;color:#1e293b;margin:0 0 14px;">Thanks for letting us know you''d like to verify your own identity for Companies House. When you have a moment, please complete it at <strong>gov.uk</strong> using GOV.UK One Login — it only takes a few minutes.</p>'
  || '<p style="font-size:14px;line-height:1.6;color:#1e293b;margin:0 0 14px;">Companies House will email your <strong>personal code</strong> straight to your own inbox once you''re verified. As soon as it arrives, please <strong>reply to this email</strong> and forward it to us so we can file {{entity}}''s Confirmation Statement.</p>'
  || '<p style="font-size:13px;line-height:1.6;color:#64748b;margin:0;">If you''d prefer we handle the verification for you instead (£20 + VAT), just reply and let us know.</p>'
)
on conflict (key) do nothing;
