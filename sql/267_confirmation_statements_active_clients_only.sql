-- ============================================================
-- Former clients: name who is IN, not who is out.
--
-- sql/266 excluded former clients the way every other surface does —
-- `not in ('nlac', 'archived')`. Checked against live data that is correct
-- today: 22 rows shown, all active; 10 rows excluded, every one nlac or
-- archived. Nobody who has left is on the list.
--
-- But a deny-list fails open. `entity_status` is an enum with five values
-- today (active, nlac, prospect, archived, third_party) and it has grown
-- before. Add a sixth for any flavour of "gone" — dormant, lapsed, lost — and
-- this view starts listing them again, silently, because the new label isn't
-- in the two it knows to refuse. That is precisely the shape of failure the
-- read-time rule exists to prevent.
--
-- So state who belongs on a list of statements WE have to file: a client we
-- currently act for. That is `active`, and only `active`.
--
--   * `prospect` (17 entities) — not a client yet, we file nothing for them.
--     None have a statement due right now, so this changes no rows today; it
--     changes what happens the first time one does.
--   * `third_party` — never a client by definition.
--   * `nlac` / `archived` — the ones Bobby asked to be sure about, now
--     excluded because they are not `active` rather than because they were
--     named.
--
-- coalesce keeps a null status reading as active, matching sql/134 and the
-- rest of the codebase. (No entity has a null status today — 667 of 667 are
-- set — but the convention costs nothing and the column is nullable.)
-- ============================================================

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
  -- Clients we currently act for. Anything else — no longer a client,
  -- archived, prospect, third party, or a status that does not exist yet —
  -- is off this list.
  and coalesce(e.entity_status::text, 'active') = 'active'
  -- Dissolved or in liquidation: there is no statement left to file.
  and coalesce(e.company_status, 'active') not in ('dissolved', 'liquidation');

comment on view public.v_confirmation_statements_due is
  'Confirmation statements overdue or due within 14 days, for CURRENT clients '
  '(entity_status = active) whose company is not dissolved or in liquidation. '
  'Allow-list, not deny-list: a new entity_status is excluded until someone '
  'decides it belongs. Sourced from the nightly Companies House refresh, so a '
  'filed statement drops off on the next run — there is nothing to tick off.';

grant select on public.v_confirmation_statements_due to authenticated, service_role;
