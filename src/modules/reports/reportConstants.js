export const CLIENT_OPTIONS = [
  { label: 'GB Cabins', realmId: '9130357945100516' },
  { label: 'Almond Valley Accounting Limited', realmId: '123145912118784' },
];

export const REPORTS = [
  // Date range
  { id: 'GeneralLedger',                 label: 'General Ledger',            type: 'range' },
  { id: 'TrialBalance',                  label: 'Trial Balance',             type: 'range' },
  { id: 'ProfitAndLoss',                 label: 'Profit & Loss',             type: 'range' },
  { id: 'BalanceSheet',                  label: 'Balance Sheet',             type: 'range' },
  { id: 'ProfitAndLossMonthly',          label: 'Profit & Loss Monthly',     type: 'range' },
  { id: 'TrialBalancePriorYear',         label: 'Trial Balance Prior Year',  type: 'range' },
  { id: 'ProfitAndLossMonthlyPriorYear', label: 'P&L Monthly Prior Year',    type: 'range' },
  { id: 'CashFlow',                      label: 'Cash Flow',                 type: 'range' },
  { id: 'ProfitAndLossDetail',           label: 'P&L Detail',                type: 'range' },
  // Point-in-time
  { id: 'AgedReceivables',               label: 'Aged Receivables',          type: 'point' },
  { id: 'AgedPayables',                  label: 'Aged Payables',             type: 'point' },
  { id: 'AgedReceivableDetail',          label: 'Aged Receivable Detail',    type: 'point' },
  { id: 'AgedPayableDetail',             label: 'Aged Payable Detail',       type: 'point' },
  { id: 'AgedReceivablesCurrent',        label: 'Aged Receivables Current',  type: 'point' },
  { id: 'AgedPayablesCurrent',           label: 'Aged Payables Current',     type: 'point' },
  // No dates
  { id: 'AccountList',                   label: 'Account List',              type: 'none'  },
];

export const DRIVE_FOLDER_URL = 'https://drive.google.com/drive/folders/1rK_8c4RBysVsdGUSMgbcDD0z4Kr2DoW0';
