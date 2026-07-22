// Occupancy ramp curve — single source of truth.
//
// The engine (locations.js) computes each entity+band's occupancy from
// this curve (plus August cohort dips) and persists it as
// `metric.occupancy_pct` output rows (amount_p = percent × 100, so
// 85.25% → 8525). Views must read those rows — see buildOccupancyIndex —
// rather than re-deriving the curve, so every surface shows exactly what
// the P&L was computed from, including the August dips the raw curve
// doesn't model.
//
// The curve functions below exist for the places that need the shape
// itself: the engine, and pre-output contexts (drill-down explainers,
// PDF export fallback).

export const ACQUIRED_TYPES = new Set(['acquired_going_concern', 'acquired_empty']);

/**
 * Ramp curve for one entity+band.
 *
 * Acquired sites — going concern OR empty premises — use the site-level
 * start / target / ramp from entity config: the operator knows the site's
 * actual starting position, and the Edit-location modal collects exactly
 * these three fields. Greenfield sites use the group per-band phase-up
 * drivers (0-2 fills slower than 3-5, etc.).
 *
 * @param {object} entity fc_entity row (config jsonb parsed)
 * @param {string} band age band key
 * @param {{opening?:number, target?:number, phase?:number}} groupCurve
 *   resolved group drivers for this band (capacity.opening_pct.<band> etc.)
 * @returns {{start:number, target:number, ramp:number}}
 */
export function curveForBand(entity, band, groupCurve) {
  const cfg = entity?.config || {};
  if (ACQUIRED_TYPES.has(cfg.acquisition_type)) {
    return {
      start:  cfg.starting_occupancy_pct ?? (cfg.acquisition_type === 'acquired_going_concern' ? 70 : 40),
      target: cfg.target_occupancy_pct ?? groupCurve?.target ?? 85,
      ramp:   Math.max(1, cfg.ramp_to_target_months ?? groupCurve?.phase ?? 6),
    };
  }
  return {
    start:  groupCurve?.opening ?? 40,
    target: groupCurve?.target ?? 85,
    ramp:   Math.max(1, groupCurve?.phase ?? 6),
  };
}

/**
 * Occupancy % on a curve at a forecast period — quadratic ease-out from
 * start to target over `ramp` months, anchored at the entity's opening
 * month. 0 before opening.
 */
export function occupancyOnCurve(curve, openingOffset, period) {
  if (period < openingOffset) return 0;
  const tIn = period - openingOffset;
  if (tIn === 0) return curve.start;
  if (tIn >= curve.ramp) return curve.target;
  const frac = tIn / curve.ramp;
  const eased = 1 - Math.pow(1 - frac, 2);
  return Math.max(0, Math.min(100, curve.start + (curve.target - curve.start) * eased));
}

/**
 * Index engine-emitted `metric.occupancy_pct` rows for O(1) lookup.
 * Build once per render (useMemo on outputs); read with occKey().
 * Values are percent (0–100).
 */
export function buildOccupancyIndex(outputs) {
  const m = new Map();
  for (const r of outputs || []) {
    if (r.nominal_type !== 'metric.occupancy_pct') continue;
    m.set(occKey(r.entity_id, r.tags?.age_band, r.period), r.amount_p / 100);
  }
  return m;
}

export const occKey = (entityId, band, period) => `${entityId}::${band}::${period}`;
