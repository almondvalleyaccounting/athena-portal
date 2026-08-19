/*
  Projection engine — turns a Client Forecast scenario plus QuickBooks actuals
  into one continuous set of statement rows.

  Both sides are reduced to the same shape first: a per-month figure for every
  dashboard category (see projectionMapping.js). Only then are they bucketed by
  the grain / basis toggles and stitched at the actuals cut-off. Doing it in
  that order is what lets a quarter that straddles the cut-off be half actual
  and half forecast rather than having to be one or the other.

  Two rules about signs and stocks that matter:

    • Costs are POSITIVE magnitudes on both sides. QBO reports its Expenses
      group positive; the forecast engine stores cost lines positive in pence.
      Net profit is therefore income minus costs, never a sum.

    • Balance-sheet categories are STOCKS. A quarter's debtors figure is the
      debtors at the quarter END, not the sum of three months. Flow categories
      (P&L, cashflow movements) sum. Getting this wrong triples a balance
      sheet, so `kind` decides it, not the caller.
*/

import {
  CATEGORIES, CATEGORY, PL_ORDER, BS_ORDER, CF_LINES,
  resolveCategory, defaultForecastCategory, defaultActualCategory,
} from './projectionMapping';

const P_TO_POUNDS = 100;
const isStock = (cat) => CATEGORY[cat]?.section === 'bs';

