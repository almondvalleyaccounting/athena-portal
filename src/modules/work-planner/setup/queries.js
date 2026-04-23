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

// ─── Scheduling rules (unified rules + defaults) ───────────────
export async function listRules() {
  const { data, error } = await supabase
    .from('bm_scheduling_rules')
    .select('*')
    .order('match_priority', { ascending: false })
    .order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}

// Mirror new canonical fields onto the legacy columns that the
// import RPC (ingest_bm_tasks) still reads. Avoids drift between
// the two representations while the legacy columns are kept for
// backward compat.
function mirrorLegacyFields(patch) {
  const out = { ...patch };
  if ('bm_deadline_offset_months' in patch) {
    // negative offset = before deadline. lead_time_days is positive days.
    const months = Number(patch.bm_deadline_offset_months) || 0;
    out.lead_time_days = Math.max(0, Math.round(-months * 30.437));
  }
  if ('week_of_month' in patch) {
    out.preferred_week_of_month = patch.week_of_month;
  }
  if ('target_hours' in patch) {
    out.standard_hours = patch.target_hours;
  }
  return out;
}

export async function createRule(patch) {
  const { data, error } = await supabase
    .from('bm_scheduling_rules')
    .insert(mirrorLegacyFields(patch))
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateRule(id, patch) {
  const { data, error } = await supabase
    .from('bm_scheduling_rules')
    .update(mirrorLegacyFields(patch))
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

// ─── Client overrides (per-client exception to a rule) ─────────
export async function listClientOverrides(ruleId = null) {
  let q = supabase
    .from('client_task_overrides')
    .select('rule_id, entity_id, bm_deadline_offset_months, week_of_month, target_hours, notes, updated_at, entities(id, name)');
  if (ruleId) q = q.eq('rule_id', ruleId);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function upsertClientOverride(patch) {
  const { data, error } = await supabase
    .from('client_task_overrides')
    .upsert(
      { ...patch, updated_at: new Date().toISOString() },
      { onConflict: 'rule_id,entity_id' },
    )
    .select('rule_id, entity_id, bm_deadline_offset_months, week_of_month, target_hours, notes, updated_at, entities(id, name)')
    .single();
  if (error) throw error;
  return data;
}

export async function deleteClientOverride(ruleId, entityId) {
  const { error } = await supabase
    .from('client_task_overrides')
    .delete()
    .eq('rule_id', ruleId)
    .eq('entity_id', entityId);
  if (error) throw error;
}

export async function listEntitiesAll() {
  const { data, error } = await supabase
    .from('entities')
    .select('id, name')
    .order('name');
  if (error) throw error;
  return data || [];
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
    .select('id, name, is_active, working_days, colour')
    .order('name');
  if (error) throw error;
  return data || [];
}

// ─── Reconciliation flags (archive; tab removed) ───────────────
// Kept here only because resolveFlag / logHoursAndResolveFlag are
// still referenced from import paths. Flag UI was retired.
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

export async function logHoursAndResolveFlag({ bmTaskId, staffId, workDate, minutes, service, entityId, notes, flagId }) {
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

// ─── Manual reschedule + clear override ────────────────────────
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

// ─── Preview / Workload data ───────────────────────────────────
// Used by the Preview calendar. Filters: staffIds, entityIds, services,
// statuses. Dates are ISO YYYY-MM-DD (inclusive).
export async function listScheduleInRange({ startISO, endISO, staffIds, entityIds, services, statuses } = {}) {
  let q = supabase
    .from('bm_task_schedule_with_progress')
    .select('id, bm_task_id, bm_task_name, service, entity_id, assignee_id, bm_assignee_name, scheduled_for_date, scheduled_hours, logged_hours, remaining_hours, state, status, draft_cycle_id, manually_overridden_at, bm_deadline, rule_id')
    .not('scheduled_for_date', 'is', null)
    .order('scheduled_for_date', { ascending: true });
  if (startISO) q = q.gte('scheduled_for_date', startISO);
  if (endISO)   q = q.lte('scheduled_for_date', endISO);
  if (staffIds && staffIds.length)  q = q.in('assignee_id', staffIds);
  if (entityIds && entityIds.length) q = q.in('entity_id', entityIds);
  if (services && services.length)   q = q.in('service', services);
  if (statuses && statuses.length)   q = q.in('status', statuses);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// Approve every draft row assigned to a given staff member in the
// current draft cycle. Flips status to 'approved'. When all drafts
// in the cycle are approved, auto-commits (sets status='committed' +
// committed_at for those rows).
export async function approveMyDrafts(assigneeId, draftCycleId) {
  const { data: userResp } = await supabase.auth.getUser();
  const uid = userResp?.user?.id || null;
  const now = new Date().toISOString();

  // 1. Flip assignee's drafts to approved
  const { error: upErr } = await supabase
    .from('bm_task_schedule')
    .update({ status: 'approved', approved_at: now, approved_by: uid })
    .eq('assignee_id', assigneeId)
    .eq('draft_cycle_id', draftCycleId)
    .eq('status', 'draft');
  if (upErr) throw upErr;

  // 2. If no drafts remain in the cycle, auto-commit approved rows.
  const { count: remainingDrafts, error: cErr } = await supabase
    .from('bm_task_schedule')
    .select('id', { count: 'exact', head: true })
    .eq('draft_cycle_id', draftCycleId)
    .eq('status', 'draft');
  if (cErr) throw cErr;

  if ((remainingDrafts || 0) === 0) {
    const { error: commitErr } = await supabase
      .from('bm_task_schedule')
      .update({ status: 'committed', committed_at: now })
      .eq('draft_cycle_id', draftCycleId)
      .eq('status', 'approved');
    if (commitErr) throw commitErr;
    return { approved: true, committed: true };
  }
  return { approved: true, committed: false };
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

export async function listDistinctBmTaskNames() {
  const { data, error } = await supabase
    .from('bm_task_schedule')
    .select('bm_task_name')
    .not('bm_task_name', 'is', null);
  if (error) throw error;
  const set = new Set((data || []).map((r) => r.bm_task_name).filter(Boolean));
  return [...set].sort((a, b) => a.localeCompare(b));
}

// ─── Schedule reset (Danger zone) ──────────────────────────────

function applyScheduleFilters(q, { taskPrefix, entityId }) {
  if (taskPrefix) q = q.ilike('bm_task_name', `${taskPrefix}%`);
  if (entityId) q = q.eq('entity_id', entityId);
  return q;
}

export async function countScheduleRows({ taskPrefix = null, entityId = null } = {}) {
  let q = supabase.from('bm_task_schedule').select('id', { count: 'exact', head: true });
  q = applyScheduleFilters(q, { taskPrefix, entityId });
  const { count, error } = await q;
  if (error) throw error;
  return count || 0;
}

export async function clearScheduleRows({ taskPrefix = null, entityId = null } = {}) {
  let q = supabase.from('bm_task_schedule').delete().not('id', 'is', null);
  q = applyScheduleFilters(q, { taskPrefix, entityId });
  const { error, count } = await q;
  if (error) throw error;
  return count ?? null;
}

// Groups currently-scheduled tasks into "types" using active rule prefixes.
// Used by the danger-zone "Clear by task type" control.
export async function listScheduleTaskGroups() {
  const [rulesRes, scheduleRes] = await Promise.all([
    supabase.from('bm_scheduling_rules').select('name, task_name_prefix, active').eq('active', true),
    supabase.from('bm_task_schedule').select('bm_task_name').not('bm_task_name', 'is', null),
  ]);
  if (rulesRes.error) throw rulesRes.error;
  if (scheduleRes.error) throw scheduleRes.error;

  const byPrefix = new Map();
  for (const r of rulesRes.data || []) {
    if (!r.task_name_prefix) continue;
    byPrefix.set(r.task_name_prefix, { label: r.name || r.task_name_prefix, prefix: r.task_name_prefix });
  }

  const names = (scheduleRes.data || []).map((r) => r.bm_task_name).filter(Boolean);
  const groups = [];
  for (const g of byPrefix.values()) {
    const count = names.filter((n) => n.toLowerCase().startsWith(g.prefix.toLowerCase())).length;
    groups.push({ ...g, count });
  }
  return groups.sort((a, b) => a.label.localeCompare(b.label));
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
