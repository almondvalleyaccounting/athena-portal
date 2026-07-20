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
  monthlyActuals = [],          // [{ period_start, account_name, account_type, amount }] — rolling forecast
  pipelineMrrByMonth = null,    // Map<monthIndex, £> — pipeline-weighted new MRR contribution
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

  // Index monthly actuals by YYYY-MM for O(1) lookup
  const actualsByMonth = new Map();
  for (const a of monthlyActuals) {
    const key = String(a.period_start).slice(0, 7);
    if (!actualsByMonth.has(key)) actualsByMonth.set(key, { revenue: 0, expenses: 0, expensesByType: {} });
    const bucket = actualsByMonth.get(key);
    const amt = Number(a.amount) || 0;
    if (a.account_type === 'Income') bucket.revenue += amt;
    else { bucket.expenses += amt; bucket.expensesByType[a.account_type] = (bucket.expensesByType[a.account_type] || 0) + amt; }
  }
  const todayKey = new Date().toISOString().slice(0, 7);

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

    // ── Pipeline contribution (from accepted/sent quotes)
    const pipelineContrib = pipelineMrrByMonth?.get?.(i) || 0;
    const revenueWithPipeline = revenue + pipelineContrib;

    // ── Rolling forecast: if month is closed and we have actuals, overlay them
    const monthKeyStr = `${year}-${String(month).padStart(2, '0')}`;
    const actual = actualsByMonth.get(monthKeyStr);
    const isClosed = monthKeyStr < todayKey;
    const hasActual = isClosed && actual && (actual.revenue > 0 || actual.expenses > 0);

    const plannedRevenue = revenueWithPipeline;
    const plannedExpenses = staffCost + overheads + ownerComp;
    const plannedEbitda = plannedRevenue - staffCost - overheads;
    const plannedProfit = plannedEbitda - ownerComp;

    const displayRevenue = hasActual ? actual.revenue : plannedRevenue;
    const displayExpenses = hasActual ? actual.expenses : plannedExpenses;
    const displayEbitda = displayRevenue - (hasActual ? actual.expenses - ownerComp : staffCost + overheads);
    // If we have actuals, treat the actual expenses as already including owner comp paid.
    // So EBITDA = actual.revenue - (actual.expenses - ownerComp); profit = actual.revenue - actual.expenses.
    const finalEbitda = hasActual ? (actual.revenue - (actual.expenses - ownerComp)) : plannedEbitda;
    const finalProfit = hasActual ? (actual.revenue - actual.expenses) : plannedProfit;

    months.push({
      index: i, year, month, label,
      revenue: displayRevenue,
      plannedRevenue,
      actualRevenue: hasActual ? actual.revenue : null,
      recurringRevenue: recurringApplied, adHocRevenue: adHoc, newMrrRevenue: newMrrApplied, pipelineRevenue: pipelineContrib,
      staffCost, overheads, ownerComp,
      ebitda: finalEbitda,
      profit: finalProfit,
      plannedEbitda, plannedProfit,
      margin: displayRevenue > 0 ? finalEbitda / displayRevenue : 0,
      profitMargin: displayRevenue > 0 ? finalProfit / displayRevenue : 0,
      seasonalityMult: seasMult,
      isActual: hasActual,
      varianceRevenue: hasActual ? actual.revenue - plannedRevenue : null,
      varianceProfit: hasActual ? finalProfit - plannedProfit : null,
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

// ── Narrator — rule-based plain-English summary of the plan ──
//
// Reads projection + ancillary derived data, emits ordered findings.
// Each finding has a severity (info/warning/critical/positive) and 1-sentence narrative.
// Caller renders these in priority order.
export function buildNarrative({
  projection,
  clientBillings = [],
  clientOverrides = [],
  staffLines = [],
  churnScores = [],
  profitability = [],
  capacityByMonth = [],
  pipelineResult = null,
  scenario,
}) {
  const findings = [];
  const { y1, y2, months, waterfall } = projection;

  // ── Unfed-model guard. A plan with revenue but no cost lines produces a
  // "100% EBITDA margin — Strong" and top-quartile benchmark verdicts that
  // are pure garbage-in-confident-out. Say so, loudly, and skip every
  // margin/benchmark-flavoured finding until the model is fed.
  const modelFed = (y1.staffCost || 0) > 0 || (y1.overheads || 0) > 0 || (y1.ownerComp || 0) > 0;
  if (!modelFed && y1.revenue > 0) {
    findings.push({
      severity: 'critical', priority: 99,
      text: 'This plan has no staff, overhead, or owner-comp lines yet — every margin and benchmark below would be meaningless, so they are hidden. Add costs on the Staff, Overheads and Owner comp tabs first.',
    });
  }

  // ── Overall profit trajectory
  const profitDeltaPct = y1.profit === 0 ? 0 : (y2.profit - y1.profit) / Math.abs(y1.profit);
  if (y2.profit > 0 && y1.profit > 0) {
    if (profitDeltaPct > 0.2) {
      findings.push({ severity: 'positive', priority: 30, text: `Profit grows ${fmtPct(profitDeltaPct)} from Y1 to Y2 (${fmtGBP(y1.profit)} → ${fmtGBP(y2.profit)}) — healthy trajectory.` });
    } else if (profitDeltaPct < -0.05) {
      findings.push({ severity: 'warning', priority: 80, text: `Profit falls ${fmtPct(profitDeltaPct)} from Y1 to Y2. Dig into the drivers waterfall — usually staff cost outrunning fee uplift.` });
    } else {
      findings.push({ severity: 'info', priority: 40, text: `Profit is roughly flat Y1→Y2 (${fmtGBP(y2.profit - y1.profit)} change). Plan is defensive rather than growth-oriented.` });
    }
  } else if (y2.profit <= 0) {
    findings.push({ severity: 'critical', priority: 95, text: `Y2 shows a loss of ${fmtGBP(Math.abs(y2.profit))}. Something fundamental needs re-working — start with the sensitivity tornado.` });
  }

  // ── EBITDA margin vs benchmark (only when the model has cost lines)
  const margin = y1.margin;
  if (modelFed && margin < 0.15 && y1.revenue > 0) {
    findings.push({ severity: 'warning', priority: 70, text: `Y1 EBITDA margin is ${fmtPct(margin)} — well below the 20-30% UK practice benchmark. Check overheads and staff cost ratios.` });
  } else if (modelFed && margin > 0.35) {
    findings.push({ severity: 'positive', priority: 20, text: `Y1 EBITDA margin is ${fmtPct(margin)} — above top-quartile UK benchmark (~32%). Strong.` });
  }

  // ── Revenue per fee-earner vs benchmark
  const feeEarners = staffLines.filter((s) => s.is_fee_earner !== false).length;
  const revPerEarner = feeEarners > 0 ? y1.revenue / feeEarners : 0;
  if (feeEarners > 0) {
    if (revPerEarner < 90000) {
      findings.push({ severity: 'warning', priority: 60, text: `Revenue per fee-earner is ${fmtGBP(revPerEarner)} — below the £90-120k UK practice norm. Either under-priced or under-utilised.` });
    } else if (revPerEarner > 150000) {
      findings.push({ severity: 'positive', priority: 15, text: `Revenue per fee-earner is ${fmtGBP(revPerEarner)} — top-quartile territory (£150k+).` });
    }
  }

  // ── Concentration
  const activeBook = clientBillings.map((b) => {
    const ov = clientOverrides.find((o) => o.live_billing_id === b.id);
    return { ...b, fee: ov?.fee_override_monthly != null ? Number(ov.fee_override_monthly) : b.monthly_net };
  });
  const totalMonthly = activeBook.reduce((s, c) => s + c.fee, 0);
  const sorted = [...activeBook].sort((a, b) => b.fee - a.fee);
  const top10Pct = totalMonthly > 0 ? sorted.slice(0, 10).reduce((s, c) => s + c.fee, 0) / totalMonthly : 0;
  if (top10Pct > 0.40) {
    findings.push({ severity: 'critical', priority: 85, text: `Top-10 clients = ${fmtPct(top10Pct)} of revenue — concentration risk. Losing one hurts disproportionately.` });
  } else if (top10Pct > 0.30) {
    findings.push({ severity: 'warning', priority: 55, text: `Top-10 clients are ${fmtPct(top10Pct)} of revenue. Watch for creep above 40%.` });
  }

  // ── At-risk exposure
  const atRiskMonthly = activeBook
    .map((c) => ({ c, ov: clientOverrides.find((o) => o.live_billing_id === c.id) }))
    .filter(({ ov }) => ov && (ov.status === 'at_risk' || ov.status === 'ending'))
    .reduce((s, { c }) => s + c.fee, 0);
  if (atRiskMonthly > 0) {
    const annualExposure = atRiskMonthly * 12;
    const pctOfRevenue = y1.revenue > 0 ? annualExposure / y1.revenue : 0;
    findings.push({ severity: pctOfRevenue > 0.08 ? 'critical' : 'warning', priority: pctOfRevenue > 0.08 ? 88 : 65,
      text: `${fmtGBP(annualExposure)}/yr (${fmtPct(pctOfRevenue)}) flagged at-risk or ending. If they all go, that's ${fmtGBP(annualExposure)} of revenue to replace.` });
  }

  // ── Churn high-risk count
  const highChurn = churnScores.filter((c) => c.bucket === 'high');
  if (highChurn.length > 0) {
    const exposed = highChurn.reduce((s, c) => s + (c.monthly_fee || 0) * 12, 0);
    findings.push({ severity: 'warning', priority: 75, text: `${highChurn.length} client${highChurn.length !== 1 ? 's' : ''} scored high-risk for churn — combined exposure ${fmtGBP(exposed)}/yr. See Revenue → Churn risk.` });
  }

  // ── Capacity — any months over
  const overCapacityMonths = capacityByMonth.filter((c, i) => months[i]?.revenue > c.capacity_revenue && c.capacity_revenue > 0);
  if (overCapacityMonths.length > 3) {
    findings.push({ severity: 'warning', priority: 72, text: `${overCapacityMonths.length} forecast months exceed capacity — staff will be stretched without a hire. First over-capacity month: ${overCapacityMonths[0].label}.` });
  }

  // ── Profitability — unprofitable client count
  const atLoss = profitability.filter((r) => r.margin < 0);
  const lowMargin = profitability.filter((r) => r.margin_pct >= 0 && r.margin_pct < 0.3);
  if (atLoss.length > 0) {
    const lossSum = atLoss.reduce((s, r) => s + Math.abs(r.margin), 0);
    findings.push({ severity: 'warning', priority: 68, text: `${atLoss.length} client${atLoss.length !== 1 ? 's' : ''} currently loss-making (combined ${fmtGBP(lossSum)}/yr). Renegotiate, reassign to junior staff, or exit.` });
  } else if (lowMargin.length > profitability.length * 0.25 && profitability.length > 4) {
    findings.push({ severity: 'info', priority: 45, text: `${lowMargin.length} clients on <30% margin — a repricing round would add meaningful profit.` });
  }

  // ── Pipeline signal
  if (pipelineResult && pipelineResult.breakdown.length > 0 && scenario) {
    const weighted = pipelineResult.avgY1Run;
    const manual = Number(scenario.new_mrr_per_month) || 0;
    if (!scenario.pipeline_mrr_override_enabled && weighted > manual * 1.5 && weighted > 500) {
      findings.push({ severity: 'info', priority: 50, text: `Quote pipeline weighted-MRR is ${fmtGBP(weighted)}/mo vs your manual assumption of ${fmtGBP(manual)}/mo. Pipeline says the plan is conservative.` });
    } else if (!scenario.pipeline_mrr_override_enabled && weighted < manual * 0.5 && manual > 500) {
      findings.push({ severity: 'warning', priority: 66, text: `Quote pipeline weighted-MRR is only ${fmtGBP(weighted)}/mo vs your manual assumption of ${fmtGBP(manual)}/mo. Pipeline doesn't support the plan — either push sales or temper the assumption.` });
    }
  }

  // ── Actuals variance (rolling forecast)
  const actualMonths = months.filter((m) => m.isActual);
  if (actualMonths.length > 0) {
    const revVar = actualMonths.reduce((s, m) => s + (m.varianceRevenue || 0), 0);
    const profitVar = actualMonths.reduce((s, m) => s + (m.varianceProfit || 0), 0);
    const revVarPct = actualMonths.reduce((s, m) => s + (m.plannedRevenue || 0), 0) > 0
      ? revVar / actualMonths.reduce((s, m) => s + m.plannedRevenue, 0) : 0;
    if (Math.abs(revVarPct) > 0.05) {
      findings.push({
        severity: revVarPct >= 0 ? 'positive' : 'warning',
        priority: revVarPct >= 0 ? 25 : 62,
        text: `Actual-vs-plan: revenue ${revVarPct >= 0 ? 'ahead' : 'behind'} by ${fmtGBP(Math.abs(revVar))} (${fmtPct(Math.abs(revVarPct))}) across ${actualMonths.length} closed month${actualMonths.length !== 1 ? 's' : ''}.`,
      });
    }
  }

  // ── Fee uplift vs pay rise sanity check
  const feeUp = Number(scenario?.fee_uplift_pct || 0);
  const payUp = Number(scenario?.pay_rise_pct || 0);
  if (payUp > feeUp + 2 && y1.revenue > 0) {
    findings.push({ severity: 'warning', priority: 58, text: `Pay rise (${payUp}%) is ${(payUp - feeUp).toFixed(1)}pp above fee uplift (${feeUp}%). Margins compress every year this is true.` });
  }

  return findings.sort((a, b) => b.priority - a.priority);
}

// ── UK accounting-practice benchmarks (baked reference values) ──
// Sources: ICAEW Benchmarking, Practice Track, Xero Accounting Industry Report
// surveys of UK accountancy firms (blended across sole practitioner → small firm).
export const UK_PRACTICE_BENCHMARKS = {
  ebitda_margin: { low: 0.15, typical: 0.22, topQ: 0.32, label: 'EBITDA margin' },
  staff_to_revenue: { low: 0.45, typical: 0.55, topQ: 0.45, label: 'Staff cost ÷ revenue', lowerIsBetter: true },
  revenue_per_fee_earner: { low: 75000, typical: 105000, topQ: 160000, label: 'Revenue / fee-earner', currency: true },
  overhead_ratio: { low: 0.15, typical: 0.20, topQ: 0.15, label: 'Overheads ÷ revenue', lowerIsBetter: true },
  gross_margin: { low: 0.40, typical: 0.50, topQ: 0.60, label: 'Gross margin (revenue − staff)' },
};

export function scoreAgainstBenchmark(value, bench) {
  if (value == null || bench == null) return 'unknown';
  const { low, typical, topQ, lowerIsBetter } = bench;
  if (lowerIsBetter) {
    if (value <= topQ) return 'topQ';
    if (value <= typical) return 'typical';
    if (value <= low) return 'low';
    return 'below';
  } else {
    if (value >= topQ) return 'topQ';
    if (value >= typical) return 'typical';
    if (value >= low) return 'low';
    return 'below';
  }
}

// ── Client profitability ────────────────────────────────

// Compute per-client revenue / cost-to-serve / margin using LTM timesheets.
// Inputs:
//   clientBillings       — from live_billing (annualised fee)
//   clientOverrides      — scenario fee overrides (used if present)
//   timesheetEntries     — LTM timesheet_entries
//   staffLines           — plan_staff_lines (cost per staff)
//   targetHoursPa        — scenario default target chargeable hours per year
// For each staff member:
//   hourly cost = annual_fully_loaded / max(target_hours, logged_hours_LTM)
// For each client:
//   hours = sum minutes/60 across all staff
//   cost  = sum hours_per_staff × hourly_cost_per_staff
//   margin = revenue - cost
export function computeClientProfitability({ clientBillings, clientOverrides, timesheetEntries, staffLines, staffProfiles, scenario }) {
  const targetHoursPa = Number(scenario?.target_chargeable_hours_pa) || 1400;
  const defaultOnCosts = Number(scenario?.default_on_costs_pct) || 15.05;

  // Staff cost rate per hour (derived from fully-loaded salary ÷ target hours)
  // Staff lines can override target per person. For staff with no plan_staff_lines row,
  // fall back to a "Unknown earner" flag so the user is aware their cost is imputed.
  const staffLineByStaffId = new Map();
  for (const l of staffLines) {
    if (l.staff_id) staffLineByStaffId.set(l.staff_id, l);
  }

  const hourlyCostByStaff = new Map();
  const ltmHoursByStaff = new Map();
  for (const e of timesheetEntries) {
    ltmHoursByStaff.set(e.staff_id, (ltmHoursByStaff.get(e.staff_id) || 0) + (e.minutes || 0) / 60);
  }
  for (const sp of staffProfiles) {
    const line = staffLineByStaffId.get(sp.id);
    const annual = Number(line?.annual_salary) || 0;
    const on = line?.on_costs_pct == null ? defaultOnCosts : Number(line.on_costs_pct);
    const fullyLoaded = annual * (1 + on / 100);
    const targetHrs = Number(line?.target_chargeable_hours_pa) || targetHoursPa;
    // If the staff member has actually logged more hours than their target, use actual.
    const actualHrs = ltmHoursByStaff.get(sp.id) || 0;
    const divisor = Math.max(targetHrs, actualHrs, 1);
    hourlyCostByStaff.set(sp.id, fullyLoaded / divisor);
  }

  // Aggregate timesheet entries per entity
  const perEntity = new Map();
  for (const e of timesheetEntries) {
    if (!e.entity_id) continue;
    if (!perEntity.has(e.entity_id)) perEntity.set(e.entity_id, { hours: 0, cost: 0, byService: {} });
    const p = perEntity.get(e.entity_id);
    const hrs = (e.minutes || 0) / 60;
    const rate = hourlyCostByStaff.get(e.staff_id) || 0;
    p.hours += hrs;
    p.cost += hrs * rate;
    const svc = e.service || 'Unspecified';
    p.byService[svc] = (p.byService[svc] || 0) + hrs;
  }

  // Combine with billings
  const overrideByBilling = new Map(clientOverrides.map((o) => [o.live_billing_id, o]));
  const rows = clientBillings.map((b) => {
    const ov = overrideByBilling.get(b.id);
    const monthly = ov?.fee_override_monthly != null ? Number(ov.fee_override_monthly) : b.monthly_net;
    const annualRev = monthly * 12;
    const t = perEntity.get(b.entity_id) || { hours: 0, cost: 0, byService: {} };
    const margin = annualRev - t.cost;
    return {
      id: b.id, entity_id: b.entity_id, entity_name: b.entity_name,
      annual_revenue: annualRev,
      monthly_fee: monthly,
      hours_ltm: t.hours,
      cost_to_serve: t.cost,
      margin,
      margin_pct: annualRev > 0 ? margin / annualRev : 0,
      effective_rate: t.hours > 0 ? annualRev / t.hours : 0,
      top_service: Object.entries(t.byService).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    };
  });

  return rows.sort((a, b) => a.margin_pct - b.margin_pct); // worst margin first
}

// ── Capacity ────────────────────────────────────────────

// Monthly capacity (chargeable hours) per month from plan_staff_lines.
// Output: [{month, capacity_hours, capacity_revenue, headcount_fee_earners}]
// capacity_revenue uses an "average effective rate" based on live_billing ÷ LTM hours.
export function computeCapacity({ staffLines, scenario, months, effectiveRatePerHour }) {
  const targetHoursPa = Number(scenario?.target_chargeable_hours_pa) || 1400;
  return months.map((m) => {
    let hrs = 0, headcount = 0;
    const monthKey = m.year * 12 + (m.month - 1);
    for (const l of staffLines) {
      if (l.is_fee_earner === false) continue;
      const sKey = l.start_month ? (new Date(l.start_month).getFullYear() * 12 + new Date(l.start_month).getMonth()) : null;
      const eKey = l.end_month ? (new Date(l.end_month).getFullYear() * 12 + new Date(l.end_month).getMonth()) : null;
      if (sKey != null && monthKey < sKey) continue;
      if (eKey != null && monthKey > eKey) continue;
      const lineTarget = Number(l.target_chargeable_hours_pa) || targetHoursPa;
      hrs += lineTarget / 12;
      headcount += 1;
    }
    return {
      ...m,
      capacity_hours: hrs,
      capacity_revenue: hrs * (effectiveRatePerHour || 0),
      headcount_fee_earners: headcount,
    };
  });
}

// ── Pipeline → weighted MRR ────────────────────────────

// Converts quote pipeline into a month-by-month weighted-MRR ramp aligned
// with the projection horizon. Win rates come from scenario.
export function computePipelineContribution({ quotes, scenario, months }) {
  const winRate = {
    draft: Number(scenario?.pipeline_win_rate_draft_pct || 10) / 100,
    sent: Number(scenario?.pipeline_win_rate_sent_pct || 50) / 100,
    accepted: Number(scenario?.pipeline_win_rate_accepted_pct || 90) / 100,
  };

  // Expected go-live month for each quote:
  //   accepted -> accepted_at + 1 month (onboarding)
  //   sent     -> sent_at + 2 months (sales cycle estimate)
  //   draft    -> valid_until or created_at + 3 months
  const goLive = (q) => {
    const addMonths = (d, n) => { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; };
    if (q.status === 'accepted' && q.accepted_at) return addMonths(q.accepted_at, 1);
    if (q.status === 'sent' && q.sent_at) return addMonths(q.sent_at, 2);
    if (q.valid_until) return new Date(q.valid_until);
    return addMonths(q.created_at || new Date(), 3);
  };

  const byMonth = new Map();
  const breakdown = [];
  for (const q of quotes) {
    const live = goLive(q);
    const liveKey = live.getFullYear() * 12 + live.getMonth();
    const prob = winRate[q.status] || 0;
    const weightedMonthly = q.monthly_net * prob;
    breakdown.push({
      ...q,
      expected_live: live.toISOString().slice(0, 10),
      probability: prob,
      weighted_monthly: weightedMonthly,
    });
    // The monthly fee starts from that month and persists through the rest of horizon
    for (const m of months) {
      const mKey = m.year * 12 + (m.month - 1);
      if (mKey >= liveKey) {
        byMonth.set(m.index, (byMonth.get(m.index) || 0) + weightedMonthly);
      }
    }
  }

  const perMonth = months.map((m) => ({ ...m, pipeline_mrr: byMonth.get(m.index) || 0 }));
  const totalY1 = perMonth.slice(0, 12).reduce((s, m) => s + m.pipeline_mrr, 0) / 12;
  const avgY1Run = totalY1; // avg monthly MRR attributable to pipeline across Y1
  return { perMonth, breakdown, avgY1Run };
}

// ── Churn scoring from signals ────────────────────────

// Computes a 0-100 risk score per client based on multiple signals.
// Buckets: 0-30 low, 31-60 medium, 61-100 high.
export function computeChurnScores({ clientBillings, clientOverrides, timesheetEntries }) {
  const overrideBy = new Map(clientOverrides.map((o) => [o.live_billing_id, o]));

  // Build LTM hours per entity (engagement signal — dropping to zero = disengaged)
  const hoursByEntity = new Map();
  for (const e of timesheetEntries) {
    if (!e.entity_id) continue;
    hoursByEntity.set(e.entity_id, (hoursByEntity.get(e.entity_id) || 0) + (e.minutes || 0) / 60);
  }

  return clientBillings.map((b) => {
    const ov = overrideBy.get(b.id);
    const signals = [];
    let score = 0;

    // 1. Scenario status override
    if (ov?.status === 'ending') { signals.push({ label: 'Marked ending', weight: 50 }); score += 50; }
    else if (ov?.status === 'at_risk') { signals.push({ label: 'Flagged at-risk', weight: 30 }); score += 30; }

    // 2. Wind-down phrases in services
    const wd = detectWindDown(b.services);
    if (wd) { signals.push({ label: `Wind-down phrase ("${(wd[0].text || '').slice(0, 40)}…")`, weight: 25 }); score += 25; }

    // 3. No recent work logged (engagement proxy)
    const hrs = hoursByEntity.get(b.entity_id) || 0;
    if (hrs === 0) { signals.push({ label: 'No time logged in LTM', weight: 10 }); score += 10; }
    else if (hrs < 2) { signals.push({ label: 'Very low engagement (<2h LTM)', weight: 5 }); score += 5; }

    // 4. Fee override pushing monthly below baseline (price pressure)
    if (ov?.fee_override_monthly != null && Number(ov.fee_override_monthly) < b.monthly_net * 0.8) {
      signals.push({ label: 'Fee override materially lower than live billing', weight: 15 });
      score += 15;
    }

    // 5. Explicit end_month in near future
    if (ov?.end_month) {
      const months = (new Date(ov.end_month) - Date.now()) / (30 * 24 * 60 * 60 * 1000);
      if (months < 6) { signals.push({ label: `End-month within ${Math.round(months)}mo`, weight: 20 }); score += 20; }
    }

    const bucket = score >= 61 ? 'high' : score >= 31 ? 'medium' : 'low';
    return { id: b.id, entity_id: b.entity_id, entity_name: b.entity_name, monthly_fee: b.monthly_net, score: Math.min(100, score), bucket, signals };
  }).sort((a, b) => b.score - a.score);
}