/* ─── Forecast side ────────────────────────────────────────────── */
/*
  forecastByMonth(rows, openingPeriod, overrides)

  rows           fc_output rows { period, nominal_type, amount_p }
  openingPeriod  fc_forecast.opening_period ('YYYY-MM-DD'); period 0 is that month
  overrides      { forecast: { nominal_type: category } }

  → { months: [YYYY-MM], categories: { cat: { month: amount } }, lines: [...] }
    `lines` carries every nominal_type seen with its resolved category and its
    total, which is what the Mapping sub-tab lists.
*/
export function forecastByMonth(rows, openingPeriod, overrides = {}) {
  const [oy, om] = String(openingPeriod || '').slice(0, 7).split('-').map(Number);
  if (!oy || !om) return { months: [], categories: {}, lines: [], cf: {} };

  const monthOf = (period) => {
    const abs = (oy * 12 + (om - 1)) + Number(period || 0);
    return `${Math.floor(abs / 12)}-${String((abs % 12) + 1).padStart(2, '0')}`;
  };

  const categories = {};
  const cf = {};                 // raw cf.* series, for the Cashflow sub-tab
  const lineTotals = {};
  const monthSet = new Set();

  for (const r of rows || []) {
    const m = monthOf(r.period);
    monthSet.add(m);
    const nt = String(r.nominal_type || '');
    const amount = Number(r.amount_p || 0) / P_TO_POUNDS;

    lineTotals[nt] = (lineTotals[nt] || 0) + amount;

    if (nt.startsWith('cf.')) {
      // Cashflow lines are read directly rather than mapped; a scenario may
      // carry several entity rows for the same line, so they accumulate.
      cf[nt] = cf[nt] || {};
      cf[nt][m] = (cf[nt][m] || 0) + amount;
      continue;
    }

    const cat = resolveCategory('forecast', nt, overrides);
    if (cat === 'ignore') continue;
    categories[cat] = categories[cat] || {};
    // Stocks: a scenario can split one balance across entities, so the month's
    // value is still a sum ACROSS lines — it is only across MONTHS that a stock
    // must not be added up, and that happens later, at bucketing.
    categories[cat][m] = (categories[cat][m] || 0) + amount;
  }

  const lines = Object.entries(lineTotals)
    .map(([nominal_type, total]) => ({
      source: 'forecast',
      key: nominal_type,
      label: nominal_type,
      total,
      category: nominal_type.startsWith('cf.') ? 'ignore' : resolveCategory('forecast', nominal_type, overrides),
      isDefault: !overrides?.forecast?.[nominal_type],
      defaultCategory: defaultForecastCategory(nominal_type),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return { months: [...monthSet].sort(), categories, cf, lines };
}

/* ─── Actuals side ─────────────────────────────────────────────── */
/*
  actualsByMonth({ pl, bs, cf }, accountsById, overrides)

  pl  the `pnl_chart_detail` metric — per-account monthly amounts
  bs  the `bs_monthly` metric — already category-shaped balance-sheet lines
  cf  the `cf_monthly` metric — raw QBO cashflow group series
*/
export function actualsByMonth({ pl, bs, cf } = {}, accountsById = {}, overrides = {}) {
  const categories = {};
  const monthSet = new Set();
  const lineTotals = {};

  // P&L — per account, mapped to a category.
  const plKeys = pl?.month_keys || [];
  plKeys.forEach((m) => m && monthSet.add(m));
  for (const row of pl?.rows || []) {
    const account = accountsById[String(row.id)] || null;
    const cat = resolveCategory('actual', row.id, overrides, { account });
    const total = (row.amounts || []).reduce((s, v) => s + (Number(v) || 0), 0);
    if (row.id) {
      lineTotals[String(row.id)] = {
        label: account ? `${account.acct_num ? `${account.acct_num} · ` : ''}${account.fq_name || account.name}` : row.name,
        total: (lineTotals[String(row.id)]?.total || 0) + total,
        account,
      };
    }
    if (cat === 'ignore') continue;
    categories[cat] = categories[cat] || {};
    plKeys.forEach((m, i) => {
      if (!m) return;
      categories[cat][m] = (categories[cat][m] || 0) + (Number(row.amounts?.[i]) || 0);
    });
  }

  // Balance sheet — bsLines already speaks the dashboard's categories, so this
  // is a rename rather than a mapping. Creditors here are trade payables first,
  // falling back to the whole within-one-year group when QBO doesn't break out
  // an Accounts Payable group.
  const bsKeys = bs?.month_keys || [];
  bsKeys.forEach((m) => m && monthSet.add(m));
  const put = (cat, series) => {
    if (!series) return;
    categories[cat] = categories[cat] || {};
    bsKeys.forEach((m, i) => {
      const v = series[i];
      if (m && v != null) categories[cat][m] = (categories[cat][m] || 0) + Number(v);
    });
  };
  if (bs?.lines) {
    put('fixed_assets', bs.lines.fixed_assets);
    put('cash', bs.lines.cash);
    put('debtors', bs.lines.debtors);
    // Current assets that are neither cash nor debtors.
    if (bs.lines.current_assets) {
      const other = bs.lines.current_assets.map((v, i) => {
        if (v == null) return null;
        return Number(v) - Number(bs.lines.cash?.[i] || 0) - Number(bs.lines.debtors?.[i] || 0);
      });
      put('other_current_assets', other);
    }
    put('creditors', bs.lines.accounts_payable || bs.lines.creditors_within_1yr);
    put('loans', bs.lines.creditors_after_1yr);
    // Current liabilities beyond trade creditors — VAT, PAYE, accruals.
    if (bs.lines.creditors_within_1yr && bs.lines.accounts_payable) {
      const other = bs.lines.creditors_within_1yr.map((v, i) => {
        if (v == null) return null;
        return Number(v) - Number(bs.lines.accounts_payable[i] || 0);
      });
      put('other_liabilities', other);
    }
    put('capital', bs.lines.net_assets || bs.lines.equity);
  }

  const cfKeys = cf?.month_keys || [];
  cfKeys.forEach((m) => m && monthSet.add(m));
  const cfSeries = {};
  for (const [group, arr] of Object.entries(cf?.series || {})) {
    cfSeries[group] = {};
    cfKeys.forEach((m, i) => { if (m) cfSeries[group][m] = Number(arr[i]) || 0; });
  }

  const lines = Object.entries(lineTotals)
    .map(([id, v]) => ({
      source: 'actual',
      key: id,
      label: v.label,
      total: v.total,
      category: resolveCategory('actual', id, overrides, { account: v.account }),
      isDefault: !overrides?.actual?.[id],
      defaultCategory: defaultActualCategory(v.account),
    }))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));

  return { months: [...monthSet].sort(), categories, cf: cfSeries, lines };
}

/* ─── Stitching ────────────────────────────────────────────────── */
/*
  buildStatement({ buckets, actual, forecast, cutoff, order })

  For each bucket and each category, take the actual figure for months up to
  and including `cutoff` and the forecast figure for months after it. Flow
  categories sum their months; stock categories take the last month present.

  Returns { rows: [{ category, label, kind, values: [] }], status: [] } where
  `status` is 'actual' | 'forecast' | 'mixed' per bucket.
*/
export function buildStatement({ buckets = [], actual = {}, forecast = {}, cutoff, order = [] }) {
  const status = buckets.map((b) => {
    if (!cutoff) return 'forecast';
    if (b.endKey <= cutoff) return 'actual';
    if (b.startKey > cutoff) return 'forecast';
    return 'mixed';
  });

  const valueFor = (cat, bucket) => {
    const stock = isStock(cat);
    const aMap = actual[cat] || null;
    const fMap = forecast[cat] || null;
    let sum = 0;
    let seen = false;
    let last = null;
    for (const m of bucket.months) {
      const useActual = cutoff ? m <= cutoff : false;
      const src = useActual ? aMap : fMap;
      const v = src ? src[m] : undefined;
      if (v === undefined) continue;
      seen = true;
      sum += Number(v) || 0;
      last = Number(v) || 0;
    }
    if (!seen) return null;
    return stock ? last : sum;
  };

  const rows = order
    .map((cat) => ({
      category: cat,
      label: CATEGORY[cat]?.label || cat,
      kind: CATEGORY[cat]?.kind,
      catchAll: !!CATEGORY[cat]?.catchAll,
      values: buckets.map((b) => valueFor(cat, b)),
    }))
    // A catch-all with nothing in it is noise; a real category with nothing in
    // it is still worth a line, because its absence is information.
    .filter((r) => !r.catchAll || r.values.some((v) => v != null && Math.abs(v) > 0.005));

  return { rows, status };
}

// Sum a set of statement rows down each bucket column.
export function totalRow(rows, label, predicate = () => true) {
  const picked = rows.filter(predicate);
  if (!picked.length) return null;
  const n = picked[0].values.length;
  const values = [];
  for (let i = 0; i < n; i++) {
    let s = 0;
    let seen = false;
    for (const r of picked) {
      const v = r.values[i];
      if (v == null) continue;
      s += v; seen = true;
    }
    values.push(seen ? s : null);
  }
  return { category: `__${label}`, label, kind: 'total', values };
}

// income − costs, column by column.
export function netRow(rows, label = 'Net profit') {
  const inc = totalRow(rows, 'inc', (r) => r.kind === 'income');
  const cost = totalRow(rows, 'cost', (r) => r.kind === 'cost');
  const n = Math.max(inc?.values.length || 0, cost?.values.length || 0);
  const values = [];
  for (let i = 0; i < n; i++) {
    const a = inc?.values[i];
    const b = cost?.values[i];
    values.push(a == null && b == null ? null : (a || 0) - (b || 0));
  }
  return { category: '__net', label, kind: 'total', values };
}

/* ─── Cashflow ─────────────────────────────────────────────────── */
/*
  Cashflow rows come from named lines rather than mapped categories, because
  both sides already publish a cash statement and re-deriving one from the
  components would disagree with both. Each line names the forecast key it
  wants and the QBO group titles it will accept.
*/
const QBO_CF_GROUPS = {
  opening: ['BeginningCash', 'CashAtBeginningOfPeriod', 'BeginningCashBalance'],
  operating: ['OperatingActivities', 'TotalOperatingActivities', 'NetCashProvidedByOperatingActivities'],
  investing: ['InvestingActivities', 'TotalInvestingActivities', 'NetCashProvidedByInvestingActivities'],
  financing: ['FinancingActivities', 'TotalFinancingActivities', 'NetCashProvidedByFinancingActivities'],
  movement: ['CashIncreaseDecrease', 'NetCashIncreaseForPeriod', 'NetCashIncrease'],
  closing: ['EndingCash', 'CashAtEndOfPeriod', 'EndingCashBalance'],
};

export function buildCashflow({ buckets = [], actualCf = {}, forecastCf = {}, cutoff }) {
  const pickMap = (candidates, source) => {
    for (const c of candidates) if (source[c]) return source[c];
    return null;
  };

  return CF_LINES.map((line) => {
    const aMap = pickMap(QBO_CF_GROUPS[line.key] || [], actualCf);
    const fMap = pickMap(line.sources, forecastCf);
    const isBalance = line.kind === 'balance';

    const values = buckets.map((b) => {
      let sum = 0;
      let seen = false;
      let first = null;
      let last = null;
      for (const m of b.months) {
        const useActual = cutoff ? m <= cutoff : false;
        const src = useActual ? aMap : fMap;
        const v = src ? src[m] : undefined;
        if (v === undefined) continue;
        if (!seen) first = Number(v) || 0;
        seen = true;
        sum += Number(v) || 0;
        last = Number(v) || 0;
      }
      if (!seen) return null;
      // Opening cash is the FIRST month's opening, closing is the LAST month's
      // closing; the movements in between are what sum.
      if (isBalance) return line.key === 'opening' ? first : last;
      return sum;
    });

    return { category: line.key, label: line.label, kind: isBalance ? 'balance' : 'flow', values };
  }).filter((r) => r.values.some((v) => v != null));
}

export { PL_ORDER, BS_ORDER, CATEGORIES };
