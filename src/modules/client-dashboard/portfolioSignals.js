/*
  Portfolio tile — the numbers behind each starred client's card, and the
  plain-English flags that sort the portfolio by who needs attention.

  PURE: takes the cached qbo_dashboard_cache rows for one realm (sorted
  pulled_at DESC, snapshots included) and returns figures with their
  comparators. Nothing here calls QuickBooks; everything comes from caches the
  Client Dashboard and the nightly refresh (sql/293) already hold:

    pl_fytd / pl_fytd_prior  year to date vs the SAME window last year
    balance_sheet            now + comparatives (last month, 3m, 12m ago)
    pnl_monthly              12 monthly columns (last one may be part-month)
    aged_receivables/_payables  buckets; older snapshots are kept, so last
                             month's 90+ figure comes from priorMonthSnapshot
*/
import { latestByMetric, priorMonthSnapshot } from './dashboardData';

export const STALE_DAYS = 7;

// Headline metrics the tile reads — also what "Refresh all" and the nightly
// job ask dashboard-qbo-pull for. Keep in step with sql/293.
export const PORTFOLIO_METRICS = [
  'pl_fytd', 'pl_fytd_prior', 'balances', 'balance_sheet',
  'pnl_monthly', 'aged_receivables', 'aged_payables', 'file_health',
];

const num = (v) => (v === null || v === undefined || isNaN(v) ? null : Number(v));
const pctChange = (cur, prev) =>
  cur == null || prev == null || prev === 0 ? null : (cur - prev) / Math.abs(prev);

// Value of a labelled comparatives row at a column key ('now', 'm1', 'm3', 'm12').
function compValue(bs, label, key) {
  const cmp = bs?.comparatives;
  if (!cmp?.rows || !cmp?.columns) return null;
  const idx = cmp.columns.findIndex((c) => c.key === key);
  const row = cmp.rows.find((r) => r.label === label);
  return idx < 0 || !row ? null : num(row.values?.[idx]);
}

function agedSummary(data) {
  const b = data?.buckets;
  if (!b || !num(b.total)) return null;
  const total = num(b.total);
  return {
    total,
    buckets: {
      current: num(b.current) || 0,
      b1_30: num(b.b1_30) || 0,
      b31_60: num(b.b31_60) || 0,
      b61_90: num(b.b61_90) || 0,
      b91_plus: num(b.b91_plus) || 0,
    },
    over90: num(b.b91_plus) || 0,
    over90Share: (num(b.b91_plus) || 0) / total,
  };
}

// Monthly P&L columns, flagging a trailing part-month so averages skip it.
function monthly(pnl, pulledAt) {
  const s = pnl?.series;
  if (!s?.income?.length) return null;
  const n = s.income.length;
  const labels = pnl.months || [];
  const pulledDay = String(pulledAt || '').slice(0, 10);
  const lastIsPartial = !!(pnl.period?.end && pulledDay && pnl.period.end > pulledDay);
  const at = (arr, i) => num(arr?.[i]) || 0;
  const rows = Array.from({ length: n }, (_, i) => ({
    label: labels[i] || '',
    income: at(s.income, i),
    costs: at(s.cogs, i) + at(s.expenses, i),
    net: s.net_income ? at(s.net_income, i) : at(s.income, i) - at(s.cogs, i) - at(s.expenses, i),
    partial: lastIsPartial && i === n - 1,
  }));
  return { rows, complete: rows.filter((r) => !r.partial) };
}

