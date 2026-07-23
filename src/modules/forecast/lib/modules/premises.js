// Premises — lease vs buy switch per location.
//
// Entity config supplies `lease_or_buy: 'lease' | 'buy'`. Drivers vary
// by mode. v1 emits:
//   - lease: overhead (rent + service charge), no BS impact
//   - buy:   capex (purchase + LBTT + fees), debt_principal/interest,
//            depreciation (straight-line), overhead (NDR, maintenance)
//
// Drivers (entity-scoped):
//   LEASE:
//     premises.rent_monthly_p
//     premises.service_charge_monthly_p
//   BUY:
//     premises.purchase_price_p
//     premises.deposit_pct
//     premises.mortgage_term_years
//     premises.mortgage_interest_pct
//     premises.legal_fees_p
//     premises.fit_out_capex_p
//     premises.depreciation_years
//     premises.maintenance_annual_p
//     premises.ndr_rateable_value_p     — set when known
//     premises.ndr_relief_pct           — Small Business Bonus etc.
//
// LBTT (Land & Buildings Transaction Tax) — Scotland's SDLT-equivalent.
// Non-residential bands (2026 simplified):
//   £0-£150k         0%
//   £150k-£250k      1%
//   £250k+           5%
//
// Mortgage: simple monthly amortisation. Rate is annual %; convert.

