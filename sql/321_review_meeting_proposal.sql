-- ============================================================
-- 321 — Review-meeting cross-sell
--
-- Bobby, 2026-09-26: when a client has no review meeting, propose a
-- chargeable one. The proposal is an email from the plan (a template with
-- the fee the sender suggests), the answer is recorded on the client,
-- "Client agreed" switches the meeting on for the job, pins the date, and
-- raises a draft bill for it; a note goes to the fee viewers to consider a
-- monthly uplift if it becomes regular.
-- ============================================================

alter table public.comm_templates drop constraint if exists comm_templates_kind_check;
alter table public.comm_templates add constraint comm_templates_kind_check
  check (kind in ('promo','reminder','no_utr','records_request','gap_request','records_chase','meeting_invite','approval_chase','meeting_proposal'));

insert into public.comm_templates (comm_type, kind, subject, body_text)
select 'job_plan', 'meeting_proposal', '{{client_name}} – would a review meeting help?',
  E'Hi {{greeting}},\n\n{{opener}}While we’re planning the accounts for the year to {{year_end}}, one thought: would it help to sit down for an hour once the numbers are in? We’d go through what the year says, the tax that follows from it, and what you’re planning next – so there are no surprises and you get a say in the timing.\n\nIt’s a chargeable session – I’d suggest {{fee}} plus VAT for the meeting and the prep behind it. If that’s useful, just reply and I’ll get a date in the diary once the accounts are ready.\n\n{{signoff}}'
where not exists (select 1 from public.comm_templates where comm_type = 'job_plan' and kind = 'meeting_proposal');

alter table public.client_review_meetings drop constraint if exists client_review_meetings_basis_check;
alter table public.client_review_meetings add constraint client_review_meetings_basis_check
  check (basis in ('manual','package','included_in_accounts','proposed','declined'));
alter table public.client_review_meetings
  add column if not exists proposed_at     timestamptz,
  add column if not exists agreed_at       timestamptz,
  add column if not exists meeting_fee     numeric(10,2),
  add column if not exists billing_item_id uuid references public.billing_items(id) on delete set null;

create or replace view public.v_client_review_meeting with (security_invoker = true) as
with billed as (
  select distinct lb.entity_id
  from live_billing lb, lateral jsonb_array_elements(lb.services) s(value)
  where lb.status = 'active'
    and ((s.value ->> 'service_id') ilike '%review meeting%' or (s.value ->> 'description') ilike '%review meeting%')
)
select e.id as entity_id,
       coalesce(m.has_meeting, (b.entity_id is not null)) as has_meeting,
       case when m.entity_id is not null then m.basis
            when b.entity_id is not null then 'billed'
            else 'none' end as basis,
       m.note, m.set_by, m.set_at, m.proposed_at, m.agreed_at, m.meeting_fee
from entities e
left join client_review_meetings m on m.entity_id = e.id
left join billed b on b.entity_id = e.id;
