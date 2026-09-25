# Workflow template: annual accounts (draft 2, with Bobby's answers)

Nothing here is built. This is the agreed default flow for a set of accounts,
the rules the engine follows, and the "Plan the Job" step where a user adjusts
the default before it is committed.

Grounded in what Athena already holds: the BrightManager job pair for a set of
accounts (**Accounts Preparation** and **Companies House Submission**, year
end in the task name, statutory deadline on the row), the **CT600 Submission**
job under Corporation Tax, the BM status ladder (No Latest Action → Records
Requested → Records Received → In Progress → Queries Requested → To Review →
Reviewed → To Send to Client to Approve → Awaiting Approval), the scheduling
rule hours (5h preparation, 0.5h filing, 0.5h CT600), the Accounts Reviewer
per client in `service_reviewers`, the fee-earner manager per service, the
client cadence flag (early / normal) and the Companies House nightly refresh,
which knows the day accounts are actually filed.

---

## 1. Decisions taken (25 Sept 2026)

| Topic | Decision |
|---|---|
| Meeting | A **service line** the client buys. Overridable either way when the job is planned. |
| Cadence | Early is by design (cadence flag). Late is not by design; it happens and the engine handles it. |
| Reviewer | The Accounts Reviewer in Athena, one hour. |
| Chases | Two weeks after the request, then four; the third chase escalates. |
| Records in | **BM status Records Received.** Nothing else closes the stage. |
| Bookkeeping clients | Stages 1 to 3 become "close the books to year end" for the bookkeeper by **YE + 6 weeks**, which lines up with the VAT return window. |
| Corporation tax | Due 12 months after year end, but mirrored with the accounts and **filed the same day**. |
| Sole traders and partnerships | Own variant (section 4): deadline 31 January after the tax year to 5 April; the relevant accounting year end is the one that falls inside that tax year. |
| Hard buffers | Ten working days before each statutory date. |
| Pinning | Anyone can pin a stage. |
| Turnaround | **At least one month** between records received and the client meeting. |
| Unplanned jobs | Accounts jobs due within the next seven months with no workflow yet are flagged (section 5). |

---

## 2. Variables the template reads

| Variable | Source | Notes |
|---|---|---|
| **YE** | `derive_period_end()` from the BM task name | anchor for everything |
| **CH deadline** | `bm_deadline` on the Companies House Submission row | YE + 9 months; BM carries first-accounts exceptions |
| **CT600 deadline** | `bm_deadline` on the CT600 Submission row | YE + 12 months; filed with the accounts in practice |
| **CT payment date** | computed | YE + 9 months + 1 day; a reminder, not a job |
| **Preparer** | BM assignee of Accounts Preparation | |
| **Reviewer** | `service_reviewers` (Accounts Reviewer) | falls back to the client manager |
| **Client manager** | `client_service_allocations.fee_earner_manager_id` | owns the meeting and client comms |
| **Meeting?** | a service line on the client; override at Plan the Job | the service line does not exist in the catalogue yet |
| **Cadence** | `entities.cadence_preference` | early pulls the timeline forward two weeks |
| **Books with us?** | a bookkeeping allocation exists | switches stages 1 to 3 to "close the books" |
| **Hours** | rule standard hours, per-client override | 5h prep, 1h review, 0.5h file, 0.5h CT600 |

---

## 3. The stages: limited company

Offsets are from YE unless stated. Dates roll forward to the owner's next
working day. Hours are what the placement engine sees, so capacity counts them.

### Variant A: client has an annual meeting

