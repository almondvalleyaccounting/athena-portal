// P&L lines module — the input surface of the GENERAL CASHFLOW lens.
//
// Where the childcare pack derives revenue from occupancy × rate × places,
// this one starts from a list of lines (normally one per QuickBooks nominal
// account, seeded from actuals) and projects each forward on its own terms.
//
// Reads ctx.plLines (loaded by recompute from fc_pl_line) and emits raw,
// POSITIVE-magnitude rows tagged with their category; cashflow_core turns
// those into signed P&L lines and cash movements. Keeping the raw rows
// positive and the summary rows signed matches the childcare pack, where
// `revenue`/`overhead` are magnitudes and `pnl.cost_*` carry the sign.
//
// Projection for period t (0-based from the forecast's opening period):
//
//   override[t] ?? ( basis(t) × (1 + uplift_pct/100) + delta_p )
//                  × (1 + growth_pct_pa/100) ^ (t/12)
//
// basis(t) is base_amount_p, except under method 'shape' where it is the
// seeded amount for that CALENDAR month (so seasonality repeats in the
// right months rather than being replayed from the forecast's month 0).

import { formatMoney } from '../currency.js';

export const CATEGORIES = [
  { key: 'income',        label: 'Income',         isCost: false },
  { key: 'cost_of_sales', label: 'Cost of sales',  isCost: true  },
  { key: 'payroll',       label: 'Payroll',        isCost: true  },
  { key: 'overheads',     label: 'Overheads',      isCost: true  },
  { key: 'capex',         label: 'Capital spend',  isCost: true  },   // cash + assets, not P&L
];

export const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map(c => [c.key, c.label]));

const NOMINAL_BY_CATEGORY = {
  income:        'revenue',
  cost_of_sales: 'cost_of_sales',
  payroll:       'staff_cost',
  overheads:     'overhead',
  capex:         'capex',
};

/** Calendar month (1-12) of period t, given the forecast's opening period. */
export function calendarMonth(openingPeriod, t) {
  const d = openingPeriod ? new Date(openingPeriod) : new Date();
  const m0 = d.getUTCMonth();                       // 0-11
  return ((m0 + t) % 12) + 1;
}

/**
 * Average seeded amount per calendar month, e.g. { 9: 412300, 10: 388100 }.
 * Averaged because a seed window longer than a year covers some months twice.
 */
export function shapeByCalendarMonth(actuals) {
  const months = actuals?.months || [];
  const amounts = actuals?.amounts_p || [];
  const sums = {}, counts = {};
  for (let i = 0; i < months.length; i++) {
    const m = Number(String(months[i]).slice(5, 7));   // 'YYYY-MM'
    if (!m) continue;
    sums[m] = (sums[m] || 0) + (Number(amounts[i]) || 0);
    counts[m] = (counts[m] || 0) + 1;
  }
  const out = {};
  for (const m of Object.keys(sums)) out[m] = sums[m] / counts[m];
  return out;
}

/** Monthly amount for one line at period t, in pence. Always a magnitude. */
export function amountForPeriod(line, t, openingPeriod, shapeCache) {
  const start = Number(line.start_month) || 0;
  const end = line.end_month == null ? null : Number(line.end_month);
  if (t < start) return 0;
  if (end != null && t > end) return 0;

  const overrides = line.overrides || {};
  const ov = overrides[String(t)];
  if (ov != null && ov !== '') return Number(ov) || 0;

  if (line.method === 'zero') return 0;

  let basis = Number(line.base_amount_p) || 0;
  if (line.method === 'shape') {
    const shape = shapeCache.get(line.id) || shapeByCalendarMonth(line.actuals);
    shapeCache.set(line.id, shape);
    const m = calendarMonth(openingPeriod, t);
    basis = shape[m] != null ? shape[m] : basis;
  }

  const adjusted = basis * (1 + (Number(line.uplift_pct) || 0) / 100) + (Number(line.delta_p) || 0);
  const growth = Math.pow(1 + (Number(line.growth_pct_pa) || 0) / 100, t / 12);
  return adjusted * growth;
}

