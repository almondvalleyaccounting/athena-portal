// Shared aggregations used by both PDF and Excel exporters.
// The view layer has its own aggregation logic; we re-derive here so the
// exports don't depend on React-rendered DOM.

import { buildOccupancyIndex, occKey, curveForBand, occupancyOnCurve } from '../occupancy.js';

export function groupPeriods(periods, granularity, openingPeriod) {
  const out = [];
  const opening = openingPeriod ? new Date(openingPeriod) : null;
  const labelFor = (p) => {
    if (!opening) return `M${p}`;
    const d = new Date(opening.getFullYear(), opening.getMonth() + p, 1);
    return d.toLocaleString('en-GB', { month: 'short', year: '2-digit' });
  };

  if (granularity === 'monthly') {
    for (const p of periods) out.push({ label: labelFor(p), periods: [p] });
  } else if (granularity === 'quarterly') {
    for (let i = 0; i < periods.length; i += 3) {
      out.push({ label: `Q${Math.floor(i / 3) + 1}`, periods: periods.slice(i, i + 3) });
    }
  } else {
    for (let i = 0; i < periods.length; i += 12) {
      out.push({ label: `Y${Math.floor(i / 12) + 1}`, periods: periods.slice(i, i + 12) });
    }
  }
  return out;
}

/**
 * Aggregate a single statement line across a list of grouped periods.
 * @param {Array} outputs    fc_output rows (already filtered to the scope)
 * @param {String} nominal_type e.g. 'pnl.revenue_total'
 * @param {Array<Number>} periods list of period indices
 * @param {String} aggregate 'sum' | 'last' | 'first' | 'avg'
 */
export function sumLine(outputs, nominal_type, periods, aggregate = 'sum') {
  const setP = new Set(periods);
  let sum = 0, count = 0;
  const byPeriod = new Map();
  for (const o of outputs) {
    if (o.nominal_type !== nominal_type) continue;
    if (!setP.has(o.period)) continue;
    sum += o.amount_p; count += 1;
    byPeriod.set(o.period, o.amount_p);
  }
  if (count === 0) return 0;
  if (aggregate === 'first') {
    const m = Math.min(...periods);
    return byPeriod.has(m) ? byPeriod.get(m) : 0;
  }
  if (aggregate === 'last') {
    const m = Math.max(...periods);
    return byPeriod.has(m) ? byPeriod.get(m) : 0;
  }
  if (aggregate === 'avg') return sum / count;
  return sum;
}

/** Build a 2D matrix [lines × groups] for a statement. */
export function buildStatementMatrix(outputs, lines, grouped, scopedOutputs = null) {
  const src = scopedOutputs || outputs;
  return lines.map(line => ({
    line,
    values: grouped.map(g => sumLine(src, line.nominal_type, g.periods, line.aggregate || 'sum')),
  }));
}

// ── Staff detail aggregation ────────────────────────────────────
//
// Mirrors StaffCostsView: rows = roles in management → setting → direct,
// values per group are total cost (£) and end-of-period headcount.

export const STAFF_ROWS = [
  { role: 'executive',         label: 'Executives',          group: 'mgmt' },
  { role: 'senior_manager',    label: 'Senior managers',     group: 'mgmt' },
  { role: 'admin',             label: 'Admin',               group: 'mgmt' },
  { role: 'setting_manager',   label: 'Setting managers',    group: 'setting' },
  { role: 'assistant_manager', label: 'Assistant managers',  group: 'setting' },
  { role: 'cook',              label: 'Cooks',               group: 'setting' },
  { role: 'senior_qualified',  label: 'Senior qualified',    group: 'direct' },
  { role: 'qualified',         label: 'Qualified',           group: 'direct' },
  { role: 'apprentice',        label: 'Apprentices',         group: 'direct' },
];

