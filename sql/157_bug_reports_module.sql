-- 157: Bug Reports module — structured intake so a raw team report becomes a
-- spec Claude can act on, and Bobby just triages.
--
-- History: the original Bug Reports module was folded into issues_log
-- (category Software) by sql/110 on 2026-07-20; /bugs redirected to /issues
-- and the page was deleted. This revives a DEDICATED bug intake with the
-- questions Claude actually needs to reproduce + fix a bug — kept separate
-- from Issues Log (broad operational issues) and from the Work triage board
-- (client work), which stay as they are.
--
-- What changed vs the old free-text box: intake is now GUIDED. Instead of one
-- "describe the bug" field (the Waterfall/Magda reports crammed everything
-- into a title), we capture where, which client/record, expected vs actual,
-- steps, frequency, and impact as separate fields, plus an auto-captured
-- browser/route context blob the reporter never has to think about.

-- ── 1. Triage permission ──────────────────────────────────────────────
-- Reporting a bug is open to any active staff member. Triage (setting
-- priority, accepting/rejecting, moving through the lifecycle) is gated.
alter table public.staff_profiles
  add column if not exists can_triage_bugs boolean not null default false;

-- Seed: whoever already runs the portal can triage bugs.
update public.staff_profiles
   set can_triage_bugs = true
 where is_portal_admin = true or can_manage_portal = true;

create or replace function public.can_triage_bugs()
returns boolean
language sql stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.staff_profiles
     where id = auth.uid() and is_active and can_triage_bugs
  );
$$;
grant execute on function public.can_triage_bugs() to authenticated;

-- ── 2. bugs table ─────────────────────────────────────────────────────
create table if not exists public.bugs (
  id             uuid primary key default gen_random_uuid(),
  seq            bigint generated always as identity,   -- human ref: BUG-<seq>

  -- What the reporter tells us (the guided questions) ------------------
  title          text not null,                 -- one-line summary
  module         text,                           -- which Athena area (from modules.config)
  page_url       text,                           -- exact screen (auto-prefilled)
  entity_id      uuid references public.entities(id) on delete set null,
  record_ref     text,                           -- free-text record name/id if not an entity
  goal           text,                           -- what were you trying to do
  expected       text,                           -- what did you expect to happen
  actual         text,                           -- what actually happened (symptom / error text)
  steps          text,                           -- steps to reproduce
  frequency      text,                           -- always | sometimes | once | unsure
  impact         text,                           -- blocking | workaround | minor | cosmetic
  started        text,                           -- when it started / did it ever work
  screenshot_url text,                           -- optional attachment
  context        jsonb not null default '{}'::jsonb,  -- auto: browser, viewport, role, commit, ts

  -- Triage / lifecycle (Bobby + Claude) --------------------------------
  status         text not null default 'new',    -- see lifecycle below
  priority       text,                            -- critical | high | medium | low (set at triage)
  target         text,                            -- this_week | backlog (accepted bugs)
  triage_notes   text,
  reject_reason  text,                            -- not_a_bug | duplicate | wont_fix | cannot_repro | other
  duplicate_of   uuid references public.bugs(id) on delete set null,
  resolution_notes text,
  fix_commit     text,                            -- commit / PR that fixed it

  -- People + timestamps ------------------------------------------------
  reported_by      uuid references public.staff_profiles(id) on delete set null,
  reported_by_name text,
  assignee_id      uuid references public.staff_profiles(id) on delete set null,
  triaged_at   timestamptz,
  fixed_at     timestamptz,
  verified_at  timestamptz,
  closed_at    timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Lifecycle (status):
--   new            → just reported, awaiting triage
--   needs_info     → bounced to reporter with a question
--   accepted       → triaged + prioritised, in Claude's queue (target set)
--   in_progress    → Claude working on it
--   fixed          → fix shipped, awaiting reporter verification
--   verified       → reporter confirmed the fix (terminal, success)
--   rejected       → won't fix / not a bug / duplicate (reject_reason set, terminal)

comment on table public.bugs is
  'Structured Athena bug reports. Guided intake → triage → Claude fix. Separate from issues_log (operational) and the Work triage board (client work).';

create index if not exists bugs_status_created  on public.bugs (status, created_at desc);
create index if not exists bugs_reported_by      on public.bugs (reported_by);
create index if not exists bugs_active_priority  on public.bugs (priority)
  where status not in ('verified','rejected');

-- ── 3. updated_at trigger ─────────────────────────────────────────────
drop trigger if exists trg_bugs_updated_at on public.bugs;
create trigger trg_bugs_updated_at
  before update on public.bugs
  for each row execute function public.set_updated_at();

-- ── 4. RLS ────────────────────────────────────────────────────────────
alter table public.bugs enable row level security;

-- Any active staff member can see every bug (small internal team; reporters
-- benefit from seeing status + others' reports to avoid duplicates).
drop policy if exists bugs_select on public.bugs;
create policy bugs_select on public.bugs
  for select to authenticated using (is_active_staff());

-- Any active staff member can raise a bug.
drop policy if exists bugs_insert on public.bugs;
create policy bugs_insert on public.bugs
  for insert to authenticated with check (is_active_staff());

-- Updates: the reporter may keep editing their own report / add info /
-- verify a fix. Everything else (priority, accept/reject, lifecycle moves)
-- is triage — restricted to can_triage_bugs holders.
drop policy if exists bugs_update on public.bugs;
create policy bugs_update on public.bugs
  for update to authenticated
  using (is_active_staff() and (reported_by = auth.uid() or public.can_triage_bugs()))
  with check (is_active_staff() and (reported_by = auth.uid() or public.can_triage_bugs()));

-- Deletion is a triage action.
drop policy if exists bugs_delete on public.bugs;
create policy bugs_delete on public.bugs
  for delete to authenticated using (public.can_triage_bugs());

-- ── 5. Migrate open Software issues from issues_log ───────────────────
-- The 6 legacy Software rows still living in issues_log are old bug reports.
-- Bring the OPEN ones across as 'new' so they land in the triage queue with
-- everything Claude needs; their old free-text goes into `actual` (symptom)
-- and a note flags them as legacy for re-triage. Junk/closed rows are left
-- behind in issues_log.
insert into public.bugs (title, actual, priority, status, module,
                         entity_id, reported_by, reported_by_name, created_at,
                         context, triage_notes)
select
  left(i.title, 200),
  coalesce(i.description, i.title),
  i.priority,
  'new',
  'Unknown (legacy)',
  i.entity_id,
  i.reported_by,
  i.reported_by_name,
  i.created_at,
  jsonb_build_object('legacy_source', 'issues_log', 'legacy_id', i.id),
  'Migrated from Issues Log (category Software) — needs re-triage with the structured questions.'
from public.issues_log i
where i.category = 'Software'
  and i.status not in ('resolved','closed')
  and not exists (
    select 1 from public.bugs b
     where b.context->>'legacy_id' = i.id::text
  );

-- Retire the migrated rows from Issues Log so they aren't tracked twice.
update public.issues_log
   set status = 'closed',
       closed_at = now(),
       resolution_notes = coalesce(resolution_notes || E'\n', '')
                          || 'Moved to the Bug Reports module (sql/157).'
 where category = 'Software'
   and status not in ('resolved','closed');
