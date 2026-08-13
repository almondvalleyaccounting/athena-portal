// Definitions of which lines belong on each statement and their order.
// Optional flags:
//   aggregate: 'sum' (default) | 'last' | 'first' | 'avg'
//   kind:      'header' | 'subtle' (italic muted)
//   indent:    boolean — visual indent
//   group:     opaque tag used by the view to gate visibility (e.g. 'inflation')

export const PNL_LINES = [
  { nominal_type: 'pnl.revenue_private',       label: 'Private fees', indent: true },
  { nominal_type: 'pnl.revenue_la_funded',     label: 'LA funded', indent: true },
  { nominal_type: 'pnl.revenue_total',         label: 'Revenue', kind: 'header' },
  { nominal_type: 'pnl.income_inflation_uplift', label: 'of which: inflation uplift', indent: true, kind: 'subtle', group: 'inflation' },

  // ─── Direct costs (site-level) ───
  { nominal_type: 'pnl.cost_staff_direct',     label: 'Direct staff (site managers + practitioners)', indent: true },
  { nominal_type: 'pnl.cost_direct_costs',     label: 'Direct costs (consumables / food)', indent: true },

  // ─── Overheads ───
  { nominal_type: 'pnl.cost_staff_overhead',   label: 'Overhead staff (executive / senior mgr / admin)', indent: true },
  { nominal_type: 'pnl.cost_premises',         label: 'Premises (rent / NDR / maintenance)', indent: true },
  { nominal_type: 'pnl.cost_utilities',        label: 'Utilities', indent: true },
  { nominal_type: 'pnl.cost_other_overhead',   label: 'Other overheads', indent: true },
  { nominal_type: 'pnl.cost_admin',            label: 'Admin (central overhead)', indent: true },

  // ─── Pre-opening (one-off until site opens) ───
  { nominal_type: 'pnl.cost_pre_opening',      label: 'Pre-opening costs', indent: true },

  { nominal_type: 'pnl.cost_total',            label: 'Operating costs (total)' },
  { nominal_type: 'pnl.cost_inflation_uplift', label: 'of which: inflation uplift', indent: true, kind: 'subtle', group: 'inflation' },

  { nominal_type: 'pnl.ebitda',                label: 'EBITDA', kind: 'header' },
  { nominal_type: 'pnl.depreciation_total',    label: 'Depreciation' },
  { nominal_type: 'pnl.ebit',                  label: 'EBIT', kind: 'header' },
  // Financing costs (mortgage + bank loan + director loan interest)
  { nominal_type: 'pnl.interest_total',        label: 'Financing costs (mortgage + loan interest)' },
  { nominal_type: 'pnl.pbt',                   label: 'PBT', kind: 'header' },
  { nominal_type: 'pnl.tax_total',             label: 'Tax' },
  { nominal_type: 'pnl.npat',                  label: 'NPAT', kind: 'header' },
  { nominal_type: 'pnl.dividends',             label: 'Dividends declared' },
];

export const BS_LINES = [
  // ─── Non-current assets ───
  { nominal_type: 'bs.fixed_assets_gross',      label: 'Fixed assets (gross)', aggregate: 'last', indent: true },
  { nominal_type: 'bs.accumulated_depreciation',label: 'Accumulated depreciation', aggregate: 'last', indent: true },
  { nominal_type: 'bs.non_current_assets',      label: 'Non-current assets', kind: 'header', aggregate: 'last' },

  // ─── Current assets ───
  { nominal_type: 'bs.cash',             label: 'Cash', aggregate: 'last', indent: true },
  { nominal_type: 'bs.debtors_private',  label: 'Debtors — private', aggregate: 'last', indent: true },
  { nominal_type: 'bs.debtors_la',       label: 'Debtors — LA funded', aggregate: 'last', indent: true },
  { nominal_type: 'bs.current_assets',   label: 'Current assets', kind: 'header', aggregate: 'last' },

  { nominal_type: 'bs.total_assets',     label: 'TOTAL ASSETS', kind: 'header', aggregate: 'last' },

  // ─── Current liabilities ───
  { nominal_type: 'bs.creditors',           label: 'Creditors', aggregate: 'last', indent: true },
  { nominal_type: 'bs.deposits_held',       label: 'Parent deposits', aggregate: 'last', indent: true },
  { nominal_type: 'bs.advance_billing',     label: 'Advance billing', aggregate: 'last', indent: true },
  { nominal_type: 'bs.tax_payable',         label: 'Tax payable', aggregate: 'last', indent: true },
  { nominal_type: 'bs.debt_current_portion',label: 'Debt — current portion (next 12m)', aggregate: 'last', indent: true },
  { nominal_type: 'bs.current_liabilities', label: 'Current liabilities', kind: 'header', aggregate: 'last' },
  { nominal_type: 'bs.net_current_assets',  label: 'Net current assets / (liabilities)', kind: 'header', aggregate: 'last' },

  // ─── Non-current liabilities ───
  { nominal_type: 'bs.long_term_loans',         label: 'Long-term loans (bank + mortgage)', aggregate: 'last', indent: true },
  { nominal_type: 'bs.directors_loans',         label: 'Directors\' loans', aggregate: 'last', indent: true },
  { nominal_type: 'bs.non_current_liabilities', label: 'Non-current liabilities', kind: 'header', aggregate: 'last' },

  { nominal_type: 'bs.net_assets',       label: 'NET ASSETS', kind: 'header', aggregate: 'last' },

  // ─── Equity (cross-check: should equal net assets) ───
  { nominal_type: 'bs.equity',           label: 'Equity', kind: 'header', aggregate: 'last' },
  { nominal_type: 'bs.total_liab_equity',label: 'TOTAL L + E', kind: 'header', aggregate: 'last' },
];

