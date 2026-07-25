// Staff module — full role hierarchy with ratio-derived direct staff mix
// + NMW age-band split for qualified/apprentice (under-19 / under-21 / 21+).
//
// Allocation strategy:
//   1. Per band, compute required practitioners = ceil(children / ratio)
//   2. Sum to entity-total required (avoids per-band floor compounding)
//   3. Split entity total by mix %: senior + qualified rounded, apprentice = residual
//   4. Distribute each role's HC back to bands proportional to band requirement
//      (keeps band tagging working for the dashboard)
//
// Salary blending:
//   For qualified and apprentice, the user supplies three NMW age-band
//   salaries and a 3-way mix %. The compute() blends these into a single
//   effective annual salary used for cost emit. The age-band split itself
//   surfaces in the rate analysis box on the staff detail page.

import { AGE_BANDS_LIST, bandLabel } from './locations.js';

const DEFAULT_RATIOS = {
  babies: 3,
  twos: 5,
  three_to_five: 8,
  after_school: 10,
};

// Default annualised salaries (pence) — based on 1820 hours/year × hourly rate.
//   <19 apprentice rate ≈ £7.55/hr → £13,741
//   18-20 NMW          ≈ £10.00/hr → £18,200
//   21+ NLW            ≈ £12.21/hr → £22,222
const DEFAULTS = {
  executive:        7500000,    // £75k
  senior_manager:   5500000,    // £55k
  setting_manager:  3800000,    // £38k
  assistant_manager:3000000,    // £30k
  admin:            2400000,    // £24k
  cook:             2200000,    // £22k
  senior_qualified: 3000000,    // £30k (presumed 21+ skilled)

  qualified_under19:  1820000,  // £18.2k (matches 18-20 NMW for <19 too if not apprentice)
  qualified_under21:  1820000,  // £18.2k
  qualified_21plus:   2500000,  // £25k

  apprentice_under19: 1374000,  // £13.74k apprentice rate
  apprentice_under21: 1820000,  // £18.2k 18-20 NMW
  apprentice_21plus:  2222000,  // £22.22k NLW
};

