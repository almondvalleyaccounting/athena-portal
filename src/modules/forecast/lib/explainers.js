// explainers.js — calculation traces for line items in drill-down.
//
// Each explainer is a pure function that, given the same inputs the
// engine had at compute time, reproduces the math step-by-step. The
// drill view renders these so a CFO can prove a number on click.
//
// Inputs:
//   moduleKey   — fc_output.module_key
//   lineLabel   — fc_output.line_label
//   period      — single period to explain (drill drops to monthly)
//   entity      — fc_entity row with config
//   drivers     — fc_driver rows (entity-scoped + group-scope) for this module
//   values      — fc_driver_value rows for those drivers
//
// Returns:
//   { formula, steps: [{ label, expr, value }] } or null if unsupported.
//
// Step shape:
//   - label: human description
//   - expr: optional math expression with values plugged in
//   - value: display string (formatted with units)
//   - kind: 'input' | 'derived' | 'result' (for styling)

import { curveForBand, occupancyOnCurve, occKey } from './occupancy.js';
import { AGE_BAND_LABELS } from './modules/locations.js';

const AGE_BANDS = ['babies', 'twos', 'three_to_five', 'after_school'];
const DEFAULT_RATIOS = { babies: 3, twos: 5, three_to_five: 8, after_school: 10 };
const FUNDED_HOURS_PER_YEAR = 1140;
const FUNDED_BANDS = ['twos', 'three_to_five'];

// Output line labels carry the display band ("0-2"); config and driver
// keys use the band key ("babies"). Map back.
const LABEL_TO_KEY = Object.fromEntries(
  Object.entries(AGE_BAND_LABELS).map(([key, label]) => [label, key])
);
const bandKeyFromLabel = (label) => LABEL_TO_KEY[label] || label;

// ── Resolver helper ──────────────────────────────────────────────
//
// Replicates the engine's driver lookup against in-memory drivers/values.
// Falls back from entity-scope to group-scope.

function makeResolver(drivers, values, entityKey) {
  const valueOf = (driverId, period = -1) => {
    const v = values.find(v => v.driver_id === driverId && v.period === period);
    return v?.value;
  };
  const findDriver = (key, entity) => {
    // Prefer entity-scoped driver
    if (entity) {
      const m = drivers.find(d => d.driver_key === key && d.entity_id);
      if (m) return m;
    }
    return drivers.find(d => d.driver_key === key && !d.entity_id) || null;
  };
  return (key, opts = {}) => {
    const period = opts.period ?? -1;
    const d = findDriver(key, opts.entity ?? entityKey);
    if (!d) return 0;
    if (d.kind === 'scalar') return Number(valueOf(d.id, -1) ?? 0);
    if (d.kind === 'timeseries') return Number(valueOf(d.id, period) ?? 0);
    return 0;
  };
}

// ── Occupancy ramp (shared engine curve — lib/occupancy.js) ──────
//
// Reproduces the engine's base curve: acquired sites use entity config,
// greenfield uses the group per-band drivers (resolved via `r`). The
// engine additionally applies August cohort dips, so a trace at/after
// an August may sit slightly above the persisted number.

function occupancyAt(entity, band, period, r) {
  const num = (v) => (v == null || v === 0 ? undefined : Number(v));
  const groupCurve = {
    opening: num(r(`capacity.opening_pct.${band}`)),
    target:  num(r(`capacity.target_pct.${band}`)),
    phase:   num(r(`capacity.phase_up_months.${band}`)),
  };
  const opening = entity?.config?.opening_month_offset ?? 0;
  return occupancyOnCurve(curveForBand(entity, band, groupCurve), opening, period);
}

// ── Formatters ───────────────────────────────────────────────────

