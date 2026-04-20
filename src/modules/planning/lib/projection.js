// Pure projection math for the planning module.
// Produces a month-by-month forecast for N months given the scenario settings,
// staff lines, overhead lines, and starting recurring billing base.
//
// Revenue model: starts from the current live recurring billing monthly_net.
// On the fee_uplift month (of the scenario's start year + forward), apply the uplift %.
// Staff model: each staff line accrues monthly (annual_salary * (1 + on_costs) / 12)
//   between start_month and end_month. The pay rise % applies on the pay_rise month each year.
// Overheads: sum of plan_overhead_lines.monthly_amount (flat — could be indexed later).

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export function buildProjection({
  scenario,
  staffLines,
  overheadLines,
  baseMonthlyRevenue,
  horizonMonths = 24,
}) {
  if (!scenario) return { months: [], totals: {} };

  const startDate = scenario.start_month ? new Date(scenario.start_month) : new Date();
  const startY = startDate.getFullYear();
  const startM = startDate.getMonth() + 1; // 1-12

  const feeUpliftM = Number(scenario.fee_uplift_month) || 4;
  const feeUpliftPct = Number(scenario.fee_uplift_pct) || 0;
  const payRiseM = Number(scenario.pay_rise_month) || 4;
  const payRisePct = Number(scenario.pay_rise_pct) || 0;
  const defaultOnCosts = Number(scenario.default_on_costs_pct) || 15.05;

  const totalOverheads = (overheadLines || []).reduce((s, o) => s + (Number(o.monthly_amount) || 0), 0);

  const months = [];
  let revenueMultiplier = 1;
  let payMultiplier = 1;
  let feeUpliftsApplied = 0;
  let payRisesApplied = 0;

  for (let i = 0; i < horizonMonths; i++) {
    const year = startY + Math.floor((startM - 1 + i) / 12);
    const month = ((startM - 1 + i) % 12) + 1; // 1-12
    const label = `${MONTHS_SHORT[month - 1]} ${String(year).slice(2)}`;

    // Fee uplift applies once each year on feeUpliftM (starting from this year going forward)
    if (i > 0 && month === feeUpliftM) {
      revenueMultiplier *= 1 + feeUpliftPct / 100;
      feeUpliftsApplied++;
    } else if (i === 0 && month === feeUpliftM && feeUpliftPct !== 0) {
      // If we *start* on uplift month, assume it's already baked in — don't double count
    }

    // Pay rise each year on payRiseM
    if (i > 0 && month === payRiseM) {
      payMultiplier *= 1 + payRisePct / 100;
      payRisesApplied++;
    }

    const revenue = baseMonthlyRevenue * revenueMultiplier;

    // Staff cost for this month
    const monthDate = new Date(year, month - 1, 1);
    let staffCost = 0;
    for (const s of staffLines || []) {
      const sStart = s.start_month ? new Date(s.start_month) : null;
      const sEnd = s.end_month ? new Date(s.end_month) : null;
      if (sStart && monthDate < new Date(sStart.getFullYear(), sStart.getMonth(), 1)) continue;
      if (sEnd && monthDate > new Date(sEnd.getFullYear(), sEnd.getMonth(), 1)) continue;
      const onCosts = s.on_costs_pct == null ? defaultOnCosts : Number(s.on_costs_pct);
      const annual = Number(s.annual_salary) || 0;
      const mult = s.exclude_from_pay_rise ? 1 : payMultiplier;
      staffCost += (annual * mult * (1 + onCosts / 100)) / 12;
    }

    const overheads = totalOverheads;
    const profit = revenue - staffCost - overheads;

    months.push({
      index: i,
      year,
      month,
      label,
      revenue,
      staffCost,
      overheads,
      profit,
      margin: revenue > 0 ? profit / revenue : 0,
    });
  }

  const totals = months.reduce(
    (acc, m) => {
      acc.revenue += m.revenue;
      acc.staffCost += m.staffCost;
      acc.overheads += m.overheads;
      acc.profit += m.profit;
      return acc;
    },
    { revenue: 0, staffCost: 0, overheads: 0, profit: 0 },
  );
  totals.margin = totals.revenue > 0 ? totals.profit / totals.revenue : 0;
  totals.feeUpliftsApplied = feeUpliftsApplied;
  totals.payRisesApplied = payRisesApplied;

  return { months, totals };
}

export const fmtGBP = (n) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(n || 0);

export const fmtGBPDecimals = (n) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);

export const fmtPct = (n) => `${(n * 100).toFixed(1)}%`;
