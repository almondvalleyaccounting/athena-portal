// Vertical pack registry. Each pack lists the modules that compose it.

import { smokeModule } from './modules/smoke.js';
import { locationsModule } from './modules/locations.js';
import { servicesChildcareModule } from './modules/services_childcare.js';
import { staffModule } from './modules/staff.js';
import { overheadsModule } from './modules/overheads.js';
import { premisesModule } from './modules/premises.js';
import { preOpeningModule } from './modules/pre_opening.js';
import { loansModule } from './modules/loans.js';
import { workingCapitalModule } from './modules/working_capital.js';
import { taxSimpleModule } from './modules/tax_simple.js';
import { financialCoreModule } from './modules/financial_core.js';
import { exitValuationModule } from './modules/exit_valuation.js';

const CHILDCARE_SCOTLAND_MODULES = [
  locationsModule,
  servicesChildcareModule,
  staffModule,
  overheadsModule,
  premisesModule,
  preOpeningModule,
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