| # | Stage | Kind | Owner | Due | Gate | Done when | If not done by due |
|---|---|---|---|---|---|---|---|
| 1 | Request records | client comms | client manager | YE + 5 working days | job exists | request logged | overdue action on Today |
| 2 | Chase records | client comms | client manager | 1 + 2 weeks, then + 4 weeks | 1 done, 3 not done | as 1 | third chase escalates to the client manager's manager |
| 3 | Records in | milestone | client | **YE + 3 months** | | **BM status Records Received** | every later stage shifts by the delay; job flagged *waiting on client* |
| 4 | Prepare accounts | work, 5h | preparer | placed by capacity between 3 and 5, done no later than 5 due − 5 working days | 3 done | BM status To Review | re-placed at next capacity; if that passes 5, 5 slips |
| 5 | Internal review | work, 1h | reviewer | meeting − 2 weeks | 4 done | BM status Reviewed | meeting slips |
| 6 | Client meeting | calendar | client manager | **YE + 6 months**, w/c nearest Monday; **never earlier than 3 done + 1 month** | 5 done | calendar event held | reschedule playbook: new slots offered, 7 to 9 move |
| 7 | Approval | client comms | client manager | meeting + 2 weeks | 6 done | BM status Awaiting Approval, then signed | chase + 1 week, + 2 weeks |
| 8 | File at Companies House | work, 0.5h | preparer | **YE + 7 months**, hard limit CH deadline − 10 working days | 7 done | CH refresh shows the new made-up-to date | at risk when the buffer is gone |
| 9 | File CT600 | work, 0.5h | preparer | **same day as 8**, hard limit CT deadline − 10 working days | 7 done | job leaves BM | as 8 |
| 10 | CT payment reminder | client comms | client manager | YE + 9 months − 3 weeks | 9 done | reminder sent | none |

### Variant B: no meeting

Stages 1 to 5 as above, then:

| # | Stage | Kind | Owner | Due | Gate | Done when |
|---|---|---|---|---|---|---|
| 6 | Send for approval | client comms | preparer | YE + 6 months, never earlier than 3 done + 1 month | 5 done | BM status To Send → Awaiting Approval |
| 7 to 10 | as A7 to A10 | | | | | |

### Variant C: we keep the books

Stages 1 to 3 are replaced by one stage:

| # | Stage | Kind | Owner | Due | Done when |
|---|---|---|---|---|---|
| 1 | Close the books to year end | work, 2h | bookkeeper | **YE + 6 weeks** | bookkeeper marks done, or BM status Records Received |

Then A4 or B4 onward. The one-month rule runs from the close.

### Timeline shape (normal cadence, meeting client)

```
YE  +1wk      +3mo           +5.5mo  +6mo      +6.5mo   +7mo         +8.3mo       +9mo (statutory)
|---|---------|---------------|-------|---------|--------|-------------|------------|
 request   records in       review  meeting  approval  file CH+CT   CT reminder   CH deadline
           chases +2w, +6w    prepare placed in here by capacity
```

---

## 4. The stages: sole traders and partnerships

The tax year runs 6 April to 5 April; the return is due 31 January after it.
The relevant accounting year end is the one that falls inside the tax year,
so accounts to 30 April 2025 belong to 2025/26 and are due 31 January 2027,
although they can be prepared from 1 May 2025.

Same stages as section 3, with two changes:

- **Anchor** is still the accounting year end, so records are requested and
  chased at YE + 1 week and YE + 3 months, and preparation is placed from
  records in. Early completion is the point: the tax bill becomes known well
  before the January payment.
- **Hard limit** is 31 January − 10 working days for the SA800 or SA100
  submission. The filing target stays YE + 7 months, which for a 30 April
  year end is the end of November, fourteen months before the deadline. The
  engine never pulls a target past the hard limit but it will let one sit
  early.
- **Payment reminders** replace the CT stage: 31 January balancing payment
  and first payment on account, 31 July second payment on account, each with
  a reminder three weeks ahead.

For partnerships the SA800 partnership return and each partner's SA100 hang
off the same accounts; the partners' returns are separate BM jobs and follow
the Self Assessment flow with the partnership accounts as their gate.

---

## 5. Plan the Job

The workflow is not applied silently. When an accounts job appears from
BrightManager, Athena proposes the chain above and someone confirms it. That
is the same draft → approve → commit lifecycle Waiting already uses, applied
to the whole chain rather than one placement date.

**The screen.** One job, the proposed stages as a vertical timeline with
dates, owners and hours. Controls per stage: move the date (within its hard
limit and the one-month rule), change the owner, pin it, or remove it
(meeting on or off, which is the service-line override). A note field. Commit
writes the milestones; the nightly engine maintains them from then on and
never moves a pinned stage.

