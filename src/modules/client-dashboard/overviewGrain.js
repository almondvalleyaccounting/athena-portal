/*
  Overview grain / basis / view — pure period maths for the Client Dashboard.

  The Overview tab is driven by three toggles rather than by the raw QBO
  columns:

    GRAIN  months | quarters | years   — how wide one bucket is
    BASIS  fiscal | calendar           — where the bucket boundaries fall
    VIEW   reported | underlying       — whether owner costs come back out

  BASIS is the fiddly one. "Fiscal" means aligned to the company's own year
  end, which QBO reports as the month the fiscal year STARTS: a company with a
  31 July year end starts its year in August, so its Q4 ends in July and its
  year ends in July. "Calendar" ignores the company and lands years on December
  and quarters on Mar / Jun / Sep / Dec.

  Everything here works on YYYY-MM month keys (never Date objects crossing a
  timezone) and only ever emits COMPLETE buckets — a half-finished quarter next
  to four full ones reads as a collapse in trade that isn't there.

  The month-level figures come from the `pnl_chart_detail` metric, which is one
  QBO ProfitAndLoss?summarize_column_by=Month report carrying both the group
  summaries and each leaf account's monthly amounts. That per-account grain is
  what lets the underlying view strip owner costs bucket by bucket instead of
  only over one flat range.
*/

export const GRAINS = [
  { key: 'month', label: 'Months', months: 1, count: 12 },
  { key: 'quarter', label: 'Quarters', months: 3, count: 8 },
  { key: 'year', label: 'Years', months: 12, count: 5 },
];

export const BASES = [
  { key: 'fiscal', label: 'Fiscal' },
  { key: 'calendar', label: 'Calendar' },
];

export const VIEWS = [
  { key: 'reported', label: 'Reported' },
  { key: 'underlying', label: 'Underlying' },
];

export const grainDef = (key) => GRAINS.find((g) => g.key === key) || GRAINS[0];

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ─── Month-key arithmetic ─────────────────────────────────────── */
// Absolute month number so ranges can be walked without Date rollover bugs.
const absOf = (key) => {
  const [y, m] = String(key).split('-').map(Number);
  return y * 12 + (m - 1);
};
const keyOf = (abs) => `${Math.floor(abs / 12)}-${String((abs % 12) + 1).padStart(2, '0')}`;
const monthIdx = (abs) => abs % 12;
const yearOf = (abs) => Math.floor(abs / 12);

export const monthKeyOfDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

