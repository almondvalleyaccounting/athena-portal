# Work module review — 25 September 2026

Objective set by Bobby: **optimise workflow management.** Help people record and
manage their workload, and help managers see what is going on, what is drifting
and who is under pressure. Timesheets and Capacity are in scope because they are
the same question asked from the other side.

Method: read every file under `src/modules/work-planner`, `timesheets`,
`job-review`, `triage` and the SQL that feeds them; queried the live database
for what the tables actually hold; walked every tab in the browser as Bobby;
created a test quick task, promoted it, completed it, dragged it on the
Calendar, then deleted the test rows. Kanban drag could not be driven by the
automation (native HTML5 drag), and the Waiting grid's drag/approve were left
alone because those are live BrightManager rows.

---

## 1. The headline

**The team's work is not in the planner.** Live counts today:

| Table | Rows | Note |
|---|---|---|
| `bm_task_schedule` (BrightManager jobs) | 2,431 | 1,616 planned, 823 completed-by-disappearance |
| `quick_tasks` | 27 | 22 are BM "NST" rows; all 27 overdue |
| `scheduled_tasks` | 0 | never used |
| `instance_overrides` | 0 | never used |
| `completed_tasks` | 1 | July |
| `task_progress_notes` | 6 | April |
| `timesheet_entries` | 32 | three people, last entry 11 May |
| `admin_tasks` | 132 | Sophie's list, healthy |
| `staff_profiles.weekly_capacity_hours` | null for all 11 | never set |

So of the seven Planner tabs, four (Scheduled, Calendar, Kanban, Completed)
operate on a task model nobody has adopted, My Tasks shows only quick tasks, and
the one tab that holds the real workload (Waiting) is a manager's scheduling
grid with no way to say "done", no way to log time, and no filter bar of its
own that works (the shared one above it is dead on that tab).

**Is it a best-in-class work planning assistant?** No, and not because of
polish. It is because there are **twelve distinct "task" concepts** across
twelve tables, with five different vocabularies for "waiting on the client",
and nothing joins them into "what is on my plate today" or "who is behind".

| Concept | Table | Where it shows |
|---|---|---|
| BM job | `bm_task_schedule` | Waiting, Ready Now, Capacity, Home |
| Quick task | `quick_tasks` | My Tasks, Quick, Kanban, Calendar |
| Scheduled task + occurrence | `scheduled_tasks`, `instance_overrides` | unused |
| Completion record | `completed_tasks` | Completed, Timesheets |
| Admin task | `admin_tasks` | Admin task list, Home |
| BM change request | `ready_now_change_requests` | Ready Now queue |
| Job-review item | `job_review_item` | Job Review, Home radar |
| Triage case / action | `triage_cases`, `triage_actions` | Triage |
| Drift case / nudge | `bk_drift_cases`, `bk_drift_nudges` | Bookkeeping Health |
| Allocation draft / capacity shift | `allocation_changes`, `capacity_shifts` | Capacity tabs, Admin |
| Client agenda item | `client_agenda_items` | Client page |

**Do we need an overview page?** Yes, but as the front door of Work, not an
eighth tab. See section 6.

---

## 2. Tab by tab

### Planner › Waiting
*Purpose:* the BrightManager jobs placed on a week grid per person, with the
draft → approved → committed lifecycle and drag-to-reschedule.
*Works:* loads fast, drag pins a date and survives re-import, Approve per
person, Plan 9 months.
*Problems:*
- The shared filter bar (Team avatars, Client, Service, Status, A–Z) renders
  above it and does nothing; Waiting has its own filters inside.
- "Remaining" on every card equals "Scheduled" because `logged_hours` is always
  zero (see Timesheets). The effort colour is therefore meaningless.
- Capacity line ("14.0h / 150h cap") uses 7.5h/day when the person has no
  capacity set, which is everyone. The Capacity tab uses 35h/week. Two answers.
- 111 draft/approved rows are dated in the past and 84 planned jobs are past
  their statutory deadline. Nothing flags either.
