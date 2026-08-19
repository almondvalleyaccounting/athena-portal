# HMRC submissions, and the timing rules a working paper has to know

Written 19 August 2026, to be argued with rather than trusted. Every rule here
either changes what a reconciliation compares or changes what counts as a
variance. Where a rule was verified against the live scrape, the figures are
given — those are the ones to re-run if anything looks wrong.

The three things this document exists to stop:

1. Reconciling a tax-year concept on an accounting year.
2. Matching CIS month to month, which manufactures a variance on more than half
   the population.
3. Treating a credit HMRC recorded in one year for another year as an error.

---

## 1. The calendar

### The tax month

**6th of one month to the 5th of the next.** Month 1 is 6 April – 5 May.

Two consequences that catch people out, both of them load-bearing:

- **A payroll run in January is charged in the tax month 6 January – 5 February.**
  So a company with a **31 January year end** accrues that month, and the PAYE
  creditor at its year end includes the month *ending 5 February*. This is
  exactly what [sql/239](../sql/239_hmrc_statement_period_rule.sql) fixed: the
  earlier rule counted a month only once its period had ended, and every client
  lost their final month.

  The rule now: **a tax month belongs to the period containing its START.**
  Include the month when `period_start <= as_at`.

- **1 April, 5 April and 6 April are three different dates in three different
  contexts.** Corporation tax and most year ends care about 31 March / 1 April.
  PAYE and CIS care about 5 / 6 April. A helper that derives a tax year from
  `getFullYear()` is wrong for five days a year, and those five days hold a whole
  tax month of CIS.

### Payment deadlines

| What | Due |
|---|---|
| PAYE/NIC/CIS, electronic | **22nd** of the month after the tax month ends |
| PAYE/NIC/CIS, by post | 19th |
| Quarterly payers (average monthly liability under £1,500) | 22nd after the quarter |
| CIS300 monthly contractor return | **19th** after the tax month ends |
| EPS | **19th** of the following tax month |
| FPS | on or before payday |

The 22nd matters to a working paper for a specific reason: **if a tax month's
due date is after the balance-sheet date, no payment against it can have been
made before that date**, whatever payment records we hold. That lets sql/239
prove a creditor without needing a payment date — Village Estates at
31 December 2025 owed £437.50 for the month 6 Dec – 5 Jan, due 22 January, and
the proof needs no dated payment at all.

### Quarterly payers

BrightPay's HMRC screen renders a **quarter** instead of a month for these, and
the year-to-date column says "quarters" where a monthly payer's says "months".
The runner's driver already throws `QuarterlyScheduleError` when asked for a
month and handed a quarter — the figures on screen cover three months and the
quarter is usually still running, so reading them as a month is a misread, not a
rounding difference.

`wp_brightpay_period.period_kind` carries `'month' | 'quarter'` for this reason.
A quarterly payer has 4 rows a year, not 12, and a paper that divides by 12
anywhere is broken for them.

---

## 2. CIS — the rules that actually bite

### The two directions, which are different liabilities

| | What it is | Where it appears |
|---|---|---|
| **CIS withheld** | The client is the **contractor**. It deducted 20% or 30% from its subcontractors and owes that over to HMRC. | A **charge** on the HMRC PAYE account. Reported on the monthly CIS300. |
| **CIS suffered** | The client is the **subcontractor**. Its own contractors deducted from it. | A **credit** on the HMRC PAYE account, claimed on the EPS. |

A client can be both, in the same month, and many are. They must never be netted
in a working paper — a nil net position can hide a £40k charge against a £40k
credit, and the credit is subject to the year restriction below while the charge
is not.

**And HMRC only itemises one of them.** Checked across the whole of
`hmrc.charge_line`: **every CIS line in the source is an EPS credit** — 2,083
rows, 80 distinct line types, not one of them a charge. HMRC's PAYE statement
itemises only Income Tax, Employer's NICs, Employees' NI, student and
postgraduate loans and the NIC uplift in its FPS section. **The CIS a contractor
withheld from its subcontractors sits inside the month's charge total and is
never broken out.**

