import { addDays, addMonths, formatISO } from './helpers';

// Occurrences of a scheduled task / block (sql/312, sql/314).
//
// A block's cadence is one of:
//   daily        every weekday in `weekdays` (default Mon–Fri)
//   weekly       the `weekdays` each week
//   fortnightly  the `weekdays` every other week, counted from the start date's week
//   monthly      from the start date's day of the month, for `span_days` working
//                days or until `span_end_day`; each day is its own occurrence
//   quarterly / annually   the same day every 3 / 12 months (legacy one-a-period)
// `until` ends the series. A non-recurring task is a single occurrence.

const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MAX_DAYS = 800;

const isWorkingDay = (d) => d.getDay() !== 0 && d.getDay() !== 6;
const nextWorkingDay = (d) => { let x = new Date(d); while (!isWorkingDay(x)) x = addDays(x, 1); return x; };
const weekStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); const dow = x.getDay() === 0 ? 6 : x.getDay() - 1; return addDays(x, -dow); };
const dayISO = (d) => formatISO(d);

function weekdaySet(master) {
  const s = new Set(String(master.weekdays || 'mon,tue,wed,thu,fri').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
  return s.size ? s : new Set(['mon', 'tue', 'wed', 'thu', 'fri']);
}

// The days a monthly block runs in the month containing `monthDate`.
function monthlySpan(master, start, monthDate) {
  const dom = start.getDate();
  const y = monthDate.getFullYear(), m = monthDate.getMonth();
  const lastDay = new Date(y, m + 1, 0).getDate();
  const first = nextWorkingDay(new Date(y, m, Math.min(dom, lastDay)));
  const days = [];
  if (master.span_end_day) {
    const endDay = Math.min(Number(master.span_end_day), lastDay);
    let end = new Date(y, m, endDay);
    if (end < first) end = new Date(y, m + 1, Math.min(Number(master.span_end_day), new Date(y, m + 2, 0).getDate()));
    for (let d = new Date(first); d <= end; d = addDays(d, 1)) if (isWorkingDay(d)) days.push(d);
    return days;
  }
  const n = Math.max(1, Number(master.span_days) || 1);
  let d = new Date(first);
  while (days.length < n) { if (isWorkingDay(d)) days.push(d); d = addDays(d, 1); }
  return days;
}

/** Every date (local midnight) the master occurs on between from and to, inclusive. */
export function occurrenceDates(master, fromDate, toDate) {
  if (!master.planned_date) return [];
  const start = new Date(master.planned_date); start.setHours(0, 0, 0, 0);
  const from = new Date(fromDate); from.setHours(0, 0, 0, 0);
  const to = new Date(toDate); to.setHours(0, 0, 0, 0);
  const until = master.until ? new Date(`${String(master.until).slice(0, 10)}T00:00:00`) : null;
  const hi = until && until < to ? until : to;
  const out = [];
  if (!master.recurring || !master.recurrence) {
    if (start >= from && start <= hi) out.push(start);
    return out;
  }
  const rec = master.recurrence;
  if (rec === 'quarterly' || rec === 'annually') {
    let d = new Date(start);
    for (let i = 0; i < 200 && d <= hi; i++) { if (d >= from) out.push(d); d = addMonths(d, rec === 'quarterly' ? 3 : 12); }
    return out;
  }
  if (rec === 'monthly') {
    // Walk month by month from the later of the start month and the window.
    let cursor = new Date(Math.max(start.getTime(), from.getTime()));
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1); // spans can begin in the previous month
    for (let i = 0; i < 40; i++) {
      const monthDate = new Date(cursor.getFullYear(), cursor.getMonth() + i, 1);
      if (monthDate > addMonths(hi, 1)) break;
      for (const d of monthlySpan(master, start, monthDate)) {
        if (d >= start && d >= from && d <= hi) out.push(d);
      }
    }
    return out.sort((a, b) => a - b).filter((d, i, arr) => i === 0 || +d !== +arr[i - 1]);
  }
  // daily / weekly / fortnightly: day by day
  const days = weekdaySet(master);
  const base = weekStart(start);
  let d = new Date(Math.max(start.getTime(), from.getTime()));
  for (let i = 0; i < MAX_DAYS && d <= hi; i++, d = addDays(d, 1)) {
    if (!days.has(DOW[d.getDay()])) continue;
    if (rec === 'fortnightly') {
      const weeks = Math.round((weekStart(d) - base) / (7 * 86400000));
      if (weeks % 2 !== 0) continue;
    }
    out.push(new Date(d));
  }
  return out;
}

// Deterministic key for an instance: "{masterId}_{YYYY-MM-DD}"
export function instanceKey(masterId, date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${masterId}_${dayISO(d)}`;
}

// Generate all virtual instances for a master within a date range
// overridesMap: { key: overrideRow } keyed by instanceKey
// completedKeys: Set of instanceKey strings that are already completed
export function generateInstances(master, fromDate, toDate, overridesMap, completedKeys) {
  const instances = [];
  for (const d of occurrenceDates(master, fromDate, toDate)) {
    const key = instanceKey(master.id, d);
    if (completedKeys.has(key)) continue;
    instances.push(mergeInstance(master, d, key, overridesMap.get(key)));
  }
  return instances;
}

// The next upcoming instance for a master (from today forward)
export function nextInstance(master, overridesMap, completedKeys) {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const list = generateInstances(master, now, addDays(now, 400), overridesMap, completedKeys);
  return list[0] || null;
}

// Count future overrides for a master
export function countOverrides(masterId, overridesMap) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  let count = 0;
  for (const [key] of overridesMap) {
    if (!key.startsWith(masterId + '_')) continue;
    const dateStr = key.slice(masterId.length + 1);
    const d = new Date(dateStr);
    if (d >= now) count++;
  }
  return count;
}

// Merge master defaults with override fields (non-null override wins)
function mergeInstance(master, date, key, override) {
  return {
    _instance: true,
    _masterId: master.id,
    _date: new Date(date),
    _key: key,
    _hasOverride: !!override,
    id: key,
    title: master.title,
    task_type: master.task_type,
    entity_id: master.entity_id,
    service: override?.service ?? master.service,
    assignee_id: override?.assignee_id ?? master.assignee_id,
    status: override?.status ?? master.status,
    source: master.source,
    planned_date: date.toISOString(),
    planned_hour: override?.planned_hour ?? master.planned_hour,
    planned_min: override?.planned_min ?? master.planned_min,
    duration: override?.duration ?? master.duration,
    recurring: master.recurring,
    recurrence: master.recurrence,
    block_kind: master.block_kind || null,
    carry_over: !!master.carry_over,
    notes: override?.notes ?? null,
  };
}
