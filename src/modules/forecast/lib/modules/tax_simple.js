// Tax (simple) — flat marginal CT rate applied to PBT each period.
// Cash timing: cash payment lags 9 months from period end (UK CT 9mo+1day);
// for v1 we apply tax to P&L when accrued and to cash 9 months later.

export const taxSimpleModule = {
  key: 'tax_simple',
  pack: ['childcare_scotland', 'accountancy'],
  dependsOn: ['services_childcare', 'staff', 'overheads', 'premises', 'pre_opening', 'loans'],

  drivers: [
    { key: 'tax.ct_rate_pct', label: 'Corporation tax %', unit: 'pct', kind: 'scalar', scope: 'group', defaultValue: 25 },
    { key: 'tax.payment_lag_months', label: 'CT payment lag (months)', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 9 },
  ],

  outputs: [
    { nominal_type: 'tax', label: 'Corporation tax (accrued)', by_entity: false },
  ],

  compute(ctx) {
    const out = [];
    const ctRate = ctx.resolve('tax.ct_rate_pct', {}) / 100;

    const upstream = ctx.upstreamOutputs;
    for (const t of ctx.periods) {
      // PBT = revenue - costs - depreciation - interest
      let revenue = 0, costs = 0, dep = 0, interest = 0;
      for (const r of upstream) {
        if (r.period !== t) continue;
        switch (r.nominal_type) {
          case 'revenue':       revenue  += r.amount_p; break;
          case 'staff_cost':
          case 'overhead':
          case 'cost_of_sales': costs    += r.amount_p; break;
          case 'depreciation':  dep      += r.amount_p; break;
          case 'debt_interest': interest += r.amount_p; break;
        }
      }
      const pbt = revenue - costs - dep - interest;
      // Don't accrue negative tax (no group relief modelled in v1)
      const taxAccrued = pbt > 0 ? Math.round(pbt * ctRate) : 0;
      if (taxAccrued !== 0) {
        out.push({
          module_key: 'tax_simple', period: t,
          nominal_type: 'tax', line_label: 'Corporation tax', amount_p: taxAccrued,
        });
      }
    }
    return out;
  },
};
