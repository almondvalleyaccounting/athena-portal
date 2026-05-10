// Smoke-test module — proves the engine wiring end-to-end.
//
// One scalar driver (`monthly_revenue`) and one timeseries driver
// (`monthly_uplift_pct`). Produces a single revenue line per period.
// No entities, no tags.

export const smokeModule = {
  key: 'simple_smoke',
  pack: ['simple', 'childcare_scotland', 'accountancy'],   // available everywhere for testing
  dependsOn: [],
  drivers: [
    {
      key: 'monthly_revenue',
      label: 'Base monthly revenue',
      unit: 'gbp_p',
      kind: 'scalar',
      scope: 'group',
      defaultValue: 1000000,                  // 10,000 GBP in pence
    },
    {
      key: 'monthly_uplift_pct',
      label: 'Cumulative uplift % per period',
      unit: 'pct',
      kind: 'timeseries',
      scope: 'group',
      defaultValue: 0,
    },
  ],
  outputs: [
    { nominal_type: 'revenue', label: 'Smoke revenue', by_entity: false },
  ],
  compute(ctx) {
    const out = [];
    const base = ctx.resolve('monthly_revenue', {});
    for (const t of ctx.periods) {
      const upliftPct = ctx.resolve('monthly_uplift_pct', { period: t });
      const amount = Math.round(base * (1 + upliftPct / 100));
      out.push({
        module_key: 'simple_smoke',
        period: t,
        nominal_type: 'revenue',
        line_label: 'Smoke revenue',
        amount_p: amount,
      });
    }
    return out;
  },
};
