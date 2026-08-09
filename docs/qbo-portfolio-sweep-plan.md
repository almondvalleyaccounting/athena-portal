# QBO portfolio sweep — build plan

**Status:** proposed, not started
**Written:** 9 August 2026
**Scope:** Athena (`athena-portal-build`) + the BrightPay journal runner (`BrightPay Payments and Journals`)

Covers four asks that turn out to be one piece of infrastructure:

1. Fill the `realm_id ↔ client` identity link
2. PAYE control-account drift detection
4. QBO connection keep-alive
5. Portfolio-wide bookkeeping hygiene

Plus **Phase 0**, a duplicate-journal check that is time-critical and should go
first regardless of the rest.

(Numbering follows the original options list; 3 and 6 were not selected.)

---

## 1. Why this is one job, not four

Only **4 of 128 realms** have any data in `qbo_dashboard_cache`. The cache fills
only when a member of staff opens a client dashboard. No scheduled job touches
client realms at all — `qbo-pull-nightly` and `planning-qbo-nightly-pull` are
both AVA's own books.

That single gap explains all four asks:

| Ask | What it actually needs |
|---|---|
| #4 keep-alive | Something to touch each realm periodically |
| #5 portfolio hygiene | The `file_health` metric populated for every client |
| #2 PAYE drift | One more metric on the same per-realm pass |
| #1 identity link | A pass over every realm that can write the match |

A nightly sweep over all realms delivers #4 as a by-product, feeds a portfolio
page that **already exists and is starved of data**, and is the natural carrier
for the other two.

---

## 2. What already exists — do not rebuild

| Asset | Where | State |
|---|---|---|
| Per-realm token resolution + refresh | `supabase/functions/dashboard-qbo-pull/index.ts` | Working; `qbo_report_tokens` → `qbo_connections` fallback |
| Generic QBO fetch for any v3 endpoint | same, `qboFetch` / `qboQuery` | Working |
| `file_health` metric | same | Working (uncategorised, undeposited funds, OBE, unreconciled bank items) |
| Metric cache | `qbo_dashboard_cache` (realm + metric_key + period) | Working, near-empty |
| Portfolio view of cached health | `src/modules/client-dashboard/PortfolioDashboardPage.jsx` | **Built.** Reads `file_health` from cache. Needs data, not code |
| General Ledger / Trial Balance per client | `src/modules/reports/ReportsPage.jsx` | Working, but routes via Apps Script to Drive — human-facing, not machine-comparable. Do not reuse for recon |
| Chunked nightly cron pattern | `ch-refresh-nightly` (`*/5 1-3 * * *` → `run_ch_refresh_chunk()`) | Copy this shape |
| Journal run state | `payroll.task` / `payroll.employer` (same Supabase project) | Working |

The BrightPay runner and Athena **share one Postgres database**
(project `neksyvneljgxvpchwgch`); the runner uses a restricted `payroll_runner`
role scoped to the `payroll` schema. Reconciliation is a join, not an
integration.

---

## 3. Phase 0 — duplicate journal check (urgent, do first)

### Why it can't wait

The catch-up run now spans **2026-04-01 → 2026-07-31 with 145 posted journals**.
The old Cowork automation already posted into some of those same client ledgers
for April–June.

`payroll.task`'s `UNIQUE (employer_id, kind, period_start, period_end)` prevents
*this* process double-posting. It has no knowledge of what Cowork put in
QuickBooks. **A database constraint cannot see QuickBooks.** Every month that
passes makes the duplicates harder to unpick and more likely to be sitting in a
filed VAT period or a closed month.

### Step 0.1 — pin the journal signature (blocking, ~1 hour)

Nothing here is safe to automate until we know what a BrightPay posting looks
like in QBO. Against one known-good July client:

```
query select * from JournalEntry where TxnDate >= '2026-07-01' and TxnDate <= '2026-07-31'
```

Record: does BrightPay create `JournalEntry` objects at all; what goes in
`DocNumber`, `PrivateNote` and line `Description`; is there anything that
identifies BrightPay as the source; does `MetaData.CreateTime` distinguish the
Cowork era from the current run.

**This is the one unverified link in the whole plan.** If BrightPay posts
something other than a `JournalEntry`, matching rules change and Phase 0 needs
re-scoping. Everything downstream assumes a stable signature.

`CreateTime` is the most promising discriminator: Cowork's postings were created
weeks before the catch-up run's, so even without a source marker the two eras
should separate cleanly on creation timestamp.

### Step 0.2 — the check

One-off script (not an edge function yet), read-only, per realm across
2026-04-01 → 2026-07-31:

| Finding | Rule |
|---|---|
| **Duplicate** | ≥2 journals, same period, same total |
| **Near-duplicate** | ≥2 journals, same period, totals within a rounding tolerance |
| **Missing** | `payroll.task.state='posted'` with no matching journal in QBO |
| **Amount mismatch** | Journal found, total ≠ `payroll.task.amount` |
| **Orphan** | Journal in the window with no corresponding task row |

Output a workbook per client, not a summary — these need human adjudication
before anything is reversed. **Nothing in this phase writes to QuickBooks.**