export const staffModule = {
  key: 'staff',
  pack: ['childcare_scotland'],
  dependsOn: ['locations', 'services_childcare'],

  drivers: [
    // ── Statutory ratios per age band ───────────────────────────
    ...AGE_BANDS_LIST.map(band => ({
      key: `ratio.${band}`, label: `Ratio — ${bandLabel(band)} (children per adult)`,
      unit: 'ratio', kind: 'scalar', scope: 'group', defaultValue: DEFAULT_RATIOS[band] || 8,
    })),

    // ── Direct staff role mix (must total 100) ──────────────────
    { key: 'direct_mix.senior_pct',     label: 'Direct mix — senior qualified %', unit: 'pct', kind: 'scalar', scope: 'group', defaultValue: 20 },
    { key: 'direct_mix.qualified_pct',  label: 'Direct mix — qualified %',         unit: 'pct', kind: 'scalar', scope: 'group', defaultValue: 50 },
    { key: 'direct_mix.apprentice_pct', label: 'Direct mix — apprentices %',       unit: 'pct', kind: 'scalar', scope: 'group', defaultValue: 30 },

    // ── Roles, in the order requested: exec → senior mgr → admin →
    //    setting mgr → assistant mgr → qualified (21+/<21/<19) →
    //    apprentice (21+/<21/<19). Each role groups its salary +
    //    headcount together so the eye reads down the whole role.
    // Executive
    { key: 'base_salary_p.executive',              label: 'Executive — salary',              unit: 'gbp_p', kind: 'scalar', scope: 'group',  defaultValue: DEFAULTS.executive },
    { key: 'headcount.executives',                 label: 'Executive — group headcount',     unit: 'count', kind: 'scalar', scope: 'group',  defaultValue: 1 },
    // Senior manager
    { key: 'base_salary_p.senior_manager',         label: 'Senior manager — salary',         unit: 'gbp_p', kind: 'scalar', scope: 'group',  defaultValue: DEFAULTS.senior_manager },
    { key: 'headcount.senior_managers',            label: 'Senior manager — group headcount',unit: 'count', kind: 'scalar', scope: 'group',  defaultValue: 1 },
    // Admin
    { key: 'base_salary_p.admin',                  label: 'Admin — salary',                  unit: 'gbp_p', kind: 'scalar', scope: 'group',  defaultValue: DEFAULTS.admin },
    { key: 'headcount.admin',                      label: 'Admin — group headcount',         unit: 'count', kind: 'scalar', scope: 'group',  defaultValue: 1 },
    // Setting manager
    { key: 'base_salary_p.setting_manager',        label: 'Setting manager — salary',        unit: 'gbp_p', kind: 'scalar', scope: 'group',  defaultValue: DEFAULTS.setting_manager },
    { key: 'headcount.setting_managers_per_site',  label: 'Setting manager — per site',      unit: 'count', kind: 'scalar', scope: 'entity', defaultValue: 1 },
    // Assistant manager
    { key: 'base_salary_p.assistant_manager',      label: 'Assistant manager — salary',      unit: 'gbp_p', kind: 'scalar', scope: 'group',  defaultValue: DEFAULTS.assistant_manager },
    { key: 'headcount.assistant_managers_per_site',label: 'Assistant manager — per site',    unit: 'count', kind: 'scalar', scope: 'entity', defaultValue: 1 },
    // Cook — site kitchen staff; costed like managers (salary + per-site
    // headcount) but never counts toward the statutory ratio.
    { key: 'base_salary_p.cook',                   label: 'Cook — salary',                   unit: 'gbp_p', kind: 'scalar', scope: 'group',  defaultValue: DEFAULTS.cook },
    { key: 'headcount.cooks_per_site',             label: 'Cooks — per site',                unit: 'count', kind: 'scalar', scope: 'entity', defaultValue: 1 },

    // Senior qualified (kept for back-compat; sits between mgmt and qualified bands)
    { key: 'base_salary_p.senior_qualified',       label: 'Senior qualified — salary',       unit: 'gbp_p', kind: 'scalar', scope: 'group',  defaultValue: DEFAULTS.senior_qualified },

    // Qualified — 21+ → under 21 → under 19
    { key: 'base_salary_p.qualified_21plus',       label: 'Qualified >21 — salary',          unit: 'gbp_p', kind: 'scalar', scope: 'group',  defaultValue: DEFAULTS.qualified_21plus },
    { key: 'nmw_mix.qualified.21plus_pct',         label: 'Qualified >21 — % of qualified',  unit: 'pct',   kind: 'scalar', scope: 'group',  defaultValue: 70 },
    { key: 'base_salary_p.qualified_under21',      label: 'Qualified >19 — salary',          unit: 'gbp_p', kind: 'scalar', scope: 'group',  defaultValue: DEFAULTS.qualified_under21 },
    { key: 'nmw_mix.qualified.under21_pct',        label: 'Qualified >19 — % of qualified',  unit: 'pct',   kind: 'scalar', scope: 'group',  defaultValue: 25 },
    { key: 'base_salary_p.qualified_under19',      label: 'Qualified <19 — salary',          unit: 'gbp_p', kind: 'scalar', scope: 'group',  defaultValue: DEFAULTS.qualified_under19 },
    { key: 'nmw_mix.qualified.under19_pct',        label: 'Qualified <19 — % of qualified',  unit: 'pct',   kind: 'scalar', scope: 'group',  defaultValue: 5 },

    // Apprentice — 21+ → under 21 → under 19
    { key: 'base_salary_p.apprentice_21plus',      label: 'Apprentice >21 — salary',         unit: 'gbp_p', kind: 'scalar', scope: 'group',  defaultValue: DEFAULTS.apprentice_21plus },
    { key: 'nmw_mix.apprentice.21plus_pct',        label: 'Apprentice >21 — % of apprentice',unit: 'pct',   kind: 'scalar', scope: 'group',  defaultValue: 15 },
    { key: 'base_salary_p.apprentice_under21',     label: 'Apprentice >19 — salary',         unit: 'gbp_p', kind: 'scalar', scope: 'group',  defaultValue: DEFAULTS.apprentice_under21 },
    { key: 'nmw_mix.apprentice.under21_pct',       label: 'Apprentice >19 — % of apprentice',unit: 'pct',   kind: 'scalar', scope: 'group',  defaultValue: 35 },
    { key: 'base_salary_p.apprentice_under19',     label: 'Apprentice <19 — salary',         unit: 'gbp_p', kind: 'scalar', scope: 'group',  defaultValue: DEFAULTS.apprentice_under19 },
    { key: 'nmw_mix.apprentice.under19_pct',       label: 'Apprentice <19 — % of apprentice',unit: 'pct',   kind: 'scalar', scope: 'group',  defaultValue: 50 },

    // ── On-costs and policy ─────────────────────────────────────
    { key: 'employer_ni_pct',         label: 'Employer NI %',                    unit: 'pct',   kind: 'scalar', scope: 'group', defaultValue: 15 },
    { key: 'employer_pension_pct',    label: 'Employer pension %',               unit: 'pct',   kind: 'scalar', scope: 'group', defaultValue: 3 },
    { key: 'employment_allowance_p',  label: 'Employment allowance (annual £)',  unit: 'gbp_p', kind: 'scalar', scope: 'group', defaultValue: 500000 },
    { key: 'vacancy_rate_pct',        label: 'Vacancy / agency cover %',         unit: 'pct',   kind: 'scalar', scope: 'group', defaultValue: 8 },
    { key: 'agency_premium_pct',      label: 'Agency premium %',                 unit: 'pct',   kind: 'scalar', scope: 'group', defaultValue: 30 },
    // Over-staffing buffer: lets you carry headcount above the statutory
    // ratio (e.g. for break cover, peer support, quality of provision).
    // 0% = manage to ratio. 10% = 10% more practitioners than required.
    { key: 'overstaff_pct',           label: 'Over-staffing % (above statutory ratio)', unit: 'pct', kind: 'scalar', scope: 'group', defaultValue: 0 },
    { key: 'real_living_wage_hourly_p', label: 'Real Living Wage (£/hr)',        unit: 'gbp_p', kind: 'scalar', scope: 'group', defaultValue: 1290 },
    { key: 'nmw_21plus_hourly_p',     label: 'NMW — 21+ (NLW) £/hr',             unit: 'gbp_p', kind: 'scalar', scope: 'group', defaultValue: 1221 },
    { key: 'nmw_18to20_hourly_p',     label: 'NMW — 18-20 £/hr',                 unit: 'gbp_p', kind: 'scalar', scope: 'group', defaultValue: 1000 },
    { key: 'nmw_under18_hourly_p',    label: 'NMW — under 18 £/hr',              unit: 'gbp_p', kind: 'scalar', scope: 'group', defaultValue: 755 },
    { key: 'nmw_apprentice_hourly_p', label: 'NMW — apprentice £/hr',            unit: 'gbp_p', kind: 'scalar', scope: 'group', defaultValue: 755 },
    // Productive hours ONE employee delivers in a year (net of holidays).
    // Drives the ratio→headcount conversion: a room open longer than one
    // contract covers needs more than one employee per floor position.
    { key: 'standard_hours_per_year', label: 'Productive hours per employee / year', unit: 'hours', kind: 'scalar', scope: 'group', defaultValue: 1820 },

    // ── Floor-time factors (share of a head's time that stands in the
    //    statutory ratio). 1 = fully counted, 0 = never counted, 0.5 =
    //    half their time on the floor. Management set > 0 ABSORBS part of
    //    the ratio requirement instead of sitting on top of it.
    { key: 'ratio_inclusion.senior_qualified',  label: 'Senior qualified — floor-time factor (1 = full)',  unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 1 },
    { key: 'ratio_inclusion.qualified',         label: 'Qualified — floor-time factor (1 = full)',         unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 1 },
    { key: 'ratio_inclusion.apprentice',        label: 'Apprentice — floor-time factor (1 = full)',        unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 1 },
    { key: 'ratio_inclusion.setting_manager',   label: 'Setting manager — floor-time factor (1 = full)',   unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 1 },
    { key: 'ratio_inclusion.assistant_manager', label: 'Assistant manager — floor-time factor (1 = full)', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 1 },
  ],

  outputs: [
    { nominal_type: 'staff_cost', label: 'Staff cost (per role)', by_entity: true },
    { nominal_type: 'metric.ratio_required',  label: 'Employees required (ratio × hours cover)', by_entity: false },
    { nominal_type: 'metric.ratio_provided',  label: 'Employees provided (floor-time weighted)', by_entity: false },
    { nominal_type: 'metric.ratio_compliance',label: 'Ratio compliance (× required)', by_entity: false },
    { nominal_type: 'metric.floor_positions', label: 'Adults required on floor (statutory)', by_entity: false },
  ],

  compute(ctx) {
    const out = [];

    // On-cost factor (loaded for the engine's existing CF/P&L pipeline).
    // coverFactor is split out so the NI element can be isolated for the
    // employment-allowance credit below.
    const niPct = ctx.resolve('employer_ni_pct', {}) / 100;
    const penPct = ctx.resolve('employer_pension_pct', {}) / 100;
    const vacPct = ctx.resolve('vacancy_rate_pct', {}) / 100;
    const agencyPct = ctx.resolve('agency_premium_pct', {}) / 100;
    const coverFactor = 1 + vacPct * agencyPct;      // agency premium on covered vacancies
    const loadFactor = (1 + niPct + penPct) * coverFactor;
    const allowanceP = ctx.resolve('employment_allowance_p', {}) || 0;

    // Mix
    const seniorPct    = ctx.resolve('direct_mix.senior_pct', {}) / 100;
    const qualifiedPct = ctx.resolve('direct_mix.qualified_pct', {}) / 100;
    const apprenticePct = ctx.resolve('direct_mix.apprentice_pct', {}) / 100;

    // Over-staffing buffer above the statutory ratio
    const overstaffPct = (ctx.resolve('overstaff_pct', {}) || 0) / 100;

    // Blended NMW-banded salaries
    const blend = (key) => {
      const u19 = ctx.resolve(`base_salary_p.${key}_under19`, {}) || 0;
      const u21 = ctx.resolve(`base_salary_p.${key}_under21`, {}) || 0;
      const p21 = ctx.resolve(`base_salary_p.${key}_21plus`, {}) || 0;
      const m19 = (ctx.resolve(`nmw_mix.${key}.under19_pct`, {}) || 0) / 100;
      const m21 = (ctx.resolve(`nmw_mix.${key}.under21_pct`, {}) || 0) / 100;
      const mp  = (ctx.resolve(`nmw_mix.${key}.21plus_pct`, {})  || 0) / 100;
      return u19 * m19 + u21 * m21 + p21 * mp;
    };

    const sal = {
      executive:        ctx.resolve('base_salary_p.executive', {}),
      senior_manager:   ctx.resolve('base_salary_p.senior_manager', {}),
      setting_manager:  ctx.resolve('base_salary_p.setting_manager', {}),
      assistant_manager:ctx.resolve('base_salary_p.assistant_manager', {}),
      admin:            ctx.resolve('base_salary_p.admin', {}),
      cook:             ctx.resolve('base_salary_p.cook', {}),
      senior_qualified: ctx.resolve('base_salary_p.senior_qualified', {}),
      qualified:        blend('qualified'),
      apprentice:       blend('apprentice'),
    };

    // Group-level headcounts
    const hcExec   = ctx.resolve('headcount.executives', {}) || 0;
    const hcSrMgr  = ctx.resolve('headcount.senior_managers', {}) || 0;
    const hcAdmin  = ctx.resolve('headcount.admin', {}) || 0;

    // Floor-time factors — the share of a head's time that stands in the
    // statutory ratio. Values are 0..1 (1 = fully counted, the default).
    const f01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
    const inclF = {
      senior_qualified:  f01(ctx.resolve('ratio_inclusion.senior_qualified', {})),
      qualified:         f01(ctx.resolve('ratio_inclusion.qualified', {})),
      apprentice:        f01(ctx.resolve('ratio_inclusion.apprentice', {})),
      setting_manager:   f01(ctx.resolve('ratio_inclusion.setting_manager', {})),
      assistant_manager: f01(ctx.resolve('ratio_inclusion.assistant_manager', {})),
    };

    // Statutory ratios per band
    const ratios = {};
    for (const band of AGE_BANDS_LIST) ratios[band] = ctx.resolve(`ratio.${band}`, {}) || DEFAULT_RATIOS[band] || 8;

    // ── Ratio → employees: hours coverage ─────────────────────────
    // A statutory ratio is a SIMULTANEOUS supervision requirement — one
    // adult per N children *present* — not a headcount. Converting it into
    // employees needs the room's open hours and each employee's productive
    // hours:
    //   adult-hours/yr = (children / ratio) × open_hrs_per_week × weeks
    //   employees      = adult-hours/yr ÷ productive_hrs_per_employee
    // A room open 50 hrs/week staffed on 1,820-hour contracts therefore
    // needs ~1.4 employees per floor position, not 1. Treating a floor
    // position as one employee silently under-staffs long opening hours.
    const weeksPerYear = ctx.resolve('weeks_per_year', {}) || 51;
    const hoursPerEmployee = ctx.resolve('standard_hours_per_year', {}) || 1820;
    const coverageByEntity = {};
    for (const e of (ctx.entities || [])) {
      const perBand = {};
      for (const band of AGE_BANDS_LIST) {
        const hpw = ctx.resolve(`operating_hours_per_week.${band}`, { entity: e.key }) || 0;
        // hpw 0 = band not offered. Fall back to 1:1 rather than silently
        // staffing a room with nobody if hours are ever left unset.
        perBand[band] = (hpw > 0 && hoursPerEmployee > 0)
          ? (hpw * weeksPerYear) / hoursPerEmployee
          : 1;
      }
      coverageByEntity[e.key] = perBand;
    }

    // Gross pay subject to employer NI, accumulated per period so the
    // employment allowance can be capped at the NI actually incurred.
    let niablePay = 0;
    const monthlyCost = (hc, salary) => {
      const pay = hc * (salary / 12) * coverFactor;
      niablePay += pay;
      return Math.round(pay * (1 + niPct + penPct));
    };
    // Employee counts are now fractional (fc_output.amount_p is numeric);
    // 1dp keeps the emitted metrics readable for every consumer view.
    const r1 = (x) => Math.round(x * 10) / 10;
    const emit = (entity_id, period, role, label, hc, amount, age_band) => {
      if (hc === 0 && amount === 0) return;
      out.push({
        module_key: 'staff', entity_id, period,
        nominal_type: 'staff_cost', line_label: label,
        amount_p: amount,
        tags: { role, headcount: hc, ...(age_band ? { age_band } : {}) },
      });
    };

    const practitionersByEntity = {};

    for (const t of ctx.periods) {
      niablePay = 0;

      // Group-level roles
      if (hcExec > 0)  emit(null, t, 'executive',      `Executives (${hcExec})`,       hcExec,  monthlyCost(hcExec, sal.executive));
      if (hcSrMgr > 0) emit(null, t, 'senior_manager', `Senior managers (${hcSrMgr})`, hcSrMgr, monthlyCost(hcSrMgr, sal.senior_manager));
      if (hcAdmin > 0) emit(null, t, 'admin',          `Admin (${hcAdmin})`,           hcAdmin, monthlyCost(hcAdmin, sal.admin));

      let groupRequiredTotal = 0;
      let groupProvidedTotal = 0;
      let groupFloorTotal = 0;

      for (const e of (ctx.entities || [])) {
        const cfg = e.config || {};
        const opensAt = cfg.opening_month_offset ?? 0;
        if (t < opensAt) continue;

        // Per-site setting + assistant managers
        const hcSetting = ctx.resolve('headcount.setting_managers_per_site', { entity: e.key }) || 0;
        if (hcSetting > 0) emit(e.id, t, 'setting_manager', `Setting managers (${hcSetting})`, hcSetting, monthlyCost(hcSetting, sal.setting_manager));

        const hcAsst = ctx.resolve('headcount.assistant_managers_per_site', { entity: e.key }) || 0;
        if (hcAsst > 0) emit(e.id, t, 'assistant_manager', `Assistant managers (${hcAsst})`, hcAsst, monthlyCost(hcAsst, sal.assistant_manager));

        const hcCook = ctx.resolve('headcount.cooks_per_site', { entity: e.key }) || 0;
        if (hcCook > 0) emit(e.id, t, 'cook', `Cooks (${hcCook})`, hcCook, monthlyCost(hcCook, sal.cook));

        // Direct staff: exact floor positions per band → employee-
        // equivalents via hours coverage → whole heads once, at ENTITY
        // level. Rounding at the entity (not per room) reflects that staff
        // flex across rooms and part-time contracts are normal; rounding up
        // in every room separately over-provided ~20-25%.
        const childMap = ctx.childrenAttending?.[e.key] || {};
        const cov = coverageByEntity[e.key] || {};
        const empByBand = {};
        let floorPositions = 0;   // adults required on the floor, simultaneous
        let empRequired = 0;      // employees required to cover the open week
        for (const band of AGE_BANDS_LIST) {
          const children = childMap[band]?.[t] ?? 0;
          const ratio = ratios[band];
          if (!(ratio > 0) || children <= 0) { empByBand[band] = 0; continue; }
          const positions = children / ratio;
          const emp = positions * (cov[band] ?? 1);
          empByBand[band] = emp;
          floorPositions += positions;
          empRequired += emp;
        }
        practitionersByEntity[e.key] ||= [];
        practitionersByEntity[e.key][t] = empRequired;

        // Over-staffing buffer applies to the requirement; management who
        // genuinely stand in the ratio then ABSORB part of it, rather than
        // sitting on top of a fully-staffed practitioner establishment.
        const mgrCover = hcSetting * inclF.setting_manager
                       + hcAsst * inclF.assistant_manager;
        const staffedEmp = empRequired * (1 + overstaffPct);
        const directCover = Math.max(0, staffedEmp - mgrCover);

        // A direct head only contributes its role's floor-time factor, so
        // covering `directCover` takes directCover ÷ weighted factor heads.
        const wFactor = seniorPct * inclF.senior_qualified
                      + qualifiedPct * inclF.qualified
                      + apprenticePct * inclF.apprentice;
        const totalStaffed = directCover > 0
          ? Math.ceil(directCover / (wFactor > 0 ? wFactor : 1))
          : 0;

        // Allocate at entity level, with proper rounding (round + residual)
        const hcSeniorTotal = Math.round(totalStaffed * seniorPct);
        const hcQualTotal   = Math.round(totalStaffed * qualifiedPct);
        const hcAppTotal    = Math.max(0, totalStaffed - hcSeniorTotal - hcQualTotal);

        // Distribute back to bands proportional to band requirement.
        // Per-band emit retains the age_band tag for the dashboard split.
        const distribute = (totalHc, role, salary) => {
          if (totalHc === 0 || empRequired <= 0) return;
          const monthlyPer = (salary / 12) * loadFactor;
          const payPer = (salary / 12) * coverFactor;
          let allocated = 0;
          // Largest-remainder method: integer floors per band, then top-up
          // the largest residuals until we've allocated the whole total.
          const pieces = AGE_BANDS_LIST.map(band => {
            const exact = totalHc * ((empByBand[band] || 0) / empRequired);
            return { band, exact, base: Math.floor(exact), residual: exact - Math.floor(exact) };
          });
          let used = pieces.reduce((s, p) => s + p.base, 0);
          pieces.sort((a, b) => b.residual - a.residual);
          let i = 0;
          while (used < totalHc) {
            pieces[i % pieces.length].base += 1;
            used += 1;
            i += 1;
          }
          for (const p of pieces) {
            if (p.base === 0) continue;
            const cost = Math.round(p.base * monthlyPer);
            niablePay += p.base * payPer;
            emit(e.id, t, role, `${roleLabel(role)} — ${bandLabel(p.band)} (${p.base})`, p.base, cost, p.band);
            allocated += p.base;
          }
        };
        distribute(hcSeniorTotal, 'senior_qualified', sal.senior_qualified);
        distribute(hcQualTotal,   'qualified',        sal.qualified);
        distribute(hcAppTotal,    'apprentice',       sal.apprentice);

        // Employee-equivalents provided toward cover, weighted by how much
        // of each role's time actually stands in the ratio.
        const providedEntity = mgrCover
          + hcSeniorTotal * inclF.senior_qualified
          + hcQualTotal   * inclF.qualified
          + hcAppTotal    * inclF.apprentice;

        // Per-entity ratio metrics (used by Capacities view)
        if (empRequired > 0 || providedEntity > 0) {
          const compEntity = empRequired > 0 ? providedEntity / empRequired : 1;
          out.push({ module_key: 'staff', entity_id: e.id, period: t, nominal_type: 'metric.ratio_required', line_label: 'Employees required', amount_p: r1(empRequired) });
          out.push({ module_key: 'staff', entity_id: e.id, period: t, nominal_type: 'metric.ratio_provided', line_label: 'Employees provided', amount_p: r1(providedEntity) });
          out.push({ module_key: 'staff', entity_id: e.id, period: t, nominal_type: 'metric.ratio_compliance', line_label: 'Ratio compliance (×)', amount_p: Math.round(compEntity * 10000) });
          out.push({ module_key: 'staff', entity_id: e.id, period: t, nominal_type: 'metric.floor_positions', line_label: 'Adults required on floor', amount_p: r1(floorPositions) });
        }

        groupRequiredTotal += empRequired;
        groupProvidedTotal += providedEntity;
        groupFloorTotal += floorPositions;
      }

      // ── Employment allowance ──────────────────────────────────────
      // Per-EMPLOYER annual relief against employer NI (not per site).
      // Spread evenly over the year and capped at the NI actually incurred;
      // emitted as a group-level credit so it nets off overhead staff cost.
      if (allowanceP > 0 && niPct > 0) {
        const credit = Math.min(allowanceP / 12, niablePay * niPct);
        if (credit > 0) {
          emit(null, t, 'employment_allowance', 'Employment allowance (NI relief)', 0, -Math.round(credit));
        }
      }

      const compliance = groupRequiredTotal > 0 ? groupProvidedTotal / groupRequiredTotal : 1;
      out.push({ module_key: 'staff', period: t, nominal_type: 'metric.ratio_required',  line_label: 'Employees required',  amount_p: r1(groupRequiredTotal) });
      out.push({ module_key: 'staff', period: t, nominal_type: 'metric.ratio_provided',  line_label: 'Employees provided',  amount_p: r1(groupProvidedTotal) });
      out.push({ module_key: 'staff', period: t, nominal_type: 'metric.ratio_compliance',line_label: 'Ratio compliance (×)',   amount_p: Math.round(compliance * 10000) });
      out.push({ module_key: 'staff', period: t, nominal_type: 'metric.floor_positions', line_label: 'Adults required on floor', amount_p: r1(groupFloorTotal) });
    }

    ctx.practitionersByEntity = practitionersByEntity;
    return out;
  },

  validate(ctx) {
    const findings = [];
    // Direct mix should sum to ~100
    const sp = ctx.resolve('direct_mix.senior_pct', {}) || 0;
    const qp = ctx.resolve('direct_mix.qualified_pct', {}) || 0;
    const ap = ctx.resolve('direct_mix.apprentice_pct', {}) || 0;
    if (Math.abs(sp + qp + ap - 100) > 0.5) {
      findings.push({
        severity: 'warn',
        code: 'staff.direct_mix_not_100',
        message: `Direct staff mix (${sp.toFixed(0)} + ${qp.toFixed(0)} + ${ap.toFixed(0)} = ${(sp + qp + ap).toFixed(0)}%) does not total 100%. Apprentice headcount absorbs the residual.`,
      });
    }
    // NMW age-band mixes should sum to ~100
    for (const role of ['qualified', 'apprentice']) {
      const m19 = ctx.resolve(`nmw_mix.${role}.under19_pct`, {}) || 0;
      const m21 = ctx.resolve(`nmw_mix.${role}.under21_pct`, {}) || 0;
      const mp  = ctx.resolve(`nmw_mix.${role}.21plus_pct`, {}) || 0;
      if (Math.abs(m19 + m21 + mp - 100) > 0.5) {
        findings.push({
          severity: 'warn',
          code: `staff.nmw_mix_${role}_not_100`,
          message: `${role} NMW age-band mix (${m19} + ${m21} + ${mp} = ${m19 + m21 + mp}%) does not total 100%. Salary blend is biased.`,
        });
      }
    }
    // Ratio compliance — flag any period that breaches the statutory minimum
    const breaches = [];
    let firstBreach = null;
    let worstCompliance = Infinity;
    let worstT = null;
    for (const t of ctx.periods) {
      const row = ctx.upstreamOutputs.find(r => r.module_key === 'staff' && r.nominal_type === 'metric.ratio_compliance' && r.period === t && !r.entity_id);
      if (!row) continue;
      const x = row.amount_p / 10000;
      if (x < 1.0) {
        breaches.push(t);
        if (firstBreach == null) firstBreach = t;
        if (x < worstCompliance) { worstCompliance = x; worstT = t; }
      }
    }
    if (breaches.length > 0) {
      // Pull required / provided counts at the worst breach period
      const reqRow  = ctx.upstreamOutputs.find(r => r.module_key === 'staff' && r.nominal_type === 'metric.ratio_required' && r.period === worstT && !r.entity_id);
      const provRow = ctx.upstreamOutputs.find(r => r.module_key === 'staff' && r.nominal_type === 'metric.ratio_provided' && r.period === worstT && !r.entity_id);
      const required = reqRow?.amount_p || 0;
      const provided = provRow?.amount_p || 0;
      const shortBy  = required - provided;

      // Re-read floor-time factors here (compute()'s `inclF` is out of scope).
      const f01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
      const ROLES = [
        { key: 'senior_qualified',  label: 'Senior qualified' },
        { key: 'qualified',         label: 'Qualified' },
        { key: 'apprentice',        label: 'Apprentice' },
        { key: 'setting_manager',   label: 'Setting manager' },
        { key: 'assistant_manager', label: 'Assistant manager' },
      ].map(r => ({ ...r, factor: f01(ctx.resolve(`ratio_inclusion.${r.key}`, {})) }));
      const inList = ROLES.filter(r => r.factor > 0).map(r => `${r.label} ${r.factor}`).join(', ') || 'none';
      const outList = ROLES.filter(r => r.factor === 0).map(r => r.label).join(', ') || 'none';

      findings.push({
        severity: 'error',
        code: 'staff.ratio_breach',
        period: worstT,
        message:
          `Statutory ratio breach in ${breaches.length} of ${ctx.periods.length} period${breaches.length !== 1 ? 's' : ''}. ` +
          `Worst at month ${worstT}: ${provided} employee-equivalents of floor cover provided when ${required} are required (short by ${shortBy.toFixed(1)}, ${worstCompliance.toFixed(2)}× cover vs 1.00× statutory). ` +
          `Required is the statutory ratio grossed up for opening hours — adults on the floor × (open hours × weeks) ÷ productive hours per employee. ` +
          `Floor-time factors in use: ${inList}. Roles contributing no floor cover: ${outList}. ` +
          `Fix: in Inputs → Drivers → Staff, raise the per-site setting / assistant manager headcount, raise a role's floor-time factor toward 1, rebalance the direct mix % toward senior/qualified, or add an over-staffing %.`,
      });
    }
    // RLW info
    const rlwHourly = ctx.resolve('real_living_wage_hourly_p', {});
    const hoursYear = ctx.resolve('standard_hours_per_year', {}) || 1820;
    const apprenticeAvg = (
      (ctx.resolve('base_salary_p.apprentice_under19', {}) || 0) * (ctx.resolve('nmw_mix.apprentice.under19_pct', {}) || 0) +
      (ctx.resolve('base_salary_p.apprentice_under21', {}) || 0) * (ctx.resolve('nmw_mix.apprentice.under21_pct', {}) || 0) +
      (ctx.resolve('base_salary_p.apprentice_21plus',  {}) || 0) * (ctx.resolve('nmw_mix.apprentice.21plus_pct',  {}) || 0)
    ) / 100;
    const impliedHourly = apprenticeAvg / hoursYear;
    if (impliedHourly < rlwHourly) {
      findings.push({
        severity: 'info',
        code: 'staff.apprentice_below_rlw',
        message: `Blended apprentice salary implies £${(impliedHourly / 100).toFixed(2)}/hr — below Real Living Wage (£${(rlwHourly / 100).toFixed(2)}/hr). Funded-partner status can require RLW for all staff.`,
      });
    }
    return findings;
  },
};

function roleLabel(role) {
  return {
    senior_qualified: 'Senior qualified',
    qualified:        'Qualified',
    apprentice:       'Apprentice',
  }[role] || role;
}