- No "done" and no time logging. A job's only exit is vanishing from the next
  BM export.
- Status dropdown defaults to "All" while the label says "Waiting" is the
  point. Plan 9 months re-drafts everything including completed rows, ignores
  manual pins, and the next import silently overwrites its dates because it
  never sets `manually_overridden_at`.

### Planner › My Tasks
*Purpose:* my quick tasks plus upcoming scheduled occurrences, with notes.
*Works:* filter to me by default, search, notes, "Needs rescheduling" banner.
*Problems:*
- Only quick tasks appear in practice. BM jobs, triage actions, admin tasks,
  drift cases, review items are invisible here.
- Overdue occurrences of recurring tasks vanish: instances are generated from
  *today* forward, so a missed occurrence is never shown as late anywhere.
- Status filter hides every quick task (they have no status). A–Z filter does
  nothing on this tab (only Quick Tasks applies it).
- "Tomorrow" on a stranded task sets *today* during British Summer Time
  (`formatISO` converts to UTC before slicing the date).
- The action button was an unlabelled blue ▶ pill, inconsistent with the
  platform's buttons. **Changed today** (see section 8).

### Planner › Quick Tasks
*Purpose:* add and reorder ad-hoc tasks.
*Works:* add bar, drag reorder, Today/Tmrw/Unplan, Promote, notes.
*Problems:*
- The add bar requires a client, so an internal admin task cannot be created
  here; the modal on My Tasks does not require one. Two rules.
- Due date defaults to +5 calendar days and the date box shows the day before
  the badge during BST (confirmed live: box 29/09, badge 30 Sept).
- The legacy notes box writes to the database on every keystroke.
- Promote loses the due date: the promoted task arrives with no start date and
  no deadline (confirmed live).
- Client name click does a full page reload instead of routing.
- Every row shows for every person; there is no "mine" default. The ▶ button
  was titled "Complete" but opened the menu. **Changed today.**

### Planner › Scheduled
*Purpose:* the list of scheduled-task masters.
*State:* empty. Would grow forever, because a one-off master is never removed
after completion (it shows "No upcoming").

### Planner › Calendar
*Purpose:* day/week/month grid with drag placement and resize.
*Works:* dnd-kit drag works and is smooth.
*Problem, confirmed live:* **dragging one occurrence of a recurring task moves
the whole series.** I dragged the 2 Oct occurrence of a weekly task to
Wed 30 Sept; the master's `planned_date` became 30 Sept and every future
occurrence moved to Wednesdays. There is no per-occurrence reschedule at all
(the override table has no date-shift field, and the Edit Instance modal only
offers owner, status and time). Month view caps at two tiles per day.

### Planner › Kanban
*Purpose:* status columns for scheduled occurrences plus a quick-tasks column.
*Problems:*
- A weekly task produces one card per future occurrence (five cards for one
  task inside the default "Month" filter). Recurring work is the wrong shape
  for a kanban.
- Quick tasks have no status so sit in their own column and cannot be moved.
- Uses native HTML5 drag while Calendar uses dnd-kit; the two feel different
  and the Kanban drag could not be driven by automation.
- No "Done" column; done disappears to Completed.

### Planner › Completed
*Purpose:* history with minutes and completion notes.
*Works:* table, sort, delete (with confirm).
*Problems:* delete is permanent and removes minutes from timesheet totals with
no trace. Delete icon was a fading 12px SVG; **changed today** to the standard
danger button.

### Ready Now
*Purpose:* Self Assessment and Annual Accounts jobs whose period end has
passed and BM has not closed, in Urgent / Expedite / Deprioritised / Normal
boxes, with a change queue for BM edits.
*Works:* this is the strongest page in the module. The boxes, filters,
Expedite/Deprioritise, Edit → Queue, Feedback popup and CSV all function.
*Problems:*
- Reads `bm_task_schedule` with no paging. The table is 2,431 rows; the API
  silently stops at 1,000. When SA plus Accounts planned rows cross that line,
  jobs vanish from the boxes and the counts with no error.