export const premisesModule = {
  key: 'premises',
  pack: ['childcare_scotland'],
  dependsOn: ['locations'],

  drivers: [
    // Lease drivers
    { key: 'premises.rent_monthly_p', label: 'Monthly rent', unit: 'gbp_p', kind: 'scalar', scope: 'entity', defaultValue: 700000 },        // £7,000/mo
    { key: 'premises.service_charge_monthly_p', label: 'Monthly service charge', unit: 'gbp_p', kind: 'scalar', scope: 'entity', defaultValue: 80000 },
    // Buy drivers
    { key: 'premises.purchase_price_p', label: 'Purchase price', unit: 'gbp_p', kind: 'scalar', scope: 'entity', defaultValue: 80000000 },  // £800k
    { key: 'premises.deposit_pct', label: 'Deposit %', unit: 'pct', kind: 'scalar', scope: 'entity', defaultValue: 25 },
    { key: 'premises.mortgage_term_years', label: 'Mortgage term (years)', unit: 'count', kind: 'scalar', scope: 'entity', defaultValue: 25 },
    { key: 'premises.mortgage_interest_pct', label: 'Mortgage interest %', unit: 'pct', kind: 'scalar', scope: 'entity', defaultValue: 6.5 },
    { key: 'premises.legal_fees_p', label: 'Legal & acquisition fees', unit: 'gbp_p', kind: 'scalar', scope: 'entity', defaultValue: 1500000 },
    { key: 'premises.fit_out_capex_p', label: 'Fit-out capex', unit: 'gbp_p', kind: 'scalar', scope: 'entity', defaultValue: 15000000 },
    { key: 'premises.depreciation_years', label: 'Depreciation horizon (years)', unit: 'count', kind: 'scalar', scope: 'entity', defaultValue: 25 },
    { key: 'premises.maintenance_annual_p', label: 'Maintenance (annual)', unit: 'gbp_p', kind: 'scalar', scope: 'entity', defaultValue: 800000 },
    { key: 'premises.ndr_rateable_value_p', label: 'NDR rateable value', unit: 'gbp_p', kind: 'scalar', scope: 'entity', defaultValue: 4500000 },
    { key: 'premises.ndr_poundage', label: 'NDR poundage', unit: 'pct', kind: 'scalar', scope: 'entity', defaultValue: 49.8 },
    { key: 'premises.ndr_relief_pct', label: 'NDR relief %', unit: 'pct', kind: 'scalar', scope: 'entity', defaultValue: 0 },
  ],

  outputs: [
    { nominal_type: 'overhead', label: 'Premises rent / NDR', by_entity: true },
    { nominal_type: 'capex', label: 'Property + fit-out', by_entity: true },
    { nominal_type: 'debt_principal', label: 'Mortgage principal', by_entity: true },
    { nominal_type: 'debt_interest', label: 'Mortgage interest', by_entity: true },
    { nominal_type: 'depreciation', label: 'Property + fit-out depreciation', by_entity: true },
    { nominal_type: 'debt_balance', label: 'Mortgage outstanding', by_entity: true },
  ],

  compute(ctx) {
    const out = [];
    const debtScheduleByEntity = {};

    for (const e of ctx.entities) {
      const cfg = e.config || {};
      const opening = cfg.opening_month_offset ?? 0;
      const mode = cfg.lease_or_buy || 'lease';

      if (mode === 'lease') {
        const rent = ctx.resolve('premises.rent_monthly_p', { entity: e.key });
        const svc = ctx.resolve('premises.service_charge_monthly_p', { entity: e.key });
        // Rent and service charge ramp on INDEPENDENT schedules: a
        // rent-free period rarely extends to the service charge, which
        // is typically payable in full from day one. No stages = full
        // from the opening month.
        const rentStages = cfg.premises_concession_stages || [];
        const svcStages = cfg.premises_svc_concession_stages || [];
        for (const t of ctx.periods) {
          if (t < opening) continue;
          const rentFactor = concessionFactorAt(t - opening, rentStages);
          const svcFactor = concessionFactorAt(t - opening, svcStages);
          if (rent > 0) {
            out.push({
              module_key: 'premises', entity_id: e.id, period: t,
              nominal_type: 'overhead', line_label: 'Rent',
              amount_p: Math.round(rent * rentFactor),
              tags: { premises_kind: 'lease', concession_factor: rentFactor },
            });
          }
          if (svc > 0) {
            out.push({
              module_key: 'premises', entity_id: e.id, period: t,
              nominal_type: 'overhead', line_label: 'Service charge',
              amount_p: Math.round(svc * svcFactor),
              tags: { concession_factor: svcFactor },
            });
          }
        }
      } else {
        // BUY mode
        const price = ctx.resolve('premises.purchase_price_p', { entity: e.key });
        const depositPct = ctx.resolve('premises.deposit_pct', { entity: e.key }) / 100;
        const termYears = ctx.resolve('premises.mortgage_term_years', { entity: e.key });
        const ratePct = ctx.resolve('premises.mortgage_interest_pct', { entity: e.key }) / 100;
        const legalFees = ctx.resolve('premises.legal_fees_p', { entity: e.key });
        const fitOut = ctx.resolve('premises.fit_out_capex_p', { entity: e.key });
        const depYears = ctx.resolve('premises.depreciation_years', { entity: e.key }) || 25;
        const maintAnnual = ctx.resolve('premises.maintenance_annual_p', { entity: e.key });
        const rv = ctx.resolve('premises.ndr_rateable_value_p', { entity: e.key });
        const poundage = ctx.resolve('premises.ndr_poundage', { entity: e.key }) / 100;
        const ndrRelief = ctx.resolve('premises.ndr_relief_pct', { entity: e.key }) / 100;

        const lbtt = computeLBTT(price);

        // Acquisition month: opening - 1 (one month before opens), capped at 0
        const acqMonth = Math.max(0, opening - 1);
        const totalCapex = price + lbtt + legalFees + fitOut;
        const deposit = price * depositPct;
        const loan = price - deposit;

        // Capex row at acquisition month
        out.push({
          module_key: 'premises', entity_id: e.id, period: acqMonth,
          nominal_type: 'capex', line_label: 'Acquisition + fit-out',
          amount_p: Math.round(totalCapex),
          tags: { breakdown: { price, lbtt, legalFees, fitOut } },
        });

        // Mortgage amortisation from acquisition month
        const monthlyRate = ratePct / 12;
        const nMonths = termYears * 12;
        const payment = monthlyRate === 0 ? loan / nMonths
          : (loan * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -nMonths));

        let outstanding = loan;
        const schedule = [];
        for (let t = 0; t < ctx.periods.length; t++) {
          if (t < acqMonth || outstanding <= 0) {
            schedule[t] = { interest: 0, principal: 0, outstanding: t < acqMonth ? 0 : outstanding };
            continue;
          }
          const interest = outstanding * monthlyRate;
          const principal = Math.min(payment - interest, outstanding);
          outstanding = Math.max(0, outstanding - principal);
          schedule[t] = { interest, principal, outstanding };
        }
        debtScheduleByEntity[e.key] = schedule;

        // Depreciation: straight-line on (price + fit-out) starting from opening
        const depBase = price + fitOut;
        const monthlyDep = depBase / (depYears * 12);

        // NDR (annual) divided by 12 each month, after relief
        const ndrAnnual = rv * poundage * (1 - ndrRelief);
        const ndrMonthly = ndrAnnual / 12;

        const maintMonthly = maintAnnual / 12;

        for (const t of ctx.periods) {
          const sch = schedule[t] || { interest: 0, principal: 0, outstanding: 0 };
          if (sch.interest > 0) {
            out.push({
              module_key: 'premises', entity_id: e.id, period: t,
              nominal_type: 'debt_interest', line_label: 'Mortgage interest',
              amount_p: Math.round(sch.interest),
            });
          }
          if (sch.principal > 0) {
            out.push({
              module_key: 'premises', entity_id: e.id, period: t,
              nominal_type: 'debt_principal', line_label: 'Mortgage principal',
              amount_p: Math.round(sch.principal),
            });
          }
          // Always emit outstanding (used by BS)
          out.push({
            module_key: 'premises', entity_id: e.id, period: t,
            nominal_type: 'debt_balance', line_label: 'Mortgage outstanding',
            amount_p: Math.round(sch.outstanding),
          });

          if (t >= opening) {
            out.push({
              module_key: 'premises', entity_id: e.id, period: t,
              nominal_type: 'depreciation', line_label: 'Property + fit-out',
              amount_p: Math.round(monthlyDep),
            });
            if (ndrMonthly > 0) {
              out.push({
                module_key: 'premises', entity_id: e.id, period: t,
                nominal_type: 'overhead', line_label: 'NDR',
                amount_p: Math.round(ndrMonthly),
                tags: { premises_kind: 'buy' },
              });
            }
            if (maintMonthly > 0) {
              out.push({
                module_key: 'premises', entity_id: e.id, period: t,
                nominal_type: 'overhead', line_label: 'Maintenance',
                amount_p: Math.round(maintMonthly),
              });
            }
          }
        }
      }
    }

    ctx.debtScheduleByEntity = debtScheduleByEntity;
    return out;
  },
};

