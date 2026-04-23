import { supabase } from '../../../lib/supabase';

// ─── App settings (feature flags) ──────────────────────────────
export async function getSetting(key) {
  const { data, error } = await supabase
    .from('app_settings')
    .select('*')
    .eq('setting_key', key)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function updateSetting(key, value) {
  const { data, error } = await supabase
    .from('app_settings')
    .update({ setting_value: value })
    .eq('setting_key', key)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ─── Scheduling rules ──────────────────────────────────────────
export async function listRules() {
  const { data, error } = await supabase
    .from('bm_scheduling_rules')
    .select('*')
    .order('match_priority', { ascending: false })
    .order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function createRule(patch) {
  const { data, error } = await supabase
    .from('bm_scheduling_rules')
    .insert(patch)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateRule(id, patch) {
  const { data, error } = await supabase
    .from('bm_scheduling_rules')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteRule(id) {
  const { error } = await supabase
    .from('bm_scheduling_rules')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

// ─── Staff aliases ─────────────────────────────────────────────
export async function listAliases() {
  const { data, error } = await supabase
    .from('bm_staff_aliases')
    .select('*, staff_profiles(id, name, is_active)')
    .order('last_seen_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function updateAlias(name, patch) {
  const { data, error } = await supabase
    .from('bm_staff_aliases')
    .update(patch)
    .eq('bm_assignee_name', name)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function listStaffProfiles() {
  const { data, error } = await supabase
    .from('staff_profiles')
    .select('id, name, is_active')
    .order('name');
  if (error) throw error;
  return data || [];
}

// ─── Reconciliation flags ──────────────────────────────────────
export async function listFlags({ resolved = false } = {}) {
  let q = supabase
    .from('bm_reconciliation_flags')
    .select('*')
    .order('raised_at', { ascending: false })
    .limit(500);
  if (resolved === false) q = q.is('resolved_at', null);
  else if (resolved === true) q = q.not('resolved_at', 'is', null);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// Reschedule a planned task to a new date. Marks manually_overridden_*.
// Scheduler will then leave this task's date/hours alone on future
// imports until the override is cleared.
export async function rescheduleTask(taskId, newDateISO) {
  const { data: userResp } = await supabase.auth.getUser();
  const uid = userResp?.user?.id || null;
  const { data, error } = await supabase
    .from('bm_task_schedule')
    .update({
      scheduled_for_date: newDateISO,
      manually_overridden_at: new Date().toISOString(),
      manually_overridden_by: uid,
    })
    .eq('id', taskId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function clearManualOverride(taskId) {
  const { data, error } = await supabase
    .from('bm_task_schedule')
    .update({
      manually_overridden_at: null,
      manually_overridden_by: null,
    })
    .eq('id', taskId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ─── Workload calendar ─────────────────────────────────────────
export async function listWorkloadInWeek(weekStartISO, weekEndISO) {
  // weekStartISO/weekEndISO are YYYY-MM-DD (inclusive)
  const { data, error } = await supabase
    .from('bm_task_schedule_with_progress')
    .select('id, bm_task_id, bm_task_name, service, entity_id, assignee_id, bm_assignee_name, scheduled_for_date, scheduled_hours, logged_hours, remaining_hours, state, manually_overridden_at, bm_deadline')
    .gte('scheduled_for_date', weekStartISO)
    .lte('scheduled_for_date', weekEndISO)
    .eq('state', 'planned')
    .order('assignee_id')
    .order('scheduled_for_date');
  if (error) throw error;
  return data || [];
}

export async function listWorkloadUnscheduled() {
  const { data, error } = await supabase
    .from('bm_task_schedule_with_progress')
    .select('id, bm_task_id, bm_task_name, service, entity_id, assignee_id, bm_assignee_name, scheduled_for_date, scheduled_hours, logged_hours, remaining_hours, state, bm_deadline')
    .is('scheduled_for_date', null)
    .eq('state', 'planned')
    .limit(200);
  if (error) throw error;
  return data || [];
}

export async function listEntities(ids) {
  if (!ids || !ids.length) return {};
  const unique = [...new Set(ids)];
  const { data, error } = await supabase
    .from('entities')
    .select('id, name')
    .in('id', unique);
  if (error) throw error;
  const map = {};
  for (const e of data || []) map[e.id] = e.name;
  return map;
}

// ─── Retro-log hours against a completed task ──────────────────
// Used by the Reconciliation inbox when dismissing completed_no_time
// or completed_under_expected flags. Inserts a timesheet entry linked
// back to the bm_task_schedule row via source_task_id, then resolves
// the flag. Returns { timesheet_id, flag_id }.
export async function logHoursAndResolveFlag({ bmTaskId, staffId, workDate, minutes, service, entityId, notes, flagId }) {
  // Look up the schedule row to link the timesheet entry
  const { data: sched, error: schedErr } = await supabase
    .from('bm_task_schedule')
    .select('id, entity_id, service')
    .eq('bm_task_id', bmTaskId)
    .single();
  if (schedErr) throw schedErr;

  const { data: tsEntry, error: tsErr } = await supabase
    .from('timesheet_entries')
    .insert({
      staff_id: staffId,
      entity_id: entityId || sched.entity_id,
      service: service || sched.service,
      work_date: workDate,
      minutes,
      notes: notes || `Retroactive log for BM task ${bmTaskId}`,
      source: 'bm_reconciliation',
      source_task_id: sched.id,
    })
    .select('id')
    .single();
  if (tsErr) throw tsErr;

  const flag = await resolveFlag(flagId, `Logged ${Math.round(Number(minutes) || 0)}m retroactively${notes ? ' — ' + notes : ''}`);
  return { timesheet_id: tsEntry.id, flag_id: flag.id };
}

// ─── Task-type schedule defaults ───────────────────────────────
// Prefix-match on bm_task_name, first-match-wins by priority DESC
// then name ASC. Yields a calendar slot (month anchor, week-of-month,
// target hours) that the planner uses when placing draft rows.

export async function listDefaults() {
  const { data, error } = await supabase
    .from('task_type_schedule_defaults')
    .select('*')
    .order('match_priority', { ascending: false })
    .order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function createDefault(patch) {
  const { data, error } = await supabase
    .from('task_type_schedule_defaults')
    .insert(patch)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateDefault(id, patch) {
  const { data, error } = await supabase
    .from('task_type_schedule_defaults')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteDefault(id) {
  const { error } = await supabase
    .from('task_type_schedule_defaults')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

// ─── Schedule reset (Danger zone) ──────────────────────────────
// Deletes rows from bm_task_schedule. Logged time lives on
// timesheet_entries and is untouched — schedule rows are plans only.
// A re-import will rebuild rows for any BM tasks that still exist.

function applyScheduleFilters(q, { taskName, entityId }) {
  if (taskName) q = q.eq('bm_task_name', taskName);
  if (entityId) q = q.eq('entity_id', entityId);
  return q;
}

export async function countScheduleRows({ taskName = null, entityId = null } = {}) {
  let q = supabase.from('bm_task_schedule').select('id', { count: 'exact', head: true });
  q = applyScheduleFilters(q, { taskName, entityId });
  const { count, error } = await q;
  if (error) throw error;
  return count || 0;
}

export async function clearScheduleRows({ taskName = null, entityId = null } = {}) {
  let q = supabase.from('bm_task_schedule').delete().not('id', 'is', null);
  q = applyScheduleFilters(q, { taskName, entityId });
  const { error, count } = await q;
  if (error) throw error;
  return count ?? null;
}

export async function listScheduleTaskNames() {
  const { data, error } = await supabase
    .from('bm_task_schedule')
    .select('bm_task_name')
    .not('bm_task_name', 'is', null);
  if (error) throw error;
  const set = new Set((data || []).map((r) => r.bm_task_name).filter(Boolean));
  return [...set].sort((a, b) => a.localeCompare(b));
}

export async function listScheduleEntities() {
  const { data, error } = await supabase
    .from('bm_task_schedule')
    .select('entity_id')
    .not('entity_id', 'is', null);
  if (error) throw error;
  const ids = [...new Set((data || []).map((r) => r.entity_id))];
  if (!ids.length) return [];
  const { data: ents, error: eErr } = await supabase
    .from('entities')
    .select('id, name')
    .in('id', ids);
  if (eErr) throw eErr;
  return (ents || []).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

export async function resolveFlag(id, notes) {
  const { data: userResp } = await supabase.auth.getUser();
  const uid = userResp?.user?.id || null;
  const { data, error } = await supabase
    .from('bm_reconciliation_flags')
    .update({
      resolved_at: new Date().toISOString(),
      resolved_by: uid,
      resolution_notes: notes || null,
    })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}