- Reads every answered `job_review_item` oldest-first with no paging, so the
  *newest* feedback is what gets truncated once cycles accumulate.
- The SQL view `ready_now_jobs` (sql/129) lost the `excluded_at is null`
  predicate from sql/109, so "won't happen" jobs are hidden here but still
  snapshotted into Job Review cohorts. The JS meanwhile has no former-client
  exclusion, which the view has.
- Assignee proposals in the change queue are free-text names; nothing except
  `bm_target` self-heals. `applied_by` is never written.
- Footer says "To change a target, edit it in BM" beside the Edit button that
  queues a BM change.
- 25 jobs are "Urgent" with days-past figures of 268 to 1,634. Urgent has
  stopped meaning anything.

### Bookkeeping Health
*Purpose:* per-client bookkeeping timeliness and hygiene from the nightly QBO
sweep; cases, owners, nudges.
*Works:* board, owner assignment, acknowledge/dismiss, pause, tier, realm
linking.
*Problems:*
- **There is no nudge sender.** 237 nudges are queued (Anne 126). Nothing in
  SQL or edge functions ever sets `state='sent'`. Arming "nudges" in
  /admin/schedules changes the banner text only.
- Every action swallows its error and just reloads; an RLS refusal looks like
  "nothing happened".
- 22 clients are "critical, 115–152 days over", 42 unassigned. Again the
  urgency scale has saturated.