### Step 0.3 — close the loop

`REBUILD-SPEC.md` §6 already specifies this and it was never built:

```
3. UPDATE task SET state='posted'
4. Verify against QuickBooks API      ← does not exist
5. UPDATE task SET state='verified'   ← does not exist
```

`store.js` has a `verified(taskId, evidence)` method. Nothing calls it. All 145
rows sit at `posted`, which today means only *BrightPay's screen showed no
error*. Wire step 4/5 so a clean match promotes the row to `verified` with the
QBO journal id as `evidence`.

### Known findings waiting on this

Two July rows carry `ea_status='not_mapped'` — the journal posted, the
Employment Allowance did not:

| Client | EA not posted |
|---|---|
| LA Travel Ltd | £2,030.27 |
| Local Planet Solutions Ltd (*Why Settle Technology*) | £1,743.47 |

This is the same damage class the rebuild exists to prevent. Phase 0 confirms
the actual ledger impact.

---

## 4. Phase 1 — the identity spine (#1)

### The problem

- `qbo_report_connections.entity_id` — **NULL on all 146 rows**
- `payroll.employer.destination_realm` — **NULL on all 99 rows**

There is no durable link between a QuickBooks realm and a client in either
system. Name matching gets 72 of 96 active QBO employers (62 with live tokens),
and it will never close the tail, because the names diverge permanently:

| BrightPay sheet name | QBO company |
|---|---|
| MTG Enterprises Ltd | Merlin Travel |
| Local Planet Solutions Ltd | Why Settle Technology |
| Thee Olive Music Lounge | The Olive Music Lounge Ltd |

Encouragingly, **all 34 employers that posted a July journal matched a
connection with a live token** — so the working cohort is fully covered today.
The tail is the risk, not the core.

### The work

1. Migration (`sql/192_*` — *check the next free number, 188 and 189 are already
   duplicated across parallel workstreams*): index/constraint support for the
   link. No new table needed.
2. In the sweep (Phase 2), on each realm: attempt a normalised-name match to
   `entities`; write `entity_id` on confidence, queue the rest for manual
   resolution.
3. Small admin screen: unmatched realms, pick the client, save. One-time
   clearance of ~20–30 rows, then it stays clean.
4. **When the BrightPay runner posts, capture the realm id** into
   `payroll.employer.destination_realm`. The runner already asserts the
   destination company name on screen before sending; the realm should be
   recorded at the same moment. This is the permanent fix for the matching tail
   and belongs in the runner, not in Athena.

Do not attempt a bulk auto-match without review — a wrong realm↔client link
puts one client's financials on another's page.

---

## 5. Phase 2 — the sweep (#4 + #5)

### Shape

New edge function `qbo-sweep` (or extend `dashboard-qbo-pull` with a
service-role batch mode — prefer a separate function so the interactive path
stays untouched).

```
cron: */5 1-3 * * *   →  run_qbo_sweep_chunk()
```

Copy `ch-refresh-nightly` exactly: take the N least-recently-swept realms,
process, record, exit. Never iterate all 128 in one invocation — edge functions
time out and Intuit throttles per realm.

