// Projection engine — practice financial model.
//
// Revenue model (per month):
//   For each billing line from live_billing, check:
//     - not ended (scenario override end_month < projection month)
//     - apply fee_override_monthly if set, otherwise monthly_net
//     - apply compounding fee uplift on anniversary month (unless excluded)
//     - apply pro-rata "passive" churn to unflagged clients (churn_pct/12 of that line's £)
//   + new-MRR ramp: new_mrr_per_month × months_elapsed (cumulative)
//   + ad-hoc: ad_hoc_pct × current recurring
//
// Cost model:
//   Staff:   sum of plan_staff_lines × on-costs × pay multiplier (annual rise)
//   Owner comp: sum of plan_owner_comp_lines:
//     - salary  → monthly × on-costs × pay multiplier (if apply_pay_rise)
//     - dividend → amount_annual / 12 spread evenly (or amount_monthly if set)
//     - home_office / mileage / pension / other → amount_monthly flat
//   Overheads: sum of plan_overhead_lines × overhead_inflator (annual on uplift month)
//
// Outputs:
//   months[]: { year, month, label, revenue, recurringRevenue, adHocRevenue, newMrrRevenue,
//               staffCost, overheads, ownerComp, ebitda, profit, margin }
//   totals: { revenue, staffCost, overheads, ownerComp, ebitda, profit }
//   y1, y2: same shape
//   waterfall: Y1 profit → drivers → Y2 profit

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Heuristic — flag billing lines whose service descriptions suggest wind-down.
// Catches things like RHBAR where billing_type='recurring' but the services say
// "6 months towards…", "final…", "review for cancellation". We do NOT auto-end
// these — we surface them to the user to review and set an explicit end_month.
const WIND_DOWN_PATTERNS = [
  /\bfinal\b/i,
  /\breview\s+for\s+cancellation\b/i,
  /\bcease(d)?\b/i,
  /\bwind[- ]?down\b/i,
  /\bceasing\b/i,
  /\bclosing\b/i,
  /\btowards\b/i,      // "6 months towards..." style — paying off a fixed amount
  /\b\d+\s*months?\s+(un)?paid\b/i,
  /\b\d+\s*months?\s+(final|towards|to go)\b/i,
  /\bon\s+account\b/i,
];

export function detectWindDown(services) {
  if (!services) return null;
  const arr = Array.isArray(services) ? services : (services.services || []);
  const hits = [];
  for (const s of arr) {
    const text = `${s.description || ''} ${s.detail || ''}`;
    for (const rx of WIND_DOWN_PATTERNS) {
      if (rx.test(text)) { hits.push({ service: s.service_id || '', text: text.trim(), pattern: rx.source }); break; }
    }
  }
  return hits.length > 0 ? hits : null;
}

function monthKey(year, month) { return year * 12 + (month - 1); }

function dateToKey(d) {
  if (!d) return null;
  const dt = typeof d === 'string' ? new Date(d) : d;
  return monthKey(dt.getFullYear(), dt.getMonth() + 1);
}

