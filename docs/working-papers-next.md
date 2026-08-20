# Working Papers — what's left

Opened 19 August 2026, after the PAYE paper landed (sql/241, commit dd59de9).
Ordered so that the things unblocking other things come first. Each task says
what "done" means, because several of these are easy to half-do.

Domain rules live in [hmrc-timing-and-cis-rules.md](hmrc-timing-and-cis-rules.md).
Read that before touching anything in section A or D — most of these tasks have a
timing rule attached that is not obvious from the code.

---

## A. The BrightPay leg — blocks the whole three-way

Everything else in this file is an improvement. This is the one that changes what
the module *is*: until it lands, PAYE is a two-way agreement that cannot be signed
off as a three-way, and Net wages (section E) cannot start at all.

All of A1–A2 is in the **separate repo**, `C:\Users\bobby\BrightPay Payments and
Journals` (branch `main`), which shares Athena's Supabase.

### A1. Read the three missing figures from the HMRC Payments screen

`src/driver/brightpay.js` → `readTaxMonth()` → the `textLabels` array in the
`readLabelled()` call. It already reads eleven figures and cross-checks its own
arithmetic twice. Missing:

- **CIS deductions suffered** — the whole reason the CIS panel exists
- **CIS deductions withheld** — but see F1 first; it may not be on this screen
- **Student and postgraduate loan** — HMRC itemises it, so the paper has a line
  for it and currently no counterpart

Use the visible label, never a `_beNNN` component id — those change between
releases, and the file says so at the top.

**Done when:** a supervised run against one CIS client returns all three, and the
existing NIC and amount-due reconciliation checks still pass. A figure the driver
cannot verify must not become evidence.

### A2. Persist a row per tax period to `wp_brightpay_period`

`payroll.task` keeps only `amount` and `ea_amount`, so even the figures the driver
*does* read are thrown away once the journal is posted. The table is already
created with a column for every figure on the screen, plus:

- `period_kind` — `'month' | 'quarter'`. A quarterly payer has 4 rows a year, not
  12. The driver already throws `QuarterlyScheduleError`; carry that distinction
  through rather than flattening it.
- `reconciles` — the driver's own verdict on its arithmetic. Carry it.
- `entity_id` — resolve on write via `hmrc.brightpay_link`, so the paper does not
  have to re-derive it. Nullable on purpose; an unlinked employer should still
  record its figures.

**Done when:** `v_wp_paye_readiness.blocker` moves off `no_brightpay_periods` for
at least one client and the PAYE paper's BrightPay column shows figures instead of
the not-fed notice.

### A3. Backfill what history is reachable

The runner has read these screens for months without keeping them. Decide how far
back is worth re-walking — the answer is probably "the current tax year plus the
one before", because a paper for an older year end is being prepared from paper
files anyway.

**Done when:** the decision is recorded here with the reason, not just executed.

---

## B. The QuickBooks leg

### B1. Smoke-test `wp-qbo-accounts` mode `balances` against a live file

**This is the one genuinely unproven piece of the commit.** Deployed and the auth
guard is verified (an anon-key caller gets 403), but the GeneralLedger harvesting
has never run against real QuickBooks. Only the anon key is available locally, so
it needs a staff session.

Specifically unproven:
- Whether the account id really sits on `ColData[0].id` at every nesting depth
- Whether the closing figure is the column titled `Balance` on this report shape
- Whether the BalanceSheet cross-check agrees, and if not, why

Steps: pick a client with a mapped PAYE nominal, set a year end, hit **Value the
ledger at this date**, then compare the stored `wp_qbo_balance` row against the
same account on the same date in QuickBooks by hand.

**Done when:** one balance is confirmed to the penny against QuickBooks' own
screen, and `report_disagreements` and `absent_from_reports` both come back empty
for a client where they should.

### B2. Resolve AATT Ltd's two QuickBooks connections

One client, two active realms (`9130350301595556` and `9130357945094836`), and
nobody has decided which is the ledger. `v_wp_paye_readiness.blocker` reports it as
`ambiguous_qbo_connection` and the paper refuses rather than guessing — which is
right, but it is a live block on one client.

**Done when:** one connection is deactivated or re-pointed, and the blocker clears.

### B3. Map the first cohort of nominals

107 clients have a PAYE reference, a single QuickBooks file, and need nothing but
the mapping. Open question: bulk session, or map as each paper is prepared?

Bulk is tempting and probably wrong — mapping is a judgement per file ("PAYE"
appears as a control account, an employer-NIC expense line, and in at least one
file a bank account created by mistake), and 107 judgements in one sitting is how
a wrong one gets made. Suggest mapping as papers are prepared, and revisiting if
that proves too slow.

**Done when:** decided, and the approach noted here.

### B4. Consider valuing year ends on a schedule

Right now a balance is pulled when someone clicks. A cron that values every mapped
nominal at every upcoming year end would make the paper instant — but it would
also store a lot of rows nobody reads, and a balance pulled before the books are
finished is a balance that will change.

Probably worth doing *after* the books-complete signal exists rather than now.
Deliberately deferred, not forgotten.

---

## C. Finishing the PAYE paper

### C1. Wire up sign-off

`wp_signoff` exists with prepared-by/reviewed-by, a state machine
(`open | queried | agreed | signed_off`) and `variance_at_signoff`, and
`saveSignoff()`/`fetchSignoff()` are written in `api.js`. **There is no UI for any
of it.** Preparation and review are different acts by different people and the
table already distinguishes them; the screen does not yet.

