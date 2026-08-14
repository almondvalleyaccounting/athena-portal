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

    // Discover custom drivers added via the +Add driver UI (e.g.
    // "Pre-opening cleaning", "Pre-opening decorating"). Anything in
    // module_key='pre_opening' that isn't one of the five built-in keys
    // is treated as an additional monthly pre-opening cost line.
    const DECLARED_KEYS = new Set([
      'pre_open.registration_lead_months',
      'pre_open.monthly_overhead_p',
      'pre_open.staffing_months',
      'pre_open.staffing_monthly_p',
      'pre_open.marketing_spike_p',
    ]);
    const customDrivers = (ctx.drivers || []).filter(d =>
      d.module_key === 'pre_opening' && !DECLARED_KEYS.has(d.driver_key)
    );

    // Direct value lookup by driver id — avoids the short-key resolver
    // picking the wrong driver when the same key exists on another module.
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
      // Linked drivers fall back to the resolver
      return ctx.resolve(driver.driver_key, { entity: driver.entity_key, period }) || 0;
    };

    const labelFor = (driver) => {
      const base = driver.label || driver.driver_key;
      // Make sure the row is recognisable as pre-opening across all views
      // (financial_core / drillModal / PDF) which key off "Pre-opening".
      return /^Pre-opening/i.test(base) ? base : `Pre-opening — ${base}`;
    };

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

      // Custom pre-opening cost lines — emit each as a monthly recurring
      // cost during the registration-lead window. Group-scope drivers
      // apply to every entity; entity-scope drivers only to their own.
      for (const d of customDrivers) {
        if (d.entity_id && d.entity_id !== e.id) continue;
        for (let t = ohStart; t < opening; t++) {
          const v = valueOf(d, t);
          if (!v) continue;
          out.push({
            module_key: 'pre_opening', entity_id: e.id, period: t,
            nominal_type: 'overhead', line_label: labelFor(d),
            amount_p: Math.round(v),
          });
        }
      }
    }
    return out;
  },

  validate(ctx) {
    const findings = [];
    const DECLARED_KEYS = new Set([
      'pre_open.registration_lead_months', 'pre_open.monthly_overhead_p',
      'pre_open.staffing_months', 'pre_open.staffing_monthly_p',
      'pre_open.marketing_spike_p',
    ]);

    for (const e of (ctx.entities || [])) {
      const cfg = e.config || {};
      const opening = cfg.opening_month_offset ?? 0;
      const acq = cfg.acquisition_type || 'greenfield';
      if (acq === 'acquired_going_concern') continue;

      const staffMo = ctx.resolve('pre_open.staffing_months', { entity: e.key }) || 0;
      const entered =
        (ctx.resolve('pre_open.monthly_overhead_p', { entity: e.key }) || 0)
        + (ctx.resolve('pre_open.staffing_monthly_p', { entity: e.key }) || 0) * staffMo
        + (ctx.resolve('pre_open.marketing_spike_p', { entity: e.key }) || 0)
        + (ctx.drivers || [])
            .filter(d => d.module_key === 'pre_opening' && !DECLARED_KEYS.has(d.driver_key)
              && (!d.entity_id || d.entity_id === e.id))
            .reduce((s, d) => s + (ctx.resolve(d.driver_key, { entity: e.key }) || 0), 0);

      // Nothing entered — nothing to warn about.
      if (entered <= 0) continue;

      // The costs exist but there is no window to spend them in: compute()
      // bails at `opening <= 0`, so every penny is silently dropped.
      if (opening <= 0) {
        findings.push({
          severity: 'warn',
          code: 'pre_opening.no_window',
          entity_id: e.id,
          message:
            `${e.label}: about £${Math.round(entered / 100).toLocaleString()} of pre-opening cost is entered, but the site opens in month 0 ` +
            `so there is no pre-trading period and NONE of it is in the forecast. ` +
            `Set the location's opening month offset to the number of months between the forecast start and opening ` +
            `(Inputs → Locations → edit the location).`,
        });
        continue;
      }

      // A window exists, but the registration lead is what actually gates
      // the recurring overhead and any custom cost lines.
      const regLead = ctx.resolve('pre_open.registration_lead_months', { entity: e.key }) || 0;
      const recurring = (ctx.resolve('pre_open.monthly_overhead_p', { entity: e.key }) || 0)
        + (ctx.drivers || [])
            .filter(d => d.module_key === 'pre_opening' && !DECLARED_KEYS.has(d.driver_key)
              && (!d.entity_id || d.entity_id === e.id))
            .reduce((s, d) => s + (ctx.resolve(d.driver_key, { entity: e.key }) || 0), 0);
      if (regLead <= 0 && recurring > 0) {
        findings.push({
          severity: 'warn',
          code: 'pre_opening.no_registration_lead',
          entity_id: e.id,
          message:
            `${e.label}: pre-opening overhead and custom cost lines run over the registration-lead window, ` +
            `but the lead is 0 months — so £${Math.round(recurring / 100).toLocaleString()}/month of entered cost is not in the forecast. ` +
            `Set "Registration lead time (months)". Note these lines are charged MONTHLY across that window, not as one-offs.`,
        });
      }
    }
    return findings;
  },
};
