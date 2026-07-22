// Tax (simple) — flat marginal CT rate with loss carryforward.
//
// Taxable PBT is computed on the SAME basis as the displayed P&L: the
// income / cost inflation factors financial_core applies to revenue and
// costs are applied here too, so pnl.tax_total ties to pnl.pbt at the
// headline CT rate. Depreciation and interest are not inflated (they
// derive from actual capex and loan balances).
//
// Losses carry forward: months with negative PBT build a loss pool that
// offsets later profitable months before any tax accrues — so a ramping
// site pays no CT until its cumulative position turns positive.
// (Monthly granularity, no group relief, capital allowances = book
// depreciation. v1 simplifications.)
//
// Cash timing: cash payment lags 9 months from period end (UK CT
// 9mo+1day); financial_core applies tax to P&L when accrued and to cash
// `tax.payment_lag_months` later.

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
    // Same inflation basis as financial_core's P&L assembly.
    const incomeInflation = (ctx.resolve('inflation.income_pct', {}) || 0) / 100;
    const costInflation   = (ctx.resolve('inflation.cost_pct', {}) || 0) / 100;

    // Single pass over upstream rows into per-period buckets.
    const n = ctx.periods.length;
    const revenue = new Array(n).fill(0);
    const costs = new Array(n).fill(0);
    const dep = new Array(n).fill(0);
    const interest = new Array(n).fill(0);
    for (const r of ctx.upstreamOutputs) {
      const t = r.period;
      if (t == null || t < 0 || t >= n) continue;
      switch (r.nominal_type) {
        case 'revenue':       revenue[t]  += r.amount_p; break;
        case 'staff_cost':
        case 'overhead':
        case 'cost_of_sales': costs[t]    += r.amount_p; break;
        case 'depreciation':  dep[t]      += r.amount_p; break;
        case 'debt_interest': interest[t] += r.amount_p; break;
      }
    }

    let lossPool = 0;   // unrelieved losses carried forward, positive pence
    for (const t of ctx.periods) {
      const yearIdx = Math.floor(t / 12);
      const fInc = Math.pow(1 + incomeInflation, yearIdx);
      const fCost = Math.pow(1 + costInflation, yearIdx);
      const pbt = revenue[t] * fInc - costs[t] * fCost - dep[t] - interest[t];

      let taxAccrued = 0;
      if (pbt < 0) {
        lossPool += -pbt;
      } else if (pbt > 0) {
        const relieved = Math.min(lossPool, pbt);
        lossPool -= relieved;
        taxAccrued = Math.round((pbt - relieved) * ctRate);
      }
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