So `hmrc.line_category()`'s `'CIS withheld'` branch — a CIS line whose `kind` is
`charge` — is unreachable on this data, and CIS withheld has to be **derived**:

```
charges_itemised    = income tax + employee NI + employer NI + loans + levy + interest + penalties
charges_unitemised  = charges_total − charges_itemised     ← predominantly CIS withheld
```

Antonine Builders 2024-25: **£402,761 charged against £12,293 of itemised
payroll.** That £390,468 residual is CIS deducted from subcontractors. The first
cut of `v_wp_paye_tax_year` reported it as a variance, which would have condemned
a perfectly good record on every paper this client ever gets. It is a **named
line**, not an error.

Two guards on that derivation, both of which matter:

- It is **NULL** where the line detail covers fewer months than the totals do,
  so a part-scraped year never puts a scrape gap into a figure the paper reads
  as CIS.
- For a client with **no CIS**, `charges_unitemised` should be nil — and if it is
  not, *that* is worth investigating. Which is the check the discarded "variance"
  column was trying and failing to be.
- It is a tax-year **flow**, not a balance at a date, so it must never appear in
  the creditor panel against a year-end figure.

### The same-tax-year restriction

This is the rule the whole design turns on.

> Where a company's own CIS deductions exceed the amount due for a tax month, the
> excess can be set against **any future PAYE, NIC or CIS liability in the same
> tax year**. Excess still unused at the end of the tax year may be refunded or
> set against other liabilities — but not before the year has ended.

So:

- **In-year:** surplus CIS suffered carries forward month to month within the tax
  year, reducing later months' liabilities.
- **At 5 April:** whatever is left does *not* roll into the next tax year as an
  offset. It becomes a repayment claim, or (on request) a set-off against
  corporation tax or VAT.
- **No in-year repayment.** HMRC will not repay a company subcontractor until the
  tax year has ended *and* the company has paid all its liabilities as employer
  and contractor. The only exceptions are liquidation and administration.

**What this means for the module:** the CIS panel is on the tax year, full stop.
A client with a 31 December year end still has its offset capacity reset on
6 April, part-way through its own accounting year. Presenting CIS on the
accounting year would be arithmetically tidy and professionally wrong.

### The claim mechanism, and why it drifts

A company subcontractor claims CIS suffered on an **EPS**, per tax month, due by
the 19th of the following tax month. The figure is entered **per period, not year
to date** — BrightPay's HMRC Payments screen takes the periodic amount. Since
April 2022 the EPS must also carry the company's **CT UTR**, or HMRC will not
apply the credit.

You cannot amend a submitted EPS. A correction is made on a later one.

That is where the drift comes from, and it is measurable.

### Measured: CIS credits do not sit in the month they relate to

On the latest PAYE scrape (19 August 2026), of the CIS-suffered credit lines
HMRC's own statement carries:

| | Count |
|---|---:|
| CIS-suffered credit lines on the latest run | 36 |
| Recorded in the same tax month their label says they relate to | 16 |
| **Recorded in a DIFFERENT month** | **20** |
| Recorded in a different **tax year** | 1 |

Employment Allowance drifts the same way, less often: 232 of 259 lines match,
25 differ by month, 12 cross a tax year.

The drift runs in **both directions**:

- *Late claim.* CLF (Scotland) — claimed for 2026-27 month 1, credited in month 3
  (£214.48) and again in month 4 (£673.85). The EPS went in late; HMRC credited
  it when it processed it.
- *Back-dated.* Blackwood Plumbing & Gas — credited in month 1 for a deduction
  suffered in month 3. HMRC posted the credit against an earlier month than the
  label.
- *Across years.* **Antonine Builders — £678.34 credited in 2026-27 month 3 for a
  deduction suffered in 2022-23 month 7.** Four tax years earlier.

