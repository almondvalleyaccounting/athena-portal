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
    // Cohort flow shares — % of each band's children who age up at end of
    // each Scottish school year (August).
    { key: 'cohort.moveup_babies_pct',         label: 'Aug move-up — 0-2 → 2-3 %',                unit: 'pct',   kind: 'scalar', scope: 'group', defaultValue: 50 },
    { key: 'cohort.moveup_twos_pct',           label: 'Aug move-up — 2-3 → 3-5 %',                unit: 'pct',   kind: 'scalar', scope: 'group', defaultValue: 50 },
    // 3-5: share leaving for school (those starting P1)
    { key: 'cohort.school_leaver_three_to_five_pct', label: 'Aug school leavers — 3-5 % (start P1)',  unit: 'pct', kind: 'scalar', scope: 'group', defaultValue: 33 },
    // Of school leavers, share that continues at after-school care at the same setting
    { key: 'cohort.school_to_as_pct',          label: 'Aug school leavers continuing in AS care %', unit: 'pct',   kind: 'scalar', scope: 'group', defaultValue: 50 },
    // After-school leavers (P7 → S1, ~1/7)
    { key: 'cohort.as_leaver_pct',             label: 'Aug AS leavers % (P7 → S1, ~1/7)',         unit: 'pct',   kind: 'scalar', scope: 'group', defaultValue: 14 },
    // Refill window
    { key: 'cohort.refill_months',             label: 'Refill window (months back to capacity)',  unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 6 },
  ],
  outputs: [],

  compute(ctx) {
    // Calendar month of forecast start (0 = Jan, 7 = Aug)
    const opening = new Date(ctx.forecast.opening_period);
    const startMonthIdx = isNaN(opening.getTime()) ? 0 : opening.getMonth();

    const refillMonths = Math.max(1, Math.round(ctx.resolve('cohort.refill_months', {}) || 6));
    const moveup = {
      babies:        (ctx.resolve('cohort.moveup_babies_pct', {}) || 0) / 100,
      twos:          (ctx.resolve('cohort.moveup_twos_pct', {})   || 0) / 100,
      three_to_five: (ctx.resolve('cohort.school_leaver_three_to_five_pct', {}) || 0) / 100,
      after_school:  (ctx.resolve('cohort.as_leaver_pct', {})     || 0) / 100,
    };
    const schoolToAsShare = (ctx.resolve('cohort.school_to_as_pct', {}) || 0) / 100;

    const map = {};

    for (const e of ctx.entities) {
      const cfg = e.config || {};
      const opn = cfg.opening_month_offset ?? 0;
      const ramp = cfg.ramp_to_target_months ?? 18;
      const target = cfg.target_occupancy_pct ?? 85;
      const start = cfg.starting_occupancy_pct ??
        (cfg.acquisition_type === 'acquired_going_concern' ? 70 : 0);
      const cap = cfg.capacity_by_age_band || {};

      // Base ramp curve (no cohort events) — same for every band
      const baseAt = (t) => {
        if (t < opn) return 0;
        const tIn = t - opn;
        if (tIn === 0) return start;
        if (tIn >= ramp) return target;
        const frac = tIn / ramp;
        const eased = 1 - Math.pow(1 - frac, 2);
        return Math.max(0, Math.min(100, start + (target - start) * eased));
      };

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
          // Compute pre-event occupancy% per band
          const preOcc = {};
          for (const band of AGE_BANDS) {
            preOcc[band] = Math.max(0, baseAt(t) - dipAt(band, t));
          }

          // Convert to children counts
          const preCount = {};
          for (const band of AGE_BANDS) {
            preCount[band] = (cap[band] || 0) * (preOcc[band] / 100);
          }

          // Move-ups (these CHILDREN leave the source band)
          const movedUp = {
            babies:        preCount.babies        * moveup.babies,
            twos:          preCount.twos          * moveup.twos,
            three_to_five: preCount.three_to_five * moveup.three_to_five,  // leaving for school
            after_school:  preCount.after_school  * moveup.after_school,
          };

          // Arrivals: who lands in each room
          //   2-3 receives all 0-2 move-ups
          //   3-5 receives all 2-3 move-ups
          //   AS receives a share of 3-5 school-leavers
          const arrived = {
            babies: 0,
            twos: movedUp.babies,
            three_to_five: movedUp.twos,
            after_school: movedUp.three_to_five * schoolToAsShare,
          };

          // Post-event children counts (clamp to capacity if arrivals exceed)
          const postCount = {};
          for (const band of AGE_BANDS) {
            const c = preCount[band] - movedUp[band] + arrived[band];
            postCount[band] = Math.max(0, Math.min(c, cap[band] || 0));
          }

          // New occupancy% per band, and dip vs base
          const baseNow = baseAt(t);
          for (const band of AGE_BANDS) {
            const newOcc = (cap[band] || 0) > 0 ? (postCount[band] / cap[band]) * 100 : 0;
            // Dip = base - newOcc (positive ⇒ shortfall)
            const dip = baseNow - newOcc;
            if (Math.abs(dip) > 0.001) dips[band].push({ t, amount: dip });
          }
        }

        // Compute current occupancy after applying dips
        for (const band of AGE_BANDS) {
          const occ = Math.max(0, Math.min(100, baseAt(t) - dipAt(band, t)));
          byBand[band][t] = occ;
        }
      }

      map[e.key] = byBand;
    }

    ctx.occupancyPct = map;
    return [];
  },
};

export const AGE_BANDS_LIST = AGE_BANDS;
