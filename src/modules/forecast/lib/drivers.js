// Driver-presence helpers.
//
// `ctx.resolve(key)` returns 0 for a driver that is missing AND for one the
// user deliberately set to 0, so the idiom `resolve(key) || default` silently
// discards an explicit zero. That cost us real money once: Puddleduck had
// deposit_weeks = 0 ("we take no deposits"), got the 4-week default, and the
// forecast booked £74.9k of parent-deposit cash that does not exist.
//
// `resolveOr` separates the two cases: it falls back to the default only when
// the driver genuinely has no value behind it.
//
// Use it where a zero is a legitimate answer to the question the driver asks
// ("how many months' lag?" → none). Where zero is nonsense or divides by zero
// ("how many operating weeks a year?"), keep the plain `resolve(...) || d`
// guard and say why in a comment — that override is deliberate, not an
// oversight.

/**
 * Is this driver actually set — i.e. would a 0 from resolve() be the user's
 * answer rather than the resolver's shrug?
 *
 * A driver row alone isn't enough: seeding creates rows for every declared
 * key, and one with no value row is unanswered. Linked drivers count as set
 * when they carry an expression to evaluate.
 *
 * Entity precedence mirrors resolve(): entity-scoped row first, then group.
 * Unlike resolve() we do NOT fall back to some other entity's row — reading
 * one site's value for another is a bug, not a default.
 */
export function driverIsSet(ctx, key, entity) {
  const d = (entity ? ctx.findDriver(key, entity) : null) || ctx.findDriver(key);
  if (!d) return false;
  if (d.kind === 'linked') return Boolean(d.expression);
  const values = ctx.driverValuesById?.get(d.id) || [];
  return values.some(v =>
    v.value != null && v.value !== '' && Number.isFinite(Number(v.value)));
}

/**
 * resolve(key) when the driver is set, `fallback` when it isn't.
 * `opts` is passed through to resolve (e.g. { entity, period }).
 */
export function resolveOr(ctx, key, fallback, opts = {}) {
  return driverIsSet(ctx, key, opts.entity) ? ctx.resolve(key, opts) : fallback;
}