export function buildStaffMatrix(outputs, grouped, entityIds) {
  const inScope = (r) => !entityIds || r.entity_id == null || entityIds.has(r.entity_id);
  const matrix = {};
  for (const row of STAFF_ROWS) matrix[row.role] = grouped.map(() => ({ cost: 0, hc: 0 }));

  grouped.forEach((g, gi) => {
    const setP = new Set(g.periods);
    const lastT = Math.max(...g.periods);
    for (const r of outputs) {
      if (!inScope(r)) continue;
      if (!setP.has(r.period)) continue;
      if (r.nominal_type !== 'staff_cost') continue;
      const role = r.tags?.role;
      if (!role || !matrix[role]) continue;
      matrix[role][gi].cost += r.amount_p;
      // headcount: snapshot at end of period range (matches StaffCostsView)
      if (r.period === lastT) matrix[role][gi].hc += Number(r.tags?.headcount) || 0;
    }
  });
  return matrix;
}

// ── Premises detail aggregation ─────────────────────────────────
//
// Surfaces the per-line cost rows from the premises + overheads modules
// across the chosen periods. Matches the "Premises & overheads" view.

export function buildPremisesMatrix(outputs, grouped, entityIds) {
  const inScope = (r) => !entityIds || r.entity_id == null || entityIds.has(r.entity_id);
  const labelMap = new Map();   // line_label -> rowIndex
  const rows = [];

  grouped.forEach((g, gi) => {
    const setP = new Set(g.periods);
    for (const r of outputs) {
      if (!inScope(r)) continue;
      if (!setP.has(r.period)) continue;
      if (r.nominal_type !== 'overhead' && r.nominal_type !== 'capex' && r.nominal_type !== 'depreciation') continue;
      const lbl = r.line_label || '(unlabelled)';
      const key = `${r.nominal_type}::${lbl}`;
      let idx = labelMap.get(key);
      if (idx == null) {
        idx = rows.length;
        rows.push({ key, label: lbl, kind: r.nominal_type, values: grouped.map(() => 0) });
        labelMap.set(key, idx);
      }
      rows[idx].values[gi] += r.amount_p;
    }
  });

  // Sort: overhead first (alpha), then capex, then depreciation
  rows.sort((a, b) => {
    const order = { overhead: 0, capex: 1, depreciation: 2 };
    if (a.kind !== b.kind) return order[a.kind] - order[b.kind];
    return a.label.localeCompare(b.label);
  });

  return rows;
}

// ── Income detail aggregation ───────────────────────────────────
//
// Anchored to a single year. Returns per-band cascade rows.

export const AGE_BANDS = ['babies', 'twos', 'three_to_five', 'after_school'];
export const AGE_BAND_LABELS = {
  babies: '0-2', twos: '2-3', three_to_five: '3-5', after_school: 'After-school',
};

