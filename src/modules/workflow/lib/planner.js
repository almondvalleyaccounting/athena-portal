// Scheduling planner — turns BM tasks into draft schedule rows.
//
// Invoked manually from the Workflow UI. For each bm_task_schedule
// row with a bm_deadline, find the first matching default (prefix
// on bm_task_name), compute the target month as
// deadline + bm_deadline_offset_months, pick the Nth Mon–Fri block
// of that month for the start date, shift ±1 week for client
// cadence, and write the row back as status='draft' with a shared
// draft_cycle_id.
//
// Rows are then reviewed per assignee and approved; auto-commit
// happens when the last assignee in a cycle signs off (future step).
//
// v1 scope: operates on every row in bm_task_schedule. Does not
// skip status='committed' — the planner is an explicit user action
// and supersedes prior scheduling. Today there are no committed
// rows under the new lifecycle, so this is safe. A "leave committed
// alone" guard can be added once it matters in practice.

import { supabase } from '../../../lib/supabase';

// ── Date helpers (all in UTC to avoid DST headaches) ────────────

function addMonths(date, n) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  // Clamp to last day of resulting month if original day overshoots
  const lastDayOfNewMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDayOfNewMonth));
  return d;
}

// Returns a Date for the Monday of the Nth Mon–Fri block of the given
// month. weekIndex 1..4 = explicit, 5 = last Monday in the month.
// If weekIndex 4 overshoots (e.g. month only has 3 Mondays before the
// final week), falls back to the last Monday.
function nthMondayOfMonth(year, monthZeroIdx, weekIndex) {
  const first = new Date(Date.UTC(year, monthZeroIdx, 1));
  const dow = first.getUTCDay(); // 0=Sun .. 6=Sat
  const daysToMon = (1 - dow + 7) % 7;
  const firstMonDay = 1 + daysToMon;

  const lastDayOfMonth = new Date(Date.UTC(year, monthZeroIdx + 1, 0)).getUTCDate();

  if (weekIndex === 5) {
    let day = lastDayOfMonth;
    while (new Date(Date.UTC(year, monthZeroIdx, day)).getUTCDay() !== 1) day--;
    return new Date(Date.UTC(year, monthZeroIdx, day));
  }

  const day = firstMonDay + (weekIndex - 1) * 7;
  if (day > lastDayOfMonth) {
    // Month doesn't have that many Mondays — clamp to last.
    let d = lastDayOfMonth;
    while (new Date(Date.UTC(year, monthZeroIdx, d)).getUTCDay() !== 1) d--;
    return new Date(Date.UTC(year, monthZeroIdx, d));
  }
  return new Date(Date.UTC(year, monthZeroIdx, day));
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// ── Core placement logic ─────────────────────────────────────────

export function computeScheduledDate({ deadlineISO, offsetMonths, weekOfMonth, clientCadence }) {
  if (!deadlineISO) return null;
  // Anchor the deadline at UTC noon so month arithmetic never drifts
  // across timezone boundaries.
  const deadline = new Date(deadlineISO + 'T12:00:00Z');
  const target = addMonths(deadline, offsetMonths || 0);
  let week = weekOfMonth || 2;
  if (clientCadence === 'early') week = Math.max(1, week - 1);
  else if (clientCadence === 'late') week = Math.min(5, week + 1);
  const monday = nthMondayOfMonth(target.getUTCFullYear(), target.getUTCMonth(), week);
  return isoDate(monday);
}

// Tasks whose name starts with these prefixes are never put through
// the automated scheduler. NST = "not-standard task" — pre-arranged
// quick tasks surfaced in the Athena work planner separately.
const SKIP_PREFIXES = ['NST'];

export function shouldSkipAutomatedScheduling(taskName) {
  if (!taskName) return false;
  return SKIP_PREFIXES.some((p) => taskName.startsWith(p));
}

export function matchDefault(taskName, defaults) {
  if (!taskName) return null;
  if (shouldSkipAutomatedScheduling(taskName)) return null;
  for (const def of defaults) {
    if (!def.is_active) continue;
    if (taskName.startsWith(def.task_name_prefix)) return def;
  }
  return null;
}

// ── Planner entry point ──────────────────────────────────────────

export async function runPlanner({ horizonMonths = 9 } = {}) {
  const [defaultsRes, tasksRes] = await Promise.all([
    supabase
      .from('task_type_schedule_defaults')
      .select('*')
      .eq('is_active', true)
      .order('match_priority', { ascending: false })
      .order('name', { ascending: true }),
    supabase
      .from('bm_task_schedule')
      .select('id, bm_task_id, bm_task_name, entity_id, assignee_id, bm_deadline, status'),
  ]);
  if (defaultsRes.error) throw defaultsRes.error;
  if (tasksRes.error) throw tasksRes.error;

  const defaults = defaultsRes.data || [];
  const tasks = tasksRes.data || [];

  // Pre-fetch cadence preferences for the entities we're about to plan.
  const entityIds = [...new Set(tasks.map((t) => t.entity_id).filter(Boolean))];
  const cadenceMap = {};
  if (entityIds.length) {
    const { data: ents, error: eErr } = await supabase
      .from('entities')
      .select('id, cadence_preference')
      .in('id', entityIds);
    if (eErr) throw eErr;
    for (const e of ents || []) cadenceMap[e.id] = e.cadence_preference || 'normal';
  }

  const cycleId = (crypto?.randomUUID && crypto.randomUUID()) || fallbackUUID();
  const now = new Date();
  const horizonEnd = addMonths(now, horizonMonths);

  const summary = {
    cycleId,
    planned: 0,
    noMatch: 0,
    noDeadline: 0,
    outOfHorizon: 0,
    skippedNST: 0,
    total: tasks.length,
  };

  for (const task of tasks) {
    if (shouldSkipAutomatedScheduling(task.bm_task_name)) { summary.skippedNST++; continue; }
    if (!task.bm_deadline) { summary.noDeadline++; continue; }
    const def = matchDefault(task.bm_task_name, defaults);
    if (!def) { summary.noMatch++; continue; }

    const cadence = cadenceMap[task.entity_id] || 'normal';
    const scheduledISO = computeScheduledDate({
      deadlineISO: task.bm_deadline,
      offsetMonths: def.bm_deadline_offset_months,
      weekOfMonth: def.week_of_month,
      clientCadence: cadence,
    });
    if (!scheduledISO) { summary.noDeadline++; continue; }

    const scheduledDate = new Date(scheduledISO + 'T12:00:00Z');
    if (scheduledDate > horizonEnd) { summary.outOfHorizon++; continue; }

    const { error: uErr } = await supabase
      .from('bm_task_schedule')
      .update({
        status: 'draft',
        draft_cycle_id: cycleId,
        scheduled_for_date: scheduledISO,
        scheduled_hours: def.target_hours,
        approved_at: null,
        approved_by: null,
        committed_at: null,
      })
      .eq('id', task.id);
    if (uErr) throw uErr;
    summary.planned++;
  }

  return summary;
}

function fallbackUUID() {
  // RFC 4122 v4 fallback for environments where crypto.randomUUID is absent.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
