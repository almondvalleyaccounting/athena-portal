// Overheads — flat list of monthly costs, per-entity or central.
//
// Drivers (timeseries, per-entity OR group):
//   overhead.utilities_p
//   overhead.insurance_p
//   overhead.software_p
//   overhead.consumables_p   — nappies, food, art supplies (could scale with children, v2)
//   overhead.marketing_p
//   overhead.professional_fees_p
//   overhead.central_admin_p (group only)
//
// All scalar -> applied each month. Override per-period via timeseries kind.

import { openingMonth, occupancyMonth, isPremisesCost } from '../timeline.js';

const OVERHEAD_LINES = [
  { key: 'utilities_p',         label: 'Utilities',         scope: 'entity', defaultValue: 80000 },
  // Insurance splits along the timeline. Buildings / contents cover attaches
  // when you take the keys; liability and the rest attach when you trade.
  // "Premises insurance" also puts it in the premises bucket — see
  // isPremisesCost, which matches any label starting "Premises".
  { key: 'premises_insurance_p', label: 'Premises insurance', scope: 'entity', defaultValue: 10000 },
  { key: 'general_insurance_p',  label: 'General insurance',  scope: 'entity', defaultValue: 15000 },
  { key: 'software_p',          label: 'Software / IT',     scope: 'entity', defaultValue: 15000 },
  { key: 'consumables_p',       label: 'Consumables / food',scope: 'entity', defaultValue: 60000 },
  { key: 'marketing_p',         label: 'Marketing',         scope: 'entity', defaultValue: 10000 },
  { key: 'professional_fees_p', label: 'Professional fees', scope: 'entity', defaultValue: 8000 },
  { key: 'central_admin_p',     label: 'Central admin',     scope: 'group',  defaultValue: 50000 },
];

export const overheadsModule = {
  key: 'overheads',
  pack: ['childcare_scotland'],
  dependsOn: [],

  drivers: OVERHEAD_LINES.map(l => ({
    key: `overhead.${l.key}`,
    label: l.label,
    unit: 'gbp_p',
    kind: 'scalar',
    scope: l.scope,
    defaultValue: l.defaultValue,
  })),

  outputs: [
    { nominal_type: 'overhead', label: 'Overheads', by_entity: true },
  ],

  compute(ctx) {
    // Discover ALL drivers in this module (declared + user-added custom),
    // so adding a new line on the Inputs tab (e.g. "Cleaning") flows through
    // automatically without needing a code change here.
    //
    // Convention: any group-scope driver becomes a group line; any entity-
    // scope driver becomes a per-entity line emitted from the entity's
    // opening month onward. The driver's `label` is used for the P&L /
    // drilldown line label.
    const moduleDrivers = (ctx.drivers || []).filter(d => d.module_key === 'overheads');
    // Dedupe per (driver_key, entity_id) — defensive in case the merged
    // driver list has duplicates from base+working scenario merge.
    const seen = new Set();
    const groupDrivers = [];
    const entityDrivers = [];
    for (const d of moduleDrivers) {
      const k = `${d.entity_id || ''}::${d.driver_key}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (d.entity_id) entityDrivers.push(d);
      else groupDrivers.push(d);
    }

    // Look up a driver's value directly via the engine's by-id map. This
    // avoids the short-key resolver picking the wrong driver when the same
    // key happens to exist on another module (or scope).
    const valueOf = (driver, period) => {
      const vs = ctx.driverValuesById?.get(driver.id) || [];
      if (driver.kind === 'scalar') {
        const hit = vs.find(v => v.period === -1) || vs[0];
        return hit ? Number(hit.value) : 0;
      }
      if (driver.kind === 'timeseries') {
        const hit = vs.find(v => v.period === period);
        return hit ? Number(hit.value) : 0;
      }
      if (driver.kind === 'linked') {
        // Fall back to resolver for expression evaluation
        return ctx.resolve(driver.driver_key, { entity: driver.entity_key, period }) || 0;
      }
      return 0;
    };

    const out = [];
    for (const t of ctx.periods) {
      // Group-scope lines — emit unconditionally each period.
      for (const d of groupDrivers) {
        const v = valueOf(d, t);
        if (!v) continue;
        out.push({
          module_key: 'overheads', period: t,
          nominal_type: 'overhead',
          line_label: labelFor(d),
          amount_p: Math.round(v),
        });
      }
      // Entity-scope lines. Premises costs start when the building is taken;
      // everything else is a cost of trading and waits for opening.
      for (const e of ctx.entities) {
        const opening = openingMonth(e.config);
        const occupancy = occupancyMonth(e.config);
        for (const d of entityDrivers) {
          if (d.entity_id !== e.id) continue;
          const startsAt = isPremisesCost(labelFor(d)) ? occupancy : opening;
          if (t < startsAt) continue;
          const v = valueOf(d, t);
          if (!v) continue;
          out.push({
            module_key: 'overheads', entity_id: e.id, period: t,
            nominal_type: 'overhead',
            line_label: labelFor(d),
            amount_p: Math.round(v),
          });
        }
      }
    }
    return out;
  },
};

function labelFor(driver) {
  if (driver.label) return driver.label;
  // Strip an `overhead.` prefix and titlecase the slug as a fallback.
  const stem = String(driver.driver_key || '').replace(/^overhead\./, '').replace(/_/g, ' ');
  return stem.replace(/\b\w/g, c => c.toUpperCase()) || driver.driver_key;
}
