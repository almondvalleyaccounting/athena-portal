-- ============================================================
-- Confirmation statements become work you can track.
--
-- sql/266 put them on the admin task list; sql/267 fixed who belongs on it.
-- Both left the list read-only, and said so in the footer: "there is nothing
-- to mark complete here". That was true of *completion* — Companies House
-- decides that, and the nightly refresh moves the due date on a year the
-- moment one is filed, so the row leaves by itself.
--
-- It was never true of *progress*. Filing a statement is a five-step chase —
-- get the CH code, get the client to approve, bill it, get paid, file it —
-- and until now the only record of which step a company was on lived in
-- somebody's head. Fifteen of eighteen rows are overdue, one by 271 days, and
-- nothing on the page distinguishes "waiting on the client" from "nobody has
-- looked at this".
--
-- ── Why the key is (entity_id, due_date) and not deadline_id ────────────────
--
-- ch-ingest-officers keeps ONE deadlines row per company and updates its
-- due_date in place (supabase/functions/ch-ingest-officers/index.ts:237). So
-- deadline_id is stable across a filing: file this year's statement and the
-- same row comes back tomorrow carrying next year's date. Keyed on
-- deadline_id, last year's "To be Filed" would silently become this year's
-- status on a statement nobody has touched — the worst failure available here,
-- because it reads as progress.
--
-- (entity_id, due_date) names the period instead. A new due date is a new
-- period and starts blank, which is what filing should do. The cost is that a
-- change of accounting reference date, which moves the due date *within* a
-- period, also resets the status — rare, and it fails to "nobody has started"
-- rather than to a false claim of progress. That is the right way round.
--
-- ── Why the browser cannot write to these tables ────────────────────────────
--
-- A new mutating path is an edge function (CLAUDE.md). `authenticated` gets
-- SELECT and nothing else; confirmation-statement-update, running as
-- service_role behind requireStaffOrService, does every write. That also gets
-- attribution honestly: the author is the JWT's user, not a field the caller
-- fills in.
-- ============================================================

-- ── 1. Where a statement has got to ─────────────────────────────────────────
create table if not exists public.confirmation_statement_progress (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references public.entities(id) on delete cascade,
  due_date      date not null,
  status        text,
  status_set_by uuid references public.staff_profiles(id) on delete set null,
  status_set_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (entity_id, due_date),
  -- The five steps, in the order the work happens. null is a real value and
  -- the default: "on the list, not started". Clearing the dropdown returns a
  -- row to it, which is not the same as any of the five.
  constraint confirmation_statement_progress_status_check check (
    status is null or status in (
      'awaiting_ch_code',
      'awaiting_client_approval',
      'to_be_billed',
      'awaiting_payment',
      'to_be_filed'
    )
  )
);

comment on table public.confirmation_statement_progress is
  'Per-period working status for a confirmation statement, keyed on the company '
  'and the due date so that filing one (which moves the due date on a year) '
  'starts the next period blank rather than inheriting the last one.';

create index if not exists confirmation_statement_progress_entity_idx
  on public.confirmation_statement_progress (entity_id, due_date desc);

-- ── 2. The thread, mirroring admin_task_notes ───────────────────────────────
create table if not exists public.confirmation_statement_notes (
  id          uuid primary key default gen_random_uuid(),
  progress_id uuid not null references public.confirmation_statement_progress(id) on delete cascade,
  author_id   uuid references public.staff_profiles(id) on delete set null,
  body        text not null,
  created_at  timestamptz not null default now()
);

comment on table public.confirmation_statement_notes is
  'Notes against one confirmation-statement period. Same shape as '
  'admin_task_notes, and shown in the same thread widget on the admin task list.';

create index if not exists confirmation_statement_notes_progress_idx
  on public.confirmation_statement_notes (progress_id, created_at);

-- ── 3. Staff read; nobody in a browser writes ───────────────────────────────
alter table public.confirmation_statement_progress enable row level security;
alter table public.confirmation_statement_notes    enable row level security;

drop policy if exists confirmation_statement_progress_select_staff on public.confirmation_statement_progress;
create policy confirmation_statement_progress_select_staff
  on public.confirmation_statement_progress
  for select to authenticated
  using (is_active_staff());

drop policy if exists confirmation_statement_notes_select_staff on public.confirmation_statement_notes;
create policy confirmation_statement_notes_select_staff
  on public.confirmation_statement_notes
  for select to authenticated
  using (is_active_staff());

-- No insert/update/delete policy for `authenticated` on purpose: RLS denies
-- what it does not permit. But RLS is the second line, not the first — and
-- `grant select to authenticated` here is a no-op that reads like a decision.
--
-- Supabase ships `alter default privileges in schema public grant all on
-- tables to anon, authenticated, service_role`, so both tables were created
-- holding `authenticated=arwdDxtm/postgres` — every privilege — before a line
-- of this migration ran. Verified on the ACL, not assumed. The effect was
-- exactly the shape CLAUDE.md warns about: an INSERT was refused (no RLS
-- policy permits one) but an UPDATE *succeeded*, silently touching zero rows
-- because the SELECT policy is all that makes rows visible. A grant nobody
-- meant to give, held back only by a policy nobody wrote for it.
--
-- So revoke the writes by name. Then the grant says what is true.
revoke all on public.confirmation_statement_progress from public, anon;
revoke all on public.confirmation_statement_notes    from public, anon;
revoke insert, update, delete, truncate, references, trigger
  on public.confirmation_statement_progress from authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.confirmation_statement_notes    from authenticated;
grant select on public.confirmation_statement_progress to authenticated;
grant select on public.confirmation_statement_notes    to authenticated;
grant select, insert, update, delete on public.confirmation_statement_progress to service_role;
grant select, insert, update, delete on public.confirmation_statement_notes    to service_role;

-- ── 4. The list carries its own status ──────────────────────────────────────
-- Same definition as sql/267 — allow-list on entity_status, dissolved and in
-- liquidation out — with the progress row left-joined on. security_invoker
-- stays true, so both base tables are read under the caller's own policies and
-- this view cannot become a way round either of them.
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
  e.ch_last_refreshed_at,
  p.id                                   as progress_id,
  p.status                               as work_status,
  p.status_set_at                        as work_status_set_at,
  p.status_set_by                        as work_status_set_by,
  coalesce(n.note_count, 0)              as note_count,
  n.last_note_at
from public.deadlines d
join public.entities e on e.id = d.entity_id
-- Joined on the period, not on the deadline row: see the note at the top.
left join public.confirmation_statement_progress p
  on p.entity_id = e.id and p.due_date = d.due_date
left join lateral (
  select count(*) as note_count, max(created_at) as last_note_at
  from public.confirmation_statement_notes cn
  where cn.progress_id = p.id
) n on true
where d.tag = 'Confirmation Statement'
  and d.status <> 'complete'
  and d.due_date <= current_date + 14
  and coalesce(e.entity_status::text, 'active') = 'active'
  and coalesce(e.company_status, 'active') not in ('dissolved', 'liquidation');

comment on view public.v_confirmation_statements_due is
  'Confirmation statements overdue or due within 14 days, for CURRENT clients '
  '(entity_status = active) whose company is not dissolved or in liquidation. '
  'Allow-list, not deny-list: a new entity_status is excluded until someone '
  'decides it belongs. Due date is from the nightly Companies House refresh, so '
  'a filed statement drops off on the next run. work_status and note_count come '
  'from confirmation_statement_progress, keyed on (entity, due date) so they '
  'belong to this period only.';

grant select on public.v_confirmation_statements_due to authenticated, service_role;
