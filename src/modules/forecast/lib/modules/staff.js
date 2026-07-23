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
    { key: 'standard_hours_per_year', label: 'Standard hours per year',          unit: 'hours', kind: 'scalar', scope: 'group', defaultValue: 1820 },

    // ── Ratio inclusion flags (1 = counts toward statutory ratio) ──
    { key: 'ratio_inclusion.senior_qualified',  label: 'Senior qualified counts toward ratio',  unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 1 },
    { key: 'ratio_inclusion.qualified',         label: 'Qualified counts toward ratio',         unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 1 },
    { key: 'ratio_inclusion.apprentice',        label: 'Apprentice counts toward ratio',        unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 1 },
    { key: 'ratio_inclusion.setting_manager',   label: 'Setting manager counts toward ratio',   unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 1 },
    { key: 'ratio_inclusion.assistant_manager', label: 'Assistant manager counts toward ratio', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 1 },
  ],

  outputs: [
    { nominal_type: 'staff_cost', label: 'Staff cost (per role)', by_entity: true },
    { nominal_type: 'metric.ratio_required',  label: 'Practitioners required (ratios)', by_entity: false },
    { nominal_type: 'metric.ratio_provided',  label: 'Practitioners provided (counted roles)', by_entity: false },
    { nominal_type: 'metric.ratio_compliance',label: 'Ratio compliance (× required)', by_entity: false },
  ],

  compute(ctx) {
    const out = [];

    // On-cost factor (loaded for the engine's existing CF/P&L pipeline)
    const niPct = ctx.resolve('employer_ni_pct', {}) / 100;
    const penPct = ctx.resolve('employer_pension_pct', {}) / 100;
    const vacPct = ctx.resolve('vacancy_rate_pct', {}) / 100;
    const agencyPct = ctx.resolve('agency_premium_pct', {}) / 100;
    const loadFactor = (1 + niPct + penPct) * (1 + vacPct * agencyPct);

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

    // Ratio inclusion flags
    const incl = {
      senior_qualified:  ctx.resolve('ratio_inclusion.senior_qualified', {})  >= 1,
      qualified:         ctx.resolve('ratio_inclusion.qualified', {})         >= 1,
      apprentice:        ctx.resolve('ratio_inclusion.apprentice', {})        >= 1,
      setting_manager:   ctx.resolve('ratio_inclusion.setting_manager', {})   >= 1,
      assistant_manager: ctx.resolve('ratio_inclusion.assistant_manager', {}) >= 1,
    };

    // Statutory ratios per band
    const ratios = {};
    for (const band of AGE_BANDS_LIST) ratios[band] = ctx.resolve(`ratio.${band}`, {}) || DEFAULT_RATIOS[band] || 8;

    const monthlyCost = (hc, salary) => Math.round(hc * (salary / 12) * loadFactor);
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
      // Group-level roles
      if (hcExec > 0)  emit(null, t, 'executive',      `Executives (${hcExec})`,       hcExec,  monthlyCost(hcExec, sal.executive));
      if (hcSrMgr > 0) emit(null, t, 'senior_manager', `Senior managers (${hcSrMgr})`, hcSrMgr, monthlyCost(hcSrMgr, sal.senior_manager));
      if (hcAdmin > 0) emit(null, t, 'admin',          `Admin (${hcAdmin})`,           hcAdmin, monthlyCost(hcAdmin, sal.admin));

      let groupRequiredTotal = 0;
      let groupProvidedTotal = 0;

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

        // Direct staff: required per band, then ENTITY-LEVEL allocation by mix.
        // This avoids the floor-rounding skew you saw.
        const childMap = ctx.childrenAttending?.[e.key] || {};
        const reqByBand = {};
        let totalReq = 0;
        for (const band of AGE_BANDS_LIST) {
          const children = childMap[band]?.[t] ?? 0;
          const ratio = ratios[band];
          const required = (ratio > 0 && children > 0) ? Math.ceil(children / ratio) : 0;
          reqByBand[band] = required;
          totalReq += required;
        }
        practitionersByEntity[e.key] ||= [];
        practitionersByEntity[e.key][t] = totalReq;

        // Apply over-staffing buffer (default 0% = manage strictly to ratio).
        // The inflated total drives HC allocation; reqByBand still defines
        // the band shape for distribution, so we keep the same age-mix.
        const totalStaffed = Math.ceil(totalReq * (1 + overstaffPct));

        // Allocate at entity level, with proper rounding (round + residual)
        const hcSeniorTotal = Math.round(totalStaffed * seniorPct);
        const hcQualTotal   = Math.round(totalStaffed * qualifiedPct);
        const hcAppTotal    = Math.max(0, totalStaffed - hcSeniorTotal - hcQualTotal);

        // Distribute back to bands proportional to band requirement.
        // Per-band emit retains the age_band tag for the dashboard split.
        const distribute = (totalHc, role, salary) => {
          if (totalHc === 0 || totalReq === 0) return;
          const monthlyPer = (salary / 12) * loadFactor;
          let allocated = 0;
          // Largest-remainder method: integer floors per band, then top-up
          // the largest residuals until we've allocated the whole total.
          const pieces = AGE_BANDS_LIST.map(band => {
            const exact = totalHc * (reqByBand[band] / totalReq);
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
            emit(e.id, t, role, `${roleLabel(role)} — ${bandLabel(p.band)} (${p.base})`, p.base, cost, p.band);
            allocated += p.base;
          }
        };
        distribute(hcSeniorTotal, 'senior_qualified', sal.senior_qualified);
        distribute(hcQualTotal,   'qualified',        sal.qualified);
        distribute(hcAppTotal,    'apprentice',       sal.apprentice);

        // Provided headcount toward ratio compliance
        let providedEntity = 0;
        if (incl.setting_manager) providedEntity += hcSetting;
        if (incl.assistant_manager) providedEntity += hcAsst;
        if (incl.senior_qualified) providedEntity += hcSeniorTotal;
        if (incl.qualified)        providedEntity += hcQualTotal;
        if (incl.apprentice)       providedEntity += hcAppTotal;

        // Per-entity ratio metrics (used by Capacities view)
        if (totalReq > 0 || providedEntity > 0) {
          const compEntity = totalReq > 0 ? providedEntity / totalReq : 1;
          out.push({ module_key: 'staff', entity_id: e.id, period: t, nominal_type: 'metric.ratio_required', line_label: 'Practitioners required', amount_p: totalReq });
          out.push({ module_key: 'staff', entity_id: e.id, period: t, nominal_type: 'metric.ratio_provided', line_label: 'Practitioners provided', amount_p: providedEntity });
          out.push({ module_key: 'staff', entity_id: e.id, period: t, nominal_type: 'metric.ratio_compliance', line_label: 'Ratio compliance (×)', amount_p: Math.round(compEntity * 10000) });
        }

        groupRequiredTotal += totalReq;
        groupProvidedTotal += providedEntity;
      }

      const compliance = groupRequiredTotal > 0 ? groupProvidedTotal / groupRequiredTotal : 1;
      out.push({ module_key: 'staff', period: t, nominal_type: 'metric.ratio_required',  line_label: 'Practitioners required',  amount_p: groupRequiredTotal });
      out.push({ module_key: 'staff', period: t, nominal_type: 'metric.ratio_provided',  line_label: 'Practitioners provided',  amount_p: groupProvidedTotal });
      out.push({ module_key: 'staff', period: t, nominal_type: 'metric.ratio_compliance',line_label: 'Ratio compliance (×)',   amount_p: Math.round(compliance * 10000) });
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

      // Re-read inclusion flags here (compute()'s `incl` is out of scope).
      const incl = {
        senior_qualified:  ctx.resolve('ratio_inclusion.senior_qualified', {})  >= 1,
        qualified:         ctx.resolve('ratio_inclusion.qualified', {})         >= 1,
        apprentice:        ctx.resolve('ratio_inclusion.apprentice', {})        >= 1,
        setting_manager:   ctx.resolve('ratio_inclusion.setting_manager', {})   >= 1,
        assistant_manager: ctx.resolve('ratio_inclusion.assistant_manager', {}) >= 1,
      };

      // Build the role-inclusion breakdown
      const ROLES = [
        { key: 'senior_qualified',  label: 'Senior qualified',  flag: incl.senior_qualified },
        { key: 'qualified',         label: 'Qualified',         flag: incl.qualified },
        { key: 'apprentice',        label: 'Apprentice',        flag: incl.apprentice },
        { key: 'setting_manager',   label: 'Setting manager',   flag: incl.setting_manager },
        { key: 'assistant_manager', label: 'Assistant manager', flag: incl.assistant_manager },
      ];
      const inList = ROLES.filter(r => r.flag).map(r => r.label).join(', ') || 'none';
      const outList = ROLES.filter(r => !r.flag).map(r => r.label).join(', ') || 'none';

      findings.push({
        severity: 'error',
        code: 'staff.ratio_breach',
        period: worstT,
        message:
          `Statutory ratio breach in ${breaches.length} of ${ctx.periods.length} period${breaches.length !== 1 ? 's' : ''}. ` +
          `Worst at month ${worstT}: only ${provided} practitioners provided when ${required} are required (short by ${shortBy}, ${worstCompliance.toFixed(2)}× cover vs 1.00× statutory). ` +
          `Roles counted toward the ratio: ${inList}. Roles not counted (could be enabled): ${outList}. ` +
          `Fix: in Inputs → Drivers → staff, flip ratio_inclusion.<role> flags to 1 to include more roles (apprentices count ½-FTE in practice but the model treats inclusion as binary), increase the per-site setting / assistant manager headcount, or rebalance the direct mix % toward more senior/qualified vs apprentice.`,
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
