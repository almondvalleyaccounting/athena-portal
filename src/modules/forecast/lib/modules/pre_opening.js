// Pre-opening — costs incurred before a location's opening_month_offset.
//
// For each entity, looks at config.opening_month_offset and applies:
//   - registration_lead_months of recurring pre-opening overhead
//   - pre_opening_staffing_months of partial staff cost (e.g. manager hire 3 months early)
//   - one-shot marketing spend at month opening-1
//
// Only relevant for new (greenfield) sites; acquired going-concerns
// have no pre-opening period.
//
// Drivers (per-entity):
//   pre_open.registration_lead_months
//   pre_open.monthly_overhead_p
//   pre_open.staffing_months
//   pre_open.staffing_monthly_p
//   pre_open.marketing_spike_p

export const preOpeningModule = {
  key: 'pre_opening',
  pack: ['childcare_scotland'],
  dependsOn: ['locations'],

  drivers: [
    { key: 'pre_open.registration_lead_months', label: 'Registration lead time (months)', unit: 'count', kind: 'scalar', scope: 'entity', defaultValue: 5 },
    { key: 'pre_open.monthly_overhead_p', label: 'Pre-opening monthly overhead', unit: 'gbp_p', kind: 'scalar', scope: 'entity', defaultValue: 150000 },
    { key: 'pre_open.staffing_months', label: 'Pre-opening staffing months', unit: 'count', kind: 'scalar', scope: 'entity', defaultValue: 2 },
    { key: 'pre_open.staffing_monthly_p', label: 'Pre-opening staffing monthly', unit: 'gbp_p', kind: 'scalar', scope: 'entity', defaultValue: 400000 },
    { key: 'pre_open.marketing_spike_p', label: 'Pre-opening marketing spike', unit: 'gbp_p', kind: 'scalar', scope: 'entity', defaultValue: 250000 },
  ],

  outputs: [
    { nominal_type: 'overhead', label: 'Pre-opening overhead', by_entity: true },
    { nominal_type: 'staff_cost', label: 'Pre-opening staffing', by_entity: true },
  ],

  compute(ctx) {
    const out = [];
    for (const e of ctx.entities) {
      const cfg = e.config || {};
      const opening = cfg.opening_month_offset ?? 0;
      const acq = cfg.acquisition_type || 'greenfield';
      if (acq === 'acquired_going_concern') continue;
      if (opening <= 0) continue;     // forecast starts already-open; no pre-opening modelled

      const regLead = ctx.resolve('pre_open.registration_lead_months', { entity: e.key });
      const monOh = ctx.resolve('pre_open.monthly_overhead_p', { entity: e.key });
      const staffMo = ctx.resolve('pre_open.staffing_months', { entity: e.key });
      const staffPm = ctx.resolve('pre_open.staffing_monthly_p', { entity: e.key });
      const marketing = ctx.resolve('pre_open.marketing_spike_p', { entity: e.key });

      // Pre-opening overhead: from max(0, opening-regLead) to opening-1 inclusive
      const ohStart = Math.max(0, opening - regLead);
      for (let t = ohStart; t < opening; t++) {
        if (monOh > 0) {
          out.push({
            module_key: 'pre_opening', entity_id: e.id, period: t,
            nominal_type: 'overhead', line_label: 'Pre-opening overhead',
            amount_p: Math.round(monOh),
          });
        }
      }

      // Pre-opening staffing: last staffMo months before opening
      const staffStart = Math.max(0, opening - staffMo);
      for (let t = staffStart; t < opening; t++) {
        if (staffPm > 0) {
          out.push({
            module_key: 'pre_opening', entity_id: e.id, period: t,
            nominal_type: 'staff_cost', line_label: 'Pre-opening staffing',
            amount_p: Math.round(staffPm),
          });
        }
      }

      // Marketing spike: month opening-1
      if (marketing > 0 && opening > 0) {
        out.push({
          module_key: 'pre_opening', entity_id: e.id, period: opening - 1,
          nominal_type: 'overhead', line_label: 'Pre-opening marketing',
          amount_p: Math.round(marketing),
        });
      }
    }
    return out;
  },
};
