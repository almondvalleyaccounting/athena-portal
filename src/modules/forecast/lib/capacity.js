// Registered places per age band — the ONE place the effective-capacity rule
// lives.
//
// `fc_entity` is forecast-level, so its `config.capacity_by_age_band` is shared
// by every version. That made capacity impossible to vary per scenario: editing
// the room split in one version silently rewrote it for all of them. The split
// is now overridable per version through entity-scoped `capacity.places.<band>`
// drivers (which live on the scenario), with the entity config as the location's
// default.
//
// Two callers need the same answer:
//   • the engine — resolves the drivers directly (locations.js)
//   • every view/export — gets entities already overlaid at load time, so the
//     ~40 places that read `config.capacity_by_age_band` stay correct untouched
// Both go through placesForBand() so they can't drift apart.

/**
 * Effective places for one entity/band.
 * @param {object} entity fc_entity row
 * @param {string} band age band key
 * @param {number|string|null|undefined} override per-version value; null/'' = use default
 */
export function placesForBand(entity, band, override) {
  if (override != null && override !== '') {
    const n = Number(override);
    if (!Number.isNaN(n)) return n;
  }
  return Number(entity?.config?.capacity_by_age_band?.[band] || 0);
}

/**
 * Return `entities` with each one's capacity_by_age_band replaced by the
 * effective split for this version. Entities without an override are returned
 * unchanged (same object identity, so React memo deps stay stable).
 *
 * @param {Array} entities
 * @param {Object} overridesByEntityId { [entity_id]: { [band]: value } }
 */
export function withEffectiveCapacity(entities, overridesByEntityId) {
  if (!overridesByEntityId || Object.keys(overridesByEntityId).length === 0) return entities;
  return (entities || []).map(e => {
    const ov = overridesByEntityId[e.id];
    if (!ov) return e;
    const current = e.config?.capacity_by_age_band || {};
    const next = { ...current };
    let changed = false;
    // Union of bands the location declares and bands the override touches —
    // avoids importing the band list (locations.js imports this module).
    for (const band of new Set([...Object.keys(current), ...Object.keys(ov)])) {
      const v = placesForBand(e, band, ov[band]);
      if (v !== Number(current[band] || 0)) { next[band] = v; changed = true; }
    }
    return changed ? { ...e, config: { ...(e.config || {}), capacity_by_age_band: next } } : e;
  });
}
