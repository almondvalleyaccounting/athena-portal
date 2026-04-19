// Source catalog for the Data Import module.
// Adding a new source is a code change (per migration 021 D5 — source_key
// is a text discriminator, no DB lookup table).

export const SYSTEMS = [
  { id: 'bm', label: 'BrightManager' },
  { id: 'tc', label: 'TaxCalc' },
  { id: 'qbo', label: 'QuickBooks Online' },
];

export const SOURCES = [
  {
    key: 'bm_clients',
    system: 'bm',
    name: 'Client export',
    accepts: '.csv',
    tables: ['entities', 'users', 'services'],
    comingSoon: false,
    pullSteps: [
      'Log into BrightManager',
      'Go to Clients → Client List',
      'Click Export → Export all clients',
      'Select CSV format, include all columns',
      'Download the file',
    ],
  },
  {
    key: 'bm_tasks',
    system: 'bm',
    name: 'Tasks export',
    accepts: '.csv',
    tables: ['scheduled_tasks'],
    comingSoon: false,
    pullSteps: [
      'Log into BrightManager',
      'Go to Tasks → All Tasks',
      'Export the current view as CSV',
    ],
  },
  {
    key: 'tc_tax_refs',
    system: 'tc',
    name: 'Tax references',
    accepts: '.xlsx',
    tables: ['entities'],
    comingSoon: false,
    enrichmentOnly: true,
    pullSteps: [
      'Open TaxCalc',
      'Reports → Client tax reference export',
      'Save as Excel (.xlsx)',
    ],
  },
  {
    key: 'tc_contact_info',
    system: 'tc',
    name: 'Contact info',
    accepts: '.xlsx',
    tables: [],
    comingSoon: true,
    pullSteps: [
      'TaxCalc Contact info is disabled — BrightManager is the source of truth for client contact data.',
    ],
  },
  {
    key: 'tc_tax_returns',
    system: 'tc',
    name: 'Tax return export',
    accepts: '.xlsx',
    tables: ['deadlines'],
    comingSoon: false,
    pullSteps: [
      'Open TaxCalc',
      'Reports → Tax returns → Export all',
      'Save as Excel (.xlsx)',
    ],
  },
  {
    key: 'tc_accounts',
    system: 'tc',
    name: 'Accounts export',
    accepts: '.xlsx',
    tables: ['deadlines'],
    comingSoon: false,
    pullSteps: [
      'Open TaxCalc',
      'Reports → Accounts → Export all',
      'Save as Excel (.xlsx)',
    ],
  },
  {
    key: 'qbo_fees',
    system: 'qbo',
    name: 'Fees',
    accepts: '.csv',
    tables: ['live_billing'],
    comingSoon: true,
    pullSteps: [
      'QBO sync is managed by the existing qbo-pull edge function. Direct import from file is not yet available.',
    ],
  },
];

export function getSource(key) {
  return SOURCES.find((s) => s.key === key) || null;
}

export function getSystemLabel(systemId) {
  return SYSTEMS.find((s) => s.id === systemId)?.label || systemId;
}
