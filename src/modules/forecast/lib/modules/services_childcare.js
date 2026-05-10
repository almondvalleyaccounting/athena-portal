// Services — childcare (Scotland).
//
// Drivers (per-entity unless noted):
//   sessions_per_week.{age_band}      — 5 = full week (config)
//   weekly_rate_p.{age_band}          — private weekly fee, pence
//   funded_hours_take_up_pct.{age_band} — % of eligible children using funded hours
//   eligible_for_funded_pct.{age_band}  — % of attending children eligible
//   weeks_per_year                    — operating weeks (typically 50-51)
//   deposit_weeks                     — weeks of deposit held (working capital benefit)
//   advance_billing_weeks             — fees collected this many weeks ahead
//   la_funded_rate_p.{age_band}       — overrideable; fallback to LA lookup
//   topup_per_hour_p.{age_band}       — top-up where allowed
//   children_attending.{age_band}     — LINKED: capacity * occupancy / 100
//
// Outputs:
//   revenue (private fees)
//   revenue (funded hours income)
//   revenue (top-up income, where LA allows)
//   revenue (other — lunches/extras handled by separate sub-driver)
//
// Funded hours mechanics:
//   Scotland 1140 hours/year for eligible 3-5s (and eligible 2yos in some LAs).
//   Modelled as: eligible_children * 1140 / 12 hours per month at LA rate.
//   Children in funded hours are NOT also charged the private fee for those
//   funded hours. Simplification for v1: split each eligible child's revenue
//   between funded portion and private portion based on a fixed split.

import { AGE_BANDS_LIST, bandLabel } from './locations.js';

const FUNDED_BANDS = ['twos', 'three_to_five'];   // Scotland 1140 applies primarily here
const FUNDED_HOURS_PER_YEAR = 1140;