const fmtGBP = (n) => '£' + Math.round(n / 100).toLocaleString('en-GB');
const fmtGBP2 = (n) => '£' + (n / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (n, dp = 1) => Number(n).toFixed(dp) + '%';
const fmtNum = (n, dp = 2) => Number(n).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtInt = (n) => Math.round(n).toLocaleString('en-GB');

// ── Module explainers ────────────────────────────────────────────

const explainers = {
  services_childcare: explainServicesChildcare,
  staff: explainStaff,
  premises: explainPremises,
  overheads: explainOverheads,
  pre_opening: explainPreOpening,
  tax_simple: explainTaxSimple,
};

export function trace({ moduleKey, lineLabel, period, entity, drivers, values, occupancyIndex }) {
  const fn = explainers[moduleKey];
  if (!fn) return null;
  try {
    return fn({ lineLabel, period, entity, drivers, values, occupancyIndex });
  } catch (e) {
    return { formula: 'Could not trace this figure', steps: [{ label: e.message, kind: 'result' }] };
  }
}

// Is a driver actually set (not just defaulted)? Mirrors drivers.js
// driverIsSet, so the trace falls back to the same defaults as the engine.
function isSet(drivers, values, key) {
  const d = drivers.find((x) => x.driver_key === key && x.entity_id) || drivers.find((x) => x.driver_key === key && !x.entity_id);
  return !!d && values.some((v) => v.driver_id === d.id && v.value != null && v.value !== '' && Number.isFinite(Number(v.value)));
}

// A room's standard weekly hours by age band — same as services_childcare.js.
function defaultHoursPerWeek(band) {
  return band === 'after_school' ? 15 : 50;
}

// ── Services childcare ──────────────────────────────────────────

function explainServicesChildcare({ lineLabel, period, entity, drivers, values, occupancyIndex }) {
  const r = makeResolver(drivers, values, entity?.key);

  // Match "Private fees — {band}" or "Funded hours — {band}"
  const m = lineLabel.match(/^(Private fees|Funded hours) — (.+)$/);
  if (!m) return null;
  const kind = m[1];   // 'Private fees' | 'Funded hours'
  const band = bandKeyFromLabel(m[2]);   // display label → band key

  const cfg = entity?.config || {};
  const capacity = cfg.capacity_by_age_band?.[band] ?? 0;
  // Prefer the occupancy the engine persisted (it includes the August
  // cohort dips the raw curve doesn't); the curve is only a fallback.
  const savedOcc = entity?.id != null ? occupancyIndex?.get(occKey(entity.id, band, period)) : undefined;
  const occPct = savedOcc ?? occupancyAt(entity, band, period, r);
  const children = capacity * occPct / 100;
  const eligiblePct = r(`eligible_for_funded_pct.${band}`);
  const takeupPct = r(`funded_hours_take_up_pct.${band}`);
  const fundedChildren = children * (eligiblePct / 100) * (takeupPct / 100);
  const privateChildren = children - fundedChildren;
  const weeklyRateP = r(`weekly_rate_p.${band}`);
  const weeks = r('weeks_per_year') || 51;
  const monthlyWeeks = weeks / 12;
  const laRateP = r(`la_funded_rate_p.${band}`);
  // Same rules as the engine (modules/services_childcare.js) so the steps add
  // up to the figure that was clicked: fees work in HOURS. A room's weekly
  // hours default by age band when not set (0 means the band isn't offered).
  const hpw = isSet(drivers, values, `operating_hours_per_week.${band}`)
    ? r(`operating_hours_per_week.${band}`)
    : defaultHoursPerWeek(band);
  const fundedOnlyPct = r(`funded_only_pct.${band}`);
  const hourlyRateP = hpw > 0 ? weeklyRateP / hpw : 0;
  const fundedHoursPerWeek = Math.min(hpw, FUNDED_HOURS_PER_YEAR / weeks);
  const fundedOnly = fundedChildren * (fundedOnlyPct / 100);
  const blended = fundedChildren - fundedOnly;
  const privateHoursPerFundedChild = Math.max(0, hpw - fundedHoursPerWeek);

  const steps = [
    { label: 'Places at this location', value: `${capacity} children`, kind: 'input' },
    { label: savedOcc != null ? 'Occupancy this month' : 'Occupancy this month (from the ramp-up curve)', value: fmtPct(occPct), kind: 'derived' },
    { label: 'Children attending', expr: `${capacity} × ${fmtPct(occPct)}`, value: fmtNum(children) + ' children', kind: 'derived' },
    { label: 'Eligible for funded hours', value: fmtPct(eligiblePct, 0), kind: 'input' },
    { label: 'Funded hours take-up', value: fmtPct(takeupPct, 0), kind: 'input' },
    { label: 'Funded children', expr: `${fmtNum(children)} × ${fmtPct(eligiblePct, 0)} × ${fmtPct(takeupPct, 0)}`, value: fmtNum(fundedChildren), kind: 'derived' },
    { label: 'Private children', expr: `${fmtNum(children)} − ${fmtNum(fundedChildren)}`, value: fmtNum(privateChildren), kind: 'derived' },
    { label: 'Funded-only families (use funded hours and nothing more)', expr: `${fmtNum(fundedChildren)} × ${fmtPct(fundedOnlyPct, 0)}`, value: fmtNum(fundedOnly), kind: 'derived' },
    { label: 'Funded children who also pay for extra hours', expr: `${fmtNum(fundedChildren)} − ${fmtNum(fundedOnly)}`, value: fmtNum(blended), kind: 'derived' },
    { label: 'Hours the room is open a week', value: `${fmtNum(hpw, 1)} hours`, kind: 'input' },
    { label: 'Funded hours per child a week (1140 a year ÷ weeks open)', expr: `min(${fmtNum(hpw, 1)}, 1140 ÷ ${weeks})`, value: `${fmtNum(fundedHoursPerWeek)} hours`, kind: 'derived' },
    { label: 'Weeks open a year', value: `${weeks} weeks`, kind: 'input' },
    { label: 'Weeks per month', expr: `${weeks} / 12`, value: fmtNum(monthlyWeeks) + ' weeks', kind: 'derived' },
  ];

  if (kind === 'Private fees') {
    const privateHours = privateChildren * hpw * monthlyWeeks
      + blended * privateHoursPerFundedChild * monthlyWeeks;
    const revenueP = privateHours * hourlyRateP;
    steps.push(
      { label: 'Weekly rate', value: fmtGBP(weeklyRateP), kind: 'input' },
      { label: 'Hourly fee (weekly rate ÷ hours open)', expr: `${fmtGBP(weeklyRateP)} ÷ ${fmtNum(hpw, 1)}`, value: fmtGBP2(hourlyRateP), kind: 'derived' },
      { label: 'Paid hours a week for a funded child', expr: `${fmtNum(hpw, 1)} − ${fmtNum(fundedHoursPerWeek)}`, value: `${fmtNum(privateHoursPerFundedChild)} hours`, kind: 'derived' },
      { label: 'Paid hours this month', expr: `(${fmtNum(privateChildren)} × ${fmtNum(hpw, 1)} + ${fmtNum(blended)} × ${fmtNum(privateHoursPerFundedChild)}) × ${fmtNum(monthlyWeeks)} weeks`, value: `${fmtInt(privateHours)} hours`, kind: 'derived' },
      { label: 'Private fee income', expr: `${fmtInt(privateHours)} hours × ${fmtGBP2(hourlyRateP)}`, value: fmtGBP(revenueP), kind: 'result' },
    );
    return { formula: 'Paid hours this month × hourly fee', steps };
  }

  if (kind === 'Funded hours') {
    const fundedHours = fundedOnly * hpw * monthlyWeeks
      + blended * fundedHoursPerWeek * monthlyWeeks;
    const revenueP = fundedHours * laRateP;
    steps.push(
      { label: 'Funded hours this month', expr: `(${fmtNum(fundedOnly)} × ${fmtNum(hpw, 1)} + ${fmtNum(blended)} × ${fmtNum(fundedHoursPerWeek)}) × ${fmtNum(monthlyWeeks)} weeks`, value: `${fmtInt(fundedHours)} hours`, kind: 'derived' },
      { label: 'Council rate per funded hour', value: fmtGBP2(laRateP), kind: 'input' },
      { label: 'Funded hours income', expr: `${fmtInt(fundedHours)} hours × ${fmtGBP2(laRateP)}`, value: fmtGBP(revenueP), kind: 'result' },
    );
    return { formula: 'Funded hours this month × council hourly rate', steps };
  }

  return null;
}

// ── Staff ───────────────────────────────────────────────────────

function explainStaff({ lineLabel, period, entity, drivers, values }) {
  const r = makeResolver(drivers, values, entity?.key);
  const cfg = entity?.config || {};
  const ratioFor = (band) => r(`ratio.${band}`) || DEFAULT_RATIOS[band] || 8;

  // On-cost factor (shared by all role explanations)
  const niPct = r('employer_ni_pct') / 100;
  const penPct = r('employer_pension_pct') / 100;
  const vacPct = r('vacancy_rate_pct') / 100;
  const agencyPct = r('agency_premium_pct') / 100;
  const loadFactor = (1 + niPct + penPct) * (1 + vacPct * agencyPct);

  // Match new per-role + per-band lines: "Senior qualified — 0-2 (4)"
  const directBandMatch = lineLabel.match(/^(Senior qualified|Qualified|Apprentice) — (.+?) \((\d+)\)$/);
  if (directBandMatch) {
    const roleLabel = directBandMatch[1];
    const band = bandKeyFromLabel(directBandMatch[2]);
    const headcount = Number(directBandMatch[3]);
    const cap = cfg.capacity_by_age_band?.[band] ?? 0;
    const occ = occupancyAt(entity, band, period, r);
    const children = cap * occ / 100;
    const ratio = ratioFor(band);
    const required = children > 0 ? Math.ceil(children / ratio) : 0;
    const seniorPct = r('direct_mix.senior_pct') / 100;
    const qualPct   = r('direct_mix.qualified_pct') / 100;
    const apprPct   = r('direct_mix.apprentice_pct') / 100;

    const salaryKey = roleLabel === 'Senior qualified' ? 'base_salary_p.senior_qualified'
      : roleLabel === 'Qualified' ? 'base_salary_p.qualified' : 'base_salary_p.apprentice';
    const salary = r(salaryKey);
    const monthlyCost = (salary / 12) * loadFactor;

    return { formula: 'Staff needed = children ÷ ratio, rounded up, split by staff mix. Cost = headcount × monthly cost per head', steps: [
      { label: 'Places at this location', value: `${cap} children`, kind: 'input' },
      { label: 'Occupancy this month', value: fmtPct(occ), kind: 'derived' },
      { label: 'Children attending', expr: `${cap} × ${fmtPct(occ)}`, value: fmtNum(children) + ' children', kind: 'derived' },
      { label: `Statutory ratio (${AGE_BAND_LABELS[band] ?? band})`, value: `1 : ${ratio}`, kind: 'input' },
      { label: 'Practitioners needed for this age group', expr: `ceil(${fmtNum(children)} / ${ratio})`, value: `${required}`, kind: 'derived' },
      { label: 'Room staff mix', value: `Senior ${fmtPct(seniorPct * 100, 0)} · Qualified ${fmtPct(qualPct * 100, 0)} · Apprentice ${fmtPct(apprPct * 100, 0)}`, kind: 'note' },
      { label: `Of which ${roleLabel.toLowerCase()}`, value: `${headcount} staff`, kind: 'derived' },
      { label: 'Annual salary', value: fmtGBP(salary), kind: 'input' },
      { label: 'On-cost factor', expr: `(1 + NI + pension) × (1 + vac × agency)`, value: fmtNum(loadFactor, 4) + '×', kind: 'derived' },
      { label: 'Monthly cost per head', expr: `${fmtGBP(salary)} / 12 × ${fmtNum(loadFactor, 4)}`, value: fmtGBP(monthlyCost), kind: 'derived' },
      { label: `${roleLabel} cost for this age group`, expr: `${headcount} × ${fmtGBP(monthlyCost)}`, value: fmtGBP(headcount * monthlyCost), kind: 'result' },
    ]};
  }

  // Indirect / management roles: "Executives (1)", "Setting managers (1)" etc.
  const flatRoleMatch = lineLabel.match(/^(Executives|Senior managers|Setting managers|Assistant managers|Admin) \((\d+)\)$/);
  if (flatRoleMatch) {
    const lbl = flatRoleMatch[1];
    const hc = Number(flatRoleMatch[2]);
    const salaryKey = {
      'Executives':         'base_salary_p.executive',
      'Senior managers':    'base_salary_p.senior_manager',
      'Setting managers':   'base_salary_p.setting_manager',
      'Assistant managers': 'base_salary_p.assistant_manager',
      'Admin':              'base_salary_p.admin',
    }[lbl];
    const salary = r(salaryKey);
    const monthlyCost = (salary / 12) * loadFactor;
    return { formula: 'Headcount × monthly cost per head', steps: [
      { label: 'Headcount', value: `${hc}`, kind: 'input' },
      { label: 'Annual salary', value: fmtGBP(salary), kind: 'input' },
      { label: 'On-cost factor', value: fmtNum(loadFactor, 4) + '×', kind: 'derived' },
      { label: 'Monthly cost per head', expr: `${fmtGBP(salary)} / 12 × ${fmtNum(loadFactor, 4)}`, value: fmtGBP(monthlyCost), kind: 'derived' },
      { label: `${lbl} monthly cost`, expr: `${hc} × ${fmtGBP(monthlyCost)}`, value: fmtGBP(hc * monthlyCost), kind: 'result' },
    ]};
  }

  // Legacy lines (pre-refactor — kept working in case any old data shows up)
  const bandMatch = lineLabel.match(/^Practitioners — (.+)$/);
  if (!bandMatch && lineLabel !== 'Practitioners' && lineLabel !== 'Managers') return null;

  // Per-band practitioners required, derived from occupancy
  const bandRows = [];
  let totalPract = 0;
  for (const band of AGE_BANDS) {
    const cap = cfg.capacity_by_age_band?.[band] ?? 0;
    if (cap === 0) continue;
    const occ = occupancyAt(entity, band, period, r);
    const children = cap * occ / 100;
    const ratio = ratioFor(band);
    const required = children > 0 ? Math.ceil(children / ratio) : 0;
    if (required > 0) {
      bandRows.push({ band, cap, occ, children, ratio, required });
      totalPract += required;
    }
  }

  // Legacy "practitioner" / "manager" salary keys — fallback for old data
  const managerPerN = r('manager_per_n_practitioners') || 12;
  const salaryPract = r('base_salary_p.practitioner');
  const salaryManager = r('base_salary_p.manager');
  const monthlyPractCost = (salaryPract / 12) * loadFactor;
  const monthlyManagerCost = (salaryManager / 12) * loadFactor;

  if (bandMatch) {
    // Per-band practitioner cost
    const band = bandKeyFromLabel(bandMatch[1]);
    const cap = cfg.capacity_by_age_band?.[band] ?? 0;
    const occ = occupancyAt(entity, band, period, r);
    const children = cap * occ / 100;
    const ratio = ratioFor(band);
    const required = children > 0 ? Math.ceil(children / ratio) : 0;
    return { formula: 'Practitioners needed (children ÷ ratio, rounded up) × monthly cost each', steps: [
      { label: 'Places at this location', value: `${cap} children`, kind: 'input' },
      { label: 'Occupancy this month', value: fmtPct(occ), kind: 'derived' },
      { label: 'Children attending', expr: `${cap} × ${fmtPct(occ)}`, value: fmtNum(children) + ' children', kind: 'derived' },
      { label: `Statutory ratio (${AGE_BAND_LABELS[band] ?? band})`, value: `1 : ${ratio}`, kind: 'input' },
      { label: 'Practitioners needed', expr: `ceil(${fmtNum(children)} / ${ratio})`, value: `${required}`, kind: 'derived' },
      { label: 'Annual practitioner salary', value: fmtGBP(salaryPract), kind: 'input' },
      { label: 'On-cost factor', expr: `(1 + NI + pension) × (1 + vac × agency)`, value: fmtNum(loadFactor, 4) + '×', kind: 'derived' },
      { label: 'Monthly cost per practitioner', expr: `${fmtGBP(salaryPract)} / 12 × ${fmtNum(loadFactor, 4)}`, value: fmtGBP(monthlyPractCost), kind: 'derived' },
      { label: `Practitioner cost for ${AGE_BAND_LABELS[band] ?? band}`, expr: `${required} × ${fmtGBP(monthlyPractCost)}`, value: fmtGBP(required * monthlyPractCost), kind: 'result' },
    ]};
  }

  if (lineLabel === 'Practitioners') {
    // Legacy line (pre-refactor); keep working in case any old data exists.
    const steps = [];
    for (const b of bandRows) {
      steps.push({
        label: `${AGE_BAND_LABELS[b.band] ?? b.band}: ${b.cap} places × ${fmtPct(b.occ)} occupancy = ${fmtNum(b.children)} children, ratio 1:${b.ratio}`,
        expr: `ceil(${fmtNum(b.children)} / ${b.ratio})`,
        value: `${b.required} practitioner${b.required !== 1 ? 's' : ''}`,
        kind: 'derived',
      });
    }
    steps.push(
      { label: 'Total practitioners', value: `${totalPract}`, kind: 'derived' },
      { label: 'Annual practitioner salary', value: fmtGBP(salaryPract), kind: 'input' },
      { label: 'On-cost factor', value: fmtNum(loadFactor, 4) + '×', kind: 'derived' },
      { label: 'Monthly cost per practitioner', value: fmtGBP(monthlyPractCost), kind: 'derived' },
      { label: 'Practitioner monthly cost', expr: `${totalPract} × ${fmtGBP(monthlyPractCost)}`, value: fmtGBP(totalPract * monthlyPractCost), kind: 'result' },
    );
    return { formula: 'Practitioners needed (children ÷ ratio, rounded up) × monthly cost each', steps };
  }

  // Managers
  const managers = totalPract > 0 ? Math.max(1, Math.ceil(totalPract / managerPerN)) : 0;
  const steps = [
    { label: 'Total practitioners', value: `${totalPract}`, kind: 'derived' },
    { label: 'Practitioners per manager', value: `${managerPerN}`, kind: 'input' },
    { label: 'Managers needed', expr: `max(1, ceil(${totalPract} / ${managerPerN}))`, value: `${managers}`, kind: 'derived' },
    { label: 'Annual manager salary', value: fmtGBP(salaryManager), kind: 'input' },
    { label: 'On-cost factor', value: fmtNum(loadFactor, 4) + '×', kind: 'derived' },
    { label: 'Monthly cost per manager', expr: `${fmtGBP(salaryManager)} / 12 × ${fmtNum(loadFactor, 4)}`, value: fmtGBP(monthlyManagerCost), kind: 'derived' },
    { label: 'Manager monthly cost', expr: `${managers} × ${fmtGBP(monthlyManagerCost)}`, value: fmtGBP(managers * monthlyManagerCost), kind: 'result' },
  ];
  return { formula: 'Practitioners ÷ practitioners per manager, rounded up (at least 1) × monthly cost per manager', steps };
}

// ── Premises ────────────────────────────────────────────────────

function explainPremises({ lineLabel, period, entity, drivers, values }) {
  const r = makeResolver(drivers, values, entity?.key);
  const cfg = entity?.config || {};
  const opening = cfg.opening_month_offset ?? 0;
  const mode = cfg.lease_or_buy || 'lease';

  if (mode === 'lease') {
    const stages = cfg.premises_concession_stages || [];
    const tIn = period - opening;
    const factor = concessionFactorAt(tIn, stages);
    const stageRows = stages.length > 0 ? buildConcessionStageRows(stages, tIn) : null;

    if (lineLabel === 'Rent') {
      const v = r('premises.rent_monthly_p');
      const eff = v * factor;
      const steps = [
        { label: 'Full monthly rent', value: fmtGBP(v), kind: 'input' },
        { label: 'Months since opening', value: tIn < 0 ? '—' : `${tIn}`, kind: 'derived' },
      ];
      if (stageRows) {
        steps.push({ label: 'Concession schedule', kind: 'note' });
        for (const sr of stageRows) steps.push(sr);
      }
      steps.push(
        { label: 'Share payable this month', value: `× ${(factor * 100).toFixed(0)}%`, kind: 'derived' },
        { label: 'Rent this month', expr: `${fmtGBP(v)} × ${(factor * 100).toFixed(0)}%`, value: fmtGBP(eff), kind: 'result' },
      );
      return { formula: 'Full monthly rent × share payable (set by months since opening)', steps };
    }
    if (lineLabel === 'Service charge') {
      const v = r('premises.service_charge_monthly_p');
      const eff = v * factor;
      const steps = [
        { label: 'Full monthly service charge', value: fmtGBP(v), kind: 'input' },
        { label: 'Share payable this month', value: `× ${(factor * 100).toFixed(0)}%`, kind: 'derived' },
        { label: 'Service charge this month', expr: `${fmtGBP(v)} × ${(factor * 100).toFixed(0)}%`, value: fmtGBP(eff), kind: 'result' },
      ];
      return { formula: 'Full monthly service charge × share payable', steps };
    }
    return null;
  }

  // BUY mode: walk amortisation forward to this period
  const price = r('premises.purchase_price_p');
  const depositPct = r('premises.deposit_pct') / 100;
  const termYears = r('premises.mortgage_term_years');
  const ratePct = r('premises.mortgage_interest_pct') / 100;
  const fitOut = r('premises.fit_out_capex_p');
  const depYears = r('premises.depreciation_years') || 25;
  const maintAnnual = r('premises.maintenance_annual_p');
  const rv = r('premises.ndr_rateable_value_p');
  const poundage = r('premises.ndr_poundage') / 100;
  const ndrRelief = r('premises.ndr_relief_pct') / 100;
  const legalFees = r('premises.legal_fees_p');

  const lbtt = computeLBTT(price);
  const loan = price - price * depositPct;
  const monthlyRate = ratePct / 12;
  const nMonths = termYears * 12;
  const payment = monthlyRate === 0 ? loan / nMonths
    : (loan * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -nMonths));

  // Walk forward
  const acqMonth = Math.max(0, opening - 1);
  let outstanding = 0;
  let lastInterest = 0, lastPrincipal = 0;
  for (let t = 0; t <= period; t++) {
    if (t < acqMonth) continue;
    if (t === acqMonth) outstanding = loan;
    else {
      const interest = outstanding * monthlyRate;
      const principal = Math.min(payment - interest, outstanding);
      outstanding = Math.max(0, outstanding - principal);
      lastInterest = interest;
      lastPrincipal = principal;
    }
  }

  const setup = [
    { label: 'Purchase price', value: fmtGBP(price), kind: 'input' },
    { label: 'Deposit %', value: fmtPct(depositPct * 100, 0), kind: 'input' },
    { label: 'Loan (price less deposit)', expr: `${fmtGBP(price)} × ${fmtPct((1 - depositPct) * 100, 0)}`, value: fmtGBP(loan), kind: 'derived' },
    { label: 'Annual mortgage rate', value: fmtPct(ratePct * 100, 2), kind: 'input' },
    { label: 'Monthly rate', expr: `${fmtPct(ratePct * 100, 2)} / 12`, value: fmtPct(monthlyRate * 100, 4), kind: 'derived' },
    { label: 'Term (months)', expr: `${termYears} × 12`, value: `${nMonths}`, kind: 'derived' },
    { label: 'Monthly payment', expr: `loan × r / (1 − (1+r)^−n)`, value: fmtGBP(payment), kind: 'derived' },
  ];

  if (lineLabel === 'Mortgage interest') {
    return { formula: 'Balance at the end of last month × monthly rate', steps: [
      ...setup,
      { label: `Balance at month ${period - 1}`, value: fmtGBP(outstanding + lastPrincipal), kind: 'derived' },
      { label: `Interest in month ${period}`, expr: `${fmtGBP(outstanding + lastPrincipal)} × ${fmtPct(monthlyRate * 100, 4)}`, value: fmtGBP(lastInterest), kind: 'result' },
    ]};
  }
  if (lineLabel === 'Mortgage principal') {
    return { formula: 'Monthly payment − interest this month', steps: [
      ...setup,
      { label: `Interest in month ${period}`, value: fmtGBP(lastInterest), kind: 'derived' },
      { label: `Capital repaid in month ${period}`, expr: `${fmtGBP(payment)} − ${fmtGBP(lastInterest)}`, value: fmtGBP(lastPrincipal), kind: 'result' },
    ]};
  }
  if (lineLabel === 'Mortgage outstanding') {
    return { formula: 'Starting loan − capital repaid to date', steps: [
      ...setup,
      { label: `Balance at month ${period}`, value: fmtGBP(outstanding), kind: 'result' },
    ]};
  }
  if (lineLabel === 'Property + fit-out') {
    if (period >= opening) {
      const monthlyDep = (price + fitOut) / (depYears * 12);
      return { formula: '(Purchase price + fit-out) ÷ (depreciation years × 12)', steps: [
        { label: 'Purchase price', value: fmtGBP(price), kind: 'input' },
        { label: 'Fit-out capex', value: fmtGBP(fitOut), kind: 'input' },
        { label: 'Cost to depreciate', expr: `${fmtGBP(price)} + ${fmtGBP(fitOut)}`, value: fmtGBP(price + fitOut), kind: 'derived' },
        { label: 'Depreciation period', value: `${depYears} years`, kind: 'input' },
        { label: 'Monthly depreciation', expr: `${fmtGBP(price + fitOut)} / (${depYears} × 12)`, value: fmtGBP(monthlyDep), kind: 'result' },
      ]};
    }
  }
  if (lineLabel === 'NDR') {
    const ndrAnnual = rv * poundage * (1 - ndrRelief);
    const ndrMonthly = ndrAnnual / 12;
    return { formula: 'Rateable value × poundage × (1 − relief) ÷ 12', steps: [
      { label: 'Rateable value', value: fmtGBP(rv), kind: 'input' },
      { label: 'Poundage', value: fmtPct(poundage * 100, 3), kind: 'input' },
      { label: 'Relief %', value: fmtPct(ndrRelief * 100, 1), kind: 'input' },
      { label: 'NDR a year', expr: `${fmtGBP(rv)} × ${fmtPct(poundage * 100, 3)} × (1 − ${fmtPct(ndrRelief * 100, 1)})`, value: fmtGBP(ndrAnnual), kind: 'derived' },
      { label: 'NDR a month', expr: `${fmtGBP(ndrAnnual)} / 12`, value: fmtGBP(ndrMonthly), kind: 'result' },
    ]};
  }
  if (lineLabel === 'Maintenance') {
    return { formula: 'Annual maintenance ÷ 12', steps: [
      { label: 'Annual maintenance', value: fmtGBP(maintAnnual), kind: 'input' },
      { label: 'Maintenance a month', expr: `${fmtGBP(maintAnnual)} / 12`, value: fmtGBP(maintAnnual / 12), kind: 'result' },
    ]};
  }
  if (lineLabel === 'Acquisition + fit-out') {
    return { formula: 'Purchase price + LBTT + legal fees + fit-out, all in the month of purchase', steps: [
      { label: 'Purchase price', value: fmtGBP(price), kind: 'input' },
      { label: 'LBTT (non-residential bands)', value: fmtGBP(lbtt), kind: 'derived' },
      { label: 'Legal and purchase fees', value: fmtGBP(legalFees), kind: 'input' },
      { label: 'Fit-out cost', value: fmtGBP(fitOut), kind: 'input' },
      { label: 'Total cost at purchase', value: fmtGBP(price + lbtt + legalFees + fitOut), kind: 'result' },
      { label: `Charged once in month ${acqMonth}, the month before opening`, kind: 'note' },
    ]};
  }
  return null;
}

