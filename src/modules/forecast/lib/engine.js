// Forecast calc engine.
//
// Resolves drivers (scalar / timeseries / linked), runs each module's
// compute() in dependency order, materialises outputs into fc_output,
// emits findings into fc_finding.
//
// Solo-user, synchronous recompute. ~1-2s for one forecast is fine.

import { parse, evaluate, refsOf } from './expr.js';

// ── Module contract ──────────────────────────────────────────────
//
// A ModuleSpec is a plain JS object:
//
// {
//   key: 'services_childcare',
//   pack: ['childcare_scotland'],
//   dependsOn: ['locations'],
//   drivers: [
//     { key: 'weekly_rate.babies', label: 'Weekly rate — babies',
//       unit: 'gbp_p', kind: 'scalar', scope: 'entity', defaultValue: 30000 },
//     ...
//   ],
//   outputs: [
//     { nominal_type: 'revenue', label: 'Babies fees', by_entity: true },
//     ...
//   ],
//   compute: (ctx) => OutputRow[],
//   validate: (ctx) => Finding[],
// }
//
// OutputRow:
//   { period, entity_id?, nominal_type, line_label, amount_p, tags? }

// ── Topological sort of modules ──────────────────────────────────

function topoSort(modules) {
  const byKey = new Map(modules.map(m => [m.key, m]));
  const visited = new Set();
  const inProgress = new Set();
  const order = [];

  function visit(key) {
    if (visited.has(key)) return;
    if (inProgress.has(key)) throw new Error(`Module dependency cycle at '${key}'`);
    const m = byKey.get(key);
    if (!m) throw new Error(`Unknown module '${key}' in dependsOn`);
    inProgress.add(key);
    for (const dep of m.dependsOn || []) visit(dep);
    inProgress.delete(key);
    visited.add(key);
    order.push(m);
  }

  for (const m of modules) visit(m.key);
  return order;
}

// ── Driver resolution ────────────────────────────────────────────
//
// Drivers are loaded for the active scenario. If a base scenario exists
// for the same version and a driver is missing in the active scenario,
// we fall back to the base. The caller pre-merges these into a single
// flat array; this engine just indexes them.

function indexDrivers(drivers) {
  // Index by (entity_id|null, module_key, driver_key) -> driver row
  const byTriple = new Map();
  // And by (driver_key) for cross-module lookups (e.g. linked refs by short key)
  const byKey = new Map();

  for (const d of drivers) {
    const e = d.entity_id || '__group__';
    byTriple.set(`${e}::${d.module_key}::${d.driver_key}`, d);

    // also bare key (entity-scoped if entity present)
    const bareKey = d.driver_key;
    if (!byKey.has(bareKey)) byKey.set(bareKey, []);
    byKey.get(bareKey).push(d);
  }

  return { byTriple, byKey };
}

// Build a memoising resolver that evaluates linked drivers lazily and
// caches results per (driver_id, entity_id, period).
function buildResolver({ index, drivers, computedCache, valuesByDriverId, horizonMonths, modulesByKey }) {
  // Stack to detect cycles in linked-driver evaluation
  const evalStack = new Set();

  /** Look up driver row by short key, optionally entity-scoped. */
  function findDriver(key, entity) {
    const candidates = index.byKey.get(key) || [];
    if (candidates.length === 0) return null;
    // Prefer entity-scoped match if entity is provided
    if (entity) {
      const m = candidates.find(d => d.entity_id && d.entity_key === entity);
      if (m) return m;
    }
    // Fall back to group-scope (entity_id NULL)
    const grp = candidates.find(d => !d.entity_id);
    if (grp) return grp;
    // Fall back to first candidate
    return candidates[0];
  }

  function resolve(key, opts = {}) {
    const period = opts.period;
    const entity = opts.entity;

    const driver = findDriver(key, entity);
    if (!driver) return 0;

    const cacheKey = `${driver.id}::${entity || ''}::${period ?? ''}`;
    if (computedCache.has(cacheKey)) return computedCache.get(cacheKey);

    if (evalStack.has(cacheKey)) {
      throw new Error(`Driver expression cycle through '${key}' (entity=${entity}, period=${period})`);
    }
    evalStack.add(cacheKey);

    let result;
    try {
      if (driver.kind === 'scalar') {
        const vs = valuesByDriverId.get(driver.id) || [];
        result = vs.length ? Number(vs[0].value) : 0;
      } else if (driver.kind === 'timeseries') {
        const vs = valuesByDriverId.get(driver.id) || [];
        const hit = vs.find(v => v.period === period);
        result = hit ? Number(hit.value) : 0;
      } else if (driver.kind === 'linked') {
        if (!driver.expression) {
          result = 0;
        } else {
          const ast = driver._ast || (driver._ast = parse(driver.expression));
          result = evaluate(ast, { period, entity, resolve });
        }
      } else {
        result = 0;
      }
    } finally {
      evalStack.delete(cacheKey);
    }

    computedCache.set(cacheKey, result);
    return result;
  }

  return resolve;
}

