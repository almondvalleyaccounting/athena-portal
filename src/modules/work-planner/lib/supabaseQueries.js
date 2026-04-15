import { supabase } from '../../../lib/supabase';

// ── Quick Tasks ──

export async function fetchQuickTasks() {
  const { data, error } = await supabase
    .from('quick_tasks')
    .select('*')
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function insertQuickTask(task) {
  const { data, error } = await supabase
    .from('quick_tasks')
    .insert(task)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateQuickTask(id, patch) {
  const { data, error } = await supabase
    .from('quick_tasks')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteQuickTask(id) {
  const { error } = await supabase
    .from('quick_tasks')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

export async function reorderQuickTasks(orderedIds) {
  // Batch update sort_order for all tasks
  const updates = orderedIds.map((id, index) =>
    supabase
      .from('quick_tasks')
      .update({ sort_order: index, updated_at: new Date().toISOString() })
      .eq('id', id)
  );
  await Promise.all(updates);
}

// ── Scheduled Tasks ──

export async function fetchScheduledTasks() {
  const { data, error } = await supabase
    .from('scheduled_tasks')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function insertScheduledTask(task) {
  const { data, error } = await supabase
    .from('scheduled_tasks')
    .insert(task)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateScheduledTask(id, patch) {
  const { data, error } = await supabase
    .from('scheduled_tasks')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteScheduledTask(id) {
  const { error } = await supabase
    .from('scheduled_tasks')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

// ── Instance Overrides ──

export async function fetchInstanceOverrides() {
  const { data, error } = await supabase
    .from('instance_overrides')
    .select('*');
  if (error) throw error;
  return data || [];
}

export async function upsertInstanceOverride(masterId, occurrenceDate, fields) {
  const { data, error } = await supabase
    .from('instance_overrides')
    .upsert(
      {
        master_id: masterId,
        occurrence_date: occurrenceDate,
        ...fields,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'master_id,occurrence_date' }
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteInstanceOverride(masterId, occurrenceDate) {
  const { error } = await supabase
    .from('instance_overrides')
    .delete()
    .eq('master_id', masterId)
    .eq('occurrence_date', occurrenceDate);
  if (error) throw error;
}

// ── Completed Tasks ──

export async function fetchCompletedTasks() {
  const { data, error } = await supabase
    .from('completed_tasks')
    .select('*')
    .order('completed_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return data || [];
}

export async function insertCompletedTask(task) {
  const { data, error } = await supabase
    .from('completed_tasks')
    .insert(task)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteCompletedTask(id) {
  const { error } = await supabase
    .from('completed_tasks')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

// ── Progress Notes ──

export async function fetchProgressNotes(taskType, taskIds) {
  if (!taskIds.length) return [];
  const { data, error } = await supabase
    .from('task_progress_notes')
    .select('*')
    .eq('task_type', taskType)
    .in('task_id', taskIds)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function insertProgressNote(note) {
  const { data, error } = await supabase
    .from('task_progress_notes')
    .insert(note)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── Reference Data ──

export async function fetchStaffProfiles() {
  const { data, error } = await supabase
    .from('staff_profiles')
    .select('id, name, email, work_planner, colour')
    .order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function fetchEntities() {
  const { data, error } = await supabase
    .from('entities')
    .select('id, name')
    .order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function insertEntity(fields) {
  // Accepts either a string (legacy) or an object with { name, type, status, prospect_email }
  const row = typeof fields === 'string'
    ? { name: fields, type: 'limited_company', status: 'prospect', source: 'athena' }
    : {
        name: fields.name,
        type: fields.type || 'limited_company',
        status: fields.status || 'prospect',
        source: 'athena',
        prospect_email: fields.prospect_email || fields.email || null,
      };

  const { data, error } = await supabase
    .from('entities')
    .insert(row)
    .select()
    .single();

  if (error) {
    console.error('[insertEntity] Supabase error:', error.message, error.details, error.hint);
    throw error;
  }
  return data;
}

// ── Real-time subscription ──

export function subscribeToWorkPlanner(handlers) {
  const channel = supabase
    .channel('work-planner-realtime')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'quick_tasks' },
      handlers.onQuickTasks
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'scheduled_tasks' },
      handlers.onScheduledTasks
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'instance_overrides' },
      handlers.onOverrides
    )
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'completed_tasks' },
      handlers.onCompleted
    )
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'task_progress_notes' },
      handlers.onProgressNote
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}