function concessionFactorAt(tIn, stages) {
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

function buildConcessionStageRows(stages, currentTIn) {
  const rows = [];
  let cursor = 0;
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    const months = Number(s.months) || 0;
    const factor = Math.max(0, Math.min(1, Number(s.factor) || 0));
    const from = cursor;
    const to = cursor + months - 1;
    const active = currentTIn >= from && currentTIn <= to;
    rows.push({
      label: `  Stage ${i + 1}: months ${from}–${to}${active ? ' ← here' : ''}`,
      value: `× ${(factor * 100).toFixed(0)}%`,
      kind: active ? 'derived' : 'note',
    });
    cursor += months;
  }
  rows.push({
    label: `  Stage ${stages.length + 1}: month ${cursor}+${currentTIn >= cursor ? ' ← here' : ''}`,
    value: '× 100% (full)',
    kind: currentTIn >= cursor ? 'derived' : 'note',
  });
  return rows;
}

function computeLBTT(price) {
  const bands = [[15000000, 0], [25000000, 0.01], [Infinity, 0.05]];
  let lbtt = 0, prev = 0;
  for (const [cap, rate] of bands) {
    const slice = Math.max(0, Math.min(price, cap) - prev);
    lbtt += slice * rate;
    prev = cap;
    if (price <= cap) break;
  }
  return Math.round(lbtt);
}

