# Client Dashboard — outstanding work

Written 2026-08-19, after the Overview toggles / Projection tab / client-portal
access build. Ordered by what blocks what.

## Before Marc Kelly is told his dashboard exists

**1. Confirm Puddleduck's financial year end.**
QuickBooks returns null for `FiscalYearStartMonth` on that file, so the Overview's
Fiscal basis falls back to a September year end — Almond Valley's, not theirs. The
picker on the Overview shows amber and says "not confirmed" until somebody sets it.
The Puddleduck Expansion forecast carries `year_end_date = 2027-07-31`, which
implies **31 July**, but that is Bobby's own entry in another module and has not
been checked against Companies House. Set it on the Overview (Fiscal → Ends), or
directly: `qbo_report_connections.fiscal_year_end_month`.

Worth a sweep afterwards: how many of the ~120 connected realms return null for
the QBO setting? Every one of them is currently being shown the practice's
quarters. A one-line query answers it, and the fix is per-client data entry.

**2. Sign in as a real client and look at the page.**
The only part of this build nobody has actually seen. The server gates are verified
by impersonation (Marc's email claim → Puddleduck and its three sections; another
client → nothing; no email claim → nothing; anon refused at both edge functions),
and the "Preview as client" panel renders the identical component through the
identical endpoint — but a genuine signed-in render has not happened. Marc has an
invite and has never claimed it; no email has gone out.

**3. Decide whether the grant stays live while testing.**
`mk@four-site.com` currently holds a live grant on Puddleduck (overview, P&L,
balance sheet). Nothing reaches him unless he receives a sign-in link, but it is
live. Revoke on `/admin/dashboard-access` if that is not wanted yet.

## To test the Projection tab end to end

**4. Link a scenario to Puddleduck.** The Projection tab is empty until one is
linked, and Marc's grant has Projection off. Either link the existing
"Puddleduck — cashflow (QBO actuals)" forecast (it currently has **no calculated
output** — it needs a recompute in Client Forecast first), or one of the five
Expansion scenarios, which do have output.

**5. Walk the Mapping sub-tab.** The default line mapping has been unit-tested but
never run against a real scenario's `nominal_type` set. Anything unrecognised
lands in an "Unmapped …" row and is visible there — that screen is the check.

## Known and deliberate

- **Debtors show "—" for Puddleduck.** QBO has no Accounts Receivable group on that
  file. Correct, not a bug.
- **Cashflow actuals derive cash from the balance sheet.** QBO's CashFlow report
  publishes no BeginningCash/EndingCash groups for this file. Closing = month-end
  bank balance; opening = closing − the month's movement. Verified to tie every
  quarter.

## Bigger pieces, not started

**6. BrightPay data scraping.** Raised 2026-08-19 as a task in its own right.
Checked: headcount is **not** already in the database. `payroll.{employer,run,task}`
carries runs, states and journal amounts but no employee counts;
`hmrc.brightpay_comparison` carries net pay and EA, no counts. So staff numbers per
month need either a scrape or manual entry.

The linkage work is already done, which is the usually-hard part:
`payroll.employer.destination_realm` and `hmrc.brightpay_link.entity_id` both map a
BrightPay employer to an Athena client.

**7. Custom KPIs and custom reports.** Design discussion 2026-08-19 — see the
proposal in that conversation. Key decisions still open: where entry lives, whether
monthly entry becomes a scheduled Work task, and whether KPI definitions are
per-client or library templates applied to many clients.
