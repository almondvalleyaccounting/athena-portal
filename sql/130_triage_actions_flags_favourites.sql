-- 130: Triage action plans + invoice visibility controls + admin report flag
--      + client favourites + strike-off seeding fix.
--
-- (a) Triage next-actions become a structured action plan: typed actions
--     (email/call/meeting/other) with an owner, target date and status.
--     Templates instantiate multiple actions with target dates offset from
--     the day the plan is applied — the future hook for automating the
--     actions themselves (email templates, diary invites).
-- (b) staff_profiles.can_view_pushed_invoices — pushed billing_items are
--     visible only to holders (seeded: the can_view_client_fees tier =
--     Bobby/Tracy/Yvonne). Writes on billing_items tightened from any
--     active staff to billing staff.
-- (c) staff_profiles.can_view_admin_report — gates the admin task list
--     Report tab (seeded: Bobby + Tracy; managed via the access grid).
-- (d) staff_client_favourites — starred clients per staff member, feeds
--     the Portfolio Dashboard.
-- (e) Seed ch_status_events for entities whose CURRENT Companies House
--     status is already threatening (the ingest previously only recorded
--     changes, so a client already in liquidation at first fetch never
--     reached the Triage Board).

-- ── (a) Triage action plans ─────────────────────────────────────────
create table if not exists public.triage_action_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  active boolean not null default true,
  created_by uuid references public.staff_profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.triage_action_template_steps (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.triage_action_templates(id) on delete cascade,
  sort int not null default 0,
  action_type text not null check (action_type in ('email', 'call', 'meeting', 'other')),
  title text not null,
  offset_days int not null default 0,
  default_assignee_id uuid references public.staff_profiles(id)
);

create table if not exists public.triage_actions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.triage_cases(id) on delete cascade,
  action_type text not null check (action_type in ('email', 'call', 'meeting', 'other')),
  title text not null,
  assigned_to uuid references public.staff_profiles(id),
  target_date date,
  status text not null default 'not_started'
    check (status in ('not_started', 'in_progress', 'done', 'cancelled')),
  notes text,
  sort int not null default 0,
  template_id uuid references public.triage_action_templates(id),
  completed_at timestamptz,
  completed_by uuid references public.staff_profiles(id),
  created_by uuid references public.staff_profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists triage_actions_case_idx on public.triage_actions(case_id, sort);

alter table public.triage_action_templates enable row level security;
alter table public.triage_action_template_steps enable row level security;
alter table public.triage_actions enable row level security;

drop policy if exists "Staff manage triage action templates" on public.triage_action_templates;
create policy "Staff manage triage action templates" on public.triage_action_templates
  for all using (is_active_staff()) with check (is_active_staff());
drop policy if exists "Staff manage triage template steps" on public.triage_action_template_steps;
create policy "Staff manage triage template steps" on public.triage_action_template_steps
  for all using (is_active_staff()) with check (is_active_staff());
drop policy if exists "Staff manage triage actions" on public.triage_actions;
create policy "Staff manage triage actions" on public.triage_actions
  for all using (is_active_staff()) with check (is_active_staff());

-- Starter template to copy from.
do $$
declare v_tpl uuid;
begin
  if not exists (select 1 from triage_action_templates) then
    insert into triage_action_templates (name, description)
    values ('Standard client contact plan',
            'Default escalation: email the client, follow up by phone, then get a meeting in the diary.')
    returning id into v_tpl;
    insert into triage_action_template_steps (template_id, sort, action_type, title, offset_days) values
      (v_tpl, 0, 'email',   'Email the client explaining the issue and what we need', 0),
      (v_tpl, 1, 'call',    'Follow-up call if no reply', 3),
      (v_tpl, 2, 'meeting', 'Meeting to agree the way forward', 7);
  end if;
end $$;

-- ── (b)+(c) Access flags ────────────────────────────────────────────
alter table public.staff_profiles
  add column if not exists can_view_pushed_invoices boolean not null default false,
  add column if not exists can_view_admin_report boolean not null default false;

-- One-off seeds; managed from the Staff & Permissions grid thereafter.
update public.staff_profiles set can_view_pushed_invoices = true where can_view_client_fees = true;
update public.staff_profiles set can_view_admin_report = true
 where email in ('bobby@almondvalleyaccounting.co.uk', 'tracy@almondvalleyaccounting.co.uk');

create or replace function public.can_view_pushed_invoices()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from staff_profiles
    where id = auth.uid() and is_active and can_view_pushed_invoices
  );
$$;
grant execute on function public.can_view_pushed_invoices() to authenticated;

-- Pushed invoices visible only to flag holders; writes tightened from any
-- active staff to billing staff (can_view_billing or fee admins).
drop policy if exists "Billing staff can view billing items" on public.billing_items;
create policy "Billing staff can view billing items" on public.billing_items
  for select using (
    (can_view_client_fees() or exists (
      select 1 from staff_profiles
      where id = auth.uid() and is_active = true and can_view_billing = true
    ))
    and (status <> 'pushed' or can_view_pushed_invoices())
  );

drop policy if exists "Staff can insert billing" on public.billing_items;
create policy "Staff can insert billing" on public.billing_items
  for insert with check (
    can_view_client_fees() or exists (
      select 1 from staff_profiles
      where id = auth.uid() and is_active = true and can_view_billing = true
    )
  );
drop policy if exists "Staff can update billing" on public.billing_items;
create policy "Staff can update billing" on public.billing_items
  for update using (
    can_view_client_fees() or exists (
      select 1 from staff_profiles
      where id = auth.uid() and is_active = true and can_view_billing = true
    )
  );
drop policy if exists "Staff can delete billing" on public.billing_items;
create policy "Staff can delete billing" on public.billing_items
  for delete using (
    can_view_client_fees() or exists (
      select 1 from staff_profiles
      where id = auth.uid() and is_active = true and can_view_billing = true
    )
  );

-- ── (d) Client favourites ───────────────────────────────────────────
create table if not exists public.staff_client_favourites (
  staff_id uuid not null references public.staff_profiles(id) on delete cascade,
  entity_id uuid not null references public.entities(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (staff_id, entity_id)
);
alter table public.staff_client_favourites enable row level security;
drop policy if exists "Own favourites" on public.staff_client_favourites;
create policy "Own favourites" on public.staff_client_favourites
  for all using (staff_id = auth.uid()) with check (staff_id = auth.uid());

-- ── (e) Seed strike-off watch from CURRENT statuses ─────────────────
insert into public.ch_status_events (entity_id, old_status, new_status, old_detail, new_detail)
select e.id, null, e.company_status, null, e.company_status_detail
from public.entities e
where (coalesce(e.company_status, '') || ' ' || coalesce(e.company_status_detail, ''))
      ~* '(strike|liquidat|administrat|insolven|dissolv|receiver)'
  and not exists (
    select 1 from public.triage_cases t
    where t.entity_id = e.id and t.category = 'strike_off' and t.status = 'open'
  );
