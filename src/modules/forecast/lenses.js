// Forecast LENSES — what a vertical pack looks like in the UI.
//
// `lib/packs.js` says which engine modules a pack runs; this says which tabs
// it shows, which inputs surface it uses and which statement lines it renders.
// Kept out of lib/ on purpose: the engine is imported headlessly by
// verification harnesses and must not pull in views.
//
// Anything not listed here falls back to FULL_LENS — the childcare model's
// complete tab set, which is what every existing forecast expects.

import { PNL_LINES, BS_LINES, CF_LINES } from './views/statementLines';
import { GENERAL_PNL_LINES, GENERAL_CF_LINES, GENERAL_BS_LINES } from './views/statementLinesGeneral';

const FULL_TABS = [
  { key: 'inputs',    label: 'Inputs' },
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'overview',  label: 'Overview' },
  { key: 'pnl',       label: 'P&L' },
  { key: 'pnl_band',  label: 'P&L by age band' },
  { key: 'bs',        label: 'Balance sheet' },
  { key: 'cf',        label: 'Cashflow' },
  { key: 'income',    label: 'Income' },
  { key: 'staff',     label: 'Staff detail' },
  { key: 'premises',  label: 'Premises & overheads' },
  { key: 'capacities',label: 'Capacities' },
  { key: 'trends',    label: 'KPI trends' },
  { key: 'compare',   label: 'Compare' },
  { key: 'deal',      label: 'Deal view' },
  { key: 'insights',  label: 'AI insights' },
  { key: 'findings',  label: 'Findings' },
  { key: 'la',        label: 'LA settings' },
];

const FULL_LENS = {
  tabs: FULL_TABS,
  inputs: 'modules',                                    // the driver-grid InputsView
  statements: { pnl: PNL_LINES, bs: BS_LINES, cf: CF_LINES },
  ledgerStatements: false,
  locations: true,                                      // multi-site concepts apply
  exportPack: true,                                     // the childcare PDF/Excel pack
};

// High-level lens: a list of P&L lines, a cashflow, and little else. No
// locations, no capacity, no age bands — an IT consultancy has none of them.
const GENERAL_CASHFLOW_LENS = {
  tabs: [
    { key: 'lines',     label: 'Lines & assumptions' },
    { key: 'lending',   label: 'Lending' },
    { key: 'cash',      label: 'Cash dashboard' },
    { key: 'cf',        label: 'Cashflow' },
    { key: 'pnl',       label: 'P&L' },
    { key: 'bs',        label: 'Balance sheet' },
    { key: 'findings',  label: 'Findings' },
  ],
  inputs: 'lines',
  statements: { pnl: GENERAL_PNL_LINES, cf: GENERAL_CF_LINES, bs: GENERAL_BS_LINES },
  // P&L and Cashflow render line by line, with editable forecast cells and
  // the actuals boundary marked; the balance sheet is a summary statement.
  ledgerStatements: true,
  locations: false,
  exportPack: false,
};

export const LENSES = {
  childcare_scotland: FULL_LENS,
  accountancy: FULL_LENS,
  simple: FULL_LENS,
  general_cashflow: GENERAL_CASHFLOW_LENS,
};

export function lensFor(packKey) {
  return LENSES[packKey] || FULL_LENS;
}
