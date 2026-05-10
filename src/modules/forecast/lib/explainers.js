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

const AGE_BANDS = ['babies', 'twos', 'three_to_five', 'after_school'];
const DEFAULT_RATIOS = { babies: 3, twos: 5, three_to_five: 8, after_school: 10 };
const FUNDED_HOURS_PER_YEAR = 1140;
const FUNDED_BANDS = ['twos', 'three_to_five'];

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

// ── Occupancy ramp (mirrors locations.js logic) ──────────────────

function occupancyAt(entity, band, period) {
  const cfg = entity?.config || {};
  const opening = cfg.opening_month_offset ?? 0;
  const ramp = cfg.ramp_to_target_months ?? 18;
  const target = cfg.target_occupancy_pct ?? 85;
  const start = cfg.starting_occupancy_pct ??
    (cfg.acquisition_type === 'acquired_going_concern' ? 70 : 0);
  if (period < opening) return 0;
  const tIn = period - opening;
  if (tIn === 0) return start;
  if (tIn >= ramp) return target;
  const frac = tIn / ramp;
  const eased = 1 - Math.pow(1 - frac, 2);
  return Math.max(0, Math.min(100, start + (target - start) * eased));
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

export function trace({ moduleKey, lineLabel, period, entity, drivers, values }) {
  const fn = explainers[moduleKey];
  if (!fn) return null;
  try {
    return fn({ lineLabel, period, entity, drivers, values });
  } catch (e) {
    return { formula: 'Error tracing calculation', steps: [{ label: e.message, kind: 'result' }] };
  }
}

// ── Services childcare ──────────────────────────────────────────

function explainServicesChildcare({ lineLabel, period, entity, drivers, values }) {
  const r = makeResolver(drivers, values, entity?.key);

  // Match "Private fees — {band}" or "Funded hours — {band}"
  const m = lineLabel.match(/^(Private fees|Funded hours) — (.+)$/);
  if (!m) return null;
  const kind = m[1];   // 'Private fees' | 'Funded hours'
  const band = m[2];

  const cfg = entity?.config || {};
  const capacity = cfg.capacity_by_age_band?.[band] ?? 0;
  const occPct = occupancyAt(entity, band, period);
  const children = capacity * occPct / 100;
  const eligiblePct = r(`eligible_for_funded_pct.${band}`);
  const takeupPct = r(`funded_hours_take_up_pct.${band}`);
  const fundedChildren = children * (eligiblePct / 100) * (takeupPct / 100);
  const privateChildren = children - fundedChildren;
  const weeklyRateP = r(`weekly_rate_p.${band}`);
  const weeks = r('weeks_per_year') || 51;
  const monthlyWeeks = weeks / 12;
  const laRateP = r(`la_funded_rate_p.${band}`);

  const steps = [
    { label: 'Capacity (entity config)', value: `${capacity} children`, kind: 'input' },
    { label: 'Occupancy at this period (ramp curve)', value: fmtPct(occPct), kind: 'derived' },
    { label: 'Children attending', expr: `${capacity} × ${fmtPct(occPct)}`, value: fmtNum(children) + ' children', kind: 'derived' },
    { label: 'Eligible for funded hours', value: fmtPct(eligiblePct, 0), kind: 'input' },
    { label: 'Funded hours take-up', value: fmtPct(takeupPct, 0), kind: 'input' },
    { label: 'Funded children', expr: `${fmtNum(children)} × ${fmtPct(eligiblePct, 0)} × ${fmtPct(takeupPct, 0)}`, value: fmtNum(fundedChildren), kind: 'derived' },
    { label: 'Private children', expr: `${fmtNum(children)} − ${fmtNum(fundedChildren)}`, value: fmtNum(privateChildren), kind: 'derived' },
    { label: 'Operating weeks / year', value: `${weeks} weeks`, kind: 'input' },
    { label: 'Weeks per month', expr: `${weeks} / 12`, value: fmtNum(monthlyWeeks) + ' weeks', kind: 'derived' },
  ];

  if (kind === 'Private fees') {
    const billable = privateChildren + fundedChildren * 0.5;
    const revenueP = billable * weeklyRateP * monthlyWeeks;
    steps.push(
      { label: 'Weekly rate', value: fmtGBP(weeklyRateP), kind: 'input' },
      { label: 'Funded children also pay 50% private fee for non-funded hours', kind: 'note' },
      { label: 'Billable child-equivalents', expr: `${fmtNum(privateChildren)} + (${fmtNum(fundedChildren)} × 0.5)`, value: fmtNum(billable), kind: 'derived' },
      { label: 'Private fees revenue', expr: `${fmtNum(billable)} × ${fmtGBP(weeklyRateP)}/wk × ${fmtNum(monthlyWeeks)} weeks`, value: fmtGBP(revenueP), kind: 'result' },
    );
    return { formula: 'billable_child_equivalents × weekly_rate × monthly_weeks', steps };
  }

  if (kind === 'Funded hours') {
    const monthlyHours = FUNDED_HOURS_PER_YEAR / 12;
    const revenueP = fundedChildren * monthlyHours * laRateP;
    steps.push(
      { label: '1140-hour scheme — monthly hours per child', expr: `${FUNDED_HOURS_PER_YEAR} / 12`, value: fmtNum(monthlyHours) + ' hours', kind: 'derived' },
      { label: 'LA funded rate £/hr', value: fmtGBP2(laRateP), kind: 'input' },
      { label: 'Funded hours revenue', expr: `${fmtNum(fundedChildren)} × ${fmtNum(monthlyHours)} × ${fmtGBP2(laRateP)}`, value: fmtGBP(revenueP), kind: 'result' },
    );
    return { formula: 'funded_children × (1140/12) × la_funded_rate', steps };
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

  // Match new per-role + per-band lines: "Senior qualified — babies (4)"
  const directBandMatch = lineLabel.match(/^(Senior qualified|Qualified|Apprentice) — ([a-z_]+) \((\d+)\)$/);
  if (directBandMatch) {
    const roleLabel = directBandMatch[1];
    const band = directBandMatch[2];
    const headcount = Number(directBandMatch[3]);
    const cap = cfg.capacity_by_age_band?.[band] ?? 0;
    const occ = occupancyAt(entity, band, period);
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

    return { formula: 'required = ceil(children / ratio); split by mix %; cost = HC × monthly_loaded_salary', steps: [
      { label: 'Capacity (entity config)', value: `${cap} children`, kind: 'input' },
      { label: 'Occupancy at this period', value: fmtPct(occ), kind: 'derived' },
      { label: 'Children attending', expr: `${cap} × ${fmtPct(occ)}`, value: fmtNum(children) + ' children', kind: 'derived' },
      { label: `Statutory ratio (${band})`, value: `1 : ${ratio}`, kind: 'input' },
      { label: 'Required practitioners (band)', expr: `ceil(${fmtNum(children)} / ${ratio})`, value: `${required}`, kind: 'derived' },
      { label: 'Direct staff mix', value: `Senior ${fmtPct(seniorPct * 100, 0)} · Qualified ${fmtPct(qualPct * 100, 0)} · Apprentice ${fmtPct(apprPct * 100, 0)}`, kind: 'note' },
      { label: `Allocation to ${roleLabel.toLowerCase()}`, value: `${headcount} headcount`, kind: 'derived' },
      { label: 'Annual salary', value: fmtGBP(salary), kind: 'input' },
      { label: 'Loaded cost factor', expr: `(1 + NI + pension) × (1 + vac × agency)`, value: fmtNum(loadFactor, 4) + '×', kind: 'derived' },
      { label: 'Monthly cost per head', expr: `${fmtGBP(salary)} / 12 × ${fmtNum(loadFactor, 4)}`, value: fmtGBP(monthlyCost), kind: 'derived' },
      { label: `${roleLabel} cost (this band)`, expr: `${headcount} × ${fmtGBP(monthlyCost)}`, value: fmtGBP(headcount * monthlyCost), kind: 'result' },
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
    return { formula: 'headcount × monthly_loaded_salary', steps: [
      { label: 'Headcount', value: `${hc}`, kind: 'input' },
      { label: 'Annual salary', value: fmtGBP(salary), kind: 'input' },
      { label: 'Loaded cost factor', value: fmtNum(loadFactor, 4) + '×', kind: 'derived' },
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
    const occ = occupancyAt(entity, band, period);
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
    const band = bandMatch[1];
    const cap = cfg.capacity_by_age_band?.[band] ?? 0;
    const occ = occupancyAt(entity, band, period);
    const children = cap * occ / 100;
    const ratio = ratioFor(band);
    const required = children > 0 ? Math.ceil(children / ratio) : 0;
    return { formula: 'ceil(children / ratio) × monthly_loaded_salary', steps: [
      { label: 'Capacity (entity config)', value: `${cap} children`, kind: 'input' },
      { label: 'Occupancy at this period', value: fmtPct(occ), kind: 'derived' },
      { label: 'Children attending', expr: `${cap} × ${fmtPct(occ)}`, value: fmtNum(children) + ' children', kind: 'derived' },
      { label: `Statutory ratio (${band})`, value: `1 : ${ratio}`, kind: 'input' },
      { label: 'Required practitioners', expr: `ceil(${fmtNum(children)} / ${ratio})`, value: `${required}`, kind: 'derived' },
      { label: 'Annual practitioner salary', value: fmtGBP(salaryPract), kind: 'input' },
      { label: 'Loaded cost factor', expr: `(1 + NI + pension) × (1 + vac × agency)`, value: fmtNum(loadFactor, 4) + '×', kind: 'derived' },
      { label: 'Monthly cost per practitioner', expr: `${fmtGBP(salaryPract)} / 12 × ${fmtNum(loadFactor, 4)}`, value: fmtGBP(monthlyPractCost), kind: 'derived' },
      { label: `Practitioner cost for ${band}`, expr: `${required} × ${fmtGBP(monthlyPractCost)}`, value: fmtGBP(required * monthlyPractCost), kind: 'result' },
    ]};
  }

  if (lineLabel === 'Practitioners') {
    // Legacy line (pre-refactor); keep working in case any old data exists.
    const steps = [];
    for (const b of bandRows) {
      steps.push({
        label: `${b.band}: ${b.cap} cap × ${fmtPct(b.occ)} occ = ${fmtNum(b.children)} children, ratio 1:${b.ratio}`,
        expr: `ceil(${fmtNum(b.children)} / ${b.ratio})`,
        value: `${b.required} practitioner${b.required !== 1 ? 's' : ''}`,
        kind: 'derived',
      });
    }
    steps.push(
      { label: 'Total practitioners', value: `${totalPract}`, kind: 'derived' },
      { label: 'Annual practitioner salary', value: fmtGBP(salaryPract), kind: 'input' },
      { label: 'Loaded cost factor', value: fmtNum(loadFactor, 4) + '×', kind: 'derived' },
      { label: 'Monthly cost per practitioner', value: fmtGBP(monthlyPractCost), kind: 'derived' },
      { label: 'Practitioner monthly cost', expr: `${totalPract} × ${fmtGBP(monthlyPractCost)}`, value: fmtGBP(totalPract * monthlyPractCost), kind: 'result' },
    );
    return { formula: 'ceil(children / ratio) × monthly_loaded_salary', steps };
  }

  // Managers
  const managers = totalPract > 0 ? Math.max(1, Math.ceil(totalPract / managerPerN)) : 0;
  const steps = [
    { label: 'Total practitioners (from above)', value: `${totalPract}`, kind: 'derived' },
    { label: 'Practitioners per manager', value: `${managerPerN}`, kind: 'input' },
    { label: 'Required managers', expr: `max(1, ceil(${totalPract} / ${managerPerN}))`, value: `${managers}`, kind: 'derived' },
    { label: 'Annual manager salary', value: fmtGBP(salaryManager), kind: 'input' },
    { label: 'Loaded cost factor', value: fmtNum(loadFactor, 4) + '×', kind: 'derived' },
    { label: 'Monthly cost per manager', expr: `${fmtGBP(salaryManager)} / 12 × ${fmtNum(loadFactor, 4)}`, value: fmtGBP(monthlyManagerCost), kind: 'derived' },
    { label: 'Manager monthly cost', expr: `${managers} × ${fmtGBP(monthlyManagerCost)}`, value: fmtGBP(managers * monthlyManagerCost), kind: 'result' },
  ];
  return { formula: 'max(1, ceil(practitioners / managers_per_n)) × monthly_loaded_salary', steps };
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
        { label: 'Full monthly rent (entity driver)', value: fmtGBP(v), kind: 'input' },
        { label: 'Months since opening', value: tIn < 0 ? '—' : `${tIn}`, kind: 'derived' },
      ];
      if (stageRows) {
        steps.push({ label: 'Concession schedule', kind: 'note' });
        for (const sr of stageRows) steps.push(sr);
      }
      steps.push(
        { label: 'Concession factor at this period', value: `× ${(factor * 100).toFixed(0)}%`, kind: 'derived' },
        { label: 'Effective rent', expr: `${fmtGBP(v)} × ${(factor * 100).toFixed(0)}%`, value: fmtGBP(eff), kind: 'result' },
      );
      return { formula: 'rent_monthly_p × concession_factor(months since opening)', steps };
    }
    if (lineLabel === 'Service charge') {
      const v = r('premises.service_charge_monthly_p');
      const eff = v * factor;
      const steps = [
        { label: 'Full monthly service charge', value: fmtGBP(v), kind: 'input' },
        { label: 'Concession factor at this period', value: `× ${(factor * 100).toFixed(0)}%`, kind: 'derived' },
        { label: 'Effective service charge', expr: `${fmtGBP(v)} × ${(factor * 100).toFixed(0)}%`, value: fmtGBP(eff), kind: 'result' },
      ];
      return { formula: 'service_charge_monthly_p × concession_factor', steps };
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
    { label: 'Loan = price × (1 − deposit%)', expr: `${fmtGBP(price)} × ${fmtPct((1 - depositPct) * 100, 0)}`, value: fmtGBP(loan), kind: 'derived' },
    { label: 'Annual mortgage rate', value: fmtPct(ratePct * 100, 2), kind: 'input' },
    { label: 'Monthly rate', expr: `${fmtPct(ratePct * 100, 2)} / 12`, value: fmtPct(monthlyRate * 100, 4), kind: 'derived' },
    { label: 'Term (months)', expr: `${termYears} × 12`, value: `${nMonths}`, kind: 'derived' },
    { label: 'Monthly payment', expr: `loan × r / (1 − (1+r)^−n)`, value: fmtGBP(payment), kind: 'derived' },
  ];

  if (lineLabel === 'Mortgage interest') {
    return { formula: 'outstanding[t-1] × monthly_rate', steps: [
      ...setup,
      { label: `Outstanding at t=${period - 1}`, value: fmtGBP(outstanding + lastPrincipal), kind: 'derived' },
      { label: `Interest at t=${period}`, expr: `${fmtGBP(outstanding + lastPrincipal)} × ${fmtPct(monthlyRate * 100, 4)}`, value: fmtGBP(lastInterest), kind: 'result' },
    ]};
  }
  if (lineLabel === 'Mortgage principal') {
    return { formula: 'monthly_payment − interest[t]', steps: [
      ...setup,
      { label: `Interest at t=${period}`, value: fmtGBP(lastInterest), kind: 'derived' },
      { label: `Principal at t=${period}`, expr: `${fmtGBP(payment)} − ${fmtGBP(lastInterest)}`, value: fmtGBP(lastPrincipal), kind: 'result' },
    ]};
  }
  if (lineLabel === 'Mortgage outstanding') {
    return { formula: 'opening loan − Σ principal repaid', steps: [
      ...setup,
      { label: `Outstanding at t=${period}`, value: fmtGBP(outstanding), kind: 'result' },
    ]};
  }
  if (lineLabel === 'Property + fit-out') {
    if (period >= opening) {
      const monthlyDep = (price + fitOut) / (depYears * 12);
      return { formula: '(purchase_price + fit-out) / (depreciation_years × 12)', steps: [
        { label: 'Purchase price', value: fmtGBP(price), kind: 'input' },
        { label: 'Fit-out capex', value: fmtGBP(fitOut), kind: 'input' },
        { label: 'Depreciable base', expr: `${fmtGBP(price)} + ${fmtGBP(fitOut)}`, value: fmtGBP(price + fitOut), kind: 'derived' },
        { label: 'Depreciation horizon', value: `${depYears} years`, kind: 'input' },
        { label: 'Monthly depreciation', expr: `${fmtGBP(price + fitOut)} / (${depYears} × 12)`, value: fmtGBP(monthlyDep), kind: 'result' },
      ]};
    }
  }
  if (lineLabel === 'NDR') {
    const ndrAnnual = rv * poundage * (1 - ndrRelief);
    const ndrMonthly = ndrAnnual / 12;
    return { formula: 'rateable_value × poundage × (1 − relief) / 12', steps: [
      { label: 'Rateable value', value: fmtGBP(rv), kind: 'input' },
      { label: 'Poundage', value: fmtPct(poundage * 100, 3), kind: 'input' },
      { label: 'Relief %', value: fmtPct(ndrRelief * 100, 1), kind: 'input' },
      { label: 'NDR annual', expr: `${fmtGBP(rv)} × ${fmtPct(poundage * 100, 3)} × (1 − ${fmtPct(ndrRelief * 100, 1)})`, value: fmtGBP(ndrAnnual), kind: 'derived' },
      { label: 'NDR monthly', expr: `${fmtGBP(ndrAnnual)} / 12`, value: fmtGBP(ndrMonthly), kind: 'result' },
    ]};
  }
  if (lineLabel === 'Maintenance') {
    return { formula: 'maintenance_annual / 12', steps: [
      { label: 'Annual maintenance', value: fmtGBP(maintAnnual), kind: 'input' },
      { label: 'Monthly', expr: `${fmtGBP(maintAnnual)} / 12`, value: fmtGBP(maintAnnual / 12), kind: 'result' },
    ]};
  }
  if (lineLabel === 'Acquisition + fit-out') {
    return { formula: 'purchase + LBTT + legal + fit-out (one-shot at acq month)', steps: [
      { label: 'Purchase price', value: fmtGBP(price), kind: 'input' },
      { label: 'LBTT (Scotland non-residential bands)', value: fmtGBP(lbtt), kind: 'derived' },
      { label: 'Legal & acquisition fees', value: fmtGBP(legalFees), kind: 'input' },
      { label: 'Fit-out capex', value: fmtGBP(fitOut), kind: 'input' },
      { label: 'Total capex at acquisition', value: fmtGBP(price + lbtt + legalFees + fitOut), kind: 'result' },
      { label: `Recorded once at month ${acqMonth} (opening month − 1)`, kind: 'note' },
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
  return { formula: 'driver value (applies each month after opening)', steps: [
    { label: lineLabel + ' (driver)', value: d.unit === 'gbp_p' ? fmtGBP(Number(v?.value ?? 0)) : String(v?.value ?? 0), kind: 'result' },
    { label: d.entity_id ? 'Entity-scoped — applies once entity opens' : 'Group-scope — applies every month', kind: 'note' },
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
    return { formula: 'monthly_overhead applied from (opening − registration_lead) to opening − 1', steps: [
      { label: 'Opening month', value: `t=${opening}`, kind: 'input' },
      { label: 'Registration lead time', value: `${lead} months`, kind: 'input' },
      { label: 'Pre-opening window', value: `t=${start} … t=${opening - 1}`, kind: 'derived' },
      { label: 'Monthly pre-opening overhead', value: fmtGBP(v), kind: 'result' },
    ]};
  }
  if (lineLabel === 'Pre-opening staffing') {
    const v = r('pre_open.staffing_monthly_p');
    const months = r('pre_open.staffing_months');
    return { formula: 'staffing_monthly applied for last N months before opening', steps: [
      { label: 'Pre-opening staffing months', value: `${months}`, kind: 'input' },
      { label: 'Monthly staffing cost', value: fmtGBP(v), kind: 'result' },
    ]};
  }
  if (lineLabel === 'Pre-opening marketing') {
    const v = r('pre_open.marketing_spike_p');
    return { formula: 'one-shot marketing spike at month opening − 1', steps: [
      { label: 'Marketing spike', value: fmtGBP(v), kind: 'result' },
      { label: `Recorded once at t=${opening - 1}`, kind: 'note' },
    ]};
  }
  return null;
}

// ── Tax ─────────────────────────────────────────────────────────

function explainTaxSimple({ lineLabel, period, entity, drivers, values }) {
  if (lineLabel !== 'Corporation tax') return null;
  const r = makeResolver(drivers, values, null);
  const ctRate = r('tax.ct_rate_pct');
  return { formula: 'max(0, PBT × CT_rate). Cash settlement lags 9 months.', steps: [
    { label: 'CT rate (worst-case marginal)', value: fmtPct(ctRate, 1), kind: 'input' },
    { label: 'Tax accrued = PBT × CT rate (zeroed if PBT < 0)', kind: 'note' },
    { label: 'Cash CT paid = tax accrued at t − 9 months', kind: 'note' },
  ]};
}