Per realm, per pass:
- refresh the token (this *is* #4)
- pull `file_health` and headline metrics into `qbo_dashboard_cache`
- attempt the identity match (Phase 1)
- record outcome in a sweep log: ok / needs-reconnect / error

### What this delivers on day one

- **#4 keep-alive.** Refresh tokens roll on use and die after ~100 days unused.
  The soonest `refresh_token_expires_at` is **30 October 2026**, and 124 realms
  are currently untouched. Without this, connections start failing in autumn and
  each one costs a client interaction to restore. The sweep also produces an
  accurate live "needs reconnect" list — which is why chasing the ~18 tokenless
  connections *before* the sweep exists is wasted effort.
- **#5 portfolio hygiene.** `PortfolioDashboardPage` already renders
  `file_health`. Populating the cache turns an existing page on. Follow-up (not
  day one): a portfolio-wide ranked view rather than just starred clients, and a
  feed into job review.

### Rate limits — verify before scaling

Intuit throttles per realm and per app. Confirm current limits against Intuit's
developer docs before choosing chunk size; start deliberately small (5–10 realms
per invocation) and widen once the sweep log shows headroom. Getting this wrong
risks throttling the interactive dashboard, which staff use during the day —
hence the 01:00–03:00 window.

### Practice-financials guard

`qbo_report_connections.is_practice` is true on AVA's own realm, and access is
restricted to `can_view_practice_financials` (Bobby, Tracy, Yvonne) via
RESTRICTIVE RLS on the connections and cache tables. **The sweep runs as
service-role and must not become a way around that.** Any portfolio view built
on swept data has to re-apply the practice filter, exactly as
`dashboard-qbo-pull` re-checks the flag imperatively today.

---

## 6. Phase 3 — PAYE control drift (#2)

Last, because it needs the most genuinely new work.

### Two constraints found

1. **The existing `accounts` metric returns P&L accounts only** (Revenue /
   Expense, for the owner-cost nominal pickers). PAYE control is a balance-sheet
   liability, so it is not reachable through the current metric — this needs a
   new account pull, not a config change.
2. **HMRC history is one month deep.** As of 09/08/2026 17:00 `payroll.task` holds
   79 `hmrc` rows (44 posted, 35 not_required) covering 2026-07-06 → 2026-08-05
   — up from 1 earlier the same day, as the run worked through. So the "what
   BrightPay says is due" side now exists, but with a single period there is no
   trend to compare against yet.

### Therefore: build it QBO-only first

A PAYE control balance that ratchets upward month after month and never clears
is self-evidently a problem without needing BrightPay's figure. Ship that as a
drift check on the sweep:

- new metric pulling balance-sheet liability accounts per realm
- identify the PAYE/HMRC control account (name heuristic + per-client override —
  charts of accounts differ, so assume a manual override table will be needed)
- flag: balance rising for N consecutive months with no clearing payment

Add the BrightPay comparison later, once HMRC tasks accumulate enough history to
be worth comparing against.

**Advisory value:** this is the only proposal here that surfaces something about
the *client* rather than about our own work quality. A client quietly not paying
HMRC is a risk we currently have no portfolio-wide way to see.

---

## 7. What this plan deliberately does not do

**It does not use Athena's QBO connection as a pre-flight check on BrightPay's
connection health.** `REBUILD-SPEC.md` §7.5 rules that out (Bobby, 9 Aug 2026):
the two are separate authorisations with QBO and do not track each other. Pass 0
of the journal run must keep using BrightPay as the authority on BrightPay.

Everything above is the opposite direction — reading QBO *after* the fact as
evidence of what landed. That is not a proxy for anything; it is the primary
record, and §6 of the same spec already asks for it.

---

## 8. Sequencing and dependencies

```
Phase 0.1  pin journal signature      ── blocking, ~1 hour
   │
Phase 0.2  duplicate/missing check    ── urgent, days
Phase 0.3  wire verified() state      ──┐
   │                                    │
Phase 1    identity spine             ──┤ Phase 1 can start in parallel
   │                                    │ with 0.2/0.3
Phase 2    the sweep  (#4 + #5)       ──┘ needs Phase 1's matching logic
   │
Phase 3    PAYE drift (#2)            ── needs Phase 2 running
```

Phase 0 stands alone and does not depend on any of the rest. If nothing else in
this document gets built, Phase 0 should still happen.

---

## 9. Open decisions

1. **Duplicate remediation.** When Phase 0.2 finds a genuine duplicate, who
   reverses it and how? Reversing journals in client ledgers is not something
   this plan should automate. Needs a named human process, and a check on
   whether the period is closed or VAT-filed.
2. **Portfolio hygiene scope.** Starred clients only (existing page), or a
   ranked all-clients view? The latter is more useful and more work.
3. **PAYE account identification.** Heuristic-plus-override assumed above.
   Worth a look at 3–4 real client charts before committing to the shape.
4. **Where the recon output lives.** Workbook per client for Phase 0 is right
   for adjudication. Longer term, does this become a tab in Client Dashboard, or
   part of job review?

---

## Appendix — verified state, 9 August 2026

Everything below was read from the live database on the date shown. It will
drift; re-check before relying on it.

| Fact | Value |
|---|---|
| `qbo_report_tokens` | 128 rows, all `active`, all with refresh tokens |
| Token scope | `com.intuit.quickbooks.accounting` (all 128) — covers `JournalEntry`, `reports/GeneralLedger`, `reports/TransactionList` |
| Soonest `refresh_token_expires_at` | 2026-10-30 |
| `qbo_report_connections` | 146 rows, `entity_id` NULL on all, 1 `is_practice` |
| Realms with any cached metric | **4 of 128** (168 rows, 2026-07-20 → 2026-08-09) |
| Cron jobs touching client realms | **none** |
| `payroll.employer` | 99 rows — 96 quickbooks, 2 xero, 1 freeagent; `brightpay_slug` on all 99; `destination_realm` NULL on all 99 |
| `payroll.task` | 150 `journal` (145 posted, 4 not_required, 1 failed) + 79 `hmrc` (44 posted, 35 not_required) |
| Journal window | 2026-04-01 → 2026-07-31 |
| HMRC window | 2026-07-06 → 2026-08-05 |
| Tasks in `attempting` | **0** — nothing stranded mid-post |
| Unclosed `payroll.run` rows | 6 (incl. run 718, 23 tasks, started 16:09 and never closed) |
| Outstanding failure | Grit Coaching Ltd — July journal, no saved nominal ledger mapping |
| Name match, active QBO employers | 72 of 96 (62 with live tokens) |
| Name match, July-posted employers | **34 of 34** |
| EA flagged `not_mapped` | LA Travel £2,030.27; Local Planet / Why Settle £1,743.47 |

**Not verified:** that BrightPay's postings appear in QBO as `JournalEntry`
objects with a stable, matchable signature. No live QBO call was made — there is
no service-role key locally and `dashboard-qbo-pull` requires a staff JWT. This
is Phase 0.1 and blocks the rest of Phase 0.

Related memory: `project-qbo-client-dashboard`, `project-billing-qbo-item-mapping`.
