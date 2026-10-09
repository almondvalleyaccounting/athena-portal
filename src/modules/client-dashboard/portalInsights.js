/*
  What the client dashboard's charts plot — pure derivations from the payload,
  kept apart from the drawing so they can be tested and so a chart cannot quietly
  compute a figure differently from the table beside it.

  Shared with the portal through @dash: imports nothing but siblings.
*/
import { addMonths } from './overviewGrain';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (key) => {
  const [y, m] = String(key).split('-').map(Number);
  return `${MONTHS[m - 1]} ${String(y).slice(2)}`;
};
const daysInMonth = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m, 0).getDate();
};

/*
  The same buckets a year earlier. Only buckets whose every month is in the
  detail are returned with months; the rest come back empty, so the caller
  draws a gap instead of a part-year that looks like a collapse.
*/
export function priorYearBuckets(buckets, monthKeys) {
  const have = new Set(monthKeys || []);
  return (buckets || []).map((b) => {
    const months = b.months.map((m) => addMonths(m, -12));
    return { ...b, months: months.every((m) => have.has(m)) ? months : [] };
  });
}

// A month-end balance-sheet line at a month, from metrics.bs_series.
export function bsAt(series, line, monthKey) {
  const i = (series?.month_keys || []).indexOf(monthKey);
  if (i < 0) return null;
  const v = series?.lines?.[line]?.[i];
  return v == null ? null : Number(v);
}

// What the business owes suppliers: trade creditors where QuickBooks has them.
export const creditorsAt = (series, monthKey) =>
  bsAt(series, 'accounts_payable', monthKey) ?? bsAt(series, 'creditors_within_1yr', monthKey);

/*
  Days to get paid, month by month: debtors at the month end divided by the
  turnover of the three months to it, times the days in those months — the
  usual debtor-days measure. Three months rather than one so a single quiet
  month does not make customers look slower than they are.
*/
export function debtorDays(detail, series, monthKeysWanted) {
  const keys = detail?.month_keys || [];
  const inc = detail?.series?.income || [];
  const pos = {};
  keys.forEach((k, i) => { pos[k] = i; });
  return monthKeysWanted.map((k) => {
    const debtors = bsAt(series, 'debtors', k);
    const span = [addMonths(k, -2), addMonths(k, -1), k];
    if (debtors == null || span.some((m) => pos[m] === undefined)) return { key: k, label: monthLabel(k), value: null };
    const turnover = span.reduce((s, m) => s + (Number(inc[pos[m]]) || 0), 0);
    const days = span.reduce((s, m) => s + daysInMonth(m), 0);
    return { key: k, label: monthLabel(k), value: turnover > 0 ? (debtors / turnover) * days : null };
  });
}

/*
  Turnover down to profit, from the period's statement figures. Anything below
  the overheads line that QuickBooks reports (other income, other costs) shows
  as its own step so the bars add up to the profit on the table.
*/
export function waterfallSteps(pl) {
  if (!pl || pl.income == null) return [];
  const income = Number(pl.income) || 0;
  const cogs = Number(pl.cogs) || 0;
  const gross = pl.gross_profit != null ? Number(pl.gross_profit) : income - cogs;
  const expenses = Number(pl.expenses) || 0;
  const net = pl.net_income != null ? Number(pl.net_income) : gross - expenses;
  const other = net - (gross - expenses);
  const steps = [{ label: 'Turnover', value: income, kind: 'total' }];
  if (Math.abs(cogs) > 0.5) {
    steps.push({ label: 'Cost of sales', value: -cogs, kind: 'step' });
    steps.push({ label: 'Gross profit', value: gross, kind: 'total' });
  }
  steps.push({ label: 'Overheads', value: -expenses, kind: 'step' });
  if (Math.abs(other) > 0.5) steps.push({ label: other >= 0 ? 'Other income' : 'Other costs', value: other, kind: 'step' });
  steps.push({ label: 'Profit', value: net, kind: 'total' });
  return steps;
}

/*
  Costs by heading, bucket by bucket, from a P&L tree already rolled into
  buckets (bucketReportTree). Cost of sales is one series; the overheads are
  split by their top-level headings, the biggest `keep` named and the rest
  gathered as "Everything else".
*/
export function costStack(bucketedRows, keep = 6) {
  const nodeVals = (n) => (n.kind === 'section' ? n.totals : n.values) || [];
  const find = (rows, test) => {
    for (const r of rows || []) {
      if (test(r)) return r;
    }
    return null;
  };
  const cogs = find(bucketedRows, (r) => r.kind === 'section' && (r.group === 'COGS' || /cost of (sales|goods)/i.test(r.label)));
  const exp = find(bucketedRows, (r) => r.kind === 'section' && (r.group === 'Expenses' || /^expenses$/i.test(r.label)));
  const series = [];
  if (cogs) series.push({ name: 'Cost of sales', values: nodeVals(cogs) });
  const heads = (exp?.children || [])
    .map((c) => ({ name: c.label, values: nodeVals(c) }))
    .map((s) => ({ ...s, sum: s.values.reduce((a, v) => a + (Number(v) || 0), 0) }))
    .filter((s) => s.sum > 0.5)
    .sort((a, b) => b.sum - a.sum);
  const named = heads.slice(0, keep);
  const rest = heads.slice(keep);
  series.push(...named.map(({ name, values }) => ({ name, values })));
  if (rest.length) {
    const len = rest[0].values.length;
    series.push({
      name: 'Everything else',
      values: Array.from({ length: len }, (_, i) => rest.reduce((a, s) => a + (Number(s.values[i]) || 0), 0)),
    });
  }
  return series;
}

/*
  Supplier bills by when they fall due, from the as-at date: anything already
  past due, then each of the next eight weeks, then later. Bills only — a
  supplier credit or an unapplied payment is not money going out.
*/
export function dueSchedule(bills, weeks = 8) {
  const asAt = bills?.as_at;
  if (!asAt) return [];
  const base = Date.UTC(...asAt.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  const out = [{ label: 'Overdue', value: 0, colour: '#f87171' }];
  for (let w = 0; w < weeks; w++) {
    const d = new Date(base + w * 7 * 86400000);
    out.push({ label: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`, value: 0, colour: '#93c5fd' });
  }
  out.push({ label: 'Later', value: 0, colour: '#cbd5e1' });
  for (const b of bills.items || []) {
    if (!(b.open > 0.004) || !b.due_date) continue;
    const due = Date.UTC(...b.due_date.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
    const days = Math.round((due - base) / 86400000);
    const slot = days < 0 ? 0 : days >= weeks * 7 ? weeks + 1 : 1 + Math.floor(days / 7);
    out[slot].value += b.open;
  }
  return out;
}

// Open sales-ledger items rolled into the aged-ledger bands.
export function ageBandsFromItems(items) {
  const map = { current: 'current', d1_30: 'b1_30', d31_60: 'b31_60', d61_90: 'b61_90', d91: 'b91_plus' };
  const out = { current: 0, b1_30: 0, b31_60: 0, b61_90: 0, b91_plus: 0 };
  for (const i of items || []) out[map[i.bucket] || 'current'] += Number(i.open) || 0;
  return out;
}