export function buildProjection({
  scenario,
  staffLines = [],
  overheadLines = [],
  ownerCompLines = [],
  clientBillings = [],          // [{ id, entity_id, monthly_net }]
  clientOverrides = [],         // [{ live_billing_id, status, end_month, fee_override_monthly, exclude_from_uplift }]
  horizonMonths = 24,
}) {
  if (!scenario) return emptyProjection();

  const startDate = scenario.start_month ? new Date(scenario.start_month) : new Date();
  const startY = startDate.getFullYear();
  const startM = startDate.getMonth() + 1;

  const feeUpliftM = Number(scenario.fee_uplift_month) || 4;
  const feeUpliftPct = Number(scenario.fee_uplift_pct) || 0;
  const payRiseM = Number(scenario.pay_rise_month) || 4;
  const payRisePct = Number(scenario.pay_rise_pct) || 0;
  const ohInflator = Number(scenario.overhead_inflator_pct) || 0;
  const defaultOnCosts = Number(scenario.default_on_costs_pct) || 15.05;
  const churnPct = Number(scenario.churn_pct_annual) || 0;
  const newMrr = Number(scenario.new_mrr_per_month) || 0;
  const adHocPct = Number(scenario.ad_hoc_pct_of_recurring) || 0;

  const seasonalityRaw = scenario.seasonality_monthly_mult;
  let seasonality = Array.isArray(seasonalityRaw) ? seasonalityRaw.map(Number) : null;
  if (!seasonality || seasonality.length !== 12) seasonality = Array(12).fill(1);
  const seasonalityApplies = scenario.seasonality_applies_to || 'adhoc';
  // Normalise so seasonality multipliers average 1 across the year — otherwise
  // changing seasonality inadvertently shifts total annual revenue.
  const seasonalitySum = seasonality.reduce((a, b) => a + b, 0);
  const seasonalityMean = seasonalitySum > 0 ? seasonalitySum / 12 : 1;
  const seasonalityNormalised = seasonality.map((m) => (seasonalityMean > 0 ? m / seasonalityMean : 1));

  // Index overrides by live_billing_id for quick lookup
  const overrideByBilling = new Map();
  for (const o of clientOverrides) {
    if (o.live_billing_id) overrideByBilling.set(o.live_billing_id, o);
  }

  const baseOverheads = overheadLines.reduce((s, o) => s + (Number(o.monthly_amount) || 0), 0);

  const months = [];
  let revenueMultiplier = 1;           // compounds on fee uplift anniversary
  let payMultiplier = 1;               // compounds on pay rise anniversary
  let overheadMultiplier = 1;          // compounds overhead inflator
  const monthlyChurnFactor = 1 - (churnPct / 100) / 12; // tiny erosion each month

  // Cumulative passive-churn erosion applied to unflagged clients
  let churnErosion = 1;

  for (let i = 0; i < horizonMonths; i++) {
    const year = startY + Math.floor((startM - 1 + i) / 12);
    const month = ((startM - 1 + i) % 12) + 1;
    const label = `${MONTHS_SHORT[month - 1]} ${String(year).slice(2)}`;

    // Apply anniversary multipliers (skip i=0 — they're assumed baked into the starting point)
    if (i > 0 && month === feeUpliftM) revenueMultiplier *= 1 + feeUpliftPct / 100;
    if (i > 0 && month === payRiseM) payMultiplier *= 1 + payRisePct / 100;
    if (i > 0 && month === feeUpliftM) overheadMultiplier *= 1 + ohInflator / 100;

    // Passive churn accrues every month
    if (i > 0) churnErosion *= monthlyChurnFactor;

    const monthKeyI = monthKey(year, month);

    // ── Recurring revenue — client by client
    let recurring = 0;
    for (const b of clientBillings) {
      const override = overrideByBilling.get(b.id);
      const endKey = override?.end_month ? dateToKey(override.end_month) : null;
      if (endKey != null && monthKeyI > endKey) continue; // client has ended

      const base = override?.fee_override_monthly != null
        ? Number(override.fee_override_monthly)
        : Number(b.monthly_net) || 0;

      const uplift = override?.exclude_from_uplift ? 1 : revenueMultiplier;
      // Flagged 'at_risk' or 'ending' clients are not subject to passive churn
      // (their fate is already modelled explicitly via end_month / status)
      const churnFactor = (override?.status && override.status !== 'active') ? 1 : churnErosion;

      recurring += base * uplift * churnFactor;
    }

    // ── New MRR — cumulative ramp of new clients acquired
    //   months 0..N: new_mrr × i (clients added linearly)
    //   Apply uplift multiplier from point of acquisition (approx — treat as scaling with current multiplier)
    const newMrrThisMonth = newMrr * i * revenueMultiplier;

    // ── Seasonality multiplier for this calendar month
    const seasMult = seasonalityNormalised[month - 1] || 1;

    // ── Ad-hoc / one-off
    // Seasonality applies at minimum to ad-hoc (SA rush, year-end surge). Optionally all.
    const adHocBase = (recurring + newMrrThisMonth) * (adHocPct / 100);
    const adHoc = adHocBase * seasMult; // always seasonal — ad-hoc is the cyclical part

    // If seasonalityApplies === 'all', also modulate recurring + new MRR
    const recurringApplied = seasonalityApplies === 'all' ? recurring * seasMult : recurring;
    const newMrrApplied = seasonalityApplies === 'all' ? newMrrThisMonth * seasMult : newMrrThisMonth;

    const revenue = recurringApplied + newMrrApplied + adHoc;

    // ── Staff cost
    const monthDate = new Date(year, month - 1, 1);
    let staffCost = 0;
    for (const s of staffLines) {
      const sStartKey = s.start_month ? dateToKey(s.start_month) : null;
      const sEndKey = s.end_month ? dateToKey(s.end_month) : null;
      if (sStartKey != null && monthKeyI < sStartKey) continue;
      if (sEndKey != null && monthKeyI > sEndKey) continue;
      const onCosts = s.on_costs_pct == null ? defaultOnCosts : Number(s.on_costs_pct);
      const annual = Number(s.annual_salary) || 0;
      const mult = s.exclude_from_pay_rise ? 1 : payMultiplier;
      staffCost += (annual * mult * (1 + onCosts / 100)) / 12;
    }

    // ── Owner comp
    let ownerComp = 0;
    for (const o of ownerCompLines) {
      const oStartKey = o.start_month ? dateToKey(o.start_month) : null;
      const oEndKey = o.end_month ? dateToKey(o.end_month) : null;
      if (oStartKey != null && monthKeyI < oStartKey) continue;
      if (oEndKey != null && monthKeyI > oEndKey) continue;
      const mult = o.apply_pay_rise ? payMultiplier : 1;
      if (o.comp_type === 'salary') {
        const on = o.on_costs_pct == null ? defaultOnCosts : Number(o.on_costs_pct);
        ownerComp += (Number(o.amount_monthly) || 0) * mult * (1 + on / 100);
      } else if (o.comp_type === 'dividend') {
        // If amount_annual is set, spread evenly; else use amount_monthly
        const monthly = o.amount_annual != null
          ? Number(o.amount_annual) / 12
          : (Number(o.amount_monthly) || 0);
        ownerComp += monthly * mult;
      } else {
        ownerComp += (Number(o.amount_monthly) || 0) * mult;
      }
    }

    // ── Overheads (apply annual inflator)
    const overheads = baseOverheads * overheadMultiplier;

    const ebitda = revenue - staffCost - overheads;
    const profit = ebitda - ownerComp;

    months.push({
      index: i, year, month, label,
      revenue, recurringRevenue: recurringApplied, adHocRevenue: adHoc, newMrrRevenue: newMrrApplied,
      staffCost, overheads, ownerComp,
      ebitda, profit,
      margin: revenue > 0 ? ebitda / revenue : 0,
      profitMargin: revenue > 0 ? profit / revenue : 0,
      seasonalityMult: seasMult,
    });
  }

  const sumAcross = (arr) => arr.reduce((a, m) => ({
    revenue: a.revenue + m.revenue,
    recurringRevenue: a.recurringRevenue + m.recurringRevenue,
    adHocRevenue: a.adHocRevenue + m.adHocRevenue,
    newMrrRevenue: a.newMrrRevenue + m.newMrrRevenue,
    staffCost: a.staffCost + m.staffCost,
    overheads: a.overheads + m.overheads,
    ownerComp: a.ownerComp + m.ownerComp,
    ebitda: a.ebitda + m.ebitda,
    profit: a.profit + m.profit,
  }), { revenue: 0, recurringRevenue: 0, adHocRevenue: 0, newMrrRevenue: 0, staffCost: 0, overheads: 0, ownerComp: 0, ebitda: 0, profit: 0 });

  const y1 = sumAcross(months.slice(0, 12));
  const y2 = sumAcross(months.slice(12, 24));
  const totals = sumAcross(months);
  y1.margin = y1.revenue > 0 ? y1.ebitda / y1.revenue : 0;
  y2.margin = y2.revenue > 0 ? y2.ebitda / y2.revenue : 0;
  totals.margin = totals.revenue > 0 ? totals.ebitda / totals.revenue : 0;

  // ── Waterfall Y1 → Y2 (explains the delta)
  const waterfall = buildWaterfall({ y1, y2, months, scenario });

  return { months, totals, y1, y2, waterfall };
}

