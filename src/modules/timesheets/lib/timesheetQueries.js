import { supabase } from '../../../lib/supabase';

/* ─── Fetch completed tasks for a staff member within a date range ── */
export async function fetchCompletedForWeek(staffId, weekStart, weekEnd) {
  const { data, error } = await supabase
    .from('completed_tasks')
    .select('*')
    .eq('assignee_id', staffId)
    .gte('completed_at', weekStart)
    .lt('completed_at', weekEnd)
    .order('completed_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

/* ─── Fetch manual timesheet entries for a staff member within a date range ── */
export async function fetchTimesheetEntries(staffId, weekStart, weekEnd) {
  const { data, error } = await supabase
    .from('timesheet_entries')
    .select('*')
    .eq('staff_id', staffId)
    .gte('work_date', weekStart)
    .lt('work_date', weekEnd)
    .order('work_date', { ascending: true });
  if (error) {
    // Table may not exist yet — silently return empty
    if (error.code === '42P01') return [];
    console.error('[timesheetQueries] fetchTimesheetEntries error:', error.message);
    return [];
  }
  return data || [];
}

/* ─── Upsert a timesheet entry (create or update minutes for a cell) ── */
export async function upsertTimesheetEntry({ staffId, entityId, service, workDate, minutes, notes, source = 'manual' }) {
  // Replace, don't accumulate: a cell edit sets the cell's value, so any
  // existing rows for the same (staff, entity, service, date, source) cell
  // are removed first. Requires the DELETE RLS policy (sql/119).
  let del = supabase
    .from('timesheet_entries')
    .delete()
    .eq('staff_id', staffId)
    .eq('work_date', workDate)
    .eq('source', source);
  if (entityId) del = del.eq('entity_id', entityId); else del = del.is('entity_id', null);
  if (service) del = del.eq('service', service); else del = del.is('service', null);
  const { error: delError } = await del;
  if (delError) {
    console.error('[upsertTimesheetEntry] delete error:', delError.message, delError.code);
    throw delError;
  }

  const { data, error } = await supabase
    .from('timesheet_entries')
    .insert({
      staff_id: staffId,
      entity_id: entityId || null,
      service: service || null,
      work_date: workDate,
      minutes: minutes || 0,
      notes: notes || null,
      source,
    })
    .select()
    .single();

  if (error) {
    console.error('[upsertTimesheetEntry] insert error:', error.message, error.details, error.hint, error.code);
    throw error;
  }
  return data;
}

/* ─── Override a completion-sourced cell (delete any prior override + insert new) ── */
export async function upsertCompletionOverride({ staffId, entityId, service, workDate, minutes }) {
  // Delete any existing override for this cell
  let del = supabase
    .from('timesheet_entries')
    .delete()
    .eq('staff_id', staffId)
    .eq('work_date', workDate)
    .eq('source', 'override');
  if (entityId) del = del.eq('entity_id', entityId); else del = del.is('entity_id', null);
  if (service) del = del.eq('service', service); else del = del.is('service', null);
  await del;

  // Insert the new override (minutes may be 0, which still overrides)
  return upsertTimesheetEntry({
    staffId, entityId, service, workDate, minutes, source: 'override',
  });
}

/* ─── Clear a completion override (revert to the original completion minutes) ── */
export async function clearCompletionOverride({ staffId, entityId, service, workDate }) {
  let q = supabase
    .from('timesheet_entries')
    .delete()
    .eq('staff_id', staffId)
    .eq('work_date', workDate)
    .eq('source', 'override');
  if (entityId) q = q.eq('entity_id', entityId); else q = q.is('entity_id', null);
  if (service) q = q.eq('service', service); else q = q.is('service', null);
  const { error } = await q;
  if (error) throw error;
}

/* ─── Delete all manual entries for a row (entity+service+staff) in a week ── */
export async function deleteManualRow(staffId, entityId, service, weekStart, weekEnd) {
  let query = supabase
    .from('timesheet_entries')
    .delete()
    .eq('staff_id', staffId)
    .gte('work_date', weekStart)
    .lte('work_date', weekEnd);

  if (entityId) query = query.eq('entity_id', entityId);
  else query = query.is('entity_id', null);

  if (service) query = query.eq('service', service);
  else query = query.is('service', null);

  const { data, error } = await query.select('id');
  if (error) throw error;
  // Zero deletions with no error means RLS blocked it (not your row, or the
  // period is locked) — surface that instead of silently "succeeding".
  return (data || []).length;
}

/* ─── Timesheet period locks (sql/119) ── */
export async function fetchTimesheetLocks() {
  const { data, error } = await supabase
    .from('timesheet_locks')
    .select('*')
    .order('period_start', { ascending: false });
  if (error) {
    if (error.code === '42P01') return [];
    console.error('[timesheetQueries] fetchTimesheetLocks error:', error.message);
    return [];
  }
  return data || [];
}

export async function createTimesheetLock({ periodStart, periodEnd, note, lockedBy }) {
  const { data, error } = await supabase
    .from('timesheet_locks')
    .insert({ period_start: periodStart, period_end: periodEnd, note: note || null, locked_by: lockedBy })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function removeTimesheetLock(id) {
  const { data, error } = await supabase.from('timesheet_locks').delete().eq('id', id).select('id');
  if (error) throw error;
  return (data || []).length;
}

export function isDateLocked(locks, dateStr) {
  return (locks || []).some((l) => dateStr >= l.period_start && dateStr <= l.period_end);
}

/* ─── Fetch all completed tasks within a date range (all staff, for dashboard) ── */
export async function fetchAllCompletedForRange(startDate, endDate) {
  const { data, error } = await supabase
    .from('completed_tasks')
    .select('*')
    .gte('completed_at', startDate)
    .lt('completed_at', endDate)
    .order('completed_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

/* ─── Fetch all timesheet entries within a date range (all staff, for dashboard) ── */
export async function fetchAllTimesheetEntriesForRange(startDate, endDate) {
  const { data, error } = await supabase
    .from('timesheet_entries')
    .select('*')
    .gte('work_date', startDate)
    .lt('work_date', endDate)
    .order('work_date', { ascending: true });
  if (error) {
    if (error.code === '42P01') return [];
    return [];
  }
  return data || [];
}

/* ─── Edit / delete a single timesheet entry by id (All Entries screen) ── */
export async function updateTimesheetEntry(id, patch) {
  const { error } = await supabase.from('timesheet_entries').update(patch).eq('id', id);
  if (error) throw error;
}
export async function deleteTimesheetEntryById(id) {
  const { error } = await supabase.from('timesheet_entries').delete().eq('id', id);
  if (error) throw error;
}

/* ─── Fetch scheduled tasks for a staff member (for placeholders) ── */
export async function fetchScheduledForStaff(staffId) {
  const { data, error } = await supabase
    .from('scheduled_tasks')
    .select('*')
    .eq('assignee_id', staffId)
    .order('title', { ascending: true });
  if (error) throw error;
  return data || [];
}

/* ─── Fetch staff list ── */
export async function fetchStaffList() {
  const { data, error } = await supabase
    .from('staff_profiles')
    .select('*')
    .order('name', { ascending: true });
  if (error) {
    console.error('[timesheetQueries] fetchStaffList error:', error.message);
    return [];
  }
  return (data || [])
    .filter((s) => s.is_active !== false)
    .map((s) => ({ ...s, name: s.full_name || s.name || s.email || 'Unknown' }));
}

/* ─── Fetch entities (for row labels) ── */
export async function fetchEntities() {
  const { data, error } = await supabase
    .from('entities')
    .select('id, name')
    .order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}