// ── Main entry point ─────────────────────────────────────────────

/**
 * Run all modules and return outputs + findings.
 *
 * @param {object} args
 * @param {object} args.forecast - { id, vertical_pack, horizon_months, opening_period }
 * @param {Array} args.modules - ModuleSpec[] for the active pack
 * @param {Array} args.entities - fc_entity rows (with config jsonb parsed)
 * @param {Array} args.drivers - fc_driver rows MERGED with base-scenario fallback,
 *                                each augmented with `entity_key` (if entity_id set)
 * @param {Array} args.driverValues - fc_driver_value rows
 * @returns {{ outputs: OutputRow[], findings: Finding[] }}
 */
export function runForecast({ forecast, modules, entities, drivers, driverValues, loans, plLines }) {
  const ordered = topoSort(modules);
  const modulesByKey = new Map(ordered.map(m => [m.key, m]));

  const valuesByDriverId = new Map();
  for (const v of driverValues) {
    const arr = valuesByDriverId.get(v.driver_id) || [];
    arr.push(v);
    valuesByDriverId.set(v.driver_id, arr);
  }

  const index = indexDrivers(drivers);
  const computedCache = new Map();

  const resolve = buildResolver({
    index, drivers, computedCache, valuesByDriverId,
    horizonMonths: forecast.horizon_months,
    modulesByKey,
  });

  const ctx = {
    forecast,
    entities,
    drivers,                    // full merged driver list (so modules can discover custom drivers)
    driverValuesById: valuesByDriverId,    // direct value lookup for modules iterating drivers
    loans: loans || [],
    plLines: plLines || [],      // fc_pl_line rows — the general cashflow lens
    horizonMonths: forecast.horizon_months,
    periods: range(0, forecast.horizon_months),
    resolve,
    findDriver: (key, entity) => index.byKey.get(key)?.find(d =>
      entity ? d.entity_key === entity : !d.entity_id
    ) || null,
    upstreamOutputs: [],   // outputs accumulated so far from prior modules
  };

  const outputs = [];
  const findings = [];

  for (const mod of ordered) {
    let modOutputs = [];
    try {
      modOutputs = mod.compute(ctx) || [];
    } catch (err) {
      findings.push({
        severity: 'error',
        code: `module.${mod.key}.compute_failed`,
        message: `${mod.key} compute failed: ${err.message}`,
      });
      continue;
    }
    outputs.push(...modOutputs);
    ctx.upstreamOutputs.push(...modOutputs);

    if (mod.validate) {
      try {
        const f = mod.validate(ctx) || [];
        findings.push(...f);
      } catch (err) {
        findings.push({
          severity: 'error',
          code: `module.${mod.key}.validate_failed`,
          message: `${mod.key} validation failed: ${err.message}`,
        });
      }
    }
  }

  return { outputs, findings };
}

function range(from, count) {
  const r = [];
  for (let i = from; i < from + count; i++) r.push(i);
  return r;
}

// Helper for modules: sum upstream outputs filtered by a predicate
export function sumOutputs(outputs, predicate) {
  let sum = 0;
  for (const o of outputs) if (predicate(o)) sum += o.amount_p;
  return sum;
}

// Helper to convert GBP -> pence (avoids float drift in modules)
export const toPence = (gbp) => Math.round(gbp * 100);
export const fromPence = (p) => p / 100;
