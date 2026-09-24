/*
  Portfolio tile — the numbers behind each starred client's card, and the
  plain-English flags that sort the portfolio by who needs attention.

  PURE. Two halves:

  portfolioWindow()  turns a period preset (the Client Dashboard's own presets,
                     via computePeriod) and one client's fiscal year into the
                     dates dashboard-qbo-pull's `portfolio` window pulls, and
                     the cache keys those land under.

  buildPortfolioFigures()  turns the cached rows for those keys into figures
                     with their comparators:

    pl_cmp#<period>          the period, one column
    pl_cmp#<period − 12m>    the same period last year
    pnl_chart#<24 months>    monthly; last 12 are the bars, first 12 last year
    bs_asat#<period end>     balance sheet + comparatives (m1, m3, m12)
    ar_asat# / ap_asat#      ageing at the period end, and ar a month before

  The nightly job (sql/294) mirrors portfolioWindow() for the default preset in
  SQL. If the two ever disagree the tiles show "not pulled for this period"
  rather than wrong figures — keep them in step.
*/
import { computePeriod, shiftRangeBack, shiftMonthsBack, iso } from './dashboardData';

export const STALE_DAYS = 7;
export const DEFAULT_PERIOD = 'ytdLastMonth';

// What "Refresh all" asks for alongside the period window: the point-in-time
// metrics the tile reads whatever the period (file health, fiscal year).
export const HEADLINE_METRICS = ['company', 'file_health'];

export function portfolioWindow(key, today, fyIdx, custom = null) {
  const p = computePeriod(key, today, fyIdx, custom);
  const cmp = shiftRangeBack(p.plStart, p.plEnd, 12);
  const [ey, em] = p.chartEnd.split('-').map(Number);
  const chartStart = iso(new Date(ey, em - 1 - 23, 1));
  const asAt = p.plEnd;
  const arPrevDate = shiftMonthsBack(asAt, 1);
  return {
    key, label: p.label,
    plStart: p.plStart, plEnd: p.plEnd,
    cmpStart: cmp.start, cmpEnd: cmp.end,
    chartStart, chartEnd: p.chartEnd,
    asAt, arPrevDate,
    stored: key !== 'custom',
    keys: {
      pl: `pl_cmp#${p.plStart}_${p.plEnd}`,
      plPrior: `pl_cmp#${cmp.start}_${cmp.end}`,
      chart: `pnl_chart#${chartStart}_${p.chartEnd}`,
      bs: `bs_asat#${asAt}`,
      ar: `ar_asat#${asAt}`,
      arPrev: `ar_asat#${arPrevDate}`,
      ap: `ap_asat#${asAt}`,
    },
  };
}

// dashboard-qbo-pull's windowed response names → the keys above.
export const PULL_RESULT_NAMES = {
  pf_pl: 'pl', pf_pl_prior: 'plPrior', pf_chart: 'chart',
  pf_bs: 'bs', pf_ar: 'ar', pf_ar_prev: 'arPrev', pf_ap: 'ap',
};

const num = (v) => (v === null || v === undefined || isNaN(v) ? null : Number(v));
const pctChange = (cur, prev) =>
  cur == null || prev == null || prev === 0 ? null : (cur - prev) / Math.abs(prev);

function compValue(bs, label, key) {
  const cmp = bs?.comparatives;
  if (!cmp?.rows || !cmp?.columns) return null;
  const idx = cmp.columns.findIndex((c) => c.key === key);
  const row = cmp.rows.find((r) => r.label === label);
  return idx < 0 || !row ? null : num(row.values?.[idx]);
}

function agedSummary(data) {
  const b = data?.buckets;
  if (!b || num(b.total) == null) return null;
  const total = num(b.total);
  const over90 = num(b.b91_plus) || 0;
  return {
    total,
    buckets: {
      current: num(b.current) || 0,
      b1_30: num(b.b1_30) || 0,
      b31_60: num(b.b31_60) || 0,
      b61_90: num(b.b61_90) || 0,
      b91_plus: over90,
    },
    over90,
    over90Share: total > 0 ? over90 / total : 0,
  };
}

