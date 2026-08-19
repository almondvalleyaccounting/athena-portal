/*
  Projection line mapping — how a forecast scenario and a QuickBooks file are
  made to speak the same language.

  The Projection tab puts actual months and forecast months in the same table,
  so both sides have to land on ONE set of statement rows. They arrive in two
  different dialects:

    • fc_output rows are keyed by `nominal_type` — 'pnl.revenue_la_funded',
      'bs.debtors_private', 'cf.out.payroll'. The keys differ by vertical pack,
      and the same scenario carries BOTH component lines and the totals derived
      from them ('pnl.revenue_total' alongside 'revenue'), so anything that
      naively summed every row would double-count badly.

    • QBO actuals are keyed by account id, with a QBO account type behind them.

  So: explicit rules first, then a prefix fallback, then a per-realm override
  table (dashboard_projection_map) that always wins. Nothing is discarded — a
  line nobody recognises lands in the catch-all for its statement section and
  shows up in the Mapping sub-tab asking to be told where it belongs.

  TOTALS ARE NOT MAPPED. Every derived line the engine emits (revenue_total,
  ebitda, net_assets, the bs.check row) is deliberately marked `ignore`,
  because the dashboard recomputes its own totals from the components. Mapping
  a total would count its parts twice.
*/

/* ─── Categories ───────────────────────────────────────────────── */
// section drives which statement a category appears on and which catch-all
// picks up its strays. sign is +1 for lines that add to the section subtotal.
export const CATEGORIES = [
  // Profit & loss
  { key: 'income', label: 'Income', section: 'pl', kind: 'income' },
  { key: 'other_income', label: 'Other income', section: 'pl', kind: 'income' },
  { key: 'unmapped_income', label: 'Unmapped income', section: 'pl', kind: 'income', catchAll: true },
  { key: 'cost_of_sales', label: 'Cost of sales', section: 'pl', kind: 'cost' },
  { key: 'staff_costs', label: 'Staff costs', section: 'pl', kind: 'cost' },
  { key: 'premises_costs', label: 'Premises costs', section: 'pl', kind: 'cost' },
  { key: 'overheads', label: 'Overheads', section: 'pl', kind: 'cost' },
  { key: 'depreciation', label: 'Depreciation', section: 'pl', kind: 'cost' },
  { key: 'interest', label: 'Interest', section: 'pl', kind: 'cost' },
  { key: 'tax', label: 'Tax', section: 'pl', kind: 'cost' },
  { key: 'unmapped_costs', label: 'Unmapped costs', section: 'pl', kind: 'cost', catchAll: true },

  // Balance sheet
  { key: 'fixed_assets', label: 'Fixed assets', section: 'bs', kind: 'asset' },
  { key: 'debtors', label: 'Debtors', section: 'bs', kind: 'asset' },
  { key: 'cash', label: 'Cash at bank', section: 'bs', kind: 'asset' },
  { key: 'other_current_assets', label: 'Other current assets', section: 'bs', kind: 'asset' },
  { key: 'unmapped_assets', label: 'Unmapped assets', section: 'bs', kind: 'asset', catchAll: true },
  { key: 'creditors', label: 'Creditors', section: 'bs', kind: 'liability' },
  { key: 'tax_liabilities', label: 'Tax liabilities', section: 'bs', kind: 'liability' },
  { key: 'loans', label: 'Loans & finance', section: 'bs', kind: 'liability' },
  { key: 'other_liabilities', label: 'Other liabilities', section: 'bs', kind: 'liability' },
  { key: 'unmapped_liabilities', label: 'Unmapped liabilities', section: 'bs', kind: 'liability', catchAll: true },
  { key: 'capital', label: 'Capital & reserves', section: 'bs', kind: 'capital' },
  { key: 'unmapped_capital', label: 'Unmapped capital', section: 'bs', kind: 'capital', catchAll: true },

  // Not shown as a row of its own
  { key: 'dividends', label: 'Dividends', section: 'pl', kind: 'appropriation' },
  { key: 'ignore', label: 'Not used', section: 'none', kind: 'ignore' },
];

export const CATEGORY = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));
export const catLabel = (key) => CATEGORY[key]?.label || key;

export const PL_ORDER = ['income', 'other_income', 'unmapped_income', 'cost_of_sales', 'staff_costs',
  'premises_costs', 'overheads', 'depreciation', 'interest', 'tax', 'unmapped_costs'];
export const BS_ORDER = ['fixed_assets', 'debtors', 'cash', 'other_current_assets', 'unmapped_assets',
  'creditors', 'tax_liabilities', 'loans', 'other_liabilities', 'unmapped_liabilities',
  'capital', 'unmapped_capital'];