// First / last calendar day of a month key, as a local yyyy-mm-dd.
const firstDay = (key) => `${key}-01`;
const lastDay = (key) => {
  const [y, m] = key.split('-').map(Number);
  return `${key}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
};

/* ─── Where the boundaries fall ────────────────────────────────── */
// QBO gives the month the fiscal year STARTS (fyIdx, 0-based). The year end is
// the month before it; a 31 July year end reports fyIdx = 7 (August).
export const fyEndMonthIndex = (fyIdx) => ((Number(fyIdx) || 0) + 11) % 12;

/*
  resolveFiscalYear({ overrideEndMonth, bmEndMonth, qboStartMonth })

  Where the client's year end actually comes from, and — just as important —
  whether we actually know it.

  Four steps, most authoritative first:
    override      a human decided, on the Overview
    brightmanager the year end named in the client's Annual Accounts tasks
                  ("Accounts Preparation Year End 31/07/2026"), read live
                  through v_client_year_end — Athena has this for most clients
    tax_year      sole traders and partnerships, who have no such task: since
                  basis-period reform they report to the tax year, so March.
                  An assumption, and labelled as one
    quickbooks    QBO's own FiscalYearStartMonth, which is often simply unset
    fallback      September, and the UI says so

  The fallback is flagged rather than asserted because it is the practice's own
  year end. Left silent it would draw quarters ending Dec/Mar/Jun/Sep and label
  them the CLIENT'S, with nothing on screen looking wrong.

  Returns { fyIdx, endMonth, source }.
*/
export function resolveFiscalYear({ overrideEndMonth, bmEndMonth, bmSource, qboStartMonth } = {}) {
  const fromEndMonth = (m, source) => {
    const endMonth = Number(m) - 1;                     // 0-based
    return { fyIdx: (endMonth + 1) % 12, endMonth, source };
  };
  const ov = Number(overrideEndMonth);
  if (ov >= 1 && ov <= 12) return fromEndMonth(ov, 'override');

  const bm = Number(bmEndMonth);
  if (bm >= 1 && bm <= 12) return fromEndMonth(bm, bmSource || 'brightmanager');

  if (qboStartMonth != null && qboStartMonth !== '') {
    const fyIdx = fyStartMonthIndexLocal(qboStartMonth);
    if (fyIdx != null) return { fyIdx, endMonth: fyEndMonthIndex(fyIdx), source: 'quickbooks' };
  }
  return { fyIdx: 9, endMonth: 8, source: 'fallback' };   // Oct start / Sep end
}

const MONTH_NAMES_LC = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

// Local copy of the QBO month parse — returns null when it cannot tell, so
// resolveFiscalYear can distinguish "QBO said October" from "QBO said nothing".
function fyStartMonthIndexLocal(v) {
  const n = parseInt(v, 10);
  if (!isNaN(n) && n >= 1 && n <= 12) return n - 1;
  const i = MONTH_NAMES_LC.indexOf(String(v).trim().toLowerCase());
  return i >= 0 ? i : null;
}

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// The 0-based month a year ends in, for the chosen basis.
export const yearEndMonthIndex = (basis, fyIdx) =>
  (basis === 'calendar' ? 11 : fyEndMonthIndex(fyIdx));

// Month indices a bucket of this grain may end on.
function endMonthSet(grain, basis, fyIdx) {
  const ye = yearEndMonthIndex(basis, fyIdx);
  if (grain === 'month') return new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  if (grain === 'year') return new Set([ye]);
  return new Set([ye, (ye + 3) % 12, (ye + 6) % 12, (ye + 9) % 12]);
}

/* ─── Labels ───────────────────────────────────────────────────── */
// A fiscal year is named for the calendar year it ENDS in — a July year end
// running Aug 25 → Jul 26 is "FY26", which is how the client talks about it.
function fiscalYearNumber(endAbs, ye) {
  // The end month of a fiscal year is `ye`; anything after it in the calendar
  // year belongs to the next fiscal year.
  const y = yearOf(endAbs);
  return monthIdx(endAbs) <= ye ? y : y + 1;
}

function labelFor(grain, basis, endAbs, fyIdx) {
  const ye = yearEndMonthIndex(basis, fyIdx);
  if (grain === 'month') {
    return `${MONTHS_SHORT[monthIdx(endAbs)]} ${String(yearOf(endAbs)).slice(-2)}`;
  }
  if (grain === 'year') {
    return basis === 'calendar'
      ? String(yearOf(endAbs))
      : `FY${String(fiscalYearNumber(endAbs, ye)).slice(-2)}`;
  }
  // Quarter — count back from the year end to find which quarter this is.
  const monthsFromYearEnd = ((ye - monthIdx(endAbs)) + 12) % 12;   // 0, 3, 6, 9
  const q = 4 - monthsFromYearEnd / 3;                              // 4, 3, 2, 1
  const yr = basis === 'calendar'
    ? String(yearOf(endAbs)).slice(-2)
    : `FY${String(fiscalYearNumber(endAbs, ye)).slice(-2)}`;
  return basis === 'calendar' ? `Q${q} ${yr}` : `Q${q} ${yr}`;
}

/* ─── Bucket construction ──────────────────────────────────────── */
/*
  buildBuckets({ grain, basis, anchorKey, fyIdx, count })

  `anchorKey` is the YYYY-MM the user's period filter ends in. We take the last
  bucket that CLOSES on or before it, then step back `count - 1` more. An
  extra "prior" bucket is always built on the front so the tiles can show a
  vs-previous delta without a second pull.

  Returns { buckets, prior, window: { start, end }, months: [keys] } where
  `window` is the QBO date range that covers everything (prior included).
*/
export function buildBuckets({ grain = 'month', basis = 'fiscal', anchorKey, fyIdx = 9, count } = {}) {
  const def = grainDef(grain);
  const n = count || def.count;
  const span = def.months;
  const ends = endMonthSet(grain, basis, fyIdx);

  const anchorAbs = absOf(anchorKey || monthKeyOfDate(new Date()));
  // Walk back to the most recent month that legitimately closes a bucket.
  let lastEnd = anchorAbs;
  for (let i = 0; i < 12 && !ends.has(monthIdx(lastEnd)); i++) lastEnd -= 1;

  const mk = (endAbs) => {
    const startAbs = endAbs - (span - 1);
    const months = [];
    for (let a = startAbs; a <= endAbs; a++) months.push(keyOf(a));
    return {
      key: keyOf(endAbs),
      label: labelFor(grain, basis, endAbs, fyIdx),
      start: firstDay(keyOf(startAbs)),
      end: lastDay(keyOf(endAbs)),
      startKey: keyOf(startAbs),
      endKey: keyOf(endAbs),
      months,
    };
  };

  const buckets = [];
  for (let i = n - 1; i >= 0; i--) buckets.push(mk(lastEnd - i * span));
  const prior = mk(lastEnd - n * span);

  const allMonths = [...prior.months, ...buckets.flatMap((b) => b.months)];
  return {
    buckets,
    prior,
    months: allMonths,
    window: { start: prior.start, end: buckets[buckets.length - 1].end },
  };
}

/*
  bucketsBetween({ grain, basis, startKey, endKey, fyIdx })

  Every bucket of this grain/basis whose months fall inside [startKey, endKey].
  buildBuckets counts backwards from an anchor, which is what the Overview
  needs; the Projection runs forwards across a timeline that starts in the past
  and finishes at the end of a forecast horizon, so it needs this instead.

  Buckets clipped by the range ends are kept and flagged `partial` — the last
  quarter of a horizon that stops mid-quarter is real forecast information, and
  dropping it would make the horizon look shorter than it is.
*/
export function bucketsBetween({ grain = 'month', basis = 'fiscal', startKey, endKey, fyIdx = 9 } = {}) {
  const def = grainDef(grain);
  const span = def.months;
  const ends = endMonthSet(grain, basis, fyIdx);
  const sAbs = absOf(startKey);
  const eAbs = absOf(endKey);
  if (eAbs < sAbs) return [];

  // First bucket end at or after the range start.
  let firstEnd = sAbs;
  for (let i = 0; i < 12 && !ends.has(monthIdx(firstEnd)); i++) firstEnd += 1;

  const out = [];
  for (let end = firstEnd; end - (span - 1) <= eAbs; end += span) {
    const fullStart = end - (span - 1);
    const from = Math.max(fullStart, sAbs);
    const to = Math.min(end, eAbs);
    if (to < from) continue;
    const months = [];
    for (let a = from; a <= to; a++) months.push(keyOf(a));
    out.push({
      key: keyOf(end),
      label: labelFor(grain, basis, end, fyIdx),
      start: firstDay(keyOf(from)),
      end: lastDay(keyOf(to)),
      startKey: keyOf(from),
      endKey: keyOf(to),
      months,
      partial: from !== fullStart || to !== end,
    });
  }
  return out;
}

// Shift a YYYY-MM key by n months.
export const addMonths = (key, n) => keyOf(absOf(key) + n);

// Whole months between two keys, inclusive of neither end beyond the difference.
export const monthsBetween = (a, b) => absOf(b) - absOf(a);

// The rolling 12 months ending with the latest bucket — the annualised base for
// debtor / creditor days, whatever grain is on screen.
export function rolling12Months(buckets) {
  if (!buckets?.length) return [];
  const endAbs = absOf(buckets[buckets.length - 1].endKey);
  const out = [];
  for (let a = endAbs - 11; a <= endAbs; a++) out.push(keyOf(a));
  return out;
}

/* ─── Aggregation over the monthly detail metric ───────────────── */
const isIncomeGroup = (g) => /income/i.test(g || '') && !/net\s*income/i.test(g || '');

/*
  aggregate(detail, buckets, opts)

  detail  — the `pnl_chart_detail` metric: { month_keys, series, rows }
  buckets — from buildBuckets (pass [prior, ...buckets] to get the delta bucket)
  opts.ownerAccountIds — Set of QBO account ids tagged as owner costs
  opts.accountsById     — chart of accounts, for the Revenue/Expense call
  opts.oneoffs          — dashboard_oneoff_items rows ({ kind, entry_date, amount })

  Returns one row per bucket:
    { ...bucket, income, cogs, gross_profit, expenses, net_income,
      owner_add_back, owner_income_tagged, oneoff_cost, oneoff_income,
      u_income, u_net_income }

  Reported and underlying are both computed every time — the toggle picks which
  pair the chart and tiles read, so flipping it never costs a refetch.
*/
export function aggregate(detail, buckets, opts = {}) {
  const { ownerAccountIds, accountsById = {}, oneoffs = [] } = opts;
  const keys = detail?.month_keys || [];
  const pos = {};
  keys.forEach((k, i) => { if (k) pos[k] = i; });

  const sumSeries = (name, months) => {
    const s = detail?.series?.[name];
    if (!Array.isArray(s)) return null;
    let total = 0;
    let seen = false;
    for (const m of months) {
      const i = pos[m];
      if (i === undefined) continue;
      total += Number(s[i]) || 0;
      seen = true;
    }
    return seen ? total : null;
  };

  const owner = ownerAccountIds instanceof Set ? ownerAccountIds : new Set(ownerAccountIds || []);
  const ownerRows = (detail?.rows || []).filter((r) => r.id && owner.has(String(r.id)));

  // A tagged code that is really revenue (dividends received, say) comes OUT of
  // income rather than being added back to profit — same rule the Underlying
  // Performance tab applies.
  const rowIsIncome = (r) => {
    const a = accountsById[String(r.id)];
    return a ? a.classification === 'Revenue' : isIncomeGroup(r.group);
  };

  const inRange = (d, s, e) => !!d && d >= s && d <= e;

  return buckets.map((b) => {
    const income = sumSeries('income', b.months);
    const cogs = sumSeries('cogs', b.months);
    const gross_profit = sumSeries('gross_profit', b.months);
    const expenses = sumSeries('expenses', b.months);
    const net_income = sumSeries('net_income', b.months);

    let ownerAddBack = 0;
    let ownerIncomeTagged = 0;
    for (const r of ownerRows) {
      let amt = 0;
      for (const m of b.months) {
        const i = pos[m];
        if (i !== undefined) amt += Number(r.amounts?.[i]) || 0;
      }
      if (rowIsIncome(r)) { ownerAddBack -= amt; ownerIncomeTagged += amt; }
      else ownerAddBack += amt;
    }

    const sumOO = (kind) => (oneoffs || [])
      .filter((x) => x.kind === kind && inRange(x.entry_date, b.start, b.end))
      .reduce((s, x) => s + Number(x.amount || 0), 0);
    const oneoffCost = sumOO('cost');
    const oneoffIncome = sumOO('income');

    return {
      ...b,
      income, cogs, gross_profit, expenses, net_income,
      owner_add_back: ownerAddBack,
      owner_income_tagged: ownerIncomeTagged,
      oneoff_cost: oneoffCost,
      oneoff_income: oneoffIncome,
      u_income: income == null ? null : income - ownerIncomeTagged - oneoffIncome,
      u_net_income: net_income == null ? null : net_income + ownerAddBack + oneoffCost - oneoffIncome,
    };
  });
}

// Pick the reported / underlying pair for a computed bucket.
export const seriesFor = (row, view) => (view === 'underlying'
  ? { income: row?.u_income ?? null, net_income: row?.u_net_income ?? null }
  : { income: row?.income ?? null, net_income: row?.net_income ?? null });

/* ─── Window description, for the chart heading ────────────────── */
export function windowLabel(grain, basis, buckets) {
  if (!buckets?.length) return '';
  const first = buckets[0].label;
  const last = buckets[buckets.length - 1].label;
  const unit = grain === 'month' ? 'months' : grain === 'quarter' ? 'quarters' : 'years';
  const basisWord = basis === 'calendar' ? 'calendar' : 'fiscal';
  return `${buckets.length} ${basisWord} ${unit}, ${first} to ${last}`;
}