// `spacerBefore` inserts a blank row above the line and `total` draws a rule
// across the row in the Excel export. Both are presentation-only — the
// on-screen StatementView ignores them.
export const CF_LINES = [
  { nominal_type: 'cf.opening_cash',     label: 'Opening cash', aggregate: 'first', kind: 'header', spacerBefore: true },

  // ─── Cash in ───────────────────────────────────────────────────
  { nominal_type: 'cf.in.private',       label: 'Private fees', indent: true, spacerBefore: true },
  { nominal_type: 'cf.in.la_funded',     label: 'LA funded', indent: true },
  { nominal_type: 'cf.in.debt_drawdown', label: 'Funding drawdown', indent: true },
  { nominal_type: 'cf.in_total',         label: 'Total cash in', kind: 'header', total: true },

  // ─── One-off cash out (capex + pre-opening line items) ─────────
  { nominal_type: 'cf.out.capex',                 label: 'Capex',                       indent: true, spacerBefore: true },
  { nominal_type: 'cf.out.pre_opening_overhead',  label: 'Pre-opening — overhead',      indent: true },
  { nominal_type: 'cf.out.pre_opening_marketing', label: 'Pre-opening — marketing',     indent: true },
  { nominal_type: 'cf.out.pre_opening_staffing',  label: 'Pre-opening — staffing',      indent: true },
  { nominal_type: 'cf.out.one_off_total',         label: 'Total one-off',               kind: 'header', total: true },

  // ─── Recurring operating cash out ──────────────────────────────
  { nominal_type: 'cf.out.staff',          label: 'Staff costs', indent: true, spacerBefore: true },
  { nominal_type: 'cf.out.premises_rent',           label: 'Rent', indent: true },
  { nominal_type: 'cf.out.premises_service_charge', label: 'Service charge', indent: true },
  { nominal_type: 'cf.out.premises_maintenance',    label: 'Maintenance', indent: true },
  { nominal_type: 'cf.out.premises_other',          label: 'Other premises costs', indent: true },
  { nominal_type: 'cf.out.utilities',      label: 'Utilities', indent: true },
  { nominal_type: 'cf.out.other_overhead', label: 'Other overheads', indent: true },
  { nominal_type: 'cf.out.recurring_total',label: 'Total recurring', kind: 'header', total: true },

  // ─── Financing & tax ───────────────────────────────────────────
  { nominal_type: 'cf.out.interest',     label: 'Interest', indent: true, spacerBefore: true },
  { nominal_type: 'cf.out.principal',    label: 'Mortgage / loan principal', indent: true },
  { nominal_type: 'cf.out.tax',          label: 'Corporation tax contribution', indent: true },
  { nominal_type: 'cf.out.dividends',    label: 'Dividends paid', indent: true },
  { nominal_type: 'cf.out.fin_tax_total',label: 'Total financing & tax', kind: 'header', total: true },

  { nominal_type: 'cf.out_total',        label: 'Total cash out', kind: 'header', spacerBefore: true, total: true },

  { nominal_type: 'cf.wc_movement',      label: 'Working capital movement', spacerBefore: true },
  { nominal_type: 'cf.net_movement',     label: 'Net cash movement', kind: 'header', total: true },
  { nominal_type: 'cf.closing_cash',     label: 'Closing cash', aggregate: 'last', kind: 'header' },
];