/* ─── Forecast nominal_type → category ─────────────────────────── */
// Exact keys first — these are the engine's own vocabulary and worth being
// explicit about, because a prefix rule would put 'pnl.cost_total' in overheads
// and double the cost base.
const FORECAST_EXACT = {
  // Derived totals and checks — recomputed downstream, never summed here.
  'pnl.revenue_total': 'ignore',
  'pnl.cost_total': 'ignore',
  'pnl.gross_profit': 'ignore',
  'pnl.ebitda': 'ignore',
  'pnl.ebit': 'ignore',
  'pnl.pbt': 'ignore',
  'pnl.npat': 'ignore',
  'pnl.interest_total': 'interest',
  'pnl.tax_total': 'tax',
  'pnl.depreciation_total': 'depreciation',
  'pnl.dividends': 'dividends',

  // Revenue
  'pnl.revenue_private': 'income',
  'pnl.revenue_la_funded': 'income',
  'pnl.income_inflation_uplift': 'income',
  'pnl.vat_frs_benefit': 'other_income',

  // Costs
  'pnl.cost_of_sales': 'cost_of_sales',
  'pnl.cost_direct_costs': 'cost_of_sales',
  'pnl.cost_staff_direct': 'staff_costs',
  'pnl.cost_staff_overhead': 'staff_costs',
  'pnl.cost_payroll': 'staff_costs',
  'pnl.cost_premises': 'premises_costs',
  'pnl.cost_premises_rent': 'premises_costs',
  'pnl.cost_premises_service_charge': 'premises_costs',
  'pnl.cost_premises_maintenance': 'premises_costs',
  'pnl.cost_premises_utilities': 'premises_costs',
  'pnl.cost_premises_other': 'premises_costs',
  'pnl.cost_utilities': 'premises_costs',
  'pnl.cost_admin': 'overheads',
  'pnl.cost_overheads': 'overheads',
  'pnl.cost_other_overhead': 'overheads',
  'pnl.cost_inflation_uplift': 'overheads',
  'pnl.cost_pre_opening': 'overheads',

  // Balance sheet — totals out
  'bs.total_assets': 'ignore',
  'bs.total_liabilities': 'ignore',
  'bs.total_liab_equity': 'ignore',
  'bs.net_assets': 'ignore',
  'bs.net_current_assets': 'ignore',
  'bs.net_wc': 'ignore',
  'bs.current_assets': 'ignore',
  'bs.non_current_assets': 'ignore',
  'bs.current_liabilities': 'ignore',
  'bs.non_current_liabilities': 'ignore',
  'bs.check': 'ignore',
  'bs.opening_cash_alloc': 'ignore',

  // Balance sheet — components
  'bs.fixed_assets': 'fixed_assets',
  'bs.fixed_assets_net': 'fixed_assets',
  'bs.fixed_assets_gross': 'ignore',          // net is the one that belongs on the face
  'bs.accumulated_depreciation': 'ignore',    // already inside fixed_assets_net
  'bs.cash': 'cash',
  'bs.debtors': 'debtors',
  'bs.debtors_la': 'debtors',
  'bs.debtors_private': 'debtors',
  'bs.creditors': 'creditors',
  'bs.advance_billing': 'creditors',
  'bs.deposits_held': 'creditors',
  'bs.payroll_creditor': 'creditors',
  'bs.tax_payable': 'tax_liabilities',
  'bs.tax_liability': 'tax_liabilities',
  'bs.vat_liability': 'tax_liabilities',
  'bs.debt': 'loans',
  'bs.debt_current_portion': 'ignore',        // inside bs.debt
  'bs.long_term_loans': 'ignore',             // inside bs.debt
  'bs.loans': 'loans',
  'bs.directors_loans': 'other_liabilities',
  'bs.other_liabilities': 'other_liabilities',
  'bs.equity': 'capital',
};

// Cashflow lines the Cashflow sub-tab reads straight off, in preference order.
export const CF_LINES = [
  { key: 'opening', label: 'Opening cash', sources: ['cf.opening_cash'], kind: 'balance' },
  { key: 'operating', label: 'Operating', sources: ['cf.operating'], fallbackIn: ['cf.in.'], fallbackOut: ['cf.out.'], kind: 'flow' },
  { key: 'investing', label: 'Investing', sources: ['cf.investing'], fallbackOut: ['cf.out.capex'], kind: 'flow' },
  { key: 'financing', label: 'Financing', sources: ['cf.financing'], kind: 'flow' },
  { key: 'movement', label: 'Net movement', sources: ['cf.net_movement'], kind: 'flow' },
  { key: 'closing', label: 'Closing cash', sources: ['cf.closing_cash'], kind: 'balance' },
];

