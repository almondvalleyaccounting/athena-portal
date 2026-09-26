// Go-live catch-up maths for fee-proposal: which invoices a recurring template
// has already raised at the old fee since a new fee's go-live date, and what
// the one-off catch-up invoice for them comes to. Pure — tested in
// tests/money/catchup.test.js. No Deno, no network, no database.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n: number) => Math.round(n * 100) / 100;

// Last day of a month; `month` is 1-12.
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const isoOf = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

// Invoices the template has already raised on or after the go-live date:
// step back one interval at a time from its next run. The interval is the
// template's own (qbo-pull records it per line as cadence_months: 1 monthly,
// 3 quarterly, 12 yearly); amounts stay monthly equivalents throughout. A
// missing next run means the template can't be read, so nothing is assumed
// missed.
//
// A template on the last day of the month stays on the last day as it steps
// back — 31 Oct, 30 Sep, 31 Aug — and any other day keeps its number, clamped
// to a shorter month. 130 of 141 templates run on the 31st. Stepping back with
// setUTCMonth() instead turned "31 Sep" into 1 Oct, which counted one invoice
// too many on every one of them (fixed 2026-09-26, before any go-live had been
// approved). The one ambiguity: a template on a fixed day that happens to be
// its month's last (the 30th in a 30-day month, the 28th in February) reads as
// month-end, so its earlier dates land a day or so later than the real ones.
// That changes the count only when the go-live date falls in that gap.
export function missedInvoices(nextRun: string | null, goLiveDate: string, intervalMonths = 1): string[] {
  if (!nextRun || !ISO_DATE.test(nextRun)) return [];
  const step = Math.max(1, Math.round(intervalMonths));
  const [y, m, d] = nextRun.split("-").map(Number);
  const monthEnd = d === lastDay(y, m);
  const out: string[] = [];
  for (let i = 1; i <= 36; i++) {
    const t = new Date(Date.UTC(y, m - 1 - i * step, 1));
    const ty = t.getUTCFullYear(), tm = t.getUTCMonth() + 1;
    const last = lastDay(ty, tm);
    const iso = isoOf(ty, tm, monthEnd ? last : Math.min(d, last));
    if (iso < goLiveDate) break;
    out.unshift(iso);
  }
  return out;
}

// "September 2026", or "September to November 2026"-style range.
export function catchupPeriod(missed: string[]): string {
  const fmtMonth = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  if (!missed.length) return "";
  return missed.length === 1 ? fmtMonth(missed[0]) : `${fmtMonth(missed[0])} to ${fmtMonth(missed[missed.length - 1])}`;
}

export type CatchupLine = { service: string; delta: number; net: number };

// The billing interval of a template, in months, from its lines. Every line on
// a QBO template shares its schedule, so they agree; null when they don't (or
// there is nothing recurring), and then missed invoices can't be counted.
// Weekly templates are recorded as 1 and counted monthly — none are live.
export function templateIntervalMonths(services: Array<{ cadence?: unknown; cadence_months?: unknown }>): number | null {
  const ints = new Set(services
    .filter((s) => s.cadence !== "one_off")
    .map((s) => Number(s.cadence_months) || (s.cadence === "annual" ? 12 : 1)));
  return ints.size === 1 ? [...ints][0] : null;
}

// Each staged line's monthly increase × the months each missed invoice covers
// × the invoices missed; lines that net to nothing drop out. VAT on the total
// at 20%.
export function catchupFor(
  staged: Array<{ pending_monthly_amount?: unknown; monthly_amount?: unknown }>,
  missedCount: number,
  labelFor: (s: any) => string,
  intervalMonths = 1,
) {
  const lines: CatchupLine[] = missedCount ? staged.map((s) => {
    const delta = r2((Number(s.pending_monthly_amount) || 0) - (Number(s.monthly_amount) || 0));
    return { service: labelFor(s), delta, net: r2(delta * intervalMonths * missedCount) };
  }).filter((l) => l.net !== 0) : [];
  const net = r2(lines.reduce((t, l) => t + l.net, 0));
  const vat = r2(net * 0.2);
  return { lines, net, vat, gross: r2(net + vat) };
}

// The catch-up invoice's lines: increases only (a fee that came down is not
// refunded through a catch-up), VAT per line, and the totals from those lines.
const INTERVAL_WORD: Record<number, string> = { 3: "quarterly", 6: "half-yearly", 12: "annual" };

export function catchupInvoiceLines(lines: CatchupLine[], period: string, missedCount: number, why: string, intervalMonths = 1) {
  const itemLines = lines.filter((l) => l.net > 0).map((l) => {
    const lv = r2(l.net * 0.2);
    const what = intervalMonths === 1
      ? `${missedCount} month${missedCount === 1 ? "" : "s"} at +£${l.delta.toFixed(2)}`
      : `${missedCount} ${INTERVAL_WORD[intervalMonths] || `${intervalMonths}-monthly`} invoice${missedCount === 1 ? "" : "s"} at +£${r2(l.delta * intervalMonths).toFixed(2)}`;
    return {
      service: l.service,
      description: `${l.service}: new fee from ${period} (${what}), not yet billed — ${why}`,
      net: l.net, vat: lv, gross: r2(l.net + lv), qty: 1, rate: l.net,
    };
  });
  const net = r2(itemLines.reduce((t, l) => t + l.net, 0));
  const vat = r2(itemLines.reduce((t, l) => t + l.vat, 0));
  return { itemLines, net, vat, gross: r2(net + vat) };
}
