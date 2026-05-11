import { supabase } from '../../../lib/supabase';

export const LEVEL_LABELS = ['—', 'Aware', 'Basic', 'Good', 'Strong', 'Expert'];
export const LEVEL_DESCS = [
  'No experience, knowledge or skills',
  'Aware of the concept but very limited knowledge or skills',
  'Basic skill level or outline level understanding',
  'Good knowledge or skill level',
  'Strong knowledge or skill level',
  'Expert knowledge or skill level',
];

export const LEARNING_PARTNER = {
  name: 'Croner-i Learning',
  url: 'https://goto.loginservice.co.uk/module.php/core/loginuserpass.php?AuthState=_bed45967f205fd21ec13bd548088ca80a3fc8ca31f%3Ahttps%3A%2F%2Fgoto.loginservice.co.uk%2Fsaml2%2Fidp%2FSSOService.php%3Fspentityid%3Dprod.ecpd.learning.croneri.com%26RelayState%3Dhttps%253A%252F%252Flearning.croneri.co.uk%252Flogin%252Findex.php%26cookieTime%3D1778488948',
  blurb: 'Our learning partner — courses, technical updates, and the AVA CPD library.',
};

export async function loadStaff() {
  const { data, error } = await supabase
    .from('staff_profiles')
    .select('id, name, email, colour, is_active')
    .eq('is_active', true)
    .order('name');
  if (error) throw error;
  return data || [];
}

export async function loadSkills() {
  const { data, error } = await supabase
    .from('pd_skills')
    .select('*')
    .eq('is_active', true)
    .order('display_order');
  if (error) throw error;
  return data || [];
}

export async function loadSkillLevels(staffId) {
  const { data, error } = await supabase
    .from('pd_skill_levels')
    .select('*')
    .eq('staff_id', staffId);
  if (error) throw error;
  return data || [];
}

export async function upsertSkillLevel({ staffId, skillId, current_level, target_level, notes, show_on_radar }) {
  const payload = {
    staff_id: staffId,
    skill_id: skillId,
    current_level,
    target_level,
    notes: notes ?? null,
    updated_at: new Date().toISOString(),
  };
  if (show_on_radar !== undefined) payload.show_on_radar = show_on_radar;
  const { data, error } = await supabase
    .from('pd_skill_levels')
    .upsert(payload, { onConflict: 'staff_id,skill_id' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function setShowOnRadar({ staffId, skillId, value, existing }) {
  // Use upsert so we can toggle even for skills with no levels yet.
  return upsertSkillLevel({
    staffId, skillId,
    current_level: existing?.current_level ?? 0,
    target_level:  existing?.target_level  ?? 0,
    notes: existing?.notes,
    show_on_radar: value,
  });
}

export async function loadObjectives(staffId) {
  const { data, error } = await supabase
    .from('pd_objectives')
    .select('*')
    .eq('staff_id', staffId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createObjective(row) {
  const { data, error } = await supabase
    .from('pd_objectives')
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateObjective(id, patch) {
  if (patch.status === 'complete' && !patch.completed_at) {
    patch.completed_at = new Date().toISOString();
    patch.progress_pct = 100;
  }
  const { data, error } = await supabase
    .from('pd_objectives')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteObjective(id) {
  const { error } = await supabase.from('pd_objectives').delete().eq('id', id);
  if (error) throw error;
}

export async function loadCpd(staffId) {
  const { data, error } = await supabase
    .from('pd_cpd_entries')
    .select('*')
    .eq('staff_id', staffId)
    .order('entry_date', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createCpd(row) {
  const { data, error } = await supabase
    .from('pd_cpd_entries')
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteCpd(id) {
  const { error } = await supabase.from('pd_cpd_entries').delete().eq('id', id);
  if (error) throw error;
}

export async function loadOneToOnes(staffId) {
  const { data, error } = await supabase
    .from('pd_one_to_ones')
    .select('*')
    .eq('staff_id', staffId)
    .order('meeting_date', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createOneToOne(row) {
  const { data, error } = await supabase
    .from('pd_one_to_ones')
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateOneToOne(id, patch) {
  const { data, error } = await supabase
    .from('pd_one_to_ones')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteOneToOne(id) {
  const { error } = await supabase.from('pd_one_to_ones').delete().eq('id', id);
  if (error) throw error;
}

export async function loadActions(staffId) {
  const { data, error } = await supabase
    .from('pd_one_to_one_actions')
    .select('*')
    .eq('staff_id', staffId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createAction(row) {
  // Also drop the action onto the work planner as a Quick Task so it
  // surfaces in the owner's day-to-day list.
  const ownerId = row.owner_id || row.staff_id;
  let quickTaskId = null;
  try {
    const qt = {
      title: row.action,
      service: 'PD',
      assignee_id: ownerId,
      due_date: row.due_date ? new Date(row.due_date).toISOString() : null,
      duration: 15,
      notes: 'From 1-2-1 action',
      created_by: ownerId,
      source: 'pd_tracker',
    };
    const { data: qtRow, error: qtErr } = await supabase
      .from('quick_tasks')
      .insert(qt)
      .select()
      .single();
    if (!qtErr && qtRow) quickTaskId = qtRow.id;
  } catch { /* fall through - don't block action creation if QT insert fails */ }

  const { data, error } = await supabase
    .from('pd_one_to_one_actions')
    .insert({ ...row, quick_task_id: quickTaskId })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateAction(id, patch) {
  if (patch.status === 'done' && !patch.completed_at) {
    patch.completed_at = new Date().toISOString();
  }
  const { data, error } = await supabase
    .from('pd_one_to_one_actions')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  // Mirror completion to the linked quick task (delete it when done so it
  // disappears from the planner; recreate isn't supported on un-complete).
  if (data?.quick_task_id && patch.status === 'done') {
    try { await supabase.from('quick_tasks').delete().eq('id', data.quick_task_id); } catch { /* silent */ }
  }
  return data;
}

export async function deleteAction(id) {
  const { data: existing } = await supabase
    .from('pd_one_to_one_actions')
    .select('quick_task_id')
    .eq('id', id)
    .single();
  if (existing?.quick_task_id) {
    try { await supabase.from('quick_tasks').delete().eq('id', existing.quick_task_id); } catch { /* silent */ }
  }
  const { error } = await supabase.from('pd_one_to_one_actions').delete().eq('id', id);
  if (error) throw error;
}

export async function loadKudos(staffId) {
  const { data, error } = await supabase
    .from('pd_kudos')
    .select('*')
    .eq('to_id', staffId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  return data || [];
}

export async function loadKudosFeed(limit = 30) {
  const { data, error } = await supabase
    .from('pd_kudos')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function createKudos(row) {
  const { data, error } = await supabase
    .from('pd_kudos')
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return data;
}
