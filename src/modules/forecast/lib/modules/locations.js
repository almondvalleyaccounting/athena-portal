// Locations module — entity declarations + occupancy ramp + Scottish
// August cohort dynamics.
//
// Each calendar August (when the new academic year starts in Scotland):
//   ▸ 0-2 room: a share of children (default 50%) AGE UP into 2-3 room.
//     They don't leave the setting — they free up 0-2 spots and fill
//     2-3 spots.
//   ▸ 2-3 room: a share (default 50%) ages up into 3-5.
//   ▸ 3-5 room: a share (default 33%) leaves for primary school. Of
//     those leavers, a share (default 50%) re-enrols at the same setting
//     for after-school care.
//   ▸ After-school care covers ages 6-12 (P2 → P7); 1/7 leave each
//     August as P7s graduate to high school (≈ 14%).
//
// Net effect: smaller dips than naive "X% leave" because move-ups from
// the band below partially refill the band above. The dip-stack model
// applies a refill curve back to the base ramp over `refill_months`.

import { curveForBand, occupancyOnCurve } from '../occupancy.js';

const AGE_BANDS = ['babies', 'twos', 'three_to_five', 'after_school'];

export const AGE_BAND_LABELS = {
  babies:        '0-2',
  twos:          '2-3',
  three_to_five: '3-5',
  after_school:  'After-school',
};
export const bandLabel = (key) => AGE_BAND_LABELS[key] || key;