function buildWaterfall({ y1, y2, months }) {
  const y1Profit = y1.profit;
  const y2Profit = y2.profit;
  const delta = y2Profit - y1Profit;

  const revDelta = y2.revenue - y1.revenue;
  const staffDelta = -(y2.staffCost - y1.staffCost);
  const ohDelta = -(y2.overheads - y1.overheads);
  const ownerDelta = -(y2.ownerComp - y1.ownerComp);

  // Split revenue delta into recurring-uplift, new-mrr, ad-hoc (rough attribution by category)
  const recDelta = y2.recurringRevenue - y1.recurringRevenue;
  const newDelta = y2.newMrrRevenue - y1.newMrrRevenue;
  const adHocDelta = y2.adHocRevenue - y1.adHocRevenue;

  return {
    y1Profit,
    y2Profit,
    delta,
    steps: [
      { label: 'Recurring uplift / churn net', value: recDelta },
      { label: 'New-MRR ramp', value: newDelta },
      { label: 'Ad-hoc / one-off', value: adHocDelta },
      { label: 'Staff cost change', value: staffDelta },
      { label: 'Owner comp change', value: ownerDelta },
      { label: 'Overhead change', value: ohDelta },
    ],
  };
}

function emptyProjection() {
  return {
    months: [],
    totals: { revenue: 0, staffCost: 0, overheads: 0, ownerComp: 0, ebitda: 0, profit: 0, margin: 0 },
    y1: { revenue: 0, staffCost: 0, overheads: 0, ownerComp: 0, ebitda: 0, profit: 0, margin: 0 },
    y2: { revenue: 0, staffCost: 0, overheads: 0, ownerComp: 0, ebitda: 0, profit: 0, margin: 0 },
    waterfall: { y1Profit: 0, y2Profit: 0, delta: 0, steps: [] },
  };
}

export const fmtGBP = (n) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(n || 0);

export const fmtGBPSigned = (n) => {
  const v = n || 0;
  const formatted = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(Math.abs(v));
  return v >= 0 ? `+${formatted}` : `-${formatted}`;
};

export const fmtGBP2 = (n) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);

export const fmtPct = (n) => `${(n * 100).toFixed(1)}%`;

export const fmtPctSimple = (n) => `${((n || 0) * 100).toFixed(0)}%`;