### Capacity › Allocations
*Purpose:* who does which service for which client (inferred from BM, drafts
to change, group reallocation, merge people).
*Works:* the grid, drafts, group modal, CSV.
*Problems:* drafts are "completed" on the Admin task list, not here; reviewer
columns are written but nothing reads them; a typo in a rule's `service` text
silently drops clients from all three Capacity tabs and misattributes revenue
(the same view feeds Billing's fee-earner logic).

### Capacity › Estimates
*Purpose:* minutes per job per client per service.
*State:* **a dead end.** Nothing in SQL, the app or the edge functions reads
`service_effort_overrides`. Demand on the Capacity heatmap comes from the
rule's standard hours, not from here. The "act" badge that compares to
actuals is mis-keyed (`VAT` vs `VAT Returns`, `Annual Accounts` vs `Accounts
Production`) and reads timesheets unpaged.

### Capacity › Capacity
*Purpose:* person × month load against capacity.
*Problems, confirmed:*
- `weekly_capacity_hours` is **never loaded** (the staff query does not select
  it), so every person shows the 35h default regardless of the database.
- Saving it from this screen mutates React state directly and, for anyone who
  is not a portal admin, the database update matches zero rows and reports
  nothing.
- Supply ignores working days, leave and month length (35 × 4.33 every month,
  including for people on three days a week). Demand is rule standard hours.
- Committed "shifts" move nothing except a status flag; Waiting, Calendar and
  Home do not change.
- Unassigned demand is excluded, and past months (the backlog) are not rolled
  forward, so the heatmap is greenest exactly where the problem is.

### Job Review
*Purpose:* monthly stalled-job feedback loop (My Review / Team).
*Works:* the cycle, answers, change requests to Ready Now, nudge emails.
*Problems:* the crons that open the cycle and chase were never armed (sql/090
left them commented out), so the "monthly" loop only happens when a manager
clicks. Refresh cohort cannot update stale items. Two config columns are read
by nothing. `can_view_job_review` exists as a permission but gates nothing.

### Timesheets
*Purpose:* week grid, dashboard, all entries.
*State:* effectively unused, and one core feature has never worked. The live
table carries `CHECK (source IN ('completed','manual'))`; two of the three
write paths insert `'override'` and `'bm_reconciliation'`, fail with 23514,
and the UI swallows it. That is also the only path that sets
`source_task_id`, which is why `logged_hours` is zero on every BM job and
Waiting's "remaining" is fiction. Completing a planner task writes
`completed_tasks.completion_mins`, not a timesheet row. Anyone can select a
colleague's week and "edit" it; RLS blocks the update, the insert succeeds,
duplicates accumulate. No capacity denominator, so "under pressure" cannot be
read from this module at all.

### Triage Board
*Purpose:* clients with an active problem, three views, action plans.
*Works:* well built; templates, drawer, kanban, notifications.
*Problems:* "Put back on hold" puts the case in Not started. Notes/actions are
fetched with an unpaged `.in()` over every case ever. Triage actions are a real
task list (assignee, date, status) that My Tasks cannot see.

### Admin task list, Setup
Admin tasks are the healthiest task stream (132 rows, pipeline stages, BM
confirmation). Setup › Settings' Off/Dry run/Enabled toggle controls nothing;
the copy promises Outlook and chasers that do not exist. The Danger zone
count in the dropdown is over the first 1,000 rows.

---

## 3. Cross-cutting faults

1. **BST date shift.** `formatISO` (`helpers.js:82`) slices `toISOString()`,
   which is UTC. From late March to late October every local-midnight date
   comes out one day early. Confirmed in the database: the 25 Sept test
   occurrence was recorded as `2026-09-24` in both `completed_tasks` and
   `task_progress_notes`. Affects overrides, completions, notes, "Tomorrow",
   and any SQL that reads these dates.
2. **Realtime never connects.** Every planner page load logs 15 failed
   websocket attempts. The URL carries the browser's public API key with an encoded newline
   on the end (`...jmuU%0A`). REST works because fetch trims header values;
   websockets put the key in the query string and it is not trimmed. Result:
   no live updates between colleagues, ever. Fix: strip the trailing newline
   from the Vite public-key environment variable in Vercel, and `.trim()` it in
   `src/lib/supabase.js` so it cannot recur. (Verifying the bundle directly
   was blocked by the credential check; the console evidence is unambiguous.)
3. **Page load mutates data.** The overdue sweep in `WorkPlannerModule.jsx`
   nulls `planned_date` on anyone's tasks two working days after the plan,
   from whichever browser loads the page first, silently. Reschedule logic
   belongs in a cron or a view, not a mount effect.
4. **Deleting one occurrence deleted the series** with no confirmation.
   **Fixed today** with a confirm that says so.
5. **Unbounded reads** against tables over 1,000 rows: Ready Now
   (`bm_task_schedule`, `job_review_item`), Estimates (timesheets), Setup
   (`bm_task_schedule` three ways), Triage notes, `fetchProgressNotes` (an
   `.in()` over every master id), `fetchEntities` (678 rows, close).
6. **Three definitions of capacity** (Waiting 7.5h/day, Capacity 35h/wk,
   Practice Planning 1,400 chargeable hours/yr) and three of demand (rule
   hours, per-client estimates nobody reads, timesheet actuals nobody logs).
7. **Automation that is presented but does not exist:** drift nudges, monthly
   job-review cycle, auto-schedule setting, capacity shifts.
8. **Filter bar shown where it is dead:** Waiting, Bookkeeping Health,
   Allocations, Estimates, Capacity all render the Team/Client/Service/Status
   bar and none of them read it.

---

## 4. Where tasks come from, and what is missing

**Sources that create work items today**

| Source | Creates | Trigger |
|---|---|---|
| BrightManager CSV upload | `bm_task_schedule` (statutory jobs); `quick_tasks` for "NST" rows; `admin_tasks` for import tidy-ups, won't-happen cleanups, NLAC mirror | manual upload at /admin/import |
| Home dashboard "Chase" | `quick_tasks` | click |
| Client page "Raise action", client agenda | `quick_tasks` via `client-agenda` edge function | click |
| CPD tracker | `quick_tasks` (linked) | click |
| Onboarding, BM field overrides, offboarding, person dedup | `admin_tasks` | SQL functions |
| Companies House status events | `triage_cases` | trigger, nightly refresh |
| QBO nightly sweep | `bk_drift_cases`, `bk_drift_nudges` | cron |
| Job review (manual open) | `job_review_item` | manager click |
| Ready Now edits | `ready_now_change_requests` | click |
| Allocations / Capacity | `allocation_changes`, `capacity_shifts` | click |

**Sources that produce no work item, though they know about work**

- **HMRC module.** Penalties, overdue payments, refunds and authorisation gaps
  are all scraped and displayed, and none becomes a task. Bobby's own example
  (penalty appeal) is exactly this gap.
- **Communications inbox.** A client email asking for something creates
  nothing; the Comms module stores the thread on the client page only.
- **Client portal.** Service requests and onboarding step actions raise staff
  *notifications*, not tasks; a notification is read once and gone.
- **Deadline digest, CH accounts-due email.** Both compute the week's deadlines
  and email them; nothing lands on anyone's list.
- **Working papers, VAT review, journal control check.** Findings are recorded
  on the paper, not as work for the bookkeeper.
- **Confirmation statements board, Fee engine gaps, Recurring delivery gaps.**
  Each is its own list with its own "next action" that only exists there.
- **BrightPay / payroll.** No monthly payroll task exists in Athena unless BM
  exports one (15 payroll drafts, all in the past).
- **Bug reports, Ideas.** Have their own boards; fine as they are.

The pattern: Athena is very good at *detecting* work and very poor at *routing*
it to a person with a date. Each detector grew its own table and its own page.

---

## 5. What a practice director cannot see today

- **Who is behind.** The numbers exist (per person: 12 slipped jobs for Magda,
  10 for Margaret, 9 for Tracy in the last 60 days; 6 past-deadline jobs for
  Sophie) but only by SQL. No page shows a person's slipped count.
- **Who is under pressure.** Impossible: capacity is null for everyone,
  timesheets are empty, and demand is the rule's standard hours.
- **What drifted this week.** "Completed" in BM terms means "vanished from the
  export"; 823 rows completed that way, 141 of them past their deadline at the
  time. There is no diff between imports surfaced anywhere except the tidy-up
  admin tasks.
- **One list of everything overdue.** It is split across Home (86 late
  filings), Ready Now (25 urgent), Waiting (111 slipped), Quick (27 overdue),
  Bookkeeping Health (22 critical), Triage, Admin tasks.

---

## 6. Is there a better way? Yes

Keep what works (Waiting's placement engine, Ready Now, Triage, Admin tasks,
the BM importer) and stop building views on the scheduled-task model. The
shape that fits an accountancy practice:

**One spine: the job.** A BrightManager job is already the unit clients,
deadlines and fees hang off. Everything else (chase, penalty appeal, records
request, triage action, agenda item, drift case) becomes an **action on a
job or on a client**, in one table, with assignee, due date, status, minutes.
Quick tasks are actions with no job. Triage actions, agenda actions and
drift nudges are actions with a source. That collapses eleven tables to two
concepts and gives My Tasks something to show.

**Three views, not fourteen tabs.**
- *Today* (each person): my jobs due or scheduled this week, my actions, my
  slipped items, one Done button that asks for minutes and writes the
  timesheet row (`source_task_id` set, so remaining hours become true).
- *Team* (manager): one row per person: scheduled hours next two weeks vs
  capacity, slipped jobs, past-deadline jobs, open actions, minutes logged,
  last activity. Click a cell to get the list. This is the overview page.
- *Client*: already exists on the client page; feed it the same rows.

**Signals, computed in SQL and shown everywhere:** slipped (scheduled date past,
not done), at risk (deadline minus remaining hours inside lead time), stalled
(BM status unchanged for N days, which Job Review already computes monthly),
unassigned, over capacity. Home shows the counts; Team shows the people;
Today shows the items.

**Capacity, one definition:** `weekly_capacity_hours` × the person's working
days, minus leave (a small `staff_leave` table), against scheduled hours from
the rule with per-client overrides where they differ. Retire Estimates unless
it becomes that override.

**Time, one path:** Done → minutes → `timesheet_entries` with
`source_task_id`. Fix the CHECK constraint first. Let BM status changes queue
as change requests the way Ready Now already does.

### Phasing

**P0, fixes (days):** delete confirm (done); BST date function; series-move on
Calendar drag (or remove instance drag until per-occurrence reschedule
exists); public API key newline; timesheet CHECK constraint; load
`weekly_capacity_hours`; page Ready Now's two reads; hide the filter bar on
tabs that ignore it; `ready_now_jobs` predicate; Triage "on hold".

**P1, see (a fortnight):** Team overview page from `bm_task_schedule` +
`quick_tasks` + `triage_actions` + `admin_tasks`; Today view; slipped and
past-deadline flags; hide Scheduled/Calendar/Kanban/Completed behind a flag
until they have a purpose.

**P2, record (a month):** Done + minutes on BM jobs; timesheet link; capacity
with working days and leave; retire or repurpose Estimates; arm job-review
crons; either build the drift nudge sender or remove the queue.

**P3, act:** the quick tools below.

---

## 7. Quick tools to complete tasks (last, and the hardest)

The building blocks already exist: `triage_action_templates` with ordered
steps, `comm_templates` for client emails (Resend, BCC to the mailbox),
`client_agenda_items` that write tasks, the Google Calendar connector, the
portal's service requests, and the Ready Now change queue for BM edits.
What is missing is a **playbook**: a named sequence of steps for a task type,
where each step is one of email / document / calendar / portal request /
status change / follow-up task, rendered as a checklist on the job and
executed by the system where it can be.

Candidates Bobby named, sketched:

- **Penalty appeal.** Trigger from the HMRC module (penalty seen) or manually.
  Steps: capture penalty details and reason from a short form; generate the
  appeal letter from a template with the client's facts; send by Resend (or
  file to Drive for HMRC's portal); log the submission on the client; raise a
  follow-up action at +30 days; close when HMRC responds (manual). Time logged
  on completion.
- **Schedule a client meeting.** Steps: pick two or three slots from the
  owner's calendar; email the client with the slots (comm template); on reply,
  create the calendar event and the agenda item; the agenda item already
  becomes a task.
- **Ask for information.** Steps: choose the records list for the service
  (accounts, SA, VAT); send the request (email, or portal request so it is
  tracked); queue the BM status change to "Records Requested"; chase at +7
  and +14 days automatically (the reminders engine already does cadence);
  stop when the portal upload or a reply lands.

**How to get there:** run one short session per task type with the person who
does it most (Sophie for chases and records, Tracy/Yvonne for accounts,
Bobby for appeals). Capture: the trigger, the inputs they look up, the
artefact they produce, who they tell, what they wait for, and how they know
it is finished. Write each as a playbook row set. Build the runner once; add
playbooks as data. Start with "Ask for information" because it is the most
frequent, touches the most existing machinery, and its success is measurable
(days from request to records received, which Ready Now already tracks).

---

## 8. Changed today

- `ActionPopover.jsx`: the row action menu now uses the platform's button
  kinds (secondary for Open / Done / Not required, danger for Delete), the
  fake green "Done" flash before the modal is gone, and Delete confirms,
  warning when it will remove a whole recurring series.
- `MyTasksView.jsx`, `QuickTasksView.jsx`: the unlabelled blue ▶ is now a
  standard secondary "Actions" button (the Quick one was titled "Complete").
- `KanbanView.jsx`: "+ note" is the standard secondary "+ Add note".
- `CompletedView.jsx`: the fading bin icon is the standard danger "Delete".

Lint passes. Not committed at the time of writing: another workstream has
`sql/301_client_pricing_drivers.sql` and the `fee-proposal` edge function
staged, and the security gate binds a commit to the whole staged diff, so
this change waits until that diff has its own audit pass.

## 9. Not verified

- Kanban drag (native HTML5 drag; automation cannot drive it).
- Waiting drag, Approve, Plan 9 months (live BM rows).
- The bundle's public API key literal (credential check blocked reading it); the
  websocket URL in the console is the evidence.