export const plLinesModule = {
  key: 'pl_lines',
  pack: ['general_cashflow'],
  dependsOn: [],
  drivers: [],          // lines are first-class records, not driver values
  outputs: [
    { nominal_type: 'revenue',       label: 'Income line',        by_entity: false },
    { nominal_type: 'cost_of_sales', label: 'Cost of sales line', by_entity: false },
    { nominal_type: 'staff_cost',    label: 'Payroll line',       by_entity: false },
    { nominal_type: 'overhead',      label: 'Overhead line',      by_entity: false },
    { nominal_type: 'capex',         label: 'Capital spend line', by_entity: false },
  ],

  compute(ctx) {
    const out = [];
    const lines = (ctx.plLines || []).filter(l => l.is_active !== false);
    if (lines.length === 0) return out;

    const openingPeriod = ctx.forecast?.opening_period;
    const shapeCache = new Map();

    for (const line of lines) {
      const nominal = NOMINAL_BY_CATEGORY[line.category] || 'overhead';
      const tags = {
        line_id: line.id,
        category: line.category,
        vat: line.vat_treatment || 'standard',
        // null lag means "use the category default" — resolved in cashflow_core,
        // which is the only place that knows the driver values.
        lag_days: line.cash_lag_days == null ? null : Number(line.cash_lag_days),
      };

      for (const t of ctx.periods) {
        const amount = amountForPeriod(line, t, openingPeriod, shapeCache);
        if (!amount) continue;
        out.push({
          module_key: 'pl_lines',
          period: t,
          nominal_type: nominal,
          line_label: line.label,
          amount_p: Math.round(amount),
          tags,
        });
      }
    }

    return out;
  },

  validate(ctx) {
    const findings = [];
    const lines = (ctx.plLines || []).filter(l => l.is_active !== false);
    const money = (p) => formatMoney(Math.round(p), ctx.forecast?.currency);

    if (lines.length === 0) {
      findings.push({
        severity: 'warn',
        code: 'pl_lines.empty',
        message: 'No forecast lines yet — seed them from QuickBooks or add them by hand on the Lines tab.',
      });
      return findings;
    }

    if (!lines.some(l => l.category === 'income')) {
      findings.push({
        severity: 'warn',
        code: 'pl_lines.no_income',
        message: 'No income lines — the forecast will show costs only.',
      });
    }

    // A single exceptional month drags an average badly. Foursite's sales
    // window held one £400k month against ~£8k everywhere else, which set the
    // whole forecast to £43k/month — plausible-looking and wrong. Averages
    // hide this; the projection should say so.
    for (const line of lines) {
      if (line.method !== 'average') continue;
      const amounts = (line.actuals?.amounts_p || []).map(Number);
      const months = line.actuals?.months || [];
      if (amounts.length < 4) continue;
      const total = amounts.reduce((s, v) => s + v, 0);
      if (total <= 0) continue;
      let maxIdx = 0;
      for (let i = 1; i < amounts.length; i++) if (amounts[i] > amounts[maxIdx]) maxIdx = i;
      const share = amounts[maxIdx] / total;
      // One month of twelve is ~8%; a third of the window from a single month
      // is an event, not a run rate.
      if (share >= 0.33) {
        findings.push({
          severity: 'warn',
          code: 'pl_lines.average_skewed',
          message: `"${line.label}" — ${months[maxIdx] || `month ${maxIdx + 1}`} alone is ${Math.round(share * 100)}% of the seeded window, so the average basis (${money(total / amounts.length)}/month) is being pulled up by one exceptional month. Consider "last month" or "repeat monthly shape", or override that month.`,
        });
      }
    }

    // A line seeded from QBO but left on a zero basis is nearly always an
    // oversight (an account with no activity in the window would not have
    // been seeded at all).
    const zeroSeeded = lines.filter(l =>
      l.qbo_account_id && l.method !== 'zero' && !Number(l.base_amount_p) &&
      !Object.keys(l.overrides || {}).length);
    if (zeroSeeded.length > 0) {
      findings.push({
        severity: 'info',
        code: 'pl_lines.zero_basis',
        message: `${zeroSeeded.length} seeded line(s) have a zero monthly basis: ${zeroSeeded.slice(0, 5).map(l => l.label).join(', ')}${zeroSeeded.length > 5 ? '…' : ''}`,
      });
    }

    return findings;
  },
};
