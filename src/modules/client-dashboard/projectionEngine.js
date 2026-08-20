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
  const byLine = {};             // nominal_type → month → amount, for the total fallbacks
  const monthSet = new Set();

  for (const r of rows || []) {
    const m = monthOf(r.period);
    monthSet.add(m);
    const nt = String(r.nominal_type || '');
    const amount = Number(r.amount_p || 0) / P_TO_POUNDS;

    lineTotals[nt] = (lineTotals[nt] || 0) + amount;
    byLine[nt] = byLine[nt] || {};
    byLine[nt][m] = (byLine[nt][m] || 0) + amount;

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

  /*
    TOTAL-ONLY PACKS.

    Component lines are preferred and the engine's own totals are ignored,
    because mapping both counts everything twice. But not every pack publishes
    components: the general cashflow pack has no pnl.revenue_* lines at all,
    only pnl.revenue_total, so income came out completely empty while costs —
    which DO have components there — came through. A projection showing a
    client zero turnover and a full cost base is worse than no projection.

    So a total is used only when the thing it totals produced nothing. What
    counts as "nothing" differs per total, and getting that wrong is how the
    double counting sneaks back:

      pnl.revenue_total totals the revenue lines, which all land on `income`.
      So the test is that ONE category — not the income kind, because
      pnl.vat_frs_benefit lands on `other_income` and would otherwise make an
      empty turnover row look populated.

      pnl.cost_total totals costs across several categories, so it may only be
      used when NONE of them has anything. Testing a single category there
      would double-count a pack that has cost_of_sales but no overheads.
  */
  const anyIn = (cats) => cats.some((c) => categories[c] && Object.keys(categories[c]).length);
  const costCategories = CATEGORIES.filter((c) => c.kind === 'cost').map((c) => c.key);
  const TOTAL_FALLBACKS = [
    { total: 'pnl.revenue_total', into: 'income', occupied: () => anyIn(['income']) },
    { total: 'pnl.cost_total', into: 'overheads', occupied: () => anyIn(costCategories) },
  ];
  for (const fb of TOTAL_FALLBACKS) {
    if (!byLine[fb.total] || fb.occupied()) continue;
    categories[fb.into] = categories[fb.into] || {};
    for (const m in byLine[fb.total]) {
      categories[fb.into][m] = (categories[fb.into][m] || 0) + byLine[fb.total][m];
    }
  }

  /*
    SIGN CONVENTION.

    The forecast engine stores P&L cost lines NEGATIVE — pnl.cost_of_sales
    comes back as −18,959 for a month that spent 18,959. QuickBooks stores its
    Expenses group POSITIVE. Both are internally consistent; they are just
    opposite, and the projection puts them in the same row.

    Left alone that is not a cosmetic problem: net = income − costs would have
    ADDED the forecast costs back, showing this client roughly eight times the
    profit its own forecast projects. So costs are normalised to positive here,
    matching QuickBooks and matching how the statement reads.

    Detected rather than hardcoded. A pack that changes its mind, or one I have
    not seen, should not need a code change to be right — and a whole scenario
    whose total costs are genuinely negative does not exist, so the test is
    safe. Liabilities get the same guard against the mirror image of this bug.
    Assets and capital do NOT: an overdrawn account and accumulated losses are
    both legitimately negative, and "correcting" them would be the actual bug.
  */
  const normaliseKind = (kind) => {
    const keys = Object.keys(categories).filter((c) => CATEGORY[c]?.kind === kind);
    let total = 0;
    for (const c of keys) for (const m in categories[c]) total += categories[c][m];
    if (total >= 0) return false;
    for (const c of keys) for (const m in categories[c]) categories[c][m] = -categories[c][m];
    return true;
  };
  const flipped = {
    cost: normaliseKind('cost'),
    liability: normaliseKind('liability'),
  };

  const lines = Object.entries(lineTotals)
    .map(([nominal_type, total]) => {
      const category = nominal_type.startsWith('cf.')
        ? 'ignore'
        : resolveCategory('forecast', nominal_type, overrides);
      const kind = CATEGORY[category]?.kind;
      return {
        source: 'forecast',
        key: nominal_type,
        label: nominal_type,
        // Show the line total the same way up as the statement shows it.
        total: flipped[kind] ? -total : total,
        category,
        isDefault: !overrides?.forecast?.[nominal_type],
        defaultCategory: defaultForecastCategory(nominal_type),
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  return { months: [...monthSet].sort(), categories, cf, lines, flipped };
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

  // Opening and closing cash from the BALANCE SHEET, not the cashflow report.
  //
  // QBO's CashFlow report does not reliably publish beginning/ending cash as
  // named groups — a real file checked here returned OperatingActivities,
  // InvestingActivities, FinancingActivities and CashIncrease and nothing else,
  // which would have left the cash line blank on the actuals side while the
  // forecast side drew a line, and that reads as "the cash ran out".
  //
  // The month-end bank balance is the same number and we already have it, so
  // closing is simply that month's cash. Opening is closing MINUS that month's
  // movement, not the previous month's balance: the previous month is missing
  // for the first column of any window, and taking it there would silently
  // publish a quarter whose opening + movement ≠ closing. Deriving it from the
  // movement makes the column tie by construction, including the first one.
  // These are a FALLBACK — a file that does publish the groups keeps using them
  // (see the QBO_CF_GROUPS ordering).
  if (bs?.lines?.cash && bsKeys.length) {
    const movement = QBO_CF_GROUPS.movement
      .map((k) => cf?.series?.[k])
      .find((a) => Array.isArray(a)) || null;
    const cfPos = {};
    cfKeys.forEach((m, i) => { if (m) cfPos[m] = i; });

    const closing = {};
    const opening = {};
    bsKeys.forEach((m, i) => {
      if (!m) return;
      const v = bs.lines.cash[i];
      if (v == null) return;
      closing[m] = Number(v);
      const mi = cfPos[m];
      if (movement && mi !== undefined) {
        opening[m] = Number(v) - (Number(movement[mi]) || 0);
      } else if (i > 0 && bs.lines.cash[i - 1] != null) {
        opening[m] = Number(bs.lines.cash[i - 1]);
      }
    });
    if (Object.keys(closing).length) cfSeries.__bs_closing_cash = closing;
    if (Object.keys(opening).length) cfSeries.__bs_opening_cash = opening;
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
// Candidate group titles per line, most-preferred first. The __bs_* entries are
// the balance-sheet fallbacks built in actualsByMonth, and come last so a file
// that does publish real cashflow groups keeps using them.
const QBO_CF_GROUPS = {
  opening: ['BeginningCash', 'CashAtBeginningOfPeriod', 'BeginningCashBalance', '__bs_opening_cash'],
  // QuickBooks publishes the activity split, not totals in and out, so the
  // money_in / money_out rows are forecast-only and simply stay empty on the
  // actuals side — which is why empty rows are dropped rather than dashed.
  money_in: [],
  money_out: [],
  operating: ['OperatingActivities', 'TotalOperatingActivities', 'NetCashProvidedByOperatingActivities'],
  investing: ['InvestingActivities', 'TotalInvestingActivities', 'NetCashProvidedByInvestingActivities'],
  financing: ['FinancingActivities', 'TotalFinancingActivities', 'NetCashProvidedByFinancingActivities'],
  movement: ['CashIncreaseDecrease', 'NetCashIncreaseForPeriod', 'NetCashIncrease', 'CashIncrease'],
  closing: ['EndingCash', 'CashAtEndOfPeriod', 'EndingCashBalance', '__bs_closing_cash'],
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

    /*
      Money out arrives signed negative from both sides — the forecast engine's
      cf.out_total and QBO's cashflow report agree on that — which is what makes
      "in + out = movement" work. But the P&L above now shows costs as positive
      magnitudes, and one statement contradicting the other in the same tab is
      the exact confusion this pass is meant to end. Shown positive it also
      reads the way a person expects: in − out = movement.

      Detected from the whole series, never abs(), so a month with a genuine
      net inflow on that line still shows as one.
    */
    if (line.outflow) {
      const total = values.reduce((t, v) => t + (v || 0), 0);
      if (total < 0) {
        for (let i = 0; i < values.length; i += 1) {
          if (values[i] != null) values[i] = -values[i];
        }
      }
    }

    return { category: line.key, label: line.label, kind: isBalance ? 'balance' : 'flow', values };
  }).filter((r) => r.values.some((v) => v != null));
}

export { PL_ORDER, BS_ORDER, CATEGORIES };