**Therefore: never join CIS on `tax_month`.** Doing so would report a variance on
20 of 36 lines that is pure presentation. `v_wp_paye_credit_origin` carries
"recorded in" and "relates to" as two separate facts and classifies the
difference:

| `timing` | Meaning | Is it a variance? |
|---|---|---|
| `in_period` | claimed for and credited in the same month | no |
| `timing_within_year` | different month, same tax year | no — timing only, still offsettable |
| `prior_year_credit` | relates to an earlier tax year | **no, and never chase it** |
| `unlabelled` | HMRC gave no period | unknown — agree to the EPS by hand |

The `prior_year_credit` case is the one that will otherwise waste days. It
reduces *this* year's HMRC bill and has **no counterpart in this year's payroll**,
so BrightPay will disagree by exactly that amount and be right. It is also a
prompt to check the earlier year's paper, which may still be carrying a
recoverable that has now been given.

### The nil payslip

When CIS suffered exceeds the month's liability the company submits a nil
payslip and carries the excess forward. So **a month with nothing paid is not
necessarily a month in arrears** — for a CIS subcontractor it is often the
opposite. Any arrears logic that assumes payment-absent means overdue is wrong
for this population.

### Open question for the CIS panel

The bank of unrelieved CIS is large — around **£2.1m across 17 clients** on the
last count (see the credits-and-refunds notes). What the scrape does *not* yet
show is language for a refund or a reallocation, so where that money went once
the tax year closed is currently unanswerable from Athena. It needs the CT and
VAT scrapes joined to the PAYE credits before the "what happened to the surplus"
question can be answered rather than asked.

---

## 3. RTI — what each submission carries

