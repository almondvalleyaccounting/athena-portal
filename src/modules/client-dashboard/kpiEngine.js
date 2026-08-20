/*
  Custom KPI engine.

  Turns entered figures and formulas into a number per bucket, per dimension
  value, on the same month/quarter/year grain the rest of the dashboard uses.

  Three rules decide whether the answers are right, and all three are the kind
  of thing that looks fine on a monthly view and goes quietly wrong the moment
  somebody switches to quarters:

  1. AGGREGATION IS PER-KPI. A quarter's headcount is not three months of
     headcount added up; registered places is the position at the end, not a
     total. Every entry KPI declares sum / average / last / max / min and this
     obeys it.

  2. CALCULATED KPIS ARE RECOMPUTED AFTER THEIR INPUTS AGGREGATE. A quarter's
     occupancy is total children ÷ total places — NOT the mean of three monthly
     percentages, which is only the same number when the denominators happen to
     match. Recomputing is also correct for additive formulas, so it is the
     uniform rule and calculated KPIs carry no aggregation of their own.

  3. THE SAME APPLIES ACROSS DIMENSIONS. Occupancy for the whole nursery is
     total children ÷ total places, not the average of the room percentages.

  Missing is not zero. A month with no figure entered contributes nothing and
  propagates as null, so an empty quarter reads "—" rather than "£0" — the two
  mean very different things to somebody deciding whether to worry.

  Formulas are parsed and evaluated by the forecast engine's expr.js. That
  parser already supports exactly this shape (its own documented example is
  `children_attending[babies] / 3`), and one expression language in Athena beats
  two that drift apart.
*/

import { parse, evaluate, refsOf } from '../forecast/lib/expr';

