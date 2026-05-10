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

const OVERHEAD_LINES = [
  { key: 'utilities_p',         label: 'Utilities',         scope: 'entity', defaultValue: 80000 },
  { key: 'insurance_p',         label: 'Insurance',         scope: 'entity', defaultValue: 25000 },
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
    const out = [];
    for (const t of ctx.periods) {
      // Group-level overheads
      for (const line of OVERHEAD_LINES) {
        if (line.scope !== 'group') continue;
        const v = ctx.resolve(`overhead.${line.key}`, {});
        if (v === 0) continue;
        out.push({
          module_key: 'overheads', period: t,
          nominal_type: 'overhead', line_label: line.label,
          amount_p: Math.round(v),
        });
      }
      // Entity-level overheads — only after entity has opened
      for (const e of ctx.entities) {
        const opening = e.config?.opening_month_offset ?? 0;
        if (t < opening) continue;
        for (const line of OVERHEAD_LINES) {
          if (line.scope !== 'entity') continue;
          const v = ctx.resolve(`overhead.${line.key}`, { entity: e.key });
          if (v === 0) continue;
          out.push({
            module_key: 'overheads', entity_id: e.id, period: t,
            nominal_type: 'overhead', line_label: line.label,
            amount_p: Math.round(v),
          });
        }
      }
    }
    return out;
  },
};