/*
  24 monthly columns → the last 12 as bars, each carrying the same month a year
  earlier. A month that ends after the data was pulled is a part-month: drawn
  hatched and left out of every average.
*/
function monthly(chart, pulledAt) {
  const s = chart?.series;
  if (!s?.income?.length) return null;
  const n = s.income.length;
  const labels = chart.months || [];
  const keys = chart.month_keys || [];
  const pulledDay = String(pulledAt || '').slice(0, 10);
  const at = (arr, i) => num(arr?.[i]) || 0;
  const monthEnd = (i) => {
    const [y, m] = String(keys[i] || '').slice(0, 7).split('-').map(Number);
    return y && m ? iso(new Date(y, m, 0)) : null;
  };
  const all = Array.from({ length: n }, (_, i) => ({
    label: labels[i] || '',
    income: at(s.income, i),
    costs: at(s.cogs, i) + at(s.expenses, i),
    net: s.net_income ? at(s.net_income, i) : at(s.income, i) - at(s.cogs, i) - at(s.expenses, i),
    partial: i === n - 1 && !!pulledDay && (monthEnd(i) || chart.period?.end || '') > pulledDay,
  }));
  const cur = all.slice(-12);
  const ly = n >= 24 ? all.slice(-24, -12) : null;
  const rows = cur.map((r, i) => ({ ...r, incomeLY: ly ? ly[i].income : null, netLY: ly ? ly[i].net : null }));
  return { rows, complete: rows.filter((r) => !r.partial), hasLastYear: !!ly };
}

/*
  rows: { pl, plPrior, chart, bs, ar, arPrev, ap } — each a cache row
  ({ data, pulled_at, period_end }) or null.
*/
export function buildPortfolioFigures(rows, { fileHealth = null } = {}) {
  const d = (k) => rows?.[k]?.data || null;
  const plCur = d('pl');
  const plPrior = d('plPrior');
  const bs = d('bs');

  /* Performance — the period vs the same period last year */
  const revenue = num(plCur?.income);
  const revenuePrior = num(plPrior?.income);
  const profit = num(plCur?.net_income);
  const profitPrior = num(plPrior?.net_income);
  const margin = revenue ? profit / revenue : null;
  const marginPrior = revenuePrior ? profitPrior / revenuePrior : null;

  /* Cash & liquidity, as at the period end */
  const cash = num(bs?.cash);
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

  const mon = monthly(d('chart'), rows?.chart?.pulled_at);
  const recent = mon ? mon.complete.slice(-6) : [];
  const avgCosts = recent.length ? recent.reduce((a, r) => a + r.costs, 0) / recent.length : null;
  const cashCover = cash != null && avgCosts > 0 ? cash / avgCosts : null;
  const ltmRevenue = mon && mon.complete.length
    ? mon.complete.reduce((a, r) => a + r.income, 0) * (12 / mon.complete.length) : null;

  /* Debtors & creditors, as at the period end */
  const ar = agedSummary(d('ar'));
  const arPrev = agedSummary(d('arPrev'));
  if (arPrev) arPrev.asAt = rows.arPrev.period_end || null;
  const ap = agedSummary(d('ap'));
  const debtors = ar?.total ?? num(bs?.debtors);
  const debtorDays = debtors != null && ltmRevenue > 0 ? (debtors / ltmRevenue) * 365 : null;

  /* Freshness — the OLDEST figure is what the tile can vouch for. */
  const stamps = ['pl', 'plPrior', 'chart', 'bs', 'ar']
    .map((k) => rows?.[k]?.pulled_at).filter(Boolean).sort();
  const oldestPulledAt = stamps[0] || null;
  const newestPulledAt = stamps[stamps.length - 1] || null;
  const ageDays = oldestPulledAt ? (Date.now() - new Date(oldestPulledAt).getTime()) / 86400000 : null;
  const missing = ['pl', 'plPrior', 'chart', 'bs', 'ar', 'ap'].filter((k) => !rows?.[k]);

  return {
    currency: plCur?.currency || d('chart')?.currency || bs?.currency || 'GBP',
    hasFigures: !!(plCur || bs || mon),
    complete: missing.length === 0,
    missing,
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
    hasLastYear: !!mon?.hasLastYear,
    fileHealth,
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
  if (f.profit != null && f.profit < 0) add('red', 'Loss-making in the period');
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

export const attentionScore = (flags) =>
  flags.reduce((s, fl) => s + (fl.level === 'red' ? 10 : 1), 0);