/*
  defaultForecastCategory(nominalType)

  Explicit rule → prefix fallback. The prefix fallback is deliberately cautious:
  module-level detail (`revenue`, `staff_cost`, `overhead`, `capex`) and the
  cashflow / metric / deal namespaces are IGNORED, because the pnl.* and bs.*
  lines already roll them up and the Cashflow sub-tab reads cf.* directly.
  Anything genuinely new inside pnl.* / bs.* falls to a catch-all so it is
  visible and can be assigned.
*/
export function defaultForecastCategory(nominalType) {
  const k = String(nominalType || '');
  if (FORECAST_EXACT[k]) return FORECAST_EXACT[k];

  if (k.startsWith('metric.') || k.startsWith('deal.') || k.startsWith('cf.')
    || k.startsWith('wc_balance.')) return 'ignore';

  // Bare module keys — the components behind the pnl.* / bs.* rollups.
  if (!k.includes('.')) return 'ignore';

  if (k.startsWith('pnl.')) {
    if (/revenue|income|sales|turnover/.test(k)) return 'unmapped_income';
    return 'unmapped_costs';
  }
  if (k.startsWith('bs.')) {
    if (/equity|capital|reserve|retained/.test(k)) return 'unmapped_capital';
    if (/liabilit|creditor|payable|loan|debt|accrual|deferred|tax/.test(k)) return 'unmapped_liabilities';
    return 'unmapped_assets';
  }
  return 'ignore';
}

/* ─── QBO account → category ───────────────────────────────────── */
// QBO's account type gets us most of the way; a light name pass separates the
// lines an owner actually reads separately (staff, premises, depreciation,
// interest) out of the single "Expense" bucket QBO would otherwise give.
// The stems have to allow their own inflections — a rule that matches "wage"
// but not "Wages" quietly files most payroll codes under overheads, which is
// exactly the sort of near-miss nobody notices in a total.
const NAME_RULES = [
  { cat: 'staff_costs', re: /\b(wages?|salar\w*|payroll|staff\w*|employ\w*|pension\w*|national insurance|nics?|ni)\b/i },
  { cat: 'premises_costs', re: /\b(rent\w*|rates|premises|propert\w*|service charges?|utilit\w*|electric\w*|gas|water|heat\w*|light\w*)\b/i },
  { cat: 'depreciation', re: /\b(depreciat\w*|amorti[sz]\w*)\b/i },
  { cat: 'interest', re: /\b(interest|finance charges?|bank charges?)\b/i },
  { cat: 'tax', re: /\b(corporation tax|corp tax|ct)\b/i },
];

const TYPE_DEFAULT = {
  'Income': 'income',
  'Other Income': 'other_income',
  'Cost of Goods Sold': 'cost_of_sales',
  'Expense': 'overheads',
  'Other Expense': 'overheads',
};

export function defaultActualCategory(account) {
  if (!account) return 'unmapped_costs';
  const name = `${account.fq_name || account.name || ''}`;
  for (const r of NAME_RULES) {
    if (r.re.test(name)) {
      // A revenue-classified code never becomes a cost, whatever it's called.
      if (account.classification === 'Revenue') break;
      return r.cat;
    }
  }
  const byType = TYPE_DEFAULT[account.type];
  if (byType) return byType;
  if (account.classification === 'Revenue') return 'unmapped_income';
  if (account.classification === 'Expense') return 'unmapped_costs';
  return 'unmapped_costs';
}

/*
  resolveCategory(source, key, overrides, ctx)

  overrides — { forecast: { key: cat }, actual: { accountId: cat } } read from
  dashboard_projection_map. An override always wins, including an override TO
  'ignore', which is how someone silences a line they know is a duplicate.
*/
export function resolveCategory(source, key, overrides = {}, ctx = {}) {
  const o = overrides?.[source]?.[String(key)];
  if (o) return o;
  return source === 'forecast'
    ? defaultForecastCategory(key)
    : defaultActualCategory(ctx.account);
}

// Categories a person may pick in the Mapping sub-tab, grouped for the select.
export const PICKABLE = [
  { group: 'Profit & loss', keys: ['income', 'other_income', 'cost_of_sales', 'staff_costs', 'premises_costs', 'overheads', 'depreciation', 'interest', 'tax', 'dividends'] },
  { group: 'Balance sheet', keys: ['fixed_assets', 'debtors', 'cash', 'other_current_assets', 'creditors', 'tax_liabilities', 'loans', 'other_liabilities', 'capital'] },
  { group: 'Catch-all', keys: ['unmapped_income', 'unmapped_costs', 'unmapped_assets', 'unmapped_liabilities', 'unmapped_capital'] },
  { group: 'Excluded', keys: ['ignore'] },
];