// ── Overheads ───────────────────────────────────────────────────

function explainOverheads({ lineLabel, period, entity, drivers, values }) {
  // Find a driver whose label matches the line label
  const d = drivers.find(d => d.label === lineLabel);
  if (!d) return null;
  const v = values.find(x => x.driver_id === d.id && x.period === -1);
  return { formula: 'Monthly amount, charged each month once open', steps: [
    { label: lineLabel + ' (assumption)', value: d.unit === 'gbp_p' ? fmtGBP(Number(v?.value ?? 0)) : String(v?.value ?? 0), kind: 'result' },
    { label: d.entity_id ? 'This location only — starts when it opens' : 'Whole group — charged every month', kind: 'note' },
  ]};
}

// ── Pre-opening ─────────────────────────────────────────────────

function explainPreOpening({ lineLabel, period, entity, drivers, values }) {
  const r = makeResolver(drivers, values, entity?.key);
  const cfg = entity?.config || {};
  const opening = cfg.opening_month_offset ?? 0;
  if (lineLabel === 'Pre-opening overhead') {
    const v = r('pre_open.monthly_overhead_p');
    const lead = r('pre_open.registration_lead_months');
    const start = Math.max(0, opening - lead);
    return { formula: 'Monthly overhead from (opening − registration lead time) to the month before opening', steps: [
      { label: 'Opening month', value: `Month ${opening}`, kind: 'input' },
      { label: 'Registration lead time', value: `${lead} months`, kind: 'input' },
      { label: 'Pre-opening window', value: `Month ${start} to ${opening - 1}`, kind: 'derived' },
      { label: 'Monthly pre-opening overhead', value: fmtGBP(v), kind: 'result' },
    ]};
  }
  if (lineLabel === 'Pre-opening staffing') {
    const v = r('pre_open.staffing_monthly_p');
    const months = r('pre_open.staffing_months');
    return { formula: 'Monthly staffing cost, for the set number of months before opening', steps: [
      { label: 'Months of staffing before opening', value: `${months}`, kind: 'input' },
      { label: 'Monthly staffing cost', value: fmtGBP(v), kind: 'result' },
    ]};
  }
  if (lineLabel === 'Pre-opening marketing') {
    const v = r('pre_open.marketing_spike_p');
    return { formula: 'One-off marketing spend in the month before opening', steps: [
      { label: 'Launch marketing', value: fmtGBP(v), kind: 'result' },
      { label: `Charged once in month ${opening - 1}`, kind: 'note' },
    ]};
  }
  return null;
}

// ── Tax ─────────────────────────────────────────────────────────

function explainTaxSimple({ lineLabel, period, entity, drivers, values }) {
  if (lineLabel !== 'Corporation tax') return null;
  const r = makeResolver(drivers, values, null);
  const ctRate = r('tax.ct_rate_pct');
  return { formula: 'PBT × CT rate, nil if a loss. Paid 9 months later.', steps: [
    { label: 'CT rate (top marginal rate)', value: fmtPct(ctRate, 1), kind: 'input' },
    { label: 'Tax charged = PBT × CT rate, nil if PBT is a loss', kind: 'note' },
    { label: 'CT paid = tax charged 9 months earlier', kind: 'note' },
  ]};
}
