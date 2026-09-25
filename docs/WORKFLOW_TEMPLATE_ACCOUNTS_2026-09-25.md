# Workflow template: annual accounts (worked example for correction)

A draft for Bobby and Sophie to correct. Nothing here is built. The point is
to agree the stages, the dates they hang off, what has to be true before each
one, how the system knows it happened, and what moves when it does not.

Grounded in what Athena already holds: the BrightManager job pair for a set of
accounts (**Accounts Preparation** and **Companies House Submission**, year
end in the task name, statutory deadline on the row), the **CT600 Submission**
job under Corporation Tax, the BM status ladder (No Latest Action → Records
Requested → Records Received → In Progress → Queries Requested → To Review →
Reviewed → To Send to Client to Approve → Awaiting Approval), the scheduling
rule hours (5h preparation, 0.5h filing, 0.5h CT600), the Accounts Reviewer
per client in `service_reviewers`, the fee-earner manager per service, the
client cadence flag (early / normal / late) and the Companies House nightly
refresh, which knows the day accounts are actually filed.

---

## 1. Variables the template reads

| Variable | Source today | Notes |
|---|---|---|
| **YE** (year end) | `derive_period_end()` from the BM task name | anchor for everything |
| **CH deadline** | `bm_deadline` on the Companies House Submission row | YE + 9 months (first accounts differ; BM carries the right date) |
| **CT600 deadline** | `bm_deadline` on the CT600 Submission row | YE + 12 months |
| **CT payment date** | computed | YE + 9 months + 1 day; a diary note, not a job |
| **Preparer** | BM assignee of Accounts Preparation | |
| **Reviewer** | `service_reviewers` (Accounts Reviewer) | falls back to the fee-earner manager |
| **Client manager** | `client_service_allocations.fee_earner_manager_id` | owns the meeting and client comms |
| **Meeting?** | **does not exist yet** | no service in the catalogue or per client says "annual meeting"; needs a flag (question 1) |
| **Cadence** | `entities.cadence_preference` | 631 normal, 1 early; shifts the whole timeline by ±2 weeks |
| **Books with us?** | bookkeeping allocation exists | if we keep the books, "records" means a close, not a request (question 6) |
| **Hours** | rule standard hours, per-client override | 5h prep, 0.5h file, 0.5h CT600 |

---

## 2. The stages

Offsets are from YE unless stated. "Working day" means the person's working
days; a date that lands on a weekend or bank holiday rolls forward. Hours are
the placement engine's demand, so capacity sees them.

### Variant A: client has an annual meeting

| # | Stage | Kind | Owner | Due | Gate (must be true first) | Done when | If not done by due |
|---|---|---|---|---|---|---|---|
| 1 | Request records | client comms | client manager | YE + 5 working days | job exists | request sent (email or portal request logged) | overdue action on Today |
| 2 | Chase records | client comms | client manager | 1 + 2 weeks, then + 4 weeks | stage 1 done, stage 3 not done | as 1 | repeats until 3 is done; third chase escalates to manager |
| 3 | Records in | milestone | client | **YE + 3 months** | | BM status Records Received, or portal upload, or manual tick | every later stage shifts by the delay; job flagged *waiting on client* |
| 4 | Prepare accounts | work, 5h | preparer | placed by capacity between stage 3 and stage 5 due, no later than stage 5 due − 5 working days | stage 3 done | BM status To Review, or preparer marks done | re-placed at next capacity; if that passes stage 5 due, stage 5 slips |
| 5 | Internal review | work, 1h | reviewer | **meeting − 2 weeks** | stage 4 done | BM status Reviewed, or reviewer marks done | meeting slips by the delay |
| 6 | Client meeting | calendar | client manager | **YE + 6 months**, w/c the nearest Monday | stage 5 done | calendar event held (agenda item closed) | reschedule playbook: propose new slots, move stages 7 to 9 |
| 7 | Approval | client comms | client manager | meeting + 2 weeks | stage 6 done | BM status Awaiting Approval → approval received (signed) | chase at +1 week, +2 weeks |
| 8 | File at Companies House | work, 0.5h | preparer | **YE + 7 months**, never later than CH deadline − 10 working days | stage 7 done | Companies House refresh shows the new made-up-to date | at risk when the buffer is gone; urgent at CH deadline − 10 working days |
| 9 | CT600 | work, 0.5h | preparer | stage 8 + 2 weeks, never later than CT600 deadline − 10 working days | stage 8 done | BM job disappears / HMRC shows filed | as 8 |
| 10 | CT payment reminder | client comms | client manager | YE + 9 months − 3 weeks | stage 9 done or accounts approved | reminder sent | none; informational |

### Variant B: no meeting

Stages 1 to 5 as above. Then:

| # | Stage | Kind | Owner | Due | Gate | Done when | If not done |
|---|---|---|---|---|---|---|---|
| 6 | Send for approval | client comms | preparer | **YE + 6 months** | stage 5 done | BM status To Send → Awaiting Approval | overdue action |
| 7 | Approval | as A7 | | send + 2 weeks | | | chase at +1, +2 weeks |
| 8 to 10 | as A8 to A10 | | | | | | |