| | When | Carries |
|---|---|---|
| **FPS** | on or before payday | pay, deductions, payrolled benefits, starters and leavers. This is what creates the month's **charge**. |
| **EPS** | by the 19th after the tax month | the **reductions**: Employment Allowance, CIS deductions suffered, statutory payment recovery (SMP/SPP/SAP/ShPP/bereavement/neonatal, at 92% or 103%/109% with Small Employers' Relief), plus "no payment due" and advance inactivity for up to 12 months. |

Two things follow for the paper:

- **The charge and the credit arrive on different submissions with different
  deadlines**, which is the mechanical reason a month can be right on the charge
  and wrong on the credit. In HMRC's line detail, `section` is `fps` for charges
  and `eps` for credits — the scrape already distinguishes them.
- **A month with no FPS is not a missing month.** It may be a legitimate
  no-payment EPS. Chasing it as a gap is a false positive.

### Employment Allowance

Claimed on the EPS, up to £10,500 a year, and it reduces **employer NIC only** —
never income tax, never employee NIC. BrightPay's screen shows either an input
with a figure (claimed) or an "Enable" link (not switched on at all), and the
runner distinguishes those: `eaNotEnabledButNicDue` flags a client paying
employer NIC with no claim running, which is relief being left on the table.

Whether to enable a claim is an eligibility judgement — connected companies, the
single-director rule, public-sector work — so it is reported and never actioned
automatically.

BrightPay also posts the EA adjustment as a **separate journal** from the payroll
journal. `payroll.task.amount` is their sum, verified: MAC Recruit July
= 31,845.98 + 3,331.24 = 35,177.22. Any check expecting one journal per month
produces false positives.

### Statutory payment recovery

Comes off the NIC bill, and a client claiming it can end a month with **negative
net NIC**. Hollandhurst showed net NIC of −847.24 against an expected 0, which is
exactly 777.28 recovered plus 69.96 NIC compensation. A negative amount due means
HMRC owes the employer; there is no payment to mark and reclaiming it is a
separate decision.

---

## 4. Corporation tax — for the next paper

Different rules, and simpler in the one way that matters: **CT follows the
accounting period**, so the CT paper needs no tax-year panel.

- **Payment:** 9 months and 1 day after the period end (large companies pay by
  quarterly instalments instead).
- **Filing:** CT600 within 12 months of the period end. So **the money is due
  three months before the return is**, which is why HMRC's CT account routinely
  shows a period with a payment against no filed charge.
- **Period splitting:** an accounting period cannot exceed 12 months for CT. A
  long period — an 18-month first period, or a year-end change — becomes **two CT
  accounting periods** at HMRC while the ledger and the accounts show one. Any
  comparison must align periods before it compares figures. HMRC's side is held
  in `hmrc.ct_period` (5,349 rows) and `hmrc.ct_transaction` (8,356).
- **CIS surplus into CT:** unrelieved CIS suffered at the end of a tax year can be
  set against corporation tax on request. That is a **cross-paper link**: a credit
  that leaves the PAYE paper appears on the CT paper, and neither is wrong.

The missing leg is **TaxCalc**, and it is the one that says what the charge
*should* be rather than what was posted or what HMRC recorded. No API is in use;
the options are an export, the TaxCalc database, or driving the application the
way BrightPay is driven.

---

## 5. What Athena holds today, per leg

### HMRC — fed

The scrape (private `hmrc` schema) covers all four heads. For PAYE:
`hmrc.charge` (per tax month totals), `hmrc.charge_line` (the split, with
`section` = fps/eps and `hmrc.line_category()` naming each line),
`hmrc.payment`, `hmrc.credit`, `hmrc.position`.

Read through the gated public views only — `hmrc_can_read()` is not optional, and
portal clients hold `authenticated` alongside staff.

### QuickBooks — fed, once mapped

138 active report connections, 134 linked to an entity. Reading a client's ledger
needs two things:

1. **Which nominal.** There is no house chart of accounts across 138 client
   files and there never will be — they are the clients' own files. `wp_nominal_map`
   maps a working-paper role to one or more accounts per client, by hand, recorded
   with who mapped it. Name matching is a trap: "PAYE" appears as a control
   account, as an employer-NIC expense line, and in at least one file as a bank
   account somebody created by mistake.

2. **A balance as at a date, not now.** `Account.CurrentBalance` is as-at-today
   and useless to a working paper. `wp-qbo-accounts` uses the **GeneralLedger**
   report from an epoch date to the paper's date, so the Balance column is the
   closing balance at that date, and cross-checks it against **BalanceSheet**.
   Where the two reports disagree, both figures are returned rather than one
   being picked. An account absent from both is **not** a nil balance — it is
   usually a mapping pointing at an id that no longer exists.

   `TrialBalance` was considered and rejected: it reports on a date *range*, and
   for a balance-sheet account the paper needs cumulative-to-date. `BalanceSheet`
   alone was rejected too, because a nominal with a nil balance disappears from it
   entirely — and "not on the report" and "no balance" are different facts.

Coverage today, measured: of 603 active clients, 443 have no PAYE scheme
(correctly out of scope), 52 have no QuickBooks connection, 1 has two connections
and nobody has decided which is the ledger, and **107 need nothing but the
nominal mapping**. That 107 is the population this module is for.

### BrightPay — NOT fed

This is the gap, and it is the reason PAYE is a two-way agreement today rather
than a three-way.

The journal runner drives BrightPay Online (`uk-26-27.brightpay.com`) with
Playwright, and `readTaxMonth()` in its driver **already reads** the HMRC
Payments screen: net income tax, employee NIC, employer NIC, net NIC, the EA
claim, statutory pay recovered and its NIC compensation, amount due, amount paid,
due/paid in previous periods, shortfall, net adjustment — and cross-checks its own
arithmetic twice before returning a figure.

What is missing is in two places:

1. **Three labels are not read at all** — `CIS deductions suffered`, `CIS
   deductions withheld`, and student/postgraduate loan. They need adding to
   `readLabelled()`'s `textLabels` in `src/driver/brightpay.js`.
2. **Nothing is persisted.** `payroll.task` stores only `amount` and `ea_amount`,
   so even the columns the driver does read are thrown away after the journal is
   posted.

`wp_brightpay_period` is the destination: one row per employer per tax period,
with a column for every figure the screen shows, plus the driver's own
`reconciles` verdict so an unverified figure never silently becomes evidence.

**It is deliberately empty.** A working paper showing `0.00` for a leg it has
never been fed is more dangerous than one showing nothing, because 0.00 ties to a
nil return and reads as agreement. Hence `money()` returning an em dash for null
and the `NotFedNotice` banner.

#### What still needs establishing about the BrightPay reports

Open, and worth an hour with Bobby and a real client file:

- **The P32 / HMRC Payments screen** is the right source for the PAYE paper —
  confirmed by what the driver already reads. What is *not* confirmed is whether
  the CIS suffered and CIS withheld figures both appear on it, or whether CIS
  withheld only exists on the CIS300 / monthly return screen.
- **Net wages** is not on that screen at all. It needs a gross-to-net or payroll
  summary report, and whether that is readable from the same web UI or needs the
  Analysis report builder is unknown.
- **Export format.** The docs say the P30/P32 export as PDF; the Analysis section
  has a generic "Exporting Reports". Whether a machine-readable export exists
  decides whether the BrightPay leg is scraped from the screen (as now) or
  ingested from a file, and that is an architecture decision, not a detail.

---

## 6. Rules encoded, and where

| Rule | Where |
|---|---|
| A tax month belongs to the period containing its start | `hmrc_paye_balance_at()`, sql/239 |
| Nothing against a month due after the date can have been paid before it | `hmrc_paye_balance_at()`, sql/239 |
| CIS suffered offsets only within its own tax year | tax-year panel of the PAYE paper, sql/241 |
| Recorded period and relates-to period are separate facts | `v_wp_paye_credit_origin`, sql/241 |
| A prior-year CIS credit is not a variance | `cis_suffered_prior_year` / `cis_suffered_in_year`, sql/241 |
| CIS withheld and CIS suffered are never netted | separate roles in `wp_nominal_map`; separate lines on the paper |
| HMRC never itemises CIS withheld, so it is derived | `charges_itemised` / `charges_unitemised`, sql/241 |
| The derived CIS withheld is a flow, never a year-end balance | omitted from the creditor panel on purpose |
| Line detail is scoped per (client, tax year, tax MONTH) | `line_scope` in `v_wp_paye_tax_year`, sql/241 |
| A quarterly payer has quarters, not months | `wp_brightpay_period.period_kind` |
| An unfed leg is unknown, never nil | `money()` and `NotFedNotice` in `wpShared.jsx` |
| Two QuickBooks files on one client is a blocker, not a coin toss | `v_wp_paye_readiness.blocker` |

---

## Sources

- [Claim a refund of CIS deductions if you're a limited company](https://www.gov.uk/guidance/claim-a-refund-of-construction-industry-scheme-deductions-if-youre-a-limited-company)
- [CISR76020 — claims to credit for CIS deductions](https://www.gov.uk/hmrc-internal-manuals/construction-industry-scheme-reform/cisr76020)
- [What payroll information to report to HMRC](https://www.gov.uk/guidance/what-payroll-information-to-report-to-hmrc)
- [CIS 340 — a guide for contractors and subcontractors](https://www.gov.uk/government/publications/construction-industry-scheme-cis-340/construction-industry-scheme-a-guide-for-contractors-and-subcontractors)
- [BrightPay — recovering CIS deductions suffered](https://www.brightpay.co.uk/docs/23-24/rti/employer-payment-summary-eps/recovering-cis-deductions-suffered/)
- [BrightPay — P30 & P32](https://www.brightpay.co.uk/docs/24-25/hmrc-payments/p30-p32/)
- Live scrape measurements, 19 August 2026, against `hmrc.charge_line` on the
  latest PAYE run.
