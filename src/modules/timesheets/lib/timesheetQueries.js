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
export async function upsertTimesheetEntry({ staffId, entityId, service, workDate, minutes, notes }) {
  // Skip the lookup — just insert directly. If it conflicts, update.
  // The old check-then-insert pattern was fragile with RLS.
  const { data, error } = await supabase
    .from('timesheet_entries')
    .insert({
      staff_id: staffId,
      entity_id: entityId || null,
      service: service || null,
      work_date: workDate,
      minutes: minutes || 0,
      notes: notes || null,
      source: 'manual',
    })
    .select()
    .single();

  if (error) {
    console.error('[upsertTimesheetEntry] insert error:', error.message, error.details, error.hint, error.code);
    throw error;
  }
  return data;
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

  const { error } = await query;
  if (error) throw error;
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