export function buildIncomeMatrix({
  outputs, year, entities, entityIds,
  weeklyRate, laRate, eligiblePct, takeupPct, hoursPerWeek,
  openingPct, targetPct, phaseMonths,    // per-band ramp drivers (curve fallback)
  weeksPerYear,
  occupancySource = null,   // raw (unscoped) outputs carrying metric.occupancy_pct
}) {
  const FUNDED_HOURS_PER_YEAR = 1140;
  const startOfYear = (year - 1) * 12;
  const yearPeriods = [];
  for (let p = startOfYear; p < startOfYear + 12; p++) yearPeriods.push(p);
  const setP = new Set(yearPeriods);

  const inScope = (r) => !entityIds || r.entity_id == null || entityIds.has(r.entity_id);
  const inScopeEntities = entities.filter(e => !entityIds || entityIds.has(e.id));

  // Capacity (sum across in-scope entities open at any point in the year)
  const capacity = Object.fromEntries(AGE_BANDS.map(b => [b, 0]));
  for (const e of inScopeEntities) {
    const opn = e.config?.opening_month_offset ?? 0;
    if (opn >= startOfYear + 12) continue;
    const cap = e.config?.capacity_by_age_band || {};
    for (const b of AGE_BANDS) capacity[b] += Number(cap[b] || 0);
  }

  // Average occupancy% across the year — engine-emitted occupancy
  // (metric.occupancy_pct) so the cascade shows the same numbers the
  // revenue was computed from; shared-curve fallback for stale outputs.
  const occIdx = buildOccupancyIndex(occupancySource || outputs);
  const avgOcc = {};
  for (const band of AGE_BANDS) {
    let sum = 0, n = 0;
    for (const t of yearPeriods) {
      let occThisT = 0, weight = 0;
      for (const e of inScopeEntities) {
        const cap = e.config?.capacity_by_age_band?.[band] || 0;
        if (cap === 0) continue;
        let occ = occIdx.get(occKey(e.id, band, t));
        if (occ == null) {
          occ = occupancyOnCurve(
            curveForBand(e, band, {
              opening: openingPct?.[band] ?? undefined,
              target:  targetPct?.[band] ?? undefined,
              phase:   phaseMonths?.[band] ?? undefined,
            }),
            e.config?.opening_month_offset ?? 0,
            t,
          );
        }
        occThisT += cap * occ;
        weight += cap;
      }
      if (weight > 0) { sum += occThisT / weight; n += 1; }
    }
    avgOcc[band] = n > 0 ? sum / n : 0;
  }

  // Engine revenue rows for tie-out
  const rev = {};
  for (const b of AGE_BANDS) rev[b] = { private: 0, funded: 0 };
  for (const r of outputs) {
    if (r.nominal_type !== 'revenue') continue;
    if (!setP.has(r.period)) continue;
    if (!inScope(r)) continue;
    const band = r.tags?.age_band;
    if (!band || !rev[band]) continue;
    if (r.tags?.revenue_kind === 'funded') rev[band].funded += r.amount_p;
    else rev[band].private += r.amount_p;
  }

  return AGE_BANDS.map(band => {
    const cap = capacity[band] || 0;
    const occ = (avgOcc[band] || 0) / 100;
    const child = cap * occ;
    const hpw = hoursPerWeek?.[band] || 0;
    const wRate = weeklyRate?.[band] || 0;
    const lRate = laRate?.[band] || 0;
    const elig = (eligiblePct?.[band] ?? 0) / 100;
    const take = (takeupPct?.[band] ?? 0) / 100;
    const wpy = weeksPerYear || 51;

    const fundedKids = child * elig * take;
    const nonFundedKids = child - fundedKids;
    const laPerChildWeek = wpy > 0 ? Math.min(hpw, FUNDED_HOURS_PER_YEAR / wpy) : 0;
    const fundedChildPrivateHoursWeek = Math.max(0, hpw - laPerChildWeek);

    const annualMax = cap * hpw * wpy;
    const annualLA  = fundedKids * laPerChildWeek * wpy;
    const annualPrivate = (nonFundedKids * hpw + fundedKids * fundedChildPrivateHoursWeek) * wpy;
    const annualTotal = annualLA + annualPrivate;

    const hourlyPrivate = hpw > 0 ? wRate / hpw : 0;
    const revenueLA = Math.round(annualLA * lRate);
    const revenuePrivate = Math.round(annualPrivate * hourlyPrivate);
    const revenueTotal = revenueLA + revenuePrivate;

    return {
      band, label: AGE_BAND_LABELS[band],
      capacity: cap, avgOccPct: avgOcc[band] || 0, children: child,
      hpw, weeklyRateP: wRate, hourlyPrivateP: hourlyPrivate, laRateP: lRate,
      eligPct: elig * 100, takePct: take * 100,
      annualMax, annualLA, annualPrivate, annualTotal,
      revenueLA, revenuePrivate, revenueTotal,
      // Engine tie-out
      engineRevPrivate: rev[band].private, engineRevFunded: rev[band].funded,
    };
  });
}

// Format pence as £ for spreadsheets / PDFs.
export function pToGbp(p) { return p == null ? 0 : p / 100; }