/* ─── Formatting ───────────────────────────────────────────────── */
export function formatKpi(value, unit, decimals = 0, currency = 'GBP') {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const n = Number(value);
  if (unit === 'money') {
    try {
      return new Intl.NumberFormat('en-GB', {
        style: 'currency', currency: currency || 'GBP', maximumFractionDigits: decimals,
      }).format(n);
    } catch { return `£${n.toFixed(decimals)}`; }
  }
  if (unit === 'percent') return `${n.toFixed(decimals)}%`;
  if (unit === 'ratio') return `${n.toFixed(Math.max(decimals, 1))}`;
  if (unit === 'hours') return `${n.toFixed(decimals)}h`;
  return n.toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/* ─── Aggregating months into a bucket ─────────────────────────── */
// `values` is a map of month key → number. Months with no entry are absent,
// not zero, and an entirely empty bucket returns null.
function aggregateMonths(byMonth, months, how) {
  const present = [];
  for (const m of months) {
    const v = byMonth[m];
    if (v === null || v === undefined || Number.isNaN(Number(v))) continue;
    present.push({ month: m, value: Number(v) });
  }
  if (!present.length) return null;
  switch (how) {
    case 'sum': return present.reduce((s, p) => s + p.value, 0);
    case 'average': return present.reduce((s, p) => s + p.value, 0) / present.length;
    // The latest month that actually has a figure, which is not always the last
    // month of the bucket — a quarter part-entered still has a defensible
    // closing position.
    case 'last': return present[present.length - 1].value;
    case 'max': return Math.max(...present.map((p) => p.value));
    case 'min': return Math.min(...present.map((p) => p.value));
    default: return present.reduce((s, p) => s + p.value, 0);
  }
}

/*
  Combining dimension values within ONE month.

  Almost always a sum: total children is the rooms added together, and so is
  total places. The exception is an entry KPI already expressed as a percentage
  or a ratio per room — adding those gives nonsense, so they average. (Modelling
  a per-room percentage as an entry KPI is usually a mistake anyway; the right
  shape is two entry KPIs and a calculated one over them.)
*/
function combineDimensions(perDimMonthValues, unit) {
  const present = perDimMonthValues.filter((v) => v !== null && v !== undefined && !Number.isNaN(Number(v)));
  if (!present.length) return null;
  const nums = present.map(Number);
  if (unit === 'percent' || unit === 'ratio') {
    return nums.reduce((s, v) => s + v, 0) / nums.length;
  }
  return nums.reduce((s, v) => s + v, 0);
}

/* ─── Formula dependency order ─────────────────────────────────── */
/*
  Calculated KPIs may sit on top of other calculated KPIs, so they have to be
  evaluated in dependency order, and a cycle has to be reported rather than
  hung on. Anything in a cycle is marked and skipped; everything else still
  computes, because one bad formula should not blank the whole tab.
*/
function orderCalculated(defs) {
  const byKey = {};
  for (const d of defs) byKey[d.key] = d;
  const calculated = defs.filter((d) => d.kind === 'calculated');

  const deps = {};
  for (const d of calculated) {
    let refs = [];
    try { refs = refsOf(parse(d.formula)).map((r) => r.key); } catch { refs = []; }
    // Only dependencies on OTHER calculated KPIs constrain the order; entry
    // KPIs and financial figures are already known.
    deps[d.key] = refs.filter((k) => byKey[k]?.kind === 'calculated' && k !== d.key);
  }

  const ordered = [];
  const state = {};   // undefined | 'visiting' | 'done'
  const cyclic = new Set();

  const visit = (key, stack) => {
    if (state[key] === 'done') return;
    if (state[key] === 'visiting') {
      // Everything currently on the stack from this key onwards is in the cycle.
      stack.slice(stack.indexOf(key)).forEach((k) => cyclic.add(k));
      return;
    }
    state[key] = 'visiting';
    for (const dep of deps[key] || []) visit(dep, [...stack, key]);
    state[key] = 'done';
    if (!cyclic.has(key)) ordered.push(byKey[key]);
  };

  for (const d of calculated) visit(d.key, []);
  return { ordered, cyclic };
}

/* ─── Division-by-zero detection ───────────────────────────────── */
/*
  expr.js returns 0 for x / 0 — sensible for a forecast engine, wrong for a KPI.
  A room with no registered places has UNDEFINED occupancy, not 0%, and showing
  0% invites someone to act on a number that means nothing.

  Rather than change shared behaviour the forecast engine depends on, walk the
  tree for division nodes and evaluate their denominators with the same
  resolver. Cheap — these expressions are a handful of nodes.
*/
function hasZeroDenominator(ast, ctx) {
  if (!ast) return false;
  switch (ast.type) {
    case 'binop':
      if (ast.op === 'SLASH') {
        let d;
        try { d = evaluate(ast.right, ctx); } catch { return false; }
        if (d === 0) return true;
      }
      return hasZeroDenominator(ast.left, ctx) || hasZeroDenominator(ast.right, ctx);
    case 'neg': return hasZeroDenominator(ast.expr, ctx);
    case 'call': return (ast.args || []).some((a) => hasZeroDenominator(a, ctx));
    default: return false;
  }
}

// Thrown by the resolver when a referenced figure has not been entered, so a
// formula over missing data yields null instead of a confident zero.
const MISSING = Symbol('kpi-missing');

/* ─── The model ────────────────────────────────────────────────── */
/*
  buildKpiModel({ definitions, dimensionValues, values, buckets, financials })

  definitions     rows from kpi_definitions_for_entity()
  dimensionValues rows from kpi_dimension_value for this client
  values          rows from kpi_value for this client
  buckets         from overviewGrain (each carries `months`: ['2026-04', …])
  financials      (bucketIndex, key) => number | null — the dashboard's own
                  figures (income, net_income, cash…), already aggregated to the
                  same buckets, so `income / children` works

  Returns { rows, byKey, errors } where a row is:
    { definition, total: [n|null per bucket],
      dimensions: [{ value, cells: [n|null per bucket] }],
      error }
*/
export function buildKpiModel({
  definitions = [], dimensionValues = [], values = [], buckets = [], financials = null,
} = {}) {
  const dimsFor = (dimensionId) => dimensionValues
    .filter((v) => v.dimension_id === dimensionId && v.is_active !== false)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  // definition_id → dimension_value_id ('' for none) → month → value
  const entered = {};
  for (const v of values) {
    const d = (entered[v.definition_id] = entered[v.definition_id] || {});
    const dv = (d[v.dimension_value_id || ''] = d[v.dimension_value_id || ''] || {});
    dv[String(v.period).slice(0, 7)] = v.value === null ? null : Number(v.value);
  }

  // Results as they are computed, so later formulas can read earlier ones:
  //   key → { total: [], byDim: { dimValueId: [] } }
  const computed = {};
  const rows = [];
  const errors = [];

  /* Entry KPIs first — nothing depends on anything. */
  for (const def of definitions.filter((d) => d.kind === 'entry')) {
    const dims = def.dimension_id ? dimsFor(def.dimension_id) : [];
    const byDim = {};
    const perDim = dims.map((dv) => {
      const months = entered[def.id]?.[dv.id] || {};
      const cells = buckets.map((b) => aggregateMonths(months, b.months, def.aggregation));
      byDim[dv.id] = cells;
      return { value: dv, cells };
    });

    let total;
    if (dims.length) {
      // Combine rooms within each MONTH first, then aggregate those monthly
      // totals across the bucket. Doing it the other way round would average an
      // average and quietly lose the weighting.
      const monthlyTotals = {};
      const allMonths = new Set();
      for (const dv of dims) Object.keys(entered[def.id]?.[dv.id] || {}).forEach((m) => allMonths.add(m));
      for (const m of allMonths) {
        monthlyTotals[m] = combineDimensions(dims.map((dv) => entered[def.id]?.[dv.id]?.[m]), def.unit);
      }
      total = buckets.map((b) => aggregateMonths(monthlyTotals, b.months, def.aggregation));
    } else {
      const months = entered[def.id]?.[''] || {};
      total = buckets.map((b) => aggregateMonths(months, b.months, def.aggregation));
    }

    computed[def.key] = { total, byDim };
    rows.push({ definition: def, total, dimensions: perDim, error: null });
  }

  /* Calculated KPIs, in dependency order. */
  const { ordered, cyclic } = orderCalculated(definitions);

  for (const key of cyclic) {
    const def = definitions.find((d) => d.key === key);
    if (!def) continue;
    const err = 'This formula depends on itself, directly or through another KPI.';
    errors.push({ key, error: err });
    rows.push({
      definition: def, total: buckets.map(() => null), dimensions: [], error: err,
    });
  }

  for (const def of ordered) {
    let ast;
    try {
      ast = parse(def.formula);
    } catch (e) {
      const err = `Formula won't parse: ${e.message}`;
      errors.push({ key: def.key, error: err });
      rows.push({ definition: def, total: buckets.map(() => null), dimensions: [], error: err });
      continue;
    }

    const dims = def.dimension_id ? dimsFor(def.dimension_id) : [];

    // Resolve a reference at one (bucket, dimension) position. `dimId` null
    // means the total level. A reference to a dimensioned KPI from the total
    // level reads that KPI's total — which is why occupancy for the nursery is
    // total children ÷ total places and not a mean of the rooms.
    const makeCtx = (bi, dimId) => ({
      period: bi,
      resolve: (refKey, opts) => {
        // An explicit subscript picks a dimension value by key: children[babies]
        let wantDim = dimId;
        if (opts?.entity) {
          const match = dimensionValues.find((v) => v.key === opts.entity);
          wantDim = match ? match.id : dimId;
        }
        const src = computed[refKey];
        if (src) {
          const arr = (wantDim && src.byDim?.[wantDim]) ? src.byDim[wantDim] : src.total;
          const v = arr?.[bi];
          if (v === null || v === undefined) throw MISSING;
          return v;
        }
        // Not a KPI — try the dashboard's own financial figures. Those have no
        // dimension, so they read the same at every level.
        if (financials) {
          const v = financials(bi, refKey);
          if (v === null || v === undefined) throw MISSING;
          return v;
        }
        throw MISSING;
      },
    });

    const evalAt = (bi, dimId) => {
      const ctx = makeCtx(bi, dimId);
      try {
        if (hasZeroDenominator(ast, ctx)) return null;
        const v = evaluate(ast, ctx);
        return Number.isFinite(v) ? v : null;
      } catch (e) {
        if (e === MISSING) return null;
        return null;
      }
    };

    const byDim = {};
    const perDim = dims.map((dv) => {
      const cells = buckets.map((_, bi) => evalAt(bi, dv.id));
      byDim[dv.id] = cells;
      return { value: dv, cells };
    });
    const total = buckets.map((_, bi) => evalAt(bi, null));

    computed[def.key] = { total, byDim };
    rows.push({ definition: def, total, dimensions: perDim, error: null });
  }

  // Back into the order the definitions arrived in, so the screen matches the
  // configured sort rather than the evaluation order.
  const pos = {};
  definitions.forEach((d, i) => { pos[d.id] = i; });
  rows.sort((a, b) => (pos[a.definition.id] ?? 0) - (pos[b.definition.id] ?? 0));

  const byKey = {};
  for (const r of rows) byKey[r.definition.key] = r;
  return { rows, byKey, errors };
}

/*
  Which keys a formula refers to, and whether each is known. Powers the "this
  refers to something that doesn't exist" warning in the KPI editor — a typo in
  a formula otherwise shows up as a silent "—" long after anyone remembers
  editing it.
*/
export function checkFormula(formula, knownKeys = []) {
  if (!formula || !formula.trim()) return { ok: false, error: 'Enter a formula.', refs: [] };
  let ast;
  try { ast = parse(formula); } catch (e) { return { ok: false, error: e.message, refs: [] }; }
  const known = new Set(knownKeys);
  const refs = [...new Set(refsOf(ast).map((r) => r.key))].filter((k) => k !== 't');
  const unknown = refs.filter((k) => !known.has(k));
  return {
    ok: unknown.length === 0,
    error: unknown.length ? `Unknown: ${unknown.join(', ')}` : null,
    refs,
    unknown,
  };
}

// The dashboard figures a formula may reference, alongside KPI keys.
export const FINANCIAL_KEYS = [
  { key: 'income', label: 'Turnover' },
  { key: 'cogs', label: 'Cost of sales' },
  { key: 'gross_profit', label: 'Gross profit' },
  { key: 'expenses', label: 'Running costs' },
  { key: 'net_income', label: 'Net profit' },
  { key: 'cash', label: 'Cash at bank' },
  { key: 'debtors', label: 'Debtors' },
  { key: 'creditors', label: 'Creditors' },
];