**Who plans.** Open question, see section 8.

**When.** As soon as the job appears, and in any case before the records
request is due. Jobs with a statutory date inside the next seven months and
no committed plan are flagged as **unplanned** on the Team page and on Home,
with an action on the planner's Today list. Seven months is YE + 2, so a
job flagged unplanned has already missed the records request date.

**Batch.** Most jobs will take the default unchanged, so Plan the Job also
works as a list: tick the jobs that take the default, commit them together,
open the exceptions one at a time.

---

## 6. Worked example: year end 31 December 2025, meeting client, normal cadence

| Stage | Due | Owner |
|---|---|---|
| Request records | Thu 8 Jan 2026 | client manager |
| Chase 1 / chase 2 | 22 Jan / 19 Feb | client manager |
| Records in | Tue 31 Mar | client |
| Prepare (5h) | placed 1 Apr to Fri 5 Jun by capacity | preparer |
| Internal review | Mon 15 Jun | reviewer |
| Client meeting | w/c Mon 29 Jun | client manager |
| Approval | Mon 13 Jul | client |
| File CH and CT600 | Fri 31 Jul (hard: 16 Sep and 17 Dec) | preparer |
| CT payment reminder | Thu 10 Sep, payment 1 Oct | client manager |
| Companies House deadline | Wed 30 Sep 2026 | |

**Records five weeks late (5 May):** prepare re-placed from 6 May; the
one-month rule puts the earliest meeting at 5 June, but review needs two
weeks after preparation so the meeting lands w/c 20 Jul; approval 3 Aug;
filing target 17 Aug, still outside the buffer. The job shows **slipped,
waiting on client** from 1 April and the new dates from 5 May.

**Records twelve weeks late (23 Jun):** the one-month rule gives a meeting
no earlier than 23 July; review 9 July needs preparation done by 2 July,
which capacity may not allow. The engine compresses towards the hard dates,
the filing target becomes 4 Sep inside the buffer, and the job is **at risk**
from 23 June with "records 12 weeks late" as the cause. If the compression
fails the hard limit, the meeting flips to a post-filing review and the job
is **urgent**.

---

## 7. How the engine behaves

- **Instantiate** a proposed chain when a BM accounts job first appears, for
  year ends within the last nine months. Older jobs get only the stages still
  ahead. The chain is a draft until Plan the Job commits it.
- **Recompute nightly** for committed chains. For each unmet stage: gate done
  keeps the date; gate slipped shifts by the same delay; apply the one-month
  rule; clamp to hard limits; re-place work stages through the placement
  engine so capacity is respected. Never move a pinned stage.
- **Read done signals** from BM status on each import, from the Companies
  House refresh, from calendar events and agenda items, and from a manual
  tick on the job. Records in is BM status only.
- **Where it shows.** Today: my stages due this week. Calendar (week
  planner): everyone's stages and placed work. Stage board: each job in the
  column of its furthest completed stage, filter by person. Client page: the
  timeline. Team: counts of unplanned, slipped, at risk, waiting on client.
- **Comms stages** run the matching playbook when one exists (records request
  template, chaser cadence from the reminders engine, meeting slots from the
  calendar) and otherwise raise an action for the owner.

## 8. Data shape (so the template is data, not code)

- `workflow_templates`: service, name, applies when (meeting service, books
  with us, entity type).
- `workflow_stages`: template, sequence, key, label, kind (comms / milestone
  / work / calendar), owner role, anchor (YE / prior stage / statutory),
  offset, working-day rule, gate stage, done signal, slip rule, minimum gap,
  hard limit, hours, comms template.
- `job_plans`: job, template, status (draft / committed), planned by, at.
- `job_milestones`: plan, stage key, due date, planned date, owner, status,
  done at, signal that closed it, pinned by, note.

A client override is a row that replaces one stage's offset for one client,
the same idea as `client_task_overrides` today.

## 9. Open

- **Who plans the job**: the client manager, the preparer, or whoever the
  unplanned flag lands on?
- The meeting service line needs adding to the catalogue and to each
  client who has one before the default can pick it up.
