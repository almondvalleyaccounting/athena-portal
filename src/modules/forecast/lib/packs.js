// Vertical pack registry. Each pack lists the modules that compose it.

import { smokeModule } from './modules/smoke.js';
import { locationsModule } from './modules/locations.js';
import { servicesChildcareModule } from './modules/services_childcare.js';
import { staffModule } from './modules/staff.js';
import { overheadsModule } from './modules/overheads.js';
import { premisesModule } from './modules/premises.js';
import { preOpeningModule } from './modules/pre_opening.js';
import { fixedAssetsModule } from './modules/fixed_assets.js';
import { loansModule } from './modules/loans.js';
import { workingCapitalModule } from './modules/working_capital.js';
import { taxSimpleModule } from './modules/tax_simple.js';
import { financialCoreModule } from './modules/financial_core.js';
import { exitValuationModule } from './modules/exit_valuation.js';
import { plLinesModule } from './modules/pl_lines.js';
import { generalCoreModule } from './modules/general_core.js';

const CHILDCARE_SCOTLAND_MODULES = [
  locationsModule,
  servicesChildcareModule,
  staffModule,
  overheadsModule,
  premisesModule,
  preOpeningModule,
  fixedAssetsModule,
  loansModule,
  workingCapitalModule,
  taxSimpleModule,
  financialCoreModule,
  exitValuationModule,
];

export const PACKS = {
  simple: {
    key: 'simple',
    label: 'Simple (no modules)',
    modules: [smokeModule],
  },
  childcare_scotland: {
    key: 'childcare_scotland',
    label: 'Childcare — Scotland',
    modules: CHILDCARE_SCOTLAND_MODULES,
  },
  // High-level lens for ordinary trading companies: a list of P&L lines
  // (usually seeded from the client's QuickBooks) projected forward, turned
  // into a cashflow with debtor/creditor lag, VAT, PAYE and CT timing.
  general_cashflow: {
    key: 'general_cashflow',
    label: 'General business — cashflow',
    modules: [plLinesModule, loansModule, generalCoreModule],
  },
  accountancy: {
    key: 'accountancy',
    label: 'Accountancy',
    modules: [smokeModule, taxSimpleModule, financialCoreModule, exitValuationModule],   // v2 work; placeholder
  },
};

export function modulesFor(packKey) {
  const p = PACKS[packKey];
  if (!p) throw new Error(`Unknown vertical pack '${packKey}'`);
  return p.modules;
}

export function packLabel(packKey) {
  return PACKS[packKey]?.label || packKey;
}