export function buildPortfolioFigures(rows) {
  const latest = latestByMetric(rows);
  const d = (k) => latest[k]?.data || null;
  const plCur = d('pl_fytd');
  const plPrior = d('pl_fytd_prior');
  const bs = d('balance_sheet');
  const bal = d('balances');

  /* Performance — YTD vs same window last year */
  const revenue = num(plCur?.income);
  const revenuePrior = num(plPrior?.income);
  const profit = num(plCur?.net_income);
  const profitPrior = num(plPrior?.net_income);
  const margin = revenue ? profit / revenue : null;
  const marginPrior = revenuePrior ? profitPrior / revenuePrior : null;

  /* Cash & liquidity — the balance sheet is fresher-or-equal to `balances`
     when both exist, and carries the comparatives. */
  const bsNewer = (latest.balance_sheet?.pulled_at || '') >= (latest.balances?.pulled_at || '');
  const cash = num(bs && bsNewer ? bs.cash : bal?.cash ?? bs?.cash);
  const cashM1 = compValue(bs, 'Cash at bank', 'm1');
  const cashM12 = compValue(bs, 'Cash at bank', 'm12');
  const wcAt = (k) => {
    const ca = compValue(bs, 'Current assets', k);
    const cl = compValue(bs, 'Creditors < 1 year', k);
    return ca == null || cl == null ? null : ca - cl;
  };
  const workingCapital = bs && num(bs.current_assets) != null && num(bs.current_liabilities) != null
    ? num(bs.current_assets) - num(bs.current_liabilities) : wcAt('now');
  const workingCapitalM12 = wcAt('m12');

  const mon = monthly(d('pnl_monthly'), latest.pnl_monthly?.pulled_at);
  const recent = mon ? mon.complete.slice(-6) : [];
  const avgCosts = recent.length ? recent.reduce((a, r) => a + r.costs, 0) / recent.length : null;
  const cashCover = cash != null && avgCosts > 0 ? cash / avgCosts : null;
  const ltmRevenue = mon && mon.complete.length
    ? mon.complete.reduce((a, r) => a + r.income, 0) * (12 / mon.complete.length) : null;

  /* Working capital — debtors by age, creditors by age */
  const ar = agedSummary(d('aged_receivables'));
  const arPrevRow = priorMonthSnapshot(rows, 'aged_receivables');
  const arPrev = agedSummary(arPrevRow?.data);
  if (arPrev) arPrev.asAt = arPrevRow.period_end || String(arPrevRow.pulled_at || '').slice(0, 10);
  const ap = agedSummary(d('aged_payables'));
  // Two caches carry a debtors figure; take whichever was pulled more recently.
  const balDebtors = num(bs && bsNewer ? bs.debtors : bal?.debtors) ?? num(bal?.debtors);
  const debtors = ar?.total == null ? balDebtors
    : balDebtors == null ? ar.total
    : (latest.aged_receivables?.pulled_at || '') > (latest.balance_sheet?.pulled_at || latest.balances?.pulled_at || '')
      ? ar.total : balDebtors;
  const debtorDays = debtors != null && ltmRevenue > 0 ? (debtors / ltmRevenue) * 365 : null;

  /* Freshness — the OLDEST headline snapshot is what the tile can vouch for. */
  const stamps = ['pl_fytd', 'balance_sheet', 'balances', 'pnl_monthly', 'aged_receivables']
    .map((k) => latest[k]?.pulled_at).filter(Boolean).sort();
  const oldestPulledAt = stamps[0] || null;
  const newestPulledAt = stamps[stamps.length - 1] || null;
  const ageDays = oldestPulledAt ? (Date.now() - new Date(oldestPulledAt).getTime()) / 86400000 : null;

  return {
    currency: d('pnl_monthly')?.currency || plCur?.currency || bs?.currency || 'GBP',
    hasFigures: !!(plCur || bs || bal || mon),
    ytdPeriod: plCur?.period || null,
    revenue, revenuePrior, revenueChange: pctChange(revenue, revenuePrior),
    profit, profitPrior, profitDelta: profit != null && profitPrior != null ? profit - profitPrior : null,
    margin, marginPrior,
    marginDeltaPts: margin != null && marginPrior != null ? (margin - marginPrior) * 100 : null,
    cash, cashM1, cashM12,
    cashDeltaM1: cash != null && cashM1 != null ? cash - cashM1 : null,
    cashDeltaM12: cash != null && cashM12 != null ? cash - cashM12 : null,
    avgCosts, cashCover,
    workingCapital, workingCapitalM12,
    debtors, debtorDays, ar, arPrev, ap,
    monthly: mon?.rows || [],
    fileHealth: d('file_health'),
    oldestPulledAt, newestPulledAt, ageDays,
    stale: ageDays != null && ageDays > STALE_DAYS,
  };
}

/*
  Flags — ordered red first. Thresholds are deliberately round numbers a CFO
  would say out loud; they are signals to open the dashboard, not verdicts.
*/
export function portfolioFlags(f, { chBad = false, chSevere = false, chLabel = '' } = {}) {
  const out = [];
  const add = (level, text) => out.push({ level, text });
  const pct = (v) => `${Math.abs(Math.round(v * 100))}%`;

  if (chBad) add(chSevere ? 'red' : 'amber', `Companies House: ${chLabel}`);

  if (f.revenueChange != null && f.revenueChange <= -0.1) {
    add(f.revenueChange <= -0.2 ? 'red' : 'amber', `Revenue down ${pct(f.revenueChange)} on last year`);
  }
  if (f.profit != null && f.profit < 0) add('red', 'Loss-making year to date');
  else if (f.marginDeltaPts != null && f.marginDeltaPts <= -5) {
    add('amber', `Margin down ${Math.abs(Math.round(f.marginDeltaPts))} pts on last year`);
  }

  if (f.cash != null && f.cash < 0) add('red', 'Overdrawn');
  else if (f.cashCover != null && f.cashCover < 2) {
    add(f.cashCover < 1 ? 'red' : 'amber', `Cash covers ${f.cashCover.toFixed(1)} months of costs`);
  }
  if (f.cashM12 > 0 && f.cash != null && (f.cash - f.cashM12) / f.cashM12 <= -0.25) {
    add('amber', `Cash down ${pct((f.cash - f.cashM12) / f.cashM12)} on a year ago`);
  }

  if (f.ar && f.ar.over90Share >= 0.25 && f.ar.over90 >= 1000) {
    const rising = f.arPrev && f.ar.over90 > f.arPrev.over90 * 1.05;
    add(f.ar.over90Share >= 0.5 ? 'red' : 'amber',
      `${pct(f.ar.over90Share)} of debtors over 90 days${rising ? ', and rising' : ''}`);
  }
  if (f.debtorDays != null && f.debtorDays > 90 && !(f.ar && f.ar.over90Share >= 0.25)) {
    add('amber', `Debtor days ${Math.round(f.debtorDays)}`);
  }
  if (f.ap && f.ap.over90Share >= 0.25 && f.ap.over90 >= 1000) {
    add('amber', `${pct(f.ap.over90Share)} of creditors over 90 days`);
  }

  for (const flag of f.fileHealth?.flags || []) {
    add(f.fileHealth.score === 'red' ? 'red' : 'amber', `Books: ${flag}`);
  }

  if (f.stale) add('amber', `Figures ${Math.floor(f.ageDays)} days old`);

  const rank = { red: 0, amber: 1 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

// Sort key for "needs attention first": reds dominate, then ambers.
export const attentionScore = (flags) =>
  flags.reduce((s, fl) => s + (fl.level === 'red' ? 10 : 1), 0);
