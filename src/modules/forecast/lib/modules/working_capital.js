// Working capital — debtor / creditor / VAT / PAYE timing and parent
// deposits + advance fees in childcare-specific terms.
//
// For v1 we model the WC delta as a stock at each period end:
//   debtors = revenue * (DSO / 30)
//     split: private_debtors (~0 days, fees in advance) and
//            la_funded_debtors (~90 days, quarterly arrears)
//   creditors = costs * (DPO / 30)
//   deposits_held = children_attending_total * deposit_weeks * weekly_rate
//   advance_billing = revenue_private * (advance_weeks / weeks_per_month)
//
// The CHANGE in net WC each month flows through cash. Financial core
// reads this and applies to cashflow.
//
// Drivers:
//   wc.dso_private_days        — typically 0 (advance billing makes -ve)
//   wc.dso_la_days             — 90 default (quarterly arrears)
//   wc.dpo_general_days        — 30 default
//
// Outputs:
//   working_capital_movement (signed; +ve = cash drag, -ve = cash benefit)
//
// We persist net WC and emit the period-over-period change.

import { AGE_BANDS_LIST } from './locations.js';

export const workingCapitalModule = {
  key: 'working_capital',
  pack: ['childcare_scotland'],
  dependsOn: ['services_childcare'],

  drivers: [
    { key: 'wc.dso_private_days', label: 'DSO — private fees (days)', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 0 },
    { key: 'wc.dso_la_days', label: 'DSO — LA funded (days)', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 90 },
    // DPO defaults to 0 because childcare suppliers are typically paid
    // promptly or in advance (rent, utilities by DD, food on delivery).
    // Set higher only if you genuinely run a supplier-credit book.
    { key: 'wc.dpo_general_days', label: 'DPO — costs (days)', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 0 },
  ],

  outputs: [
    { nominal_type: 'working_capital_movement', label: 'Net WC movement', by_entity: false },
    { nominal_type: 'wc_balance.debtors_private', label: 'Debtors — private', by_entity: false },
    { nominal_type: 'wc_balance.debtors_la', label: 'Debtors — LA funded', by_entity: false },
    { nominal_type: 'wc_balance.creditors', label: 'Creditors', by_entity: false },
    { nominal_type: 'wc_balance.deposits_held', label: 'Parent deposits', by_entity: false },
    { nominal_type: 'wc_balance.advance_billing', label: 'Advance billing', by_entity: false },
  ],

  compute(ctx) {
    const out = [];
    // ctx.resolve returns 0 both when a driver is absent AND when it is
    // deliberately set to 0, so `resolve(...) || default` silently discards
    // a user's explicit zero — e.g. "we take no deposits" came back as the
    // 4-week default and booked a WC benefit that doesn't exist. Fall back
    // to the default only when the driver genuinely isn't there.
    const resolveOr = (key, fallback) =>
      ctx.findDriver(key) ? ctx.resolve(key, {}) : fallback;

    const dsoPriv = resolveOr('wc.dso_private_days', 0);
    const dsoLa = resolveOr('wc.dso_la_days', 90);
    const dpoGen = resolveOr('wc.dpo_general_days', 0);
    const weeks = resolveOr('weeks_per_year', 51) || 51;   // 0 weeks would divide by zero below
    const depositWeeks = resolveOr('deposit_weeks', 4);
    const advanceWeeks = resolveOr('advance_billing_weeks', 4);

    // Build per-period totals from upstream outputs
    const upstream = ctx.upstreamOutputs;
    const periodKeys = ctx.periods;

    const revPrivByPeriod = sumByPeriod(upstream, o => o.module_key === 'services_childcare' && o.tags?.revenue_kind === 'private');
    const revLaByPeriod = sumByPeriod(upstream, o => o.module_key === 'services_childcare' && o.tags?.revenue_kind === 'funded');
    // Creditors base — overheads only:
    //   - Staff is paid through payroll on a fixed cycle, NOT on supplier
    //     credit terms. Including it would generate a fictitious payroll
    //     creditor that offsets staff cost outflows in month 1.
    //   - Pre-opening costs are paid cash up-front (fit-out, registration,
    //     marketing, custom pre-opening lines), so they're excluded too.
    //   - Capex / depreciation are not operating supplier costs.
    const costByPeriod = sumByPeriod(upstream, o =>
      o.nominal_type === 'overhead' &&
      o.module_key !== 'pre_opening'
    );

    // Children attending total (for deposits) — derived from ctx.childrenAttending
    const childrenTotalByPeriod = new Array(periodKeys.length).fill(0);
    for (const eKey in (ctx.childrenAttending || {})) {
      const byBand = ctx.childrenAttending[eKey];
      for (const band of AGE_BANDS_LIST) {
        const series = byBand[band] || [];
        for (let t = 0; t < periodKeys.length; t++) {
          childrenTotalByPeriod[t] += series[t] || 0;
        }
      }
    }

    // Approx avg weekly rate for deposits — group level avg
    let avgWeeklyRateP = 0;
    let bandsCounted = 0;
    for (const band of AGE_BANDS_LIST) {
      const r = ctx.resolve(`weekly_rate_p.${band}`, {});
      if (r > 0) { avgWeeklyRateP += r; bandsCounted += 1; }
    }
    avgWeeklyRateP = bandsCounted > 0 ? avgWeeklyRateP / bandsCounted : 0;

    let prevWcNet = 0;
    for (const t of periodKeys) {
      const revPriv = revPrivByPeriod[t] || 0;
      const revLa = revLaByPeriod[t] || 0;
      const cost = costByPeriod[t] || 0;
      const childrenTotal = childrenTotalByPeriod[t] || 0;

      const debtorsPriv = revPriv * (dsoPriv / 30);
      const debtorsLa = revLa * (dsoLa / 30);
      const creditors = cost * (dpoGen / 30);
      const deposits = childrenTotal * depositWeeks * avgWeeklyRateP;
      const advance = revPriv * (advanceWeeks / (weeks / 12));

      // Net WC = (debtors + advance) - (creditors + deposits)
      // Wait: deposits and advance billing are LIABILITIES (we owe parents back / we hold cash before earning).
      // So they REDUCE net WC (= cash benefit).
      // Net working capital invested = debtors - creditors - deposits - advance
      const netWc = debtorsPriv + debtorsLa - creditors - deposits - advance;
      const movement = netWc - prevWcNet;
      prevWcNet = netWc;

      out.push({
        module_key: 'working_capital', period: t,
        nominal_type: 'working_capital_movement', line_label: 'Net WC movement',
        amount_p: Math.round(movement),
      });
      out.push({ module_key: 'working_capital', period: t, nominal_type: 'wc_balance.debtors_private', line_label: 'Debtors — private', amount_p: Math.round(debtorsPriv) });
      out.push({ module_key: 'working_capital', period: t, nominal_type: 'wc_balance.debtors_la', line_label: 'Debtors — LA funded', amount_p: Math.round(debtorsLa) });
      out.push({ module_key: 'working_capital', period: t, nominal_type: 'wc_balance.creditors', line_label: 'Creditors', amount_p: Math.round(creditors) });
      out.push({ module_key: 'working_capital', period: t, nominal_type: 'wc_balance.deposits_held', line_label: 'Parent deposits', amount_p: Math.round(deposits) });
      out.push({ module_key: 'working_capital', period: t, nominal_type: 'wc_balance.advance_billing', line_label: 'Advance billing', amount_p: Math.round(advance) });
    }
    return out;
  },
};

function sumByPeriod(rows, predicate) {
  const m = {};
  for (const r of rows) if (predicate(r)) m[r.period] = (m[r.period] || 0) + r.amount_p;
  return m;
}