### Timeline shape (normal cadence)

```
YE   +1wk      +3mo          +5.5mo   +6mo       +6.5mo   +7mo      +7.5mo   +8.3mo   +9mo(stat)
|----|---------|--------------|--------|----------|--------|---------|--------|--------|
 request   records in     review   meeting   approval  file CH   CT600   CT reminder  CH deadline
           (chases at +2w, +6w)     prepare placed in here by capacity
```

Early cadence pulls stages 3 to 8 two weeks earlier; late pushes them two
weeks later but never past the hard limits on 8 and 9.

---

## 3. Worked example: year end 31 December 2025, meeting client, normal cadence

| Stage | Due | Owner |
|---|---|---|
| Request records | Thu 8 Jan 2026 | client manager |
| Chase 1 / chase 2 | 22 Jan / 19 Feb | client manager |
| Records in | Tue 31 Mar | client |
| Prepare (5h) | placed between 1 Apr and Fri 5 Jun by capacity | preparer |
| Internal review | Mon 15 Jun | reviewer |
| Client meeting | w/c Mon 29 Jun | client manager |
| Approval | Mon 13 Jul | client |
| File at Companies House | Fri 31 Jul (hard: 16 Sep) | preparer |
| CT600 | Fri 14 Aug (hard: 17 Dec) | preparer |
| CT payment reminder | Thu 10 Sep, payment 1 Oct | client manager |
| Companies House deadline | Wed 30 Sep 2026 | |

**Same client, records arrive 5 weeks late (5 May):** prepare is re-placed
from 6 May; review moves to 20 Jul; meeting to w/c 3 Aug; approval 17 Aug;
filing target 4 Sep, which is inside the 10-working-day buffer before 16 Sep,
so the job shows **at risk** on the Team page from 5 May, not on 16 Sep. Ready
Now already counts this job; the difference is that the reason (records) and
the date it went wrong are visible.

**Same client, records arrive 12 weeks late (23 Jun):** the recomputed
filing date would pass the hard limit, so stages 4 to 8 compress to the hard
dates, the meeting is offered as a post-filing review instead of a
pre-filing one, and the job is **urgent** from 23 Jun with "records 12 weeks
late" as the cause.

---

## 4. How the engine behaves

- **Instantiate** milestones when a BM accounts job first appears, for year
  ends within the last 9 months. Older jobs get only the stages still ahead.
- **Recompute nightly.** For each unmet stage: if its gate stage is done,
  keep the date; if the gate slipped, shift by the same delay; clamp to hard
  limits; re-place work stages through the existing placement engine so
  capacity is respected. Never move a stage a person has pinned.
- **Read done signals** from BM status on each import, from the Companies
  House refresh, from portal uploads, from calendar events and agenda items,
  and from a manual tick on the job. Any one is enough.
- **Where it shows.** Today: my stages due this week. Calendar (week
  planner): everyone's stages and placed work. Stage board: each job in the
  column of its furthest completed stage, filter by person. Client page: the
  timeline. Team: counts of slipped, at risk, waiting on client.
- **Comms stages** run the matching playbook when one exists (records
  request template, chaser cadence from the reminders engine, meeting slots
  from the calendar) and otherwise create an action for the owner.

## 5. Data shape (for later, so the template is data not code)

- `workflow_templates`: service, name, applies when (meeting flag, books
  with us, entity type).
- `workflow_stages`: template, sequence, key, label, kind (comms / milestone /
  work / calendar), owner role, anchor (YE / prior stage / statutory), offset,
  working-day rule, gate stage, done signal, slip rule, hard limit, hours,
  comms template.
- `job_milestones`: job, stage key, due date, planned date, status, done at,
  signal that closed it, pinned by.

A client override is a row that replaces one stage's offset for one client,
the same idea as `client_task_overrides` today.

---

## 6. Questions for Bobby and Sophie

1. **Meeting flag.** Where should "this client gets an annual meeting" live: a
   service line in the catalogue (so it is priced), or a flag on the client?
2. **Offsets.** Records by month 3, meeting at month 6, file by month 7: right
   for the default? Which clients should be early or late?
3. **Reviewer.** Is the Accounts Reviewer in Athena the right person for stage
   5 for every client, and is one hour the right allowance?
4. **Chase cadence.** Two weeks then four, third chase escalates: match how
   Sophie actually chases?
5. **What counts as records in.** BM's Records Received, a portal upload, or
   Sophie's judgement? Part Records Received: start preparing or wait?
6. **Books with us.** For bookkeeping clients, stage 1 to 3 become "close the
   books to year end" for the bookkeeper by YE + 6 weeks. Agree?
7. **Corporation tax.** Same workflow (as drafted) or its own?
8. **Sole traders and partnerships.** Same shape with SA dates, or leave
   them on the Self Assessment flow for now?
9. **Hard buffers.** Ten working days before each statutory date: too much,
   too little?
10. **Who may pin.** Anyone on their own stages, or managers only?
