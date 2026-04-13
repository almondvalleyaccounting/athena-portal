import { addDays, addMonths, formatISO } from './helpers';

// Advance a date by one recurrence step
export function advanceDate(d, recurrence) {
  const date = d instanceof Date ? d : new Date(d);
  switch (recurrence) {
    case 'daily':     return addDays(date, 1);
    case 'weekly':    return addDays(date, 7);
    case 'monthly':   return addMonths(date, 1);
    case 'quarterly': return addMonths(date, 3);
    case 'annually':  return addMonths(date, 12);
    default:          return null;
  }
}

// Deterministic key for an instance: "{masterId}_{YYYY-MM-DD}"
export function instanceKey(masterId, date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${masterId}_${formatISO(d)}`;
}

// Generate all virtual instances for a master within a date range
// overridesMap: { key: overrideRow } keyed by instanceKey
// completedKeys: Set of instanceKey strings that are already completed
export function generateInstances(master, fromDate, toDate, overridesMap, completedKeys) {
  const instances = [];
  if (!master.planned_date) return instances;

  const from = fromDate instanceof Date ? fromDate : new Date(fromDate);
  const to = toDate instanceof Date ? toDate : new Date(toDate);
  let d = new Date(master.planned_date);
  d.setHours(0, 0, 0, 0);

  let iterations = 0;
  const MAX_ITERATIONS = 600;

  while (d <= to && iterations < MAX_ITERATIONS) {
    iterations++;
    if (d >= from) {
      const key = instanceKey(master.id, d);
      if (!completedKeys.has(key)) {
        const override = overridesMap.get(key);
        instances.push(mergeInstance(master, d, key, override));
      }
    }
    if (!master.recurring || !master.recurrence) break;
    const next = advanceDate(d, master.recurrence);
    if (!next) break;
    d = next;
  }

  return instances;
}

// Generate the next upcoming instance for a master (from today forward)
export function nextInstance(master, overridesMap, completedKeys) {
  if (!master.planned_date) return null;

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  let d = new Date(master.planned_date);
  d.setHours(0, 0, 0, 0);

  let iterations = 0;
  const MAX_ITERATIONS = 200;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const key = instanceKey(master.id, d);
    if (d >= now && !completedKeys.has(key)) {
      const override = overridesMap.get(key);
      return mergeInstance(master, d, key, override);
    }
    if (!master.recurring || !master.recurrence) break;
    const next = advanceDate(d, master.recurrence);
    if (!next) break;
    d = next;
  }

  return null;
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
    notes: override?.notes ?? null,
  };
}