Note the deliberate design: `variance_at_signoff` snapshots the variance as it
stood when the conclusion was reached, so a later change in the underlying data
shows up as a change rather than silently overwriting what somebody signed.

**Done when:** a paper can be marked prepared, queried and reviewed, and reopening
one shows who concluded what and against which variance.

### C2. Prove the paper on a quarterly payer

Every figure on the tax-year panel is annual, so it should be fine — but nothing
has been tested against a scheme that pays quarterly, and the failure mode is
subtle rather than loud.

**Done when:** one quarterly client's paper has been read line by line and either
agrees or the discrepancy is understood.

### C3. Cosmetic: stray dashes in the variance column

On the tax-year panel, the Employment Allowance and Statutory payments rows render
a variance cell that can never hold a variance. Harmless, slightly untidy on a
document meant to look like a working paper.

### C4. Help content for the new module

`resolveModuleId()` will return `wp-paye`, `wp-mapping`, `wp-ct`, `wp-net-wages`,
and `help_content` has nothing for any of them. Part of the Help system's phase 2
(real copy, module by module) rather than a separate job — but worth doing early
here, because the two-panels/two-periods idea is the single least obvious thing in
Athena and a reviewer who does not get it will mis-read every paper.

---

## D. The corporation tax paper

Two of three legs are already available: HMRC's CT account is scraped
(`hmrc.ct_period`, 5,349 rows; `hmrc.ct_transaction`, 8,356), and the QuickBooks
leg needs only the `ct_liability` role mapped — same mechanism PAYE uses.

### D1. Decide how TaxCalc is read

**This decides the shape of everything else in section D**, so it comes first.
TaxCalc holds the computation and the CT600 as filed, which is the only source
saying what the charge *should* be rather than what someone posted or what HMRC
recorded. No API is in use here.

Three routes, in rough order of preference:
1. A machine-readable export, if one exists
2. The TaxCalc database directly
3. Driving the application, the way BrightPay is driven

**Done when:** one route is chosen with the reason recorded, not when a spike works.

### D2. Period alignment

An accounting period cannot exceed 12 months for CT, so a long first period or a
year-end change becomes **two CT accounting periods at HMRC** while the ledger and
the accounts show one. Any comparison has to align periods before it compares
figures. Get this wrong and every affected client shows a large false variance.

Note also that CT payment is due **9 months and 1 day** after the period end while
filing is due at **12 months** — so HMRC's account routinely shows a period with a
payment against no filed charge, and that is normal, not a finding.

### D3. The CIS-surplus-into-CT link

Unrelieved CIS suffered at the end of a tax year can be set against corporation tax
on request. That is a **cross-paper** movement: a credit leaves the PAYE paper and
appears on the CT paper, and neither is wrong. Both papers need to say so, or the
two will be reconciled against each other and one will look short.

Related and larger: roughly **£2.1m of unrelieved CIS across 17 clients**, and the
scrape holds no refund or reallocation language, so where that money went once each
tax year closed is currently unanswerable from Athena. Needs the CT and VAT scrapes
joined to the PAYE credits — see the credits-and-refunds notes.

---

## E. The net wages paper

Blocked on A1–A2 and on F2. A two-way check: net pay per the payroll against the
wages creditor in the ledger, with the bank payments in between. The QuickBooks
side is ready as soon as the `net_wages` and `wages_control` roles are mapped.

The reason this cannot be inferred from work already done: the journal runner posts
the payroll journal and records its total, but **a total is not a gross-to-net
analysis**. Net pay has to come from the payroll, not from the journal it produced
— otherwise the check is the ledger explaining its own balance, which is the one
thing this module exists to avoid.

---

## F. Questions for Bobby — an hour with a real client file

These are not research tasks. They are things only someone with the BrightPay
licence open can answer, and two of them gate real work.

### F1. Does CIS *withheld* appear on the HMRC Payments / P32 screen?

Gates A1. The screen is confirmed right for PAYE, and CIS *suffered* is confirmed
enterable there. CIS withheld may only exist on the CIS300 / Monthly Return screen,
which would mean a second screen to read rather than one more label.

### F2. Where does net pay live?

Gates E. Not on the HMRC Payments screen. Needs a gross-to-net or payroll summary
report — and whether that is readable from the same web UI or needs the Analysis
report builder changes the work substantially.

### F3. Is there a machine-readable export?

The docs say P30/P32 export as PDF, and the Analysis section has a generic
"Exporting Reports" with no formats named. Whether a CSV/Excel export exists decides
whether the BrightPay leg is scraped from the screen (as now) or ingested from a
file. **That is an architecture decision, not a detail** — a file ingest would be
more robust than screen-reading and would make A3's backfill much cheaper.

---

## Assumptions worth challenging

Written down because they were judgement calls, not facts, and a fresh look may
disagree:

- **The PAYE paper is keyed on the accounting year end** for the creditor and the
  tax year for CIS. If in practice the paper is always prepared at a year end, the
  tax-year selector could default harder and the second panel could shrink.
- **`v_wp_paye_readiness.blocker` reports the *first* blocker in fix order.** A
  client missing two things shows one. That keeps the list actionable but hides
  how much work each client needs.
- **Materiality on the variance cells is absolute** (a penny is rounding, a pound
  is a missing transaction) rather than proportional. Defensible on a control
  account, arguably too tight on a client with a £400k CIS charge.
- **Mapped nominals are summed with a sign flip available per account.** No
  provision yet for a nominal that belongs to a role only partly — if that turns
  out to exist, the model needs an apportionment and does not have one.