export const locationsModule = {
  key: 'locations',
  pack: ['childcare_scotland'],
  dependsOn: [],
  drivers: [
    // ── Per-band capacity ramp ────────────────────────────────────
    // Each age band has its own opening %, target %, and phase-up
    // window. These define the utilisation curve for GREENFIELD sites.
    // Acquired sites (going concern or empty premises) use their own
    // entity-config start/target/ramp instead — see lib/occupancy.js.
    //
    // Two scopes per key: the GROUP row is the default; the entity-
    // scoped row overrides it PER LOCATION (blank = group default) —
    // different settings have different capacities and ramp-ups.
    ...AGE_BANDS.flatMap(b => ([
      { key: `capacity.opening_pct.${b}`,      label: `Capacity at opening — ${AGE_BAND_LABELS[b]} (default all locations)`, unit: 'pct',   kind: 'scalar', scope: 'group', defaultValue: defaultOpeningPct(b) },
      { key: `capacity.opening_pct.${b}`,      label: `Capacity at opening — ${AGE_BAND_LABELS[b]} — this location (blank = default)`, unit: 'pct', kind: 'scalar', scope: 'entity', defaultValue: null },
      { key: `capacity.target_pct.${b}`,       label: `Capacity target — ${AGE_BAND_LABELS[b]} (default all locations)`,     unit: 'pct',   kind: 'scalar', scope: 'group', defaultValue: defaultTargetPct(b) },
      { key: `capacity.target_pct.${b}`,       label: `Capacity target — ${AGE_BAND_LABELS[b]} — this location (blank = default)`, unit: 'pct', kind: 'scalar', scope: 'entity', defaultValue: null },
      { key: `capacity.phase_up_months.${b}`,  label: `Phase-up to target — ${AGE_BAND_LABELS[b]} (months, default all locations)`, unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 6 },
      { key: `capacity.phase_up_months.${b}`,  label: `Phase-up to target — ${AGE_BAND_LABELS[b]} (months) — this location (blank = default)`, unit: 'count', kind: 'scalar', scope: 'entity', defaultValue: null },
    ])),

    // ── Cohort flow shares ────────────────────────────────────────
    // 0-2 → 2-3 and 2-3 → 3-5 are CONTINUOUS turnover (children move
    // room on their birthday, backfilled by rolling intake) — modelled
    // as a steady flow inside the base ramp curve with no drivers: the
    // old informational move-up drivers were dead inputs and have been
    // removed.
    //
    // The 3-5 → primary school transition IS a real August event in
    // Scotland (children all start P1 at the same time). It triggers
    // an occupancy dip on the 3-5 band that refills over the
    // configurable refill window.
    // 3-5: share leaving for school (those starting P1)
    { key: 'cohort.school_leaver_three_to_five_pct', label: 'Aug school leavers — 3-5 % (start P1)',  unit: 'pct', kind: 'scalar', scope: 'group', defaultValue: 33 },
    // Of school leavers, share that continues at after-school care at the same setting
    { key: 'cohort.school_to_as_pct',          label: 'Aug school leavers continuing in AS care %', unit: 'pct',   kind: 'scalar', scope: 'group', defaultValue: 50 },
    // After-school leavers (P7 → S1, ~1/7)
    { key: 'cohort.as_leaver_pct',             label: 'Aug AS leavers % (P7 → S1, ~1/7)',         unit: 'pct',   kind: 'scalar', scope: 'group', defaultValue: 14 },
    // Refill window
    { key: 'cohort.refill_months',             label: 'Refill window (months back to capacity)',  unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 6 },

    // ── Per-VERSION ramp overrides (per location) ─────────────────
    // The location's default ramp (start/target/months) lives in entity
    // config, which is forecast-level and therefore shared by every
    // version. These entity-scoped drivers override it per version —
    // leave blank to use the location default. defaultValue null means
    // seeding creates the (blank) rows without values.
    { key: 'ramp.starting_occupancy_pct', label: 'Ramp override — opening occupancy % (blank = location default)', unit: 'pct',   kind: 'scalar', scope: 'entity', defaultValue: null },
    { key: 'ramp.target_occupancy_pct',   label: 'Ramp override — target occupancy % (blank = location default)',  unit: 'pct',   kind: 'scalar', scope: 'entity', defaultValue: null },
    { key: 'ramp.months_to_target',       label: 'Ramp override — months to target (blank = location default)',    unit: 'count', kind: 'scalar', scope: 'entity', defaultValue: null },
  ],
  outputs: [
    // Per-entity, per-band occupancy — the number every view reads.
    // amount_p = percent × 100 (85.25% → 8525); tags.age_band set.
    { nominal_type: 'metric.occupancy_pct', label: 'Occupancy %', by_entity: true },
  ],

  compute(ctx) {
    // Calendar month of forecast start (0 = Jan, 7 = Aug)
    const opening = new Date(ctx.forecast.opening_period);
    const startMonthIdx = isNaN(opening.getTime()) ? 0 : opening.getMonth();

    const refillMonths = Math.max(1, Math.round(ctx.resolve('cohort.refill_months', {}) || 6));
    const moveup = {
      three_to_five: (ctx.resolve('cohort.school_leaver_three_to_five_pct', {}) || 0) / 100,
      after_school:  (ctx.resolve('cohort.as_leaver_pct', {})     || 0) / 100,
    };
    const schoolToAsShare = (ctx.resolve('cohort.school_to_as_pct', {}) || 0) / 100;

    // Per-band group ramp drivers
    const groupCurve = {};
    for (const band of AGE_BANDS) {
      groupCurve[band] = {
        opening: ctx.resolve(`capacity.opening_pct.${band}`, {}) ?? defaultOpeningPct(band),
        target:  ctx.resolve(`capacity.target_pct.${band}`, {})  ?? defaultTargetPct(band),
        phase:   ctx.resolve(`capacity.phase_up_months.${band}`, {}) ?? 6,
      };
    }

    const map = {};
    const out = [];

    for (const e of ctx.entities) {
      const cfg = e.config || {};
      const opn = cfg.opening_month_offset ?? 0;
      const cap = cfg.capacity_by_age_band || {};

      // Per-VERSION ramp overrides — entity-scoped drivers, read directly
      // (not via resolve(), which can't distinguish "no value" from 0).
      const readOverride = (key) => {
        const d = ctx.findDriver(key, e.key);
        if (!d) return null;
        const vs = ctx.driverValuesById?.get(d.id) || [];
        const hit = vs.find(v => v.period === -1) || vs[0];
        return hit != null && hit.value !== '' && hit.value != null ? Number(hit.value) : null;
      };
      const override = {
        start:  readOverride('ramp.starting_occupancy_pct'),
        target: readOverride('ramp.target_occupancy_pct'),
        months: readOverride('ramp.months_to_target'),
      };

      // Per-band ramp curves — shared helper (lib/occupancy.js).
      // Acquired sites (going concern or empty premises) use the entity's
      // own start/target/ramp config; greenfield uses the band curve —
      // per-LOCATION band values when set, group defaults otherwise.
      // The site-level ramp.* overrides beat everything.
      const curveByBand = {};
      for (const band of AGE_BANDS) {
        const bandCurve = {
          opening: readOverride(`capacity.opening_pct.${band}`)     ?? groupCurve[band].opening,
          target:  readOverride(`capacity.target_pct.${band}`)      ?? groupCurve[band].target,
          phase:   readOverride(`capacity.phase_up_months.${band}`) ?? groupCurve[band].phase,
        };
        curveByBand[band] = curveForBand(e, band, bandCurve, override);
      }

      // Base ramp curve per band — quadratic ease-out from start to target
      const baseAt = (band, t) => occupancyOnCurve(curveByBand[band], opn, t);

      // Per-band dip stack. Each dip = % shortfall from base curve at time t,
      // refilling linearly to zero over refill_months.
      const dips = { babies: [], twos: [], three_to_five: [], after_school: [] };
      const dipAt = (band, t) => {
        let s = 0;
        for (const d of dips[band]) {
          const since = t - d.t;
          if (since < 0 || since >= refillMonths) continue;
          s += d.amount * (1 - since / refillMonths);
        }
        return s;
      };

      // Per-band occupancy series
      const byBand = {};
      for (const band of AGE_BANDS) byBand[band] = [];

      for (const t of ctx.periods) {
        if (t < opn) {
          for (const band of AGE_BANDS) byBand[band][t] = 0;
          continue;
        }

        const calMonth = (startMonthIdx + t) % 12;
        const isAugust = calMonth === 7;

        if (isAugust) {
          // Pre-event occupancy% per band (post-dip, on each band's own curve)
          const preOcc = {};
          for (const band of AGE_BANDS) {
            preOcc[band] = Math.max(0, baseAt(band, t) - dipAt(band, t));
          }
          const preCount = {};
          for (const band of AGE_BANDS) {
            preCount[band] = (cap[band] || 0) * (preOcc[band] / 100);
          }
          // GENUINE August events:
          //   - 3-5 → primary school (Scottish school-year transition)
          //   - after-school → senior school (P7 → S1, ~1/7 each year)
          // ROLLING transitions (modelled as continuous, no Aug shock):
          //   - 0-2 → 2-3 (children turn 2 throughout the year)
          //   - 2-3 → 3-5 (children turn 3 throughout the year)
          // For the rolling transitions we still want to inflate the
          // *receiving* band by the implied annual flow because intake
          // is continuous — that's modelled via the base ramp curve
          // already, so we don't book any movement here.
          const movedUp = {
            babies:        0,
            twos:          0,
            three_to_five: preCount.three_to_five * moveup.three_to_five,  // school leavers
            after_school:  preCount.after_school  * moveup.after_school,    // P7 leavers
          };
          // Arrivals from genuine Aug cohort moves only:
          //   - after_school receives the share of school leavers continuing here
          // 2-3 and 3-5 don't receive a step inflow because the corresponding
          // departures from the band below are continuous, not annual.
          const arrived = {
            babies: 0,
            twos: 0,
            three_to_five: 0,
            after_school: movedUp.three_to_five * schoolToAsShare,
          };
          const postCount = {};
          for (const band of AGE_BANDS) {
            const c = preCount[band] - movedUp[band] + arrived[band];
            postCount[band] = Math.max(0, Math.min(c, cap[band] || 0));
          }
          for (const band of AGE_BANDS) {
            const newOcc = (cap[band] || 0) > 0 ? (postCount[band] / cap[band]) * 100 : 0;
            const dip = baseAt(band, t) - newOcc;
            if (Math.abs(dip) > 0.001) dips[band].push({ t, amount: dip });
          }
        }

        for (const band of AGE_BANDS) {
          const occ = Math.max(0, Math.min(100, baseAt(band, t) - dipAt(band, t)));
          byBand[band][t] = occ;
        }
      }

      map[e.key] = byBand;

      // Persist occupancy so every view reads the engine's number
      // (including August dips) instead of re-deriving the curve.
      for (const band of AGE_BANDS) {
        if ((cap[band] || 0) === 0) continue;
        for (const t of ctx.periods) {
          out.push({
            module_key: 'locations', entity_id: e.id, period: t,
            nominal_type: 'metric.occupancy_pct',
            line_label: `Occupancy — ${AGE_BAND_LABELS[band]}`,
            amount_p: Math.round(byBand[band][t] * 100),
            tags: { age_band: band },
          });
        }
      }
    }

    ctx.occupancyPct = map;
    return out;
  },
};

function defaultOpeningPct(band) {
  // Greenfield day-one capacity assumptions vary by band.
  // Lower for 0-2 (parents commit later); high for 3-5 (1140-funded demand).
  switch (band) {
    case 'babies':        return 30;
    case 'twos':          return 40;
    case 'three_to_five': return 60;
    case 'after_school':  return 30;
    default: return 40;
  }
}
function defaultTargetPct(band) {
  switch (band) {
    case 'babies':        return 85;
    case 'twos':          return 90;
    case 'three_to_five': return 95;
    case 'after_school':  return 70;
    default: return 85;
  }
}

export const AGE_BANDS_LIST = AGE_BANDS;
