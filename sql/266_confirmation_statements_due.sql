-- ============================================================
-- Confirmation statements, on the list that gets worked.
--
-- The due date is already here and already accurate: ch-ingest-officers reads
-- `confirmation_statement.next_due` off the Companies House profile on every
-- nightly run and writes it to `deadlines`. 265 rows, refreshed today. Nothing
-- has ever read them. 15 are overdue — one by 267 days — and no surface in
-- Athena says so.
--
-- Two things were in the way.
--
-- 1. `deadlines` RLS is the PORTAL model: entity_memberships and
--    my_entity_ids(). Staff hold neither, so a staff member querying this
--    table gets zero rows — verified, Bobby sees 0 of 265. The nightly writer
--    is service_role, so nobody ever noticed the read side was shut.
--
-- 2. Which rows count needs stating once, not re-derived per caller: former
--    clients out (nlac/archived — the read-time rule, sql/134), companies
--    already dissolved or in liquidation out (nothing left to file), rows
--    marked complete out.
--
-- A company with a strike-off proposed is deliberately KEPT. Its statement is
-- still legally due until the strike-off completes, and two of the overdue
-- fifteen are companies we are striking off right now. The view carries
-- company_status so the row can say why it might not matter, rather than the
-- view deciding that silently.
-- ============================================================

-- ── 1. Staff can read deadlines ─────────────────────────────────────────────
-- Additive: the two portal policies are untouched, so a client still sees only
-- their own. A CS due date is public Companies House data — the reason to gate
-- it is tidiness, not confidentiality.
drop policy if exists deadlines_select_staff on public.deadlines;
create policy deadlines_select_staff on public.deadlines
  for select to authenticated
  using (is_active_staff());

-- ── 2. What "due" means, in one place ───────────────────────────────────────
-- security_invoker = true, so the policy above does the work and this view
-- cannot become a way round it. (A view is SECURITY DEFINER unless it says
-- otherwise, and a definer view reads its base tables as the owner.)
drop view if exists public.v_confirmation_statements_due;
create view public.v_confirmation_statements_due
with (security_invoker = true) as
select
  d.id                                   as deadline_id,
  e.id                                   as entity_id,
  e.name                                 as entity_name,
  e.company_number,
  e.company_status,
  e.company_status_detail,
  d.due_date,
  (current_date - d.due_date)            as days_late,   -- negative = days to go
  (d.due_date < current_date)            as overdue,
  e.ch_last_refreshed_at
from public.deadlines d
join public.entities e on e.id = d.entity_id
where d.tag = 'Confirmation Statement'
  and d.status <> 'complete'
  and d.due_date <= current_date + 14
  -- Former clients are excluded at read time on every operational surface.
  and coalesce(e.entity_status::text, 'active') not in ('nlac', 'archived')
  -- Dissolved or in liquidation: there is no statement left to file.
  and coalesce(e.company_status, 'active') not in ('dissolved', 'liquidation');

comment on view public.v_confirmation_statements_due is
  'Confirmation statements overdue or due within 14 days, for active clients whose '
  'company is not dissolved or in liquidation. Sourced from the nightly Companies '
  'House refresh, so a filed statement drops off this list on the next run — there '
  'is nothing to tick off by hand.';

grant select on public.v_confirmation_statements_due to authenticated, service_role;
