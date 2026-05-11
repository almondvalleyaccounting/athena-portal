import { supabase } from '../../../lib/supabase';

export const LEVEL_LABELS = ['—', 'Aware', 'Practising', 'Confident', 'Skilled', 'Expert'];
export const LEVEL_DESCS = [
  'No exposure yet',
  'Aware — knows the basics, needs help',
  'Practising — does it with guidance',
  'Confident — does it independently',
  'Skilled — handles complex cases',
  'Expert — coaches others, sets standard',
];

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

export async function upsertSkillLevel({ staffId, skillId, current_level, target_level, notes }) {
  const payload = {
    staff_id: staffId,
    skill_id: skillId,
    current_level,
    target_level,
    notes: notes ?? null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('pd_skill_levels')
    .upsert(payload, { onConflict: 'staff_id,skill_id' })
    .select()
    .single();
  if (error) throw error;
  return data;
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
  const { data, error } = await supabase
    .from('pd_one_to_one_actions')
    .insert(row)
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
  return data;
}

export async function deleteAction(id) {
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
