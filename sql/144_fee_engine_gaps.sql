-- 144: Fee-engine gaps — active clients with live work but no mapped fee.
--
-- The fee engine is live_billing. Only ~197 active entities have an active row
-- there, yet ~540 active entities have planned work in BrightManager — so ~346
-- clients are having chargeable work done with NO fee mapped. That leak never
-- surfaced anywhere the practice actually looks (the old Planning → Unbilled
-- view only saw QBO-invoiced customers and had zero reviews recorded).
--
-- This view is the ONE definition of the gap; the home-dashboard counter and
-- the new review page both read it. Tiers put the clear leaks first so the
-- noisy tail (sole-trader Self Assessment, often a director whose fee is
-- bundled into a company) doesn't drown them:
--   1  recurring chargeable service, no fee  (VAT / Bookkeeping / Payroll / Pensions)
--   2  limited company / company-type work, no fee (Annual Accounts / CT / Conf stmt)
--   3  everything else — individuals (SA / Personal Tax)
--
-- Confidentiality: the view reads live_billing (RLS-gated to
-- can_view_client_fees), so it is security_invoker and the whole feature is
-- gated to fee-authorised staff — the people who actually set fees up — which
-- is consistent with every other fee surface. Only entity_status='active'
-- appears (nlac / archived / prospect never do). Billing-group co-members who
-- are billed net an entity out; the group feature is barely used today but this
-- keeps the number honest as it grows.

create table if not exists public.fee_engine_gap_reviews (
  entity_id   uuid primary key references entities(id) on delete cascade,
  status      text not null default 'pending'
    check (status in ('pending', 'actioned', 'dismissed', 'not_client')),
  notes       text,
  reviewed_at timestamptz,
  reviewed_by uuid references staff_profiles(id),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

comment on table public.fee_engine_gap_reviews is
  'Per-entity triage of fee-engine gaps (see v_fee_engine_gaps): pending / '
  'actioned (fee set up or being set up) / dismissed (one-off, no recurring '
  'fee needed) / not_client. Mirrors plan_unbilled_review.';

alter table public.fee_engine_gap_reviews enable row level security;

drop policy if exists "staff read fee gap reviews" on public.fee_engine_gap_reviews;
create policy "staff read fee gap reviews" on public.fee_engine_gap_reviews
  for select using (is_active_staff());

drop policy if exists "staff write fee gap reviews" on public.fee_engine_gap_reviews;
create policy "staff write fee gap reviews" on public.fee_engine_gap_reviews
  for all using (is_active_staff()) with check (is_active_staff());

create or replace view public.v_fee_engine_gaps
with (security_invoker = true) as
with billed as (
  select distinct entity_id
  from live_billing
  where status = 'active' and entity_id is not null
), group_covered as (
  -- an entity is covered if any co-member of its billing group is billed
  select distinct m1.entity_id
  from billing_group_members m1
  join billing_group_members m2 on m2.group_id = m1.group_id
  where m2.entity_id in (select entity_id from billed)
), work as (
  select
    t.entity_id,
    array_agg(distinct t.service) filter (where t.service is not null) as services,
    count(*)                                                           as planned_tasks,
    count(*) filter (where t.bm_deadline < current_date)               as overdue_tasks,
    min(t.bm_deadline) filter (where t.bm_deadline >= current_date)    as next_deadline,
    bool_or(t.service in ('VAT', 'Bookkeeping', 'Payroll', 'Pensions')) as has_recurring,
    bool_or(t.service in ('Annual Accounts', 'Corporation Tax',
                          'Confirmation Statement', 'Accounts'))       as has_company_work
  from bm_task_schedule t
  where t.state = 'planned' and t.excluded_at is null and t.entity_id is not null
  group by t.entity_id
)
select
  e.id                                as entity_id,
  e.name                              as entity_name,
  e.type::text                        as entity_type,
  case
    when w.has_recurring then 1
    when w.has_company_work or e.type::text = 'limited_company' then 2
    else 3
  end                                 as tier,
  w.services,
  w.planned_tasks::int                as planned_tasks,
  w.overdue_tasks::int                as overdue_tasks,
  w.next_deadline,
  coalesce(r.status, 'pending')       as review_status,
  r.notes                             as review_notes,
  r.reviewed_at
from entities e
join work w              on w.entity_id = e.id
left join billed b       on b.entity_id = e.id
left join group_covered g on g.entity_id = e.id
left join fee_engine_gap_reviews r on r.entity_id = e.id
where e.entity_status = 'active'
  and b.entity_id is null
  and g.entity_id is null;

comment on view public.v_fee_engine_gaps is
  'Active clients with planned BrightManager work but no active live_billing '
  'fee, tiered 1=recurring service / 2=company work / 3=individual. Joined to '
  'fee_engine_gap_reviews so consumers can filter out triaged rows.';