/**
 * Concession factor at month `tIn` after opening. Stages sequentially
 * consume months from t=0 onwards; once exhausted, factor is 1.0 (full).
 *
 * Example: stages = [{months: 3, factor: 0}, {months: 6, factor: 0.5}, {months: 12, factor: 0.75}]
 *   tIn 0..2  → 0    (free)
 *   tIn 3..8  → 0.5  (half price)
 *   tIn 9..20 → 0.75 (75%)
 *   tIn ≥ 21  → 1.0  (full)
 */
export function concessionFactorAt(tIn, stages) {
  if (!Array.isArray(stages) || stages.length === 0) return 1;
  let cursor = 0;
  for (const stage of stages) {
    const months = Number(stage?.months) || 0;
    if (months <= 0) continue;
    const factor = Math.max(0, Math.min(1, Number(stage?.factor) || 0));
    if (tIn < cursor + months) return factor;
    cursor += months;
  }
  return 1;
}

// Scotland LBTT non-residential (2026 simplified bands).
function computeLBTT(price) {
  const bands = [
    [15000000, 0],         // 0% to £150k
    [25000000, 0.01],      // 1% £150k-£250k
    [Infinity, 0.05],      // 5% above £250k
  ];
  let lbtt = 0;
  let prev = 0;
  for (const [cap, rate] of bands) {
    const slice = Math.max(0, Math.min(price, cap) - prev);
    lbtt += slice * rate;
    prev = cap;
    if (price <= cap) break;
  }
  return Math.round(lbtt);
}
