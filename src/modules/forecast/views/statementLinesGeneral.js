// Statement line definitions for the GENERAL CASHFLOW lens.
//
// Deliberately generic labels — "Sales", not "Private fees" / "LA funded".
// Same shape as views/statementLines.js (which stays childcare-specific), so
// StatementView renders either without changes.

export const GENERAL_PNL_LINES = [
  { nominal_type: 'pnl.revenue_total',  label: 'Sales', kind: 'header' },
  { nominal_type: 'pnl.cost_of_sales',  label: 'Cost of sales', indent: true },
  { nominal_type: 'pnl.gross_profit',   label: 'Gross profit', kind: 'header' },

  { nominal_type: 'pnl.cost_payroll',   label: 'Payroll', indent: true },
  { nominal_type: 'pnl.cost_overheads', label: 'Overheads', indent: true },
  { nominal_type: 'pnl.cost_total',     label: 'Total costs' },

  { nominal_type: 'pnl.ebitda',         label: 'EBITDA', kind: 'header' },
  { nominal_type: 'pnl.interest_total', label: 'Interest' },
  { nominal_type: 'pnl.pbt',            label: 'Profit before tax', kind: 'header' },
  { nominal_type: 'pnl.tax_total',      label: 'Company tax' },
  { nominal_type: 'pnl.npat',           label: 'Profit after tax', kind: 'header' },
  { nominal_type: 'pnl.dividends',      label: 'Dividends / drawings' },
];

// Balance sheet. Every figure is a month-end position, so all lines aggregate
// with 'last' rather than summing. Liabilities are stored negative by the
// engine (the statement convention), so they read as deductions.
export const GENERAL_BS_LINES = [
  { nominal_type: 'bs.fixed_assets',      label: 'Fixed assets', aggregate: 'last', indent: true },
  { nominal_type: 'bs.debtors',           label: 'Debtors', aggregate: 'last', indent: true },
  { nominal_type: 'bs.cash',              label: 'Cash at bank', aggregate: 'last', indent: true },
  { nominal_type: 'bs.total_assets',      label: 'Total assets', kind: 'header', aggregate: 'last' },

  { nominal_type: 'bs.creditors',         label: 'Trade creditors', aggregate: 'last', indent: true },
  { nominal_type: 'bs.payroll_creditor',  label: 'Payroll taxes owed', aggregate: 'last', indent: true },
  { nominal_type: 'bs.vat_liability',     label: 'VAT owed', aggregate: 'last', indent: true },
  { nominal_type: 'bs.tax_liability',     label: 'Company tax owed', aggregate: 'last', indent: true },
  { nominal_type: 'bs.loans',             label: 'Loans outstanding', aggregate: 'last', indent: true },
  { nominal_type: 'bs.other_liabilities', label: 'Other liabilities', aggregate: 'last', indent: true },
  { nominal_type: 'bs.total_liabilities', label: 'Total liabilities', kind: 'header', aggregate: 'last' },

  { nominal_type: 'bs.net_assets',        label: 'NET ASSETS', kind: 'header', aggregate: 'last' },
  { nominal_type: 'bs.equity',            label: 'Equity (opening + retained profit − dividends)', aggregate: 'last' },
  { nominal_type: 'bs.check',             label: 'Balance check (should be nil)', aggregate: 'last', kind: 'subtle' },
];

export const GENERAL_CF_LINES = [
  { nominal_type: 'cf.opening_cash',       label: 'Opening bank', aggregate: 'first', kind: 'header' },

  { nominal_type: 'cf.in.receipts',        label: 'Receipts from customers', indent: true },
  { nominal_type: 'cf.in.vat_refund',      label: 'VAT refunds', indent: true },
  { nominal_type: 'cf.in.debt_drawdown',   label: 'Loan drawdown', indent: true },
  { nominal_type: 'cf.in_total',           label: 'Total cash in' },

  { nominal_type: 'cf.out.cost_of_sales',  label: 'Payments to suppliers', indent: true },
  { nominal_type: 'cf.out.payroll',        label: 'Net wages', indent: true },
  { nominal_type: 'cf.out.paye',           label: 'PAYE / NI / pension', indent: true },
  { nominal_type: 'cf.out.overheads',      label: 'Overheads', indent: true },
  { nominal_type: 'cf.out.vat',            label: 'VAT', indent: true },
  { nominal_type: 'cf.out.corp_tax',       label: 'Company tax', indent: true },
  { nominal_type: 'cf.out.capex',          label: 'Capital spend', indent: true },
  { nominal_type: 'cf.out.interest',       label: 'Loan interest', indent: true },
  { nominal_type: 'cf.out.debt_principal', label: 'Loan repayments', indent: true },
  { nominal_type: 'cf.out.dividends',      label: 'Dividends / drawings', indent: true },
  { nominal_type: 'cf.out_total',          label: 'Total cash out' },

  { nominal_type: 'cf.net_movement',       label: 'Net cash movement', kind: 'header' },
  { nominal_type: 'cf.closing_cash',       label: 'Closing bank', aggregate: 'last', kind: 'header' },

  { nominal_type: 'metric.debtors',        label: 'of which: owed to us at month end', aggregate: 'last', indent: true, kind: 'subtle' },
  { nominal_type: 'metric.creditors',      label: 'of which: we owe at month end', aggregate: 'last', indent: true, kind: 'subtle' },
  { nominal_type: 'metric.vat_liability',  label: 'VAT owed at month end', aggregate: 'last', indent: true, kind: 'subtle' },
  { nominal_type: 'metric.ct_liability',   label: 'CT owed at month end', aggregate: 'last', indent: true, kind: 'subtle' },
];
