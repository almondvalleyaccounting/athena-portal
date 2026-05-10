// Fixed-asset purchases — generic capex flows separate from premises
// (which already handles property purchase + fit-out for "buy" sites).
//
// Two flows per entity:
//   1. Pre-opening lump sum  — paid at month (opening-1), capped at t=0.
//      Examples: equipment, furniture, IT, vehicles bought before doors open.
//   2. Monthly average post-opening — emitted every month from opening onward.
//      Examples: ongoing replacement / refresh capex.
//
// Both flow into the standard 'capex' nominal so they roll into BS fixed
// assets, cashflow capex, and (via the depreciation driver below) into
// monthly straight-line depreciation that hits the P&L.

export const fixedAssetsModule = {
  key: 'fixed_assets',
  pack: ['childcare_scotland'],
  dependsOn: ['locations'],

  drivers: [
    { key: 'fa.pre_opening_lump_p',  label: 'Fixed assets — pre-opening purchase (£)',     unit: 'gbp_p', kind: 'scalar', scope: 'entity', defaultValue: 5000000 },  // £50k
    { key: 'fa.monthly_average_p',   label: 'Fixed assets — monthly average (£)',          unit: 'gbp_p', kind: 'scalar', scope: 'entity', defaultValue: 50000 },     // £500/mo
    { key: 'fa.depreciation_years',  label: 'Fixed assets — depreciation life (years)',    unit: 'count', kind: 'scalar', scope: 'group',  defaultValue: 5 },
  ],

  outputs: [
    { nominal_type: 'capex',        label: 'Fixed assets — purchases',     by_entity: true },
    { nominal_type: 'depreciation', label: 'Fixed assets — depreciation',  by_entity: true },
  ],

  compute(ctx) {
    const out = [];
    const depYears = Math.max(1, ctx.resolve('fa.depreciation_years', {}) || 5);
    const depMonths = depYears * 12;

    // Discover custom fixed-asset drivers added via the +Add driver UI.
    // Anything in module_key='fixed_assets' that isn't a built-in key is
    // treated as a ONE-OFF pre-opening lump — bought once at the
    // acquisition month (opening - 1) — and depreciated over the same
    // life as the built-in flows. Driver label becomes the line_label so
    // each custom code surfaces independently in reports.
    const DECLARED_KEYS = new Set([
      'fa.pre_opening_lump_p',
      'fa.monthly_average_p',
      'fa.depreciation_years',
    ]);
    const customDrivers = (ctx.drivers || []).filter(d =>
      d.module_key === 'fixed_assets' && !DECLARED_KEYS.has(d.driver_key)
    );

    // Direct value lookup by driver id — bypasses the short-key resolver
    // so the right driver row is always read even if another module
    // happens to share the same key.
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
      return ctx.resolve(driver.driver_key, { entity: driver.entity_key, period }) || 0;
    };

    const horizon = ctx.periods.length;

    for (const e of (ctx.entities || [])) {
      const cfg = e.config || {};
      const opening = cfg.opening_month_offset ?? 0;
      const lump = ctx.resolve('fa.pre_opening_lump_p', { entity: e.key }) || 0;
      const monthly = ctx.resolve('fa.monthly_average_p', { entity: e.key }) || 0;

      // Per-period purchase schedule (built-in lump + monthly).
      // We track each LINE LABEL separately so capex rows surface as their
      // own rows (instead of all summing into one "Fixed assets — ongoing"
      // pile). Custom drivers each get their own label.
      const lines = new Map();   // label -> array of length horizon
      const ensure = (lbl) => {
        if (!lines.has(lbl)) lines.set(lbl, new Array(horizon).fill(0));
        return lines.get(lbl);
      };

      if (lump > 0) {
        const t = opening > 0 ? Math.max(0, opening - 1) : 0;
        ensure('Pre-opening fixed assets')[t] += lump;
      }
      if (monthly > 0) {
        const arr = ensure('Fixed assets — ongoing');
        for (let t = opening; t < horizon; t++) arr[t] += monthly;
      }

      // Custom drivers — group-scope applies to every entity, entity-scope
      // only to its own entity. Treated as a ONE-OFF lump at the acquisition
      // month (opening - 1, capped at t=0) so they hit cash and the BS once.
      for (const d of customDrivers) {
        if (d.entity_id && d.entity_id !== e.id) continue;
        const v = valueOf(d, 0);
        if (!v) continue;
        const lbl = d.label || d.driver_key;
        const arr = ensure(lbl);
        const t = opening > 0 ? Math.max(0, opening - 1) : 0;
        arr[t] += v;
      }

      // Emit capex rows per line label
      for (const [lbl, arr] of lines) {
        for (let t = 0; t < horizon; t++) {
          if (arr[t] > 0) {
            out.push({
              module_key: 'fixed_assets', entity_id: e.id, period: t,
              nominal_type: 'capex', line_label: lbl,
              amount_p: Math.round(arr[t]),
            });
          }
        }
      }

      // Straight-line depreciation across ALL purchases (built-in + custom).
      // Sum the per-period purchases first, then depreciate.
      const totalPurchasesByT = new Array(horizon).fill(0);
      for (const arr of lines.values()) {
        for (let t = 0; t < horizon; t++) totalPurchasesByT[t] += arr[t];
      }
      const depByT = new Array(horizon).fill(0);
      for (let s = 0; s < horizon; s++) {
        const amt = totalPurchasesByT[s];
        if (amt <= 0) continue;
        const perMonth = amt / depMonths;
        for (let t = s + 1; t < Math.min(horizon, s + 1 + depMonths); t++) {
          depByT[t] += perMonth;
        }
      }
      for (let t = 0; t < horizon; t++) {
        if (depByT[t] > 0) {
          out.push({
            module_key: 'fixed_assets', entity_id: e.id, period: t,
            nominal_type: 'depreciation', line_label: 'Fixed assets — depreciation',
            amount_p: Math.round(depByT[t]),
          });
        }
      }
    }

    return out;
  },
};
