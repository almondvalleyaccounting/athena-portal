// A QBO recurring template's schedule, and converting between what one of its
// invoices bills and the monthly figure Athena keeps. One copy, used by
// qbo-pull (template → Athena) and qbo-push-recurring (Athena → template).
// Pure — tested in tests/money/billingInterval.test.js.
//
// Athena stores every fee as a monthly equivalent rounded to the penny. For a
// monthly template that is exact. For a yearly or quarterly one it is not: a
// £500-a-year invoice is £41.67 a month, and £41.67 × 12 is £500.04. So the
// template's own per-invoice amount travels with the line (per_invoice_amount,
// written by qbo-pull), and a staged change can carry its exact per-invoice
// amount too (pending_per_invoice_amount). Converting back from the monthly
// figure is the fallback, not the rule.

const r2 = (n: number) => Math.round(n * 100) / 100;

// Monthly figure per £1 on one invoice, from the template's ScheduleInfo.
//   Monthly, N=1 → 1        Monthly, N=3 → 1/3 (quarterly)
//   Yearly,  N=1 → 1/12     Weekly,  N=1 → 52/12     Daily → 365/12
// No schedule reads as monthly.
export function monthlyFactor(schedule: Record<string, unknown> | undefined): number {
  if (!schedule) return 1;
  const type = String(schedule.IntervalType || "Monthly");
  const n = Math.max(1, Number(schedule.NumInterval || 1));
  switch (type) {
    case "Daily":   return (365 / 12) / n;
    case "Weekly":  return (52 / 12) / n;
    case "Yearly":  return 1 / (12 * n);
    case "Monthly":
    default:        return 1 / n;
  }
}

// Invoices a year.
export const invoicesPerYear = (factor: number) => factor * 12;

// The monthly equivalent of one invoice's amount, to the penny.
export const monthlyFromInvoice = (perInvoice: number, factor: number) => r2(perInvoice * factor);

// The year's total from one invoice's amount — exact, not via the rounded
// monthly figure.
export const annualFromInvoice = (perInvoice: number, factor: number) => r2(perInvoice * invoicesPerYear(factor));

// What one invoice should bill for a staged monthly amount. A staged exact
// per-invoice amount wins, but only while it still agrees with the monthly
// figure at this template's interval: a screen that later changes the monthly
// amount without knowing about the exact one leaves a stale value behind, and
// that must never be what reaches QuickBooks.
export function perInvoiceFor(pendingMonthly: number, factor: number, pendingPerInvoice?: unknown): number {
  const exact = pendingPerInvoice == null || pendingPerInvoice === "" ? NaN : Number(pendingPerInvoice);
  if (Number.isFinite(exact) && exact >= 0 && monthlyFromInvoice(exact, factor) === r2(pendingMonthly)) return r2(exact);
  // monthly × (1 / factor), not monthly / factor: the push has always worked it
  // out this way, and the two can round differently on the last penny.
  return r2(pendingMonthly * (1 / factor));
}
