# Proposal: one work model for Athena (review step 2)

Decision requested from Bobby: **yes or no to the model below.** Nothing in
this document is built until it has a yes. Background and evidence are in
[WORK_MODULE_REVIEW_2026-09-25.md](WORK_MODULE_REVIEW_2026-09-25.md).

## The problem in one line

Athena holds twelve kinds of "thing to do" in twelve tables, so no page can
answer "what is on my plate today" or "who is behind", and time logged never
meets time planned.

## The model

**Two concepts. A job, and an action.**

**Job** = a BrightManager job, exactly as it is today in `bm_task_schedule`.
BM stays the source of truth for what statutory work exists, its deadline and
its status. The Waiting placement engine, the importer, Ready Now and the
change-request queue all keep working unchanged. Nothing is added to this
table.

**Action** = anything a person does that is not itself a BM job: a chase, a
records request, a penalty appeal, a meeting, a triage step, an agenda item, a
drift follow-up, an admin task. One table, one shape:

| Field | Meaning |
|---|---|
| `entity_id` | the client (may be null for internal work) |
| `job_id` | the BM job it belongs to, when it has one |
| `kind` | chase / request_records / appeal / meeting / review / admin / triage_step / agenda / drift / other |
| `title`, `notes` | |
| `assignee_id`, `due_date`, `planned_date` | who, by when, when they intend to do it |
| `status` | open / done / not_required / cancelled |
| `source`, `source_ref` | where it came from (manual, home chase, agenda, triage, drift, HMRC, portal, BM NST) and the row it came from |
| `done_at`, `done_by`, `minutes` | completion record |

**Time** has one path. Marking a job or an action done asks for minutes and
writes a `timesheet_entries` row with `source_task_id` pointing at the job.
That is what makes "remaining hours" on Waiting and cost-to-serve in Planning
true. `completed_tasks` (one row) retires.

**Signals** are computed once, in SQL, per person and per client, and shown
on Home, the Team view and the client page:

- *slipped*: scheduled date passed, job still planned
- *past deadline*: statutory date passed, job still planned
- *stalled*: BM latest action older than N days while in progress
- *overdue actions*: due date passed, action open
- *load*: scheduled hours next 14 days against capacity (weekly hours ×
  working days, minus leave)

**Views** replace tabs:

- **Today** (`/planner`, replaces My Tasks): my jobs scheduled or due this
  week, my open actions, my slipped items, one Done button.
- **Team** (`/planner/team`, new): one row per person with the five signals,
  minutes logged this week and last activity; click any cell for the list.
  This is the overview page.
- **Client** (existing Work tab on the client page): the same rows filtered to
  one client.
- **Schedule** (Waiting, renamed): unchanged.
- Ready Now, Bookkeeping Health, Triage, Admin task list: unchanged pages;
  their "next action" items become actions so they also appear on Today.

## How we get there without a big bang

1. **Evolve `quick_tasks` into the actions table** rather than create a new
   one: add `job_id`, `kind`, `status`, `source_ref`, `done_at`, `done_by`,
   `minutes`; make `due_date` and `planned_date` plain dates. Existing 27
   rows migrate as-is (kind admin, source bm_nst or manual). Every current
   writer (Home chase, client agenda, CPD, BM NST import) keeps working.
2. **A read-only union view** `v_work_items` over actions, `triage_actions`,
   `admin_tasks` and agenda action items, with the common columns above.
   Today and Team read the view; the other tables keep their own write paths
   for now. Reversible, no data moves.
3. **Signals view** `v_work_signals` per person (and a per-client variant).
4. **Today and Team pages** on those two views.
5. **Done writes a timesheet row.** For a BM job, Done also queues a BM
   status change through the existing Ready Now change queue, because BM
   cannot be written directly.
6. Later, one source at a time, move triage and agenda writes onto the
   actions table and drop the union.

## What retires

- Scheduled, Calendar, Kanban, Completed tabs and the three tables behind
  them (0, 0 and 1 rows): hidden behind a flag, deleted after a month.
- Estimates, unless it becomes the per-client hours override for capacity.
- The Setup "auto-schedule" toggle (reads by nothing).

## What does not change

BrightManager importer, Waiting placement engine and lifecycle, Ready Now,
Triage internals, the Admin task pipeline, Bookkeeping Health scoring.

## Risks and answers

- *BM stays the status system.* Yes. Athena records time and intent; BM
  status changes go through the change queue as they do now. Long term, a BM
  API or a different practice system is a separate decision.
- *Two write paths for triage and admin during the transition.* Accepted;
  the union view hides it from users and step 6 closes it.
- *Capacity needs contracted hours.* The eleven values in
  `staff_profiles.weekly_capacity_hours` are a five-minute admin job and are
  needed regardless of this proposal.

## Effort

Steps 1 to 4 are about a fortnight. Step 5 a further week. Step 6 is
incremental and can follow the playbook work.

## Defaults I will take unless told otherwise

- Evolve `quick_tasks` rather than add a table.
- Done on a BM job = timesheet row plus a queued BM status change.
- Hide the four unused tabs behind a flag from the day Today ships.

**The one question: is this the model? Yes or no.**