export const servicesChildcareModule = {
  key: 'services_childcare',
  pack: ['childcare_scotland'],
  dependsOn: ['locations'],

  drivers: [
    { key: 'weeks_per_year', label: 'Operating weeks per year', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 51 },
    { key: 'deposit_weeks', label: 'Deposit weeks held', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 4 },
    { key: 'advance_billing_weeks', label: 'Advance billing weeks', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 4 },
    // Per-band scalar drivers — capacity-band-specific rates (entity-scoped if you want
    // per-site variation; otherwise group-level)
    ...AGE_BANDS_LIST.flatMap(band => ([
      { key: `weekly_rate_p.${band}`, label: `Weekly rate (${bandLabel(band)})`, unit: 'gbp_p', kind: 'scalar', scope: 'entity', defaultValue: defaultWeeklyRateP(band) },
      { key: `operating_hours_per_week.${band}`, label: `Operating hours per week (${bandLabel(band)})`, unit: 'hours', kind: 'scalar', scope: 'entity', defaultValue: defaultHoursPerWeek(band) },
      { key: `funded_hours_take_up_pct.${band}`, label: `Funded take-up % (${bandLabel(band)})`, unit: 'pct', kind: 'scalar', scope: 'entity', defaultValue: FUNDED_BANDS.includes(band) ? 80 : 0 },
      { key: `eligible_for_funded_pct.${band}`, label: `Eligible for funded % (${bandLabel(band)})`, unit: 'pct', kind: 'scalar', scope: 'entity', defaultValue: FUNDED_BANDS.includes(band) ? 100 : 0 },
      { key: `la_funded_rate_p.${band}`, label: `LA funded rate £/hr (${bandLabel(band)})`, unit: 'gbp_p', kind: 'scalar', scope: 'entity', defaultValue: 555 },   // ~£5.55/hr default
    ])),
  ],

  outputs: [
    { nominal_type: 'revenue', label: 'Private fees', by_entity: true },
    { nominal_type: 'revenue', label: 'Funded hours income', by_entity: true },
  ],

  compute(ctx) {
    // ── New LA-first hours allocation ─────────────────────────────
    //
    // Per band, per child-week:
    //   max_hours_per_child_per_week = operating_hours_per_week (driver)
    //   LA hours allocation per eligible+take-up child per week:
    //     = FUNDED_HOURS_PER_YEAR / weeks_per_year   (e.g. 1140/51 ≈ 22.35)
    //     capped at max_hours_per_child_per_week
    //   private hours per child per week = max - LA   (≥ 0)
    //
    // Per-period revenue (monthly = weeks_per_year / 12):
    //   LA      = LA_eligible_children × LA_per_child_per_week × monthlyWeeks × LA_rate (£/hr)
    //   Private = (private_per_child_per_week × non-funded_children
    //              + private_remainder_per_funded_child × funded_children)
    //              × monthlyWeeks × hourly_rate
    // where hourly_rate = weekly_rate / max_hours_per_week.

    const out = [];
    const weeks = ctx.resolve('weeks_per_year', {}) || 51;

    for (const e of ctx.entities) {
      const cfg = e.config || {};
      const cap = cfg.capacity_by_age_band || {};
      const occByBand = ctx.occupancyPct?.[e.key] || {};

      for (const band of AGE_BANDS_LIST) {
        const capacity = cap[band] || 0;
        if (capacity === 0) continue;

        const weeklyRate     = ctx.resolve(`weekly_rate_p.${band}`, { entity: e.key });
        const hpw            = ctx.resolve(`operating_hours_per_week.${band}`, { entity: e.key }) || 50;
        const eligiblePct    = ctx.resolve(`eligible_for_funded_pct.${band}`, { entity: e.key });
        const takeupPct      = ctx.resolve(`funded_hours_take_up_pct.${band}`, { entity: e.key });
        const laRate         = ctx.resolve(`la_funded_rate_p.${band}`, { entity: e.key });

        // £/hour for private fees (derived from the weekly rate).
        const hourlyRate = hpw > 0 ? weeklyRate / hpw : 0;
        // LA hours per eligible-take-up child per week, capped at the
        // band's operating window. After-school (15hrs/wk) typically caps
        // below the statutory 22.35 hrs/wk pro-rata.
        const laHoursPerChildPerWeek = Math.min(hpw, FUNDED_HOURS_PER_YEAR / weeks);
        const monthlyWeeks = weeks / 12;

        for (const t of ctx.periods) {
          const occ = (occByBand[band]?.[t] ?? 0) / 100;
          const children = capacity * occ;
          if (children === 0) continue;

          const fundedShare = (eligiblePct / 100) * (takeupPct / 100);
          const fundedChildren = children * fundedShare;
          const nonFundedChildren = children - fundedChildren;

          // Hours per child per week
          const fundedChildPrivateHours = Math.max(0, hpw - laHoursPerChildPerWeek);

          // Per-period totals (per month)
          const laHoursMonthly = fundedChildren * laHoursPerChildPerWeek * monthlyWeeks;
          const privateHoursMonthly =
              nonFundedChildren * hpw * monthlyWeeks
            + fundedChildren * fundedChildPrivateHours * monthlyWeeks;

          const fundedRevenue   = laHoursMonthly      * laRate;
          const privateRevenue  = privateHoursMonthly * hourlyRate;

          if (privateRevenue > 0) {
            out.push({
              module_key: 'services_childcare', entity_id: e.id, period: t,
              nominal_type: 'revenue', line_label: `Private fees — ${bandLabel(band)}`,
              amount_p: Math.round(privateRevenue),
              tags: { age_band: band, revenue_kind: 'private' },
            });
          }
          if (fundedRevenue > 0) {
            out.push({
              module_key: 'services_childcare', entity_id: e.id, period: t,
              nominal_type: 'revenue', line_label: `Funded hours — ${bandLabel(band)}`,
              amount_p: Math.round(fundedRevenue),
              tags: { age_band: band, revenue_kind: 'funded' },
            });
          }
        }
      }
    }

    // Stash children_attending for staff module
    const childrenMap = {};
    for (const e of ctx.entities) {
      const cap = e.config?.capacity_by_age_band || {};
      const occ = ctx.occupancyPct?.[e.key] || {};
      childrenMap[e.key] = {};
      for (const band of AGE_BANDS_LIST) {
        const series = [];
        for (const t of ctx.periods) {
          series[t] = (cap[band] || 0) * ((occ[band]?.[t] ?? 0) / 100);
        }
        childrenMap[e.key][band] = series;
      }
    }
    ctx.childrenAttending = childrenMap;

    return out;
  },
};

function defaultHoursPerWeek(band) {
  // Standard "full-week" hours used to convert weekly fee into £/hour.
  switch (band) {
    case 'babies':        return 50;
    case 'twos':          return 50;
    case 'three_to_five': return 50;
    case 'after_school':  return 15;
    default: return 50;
  }
}

function defaultWeeklyRateP(band) {
  // Reasonable Scottish private nursery defaults, in pence
  switch (band) {
    case 'babies': return 32500;          // £325/week
    case 'twos': return 30000;            // £300/week
    case 'three_to_five': return 28000;   // £280/week
    case 'after_school': return 9000;     // £90/week
    default: return 0;
  }
}
