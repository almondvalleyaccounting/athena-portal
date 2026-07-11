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
    .select('id, name, email, colour, is_active, pd_role_profile_id')
    .eq('is_active', true)
    .order('name');
  if (error) throw error;
  return data || [];
}

// ── Role profiles (skills grouping + per-category targets) ───────────────

export async function loadRoleProfiles() {
  const { data, error } = await supabase
    .from('pd_role_profiles')
    .select('*')
    .eq('active', true)
    .order('display_order');
  if (error) throw error;
  return data || [];
}

export async function loadRoleProfileCategories(roleProfileId) {
  const { data, error } = await supabase
    .from('pd_role_profile_categories')
    .select('*')
    .eq('role_profile_id', roleProfileId)
    .order('display_order');
  if (error) throw error;
  return data || [];
}

export async function loadStaffCategoryOverrides(staffId) {
  const { data, error } = await supabase
    .from('pd_staff_category_overrides')
    .select('*')
    .eq('staff_id', staffId);
  if (error) throw error;
  return data || [];
}

export async function upsertStaffCategoryOverride(row) {
  const { data, error } = await supabase
    .from('pd_staff_category_overrides')
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'staff_id,category' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteStaffCategoryOverride(staffId, category) {
  const { error } = await supabase
    .from('pd_staff_category_overrides')
    .delete()
    .eq('staff_id', staffId)
    .eq('category', category);
  if (error) throw error;
}

export async function assignRoleProfile(staffId, roleProfileId) {
  const { error } = await supabase
    .from('staff_profiles')
    .update({ pd_role_profile_id: roleProfileId || null })
    .eq('id', staffId);
  if (error) throw error;
}

// Effective category axes + targets for a staff member under a role profile,
// applying individual overrides (add / hide / retarget). Returns
// [{ category, target_level }] in display order.
export function effectiveRoleCategories(roleCategories, overrides) {
  const byCat = new Map();
  for (const rc of roleCategories) {
    byCat.set(rc.category, { category: rc.category, target_level: rc.target_level, order: rc.display_order });
  }
  for (const ov of overrides || []) {
    if (ov.included === false) { byCat.delete(ov.category); continue; }
    const existing = byCat.get(ov.category);
    if (existing) {
      if (ov.target_level != null) existing.target_level = ov.target_level;
    } else {
      byCat.set(ov.category, { category: ov.category, target_level: ov.target_level ?? 3, order: 999 });
    }
  }
  return Array.from(byCat.values()).sort((a, b) => a.order - b.order);
}

// ── Role-profile management (admin) ──────────────────────────────────────

export async function createRoleProfile(row) {
  const { data, error } = await supabase.from('pd_role_profiles').insert(row).select().single();
  if (error) throw error;
  return data;
}

export async function updateRoleProfile(id, patch) {
  const { data, error } = await supabase.from('pd_role_profiles').update(patch).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteRoleProfile(id) {
  const { error } = await supabase.from('pd_role_profiles').delete().eq('id', id);
  if (error) throw error;
}

export async function upsertRoleCategory(row) {
  const { data, error } = await supabase
    .from('pd_role_profile_categories')
    .upsert(row, { onConflict: 'role_profile_id,category' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteRoleCategory(id) {
  const { error } = await supabase.from('pd_role_profile_categories').delete().eq('id', id);
  if (error) throw error;
}

// Add a new skill (and, implicitly, a new category if the name is new).
export async function createSkill({ name, category, description }) {
  const { data, error } = await supabase
    .from('pd_skills')
    .insert({ name, category, description: description ?? null, display_order: 999 })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Build a "Help me learn" prompt + provider deep-links for a skill gap.
export function helpMeLearnLinks(skillName, category, current, target) {
  const prompt =
    `I want to improve my "${skillName}" skill (category: ${category}). ` +
    `I'm currently at level ${current}/5 (${LEVEL_LABELS[current] || '—'}) and want to reach ` +
    `${target}/5 (${LEVEL_LABELS[target] || '—'}). Give me a concise, practical learning plan ` +
    `with specific steps and free resources, tailored for someone working in a UK accountancy practice.`;
  const q = encodeURIComponent(prompt);
  return {
    prompt,
    claude: `https://claude.ai/new?q=${q}`,
    chatgpt: `https://chatgpt.com/?q=${q}`,
    udemy: `https://www.udemy.com/courses/search/?q=${encodeURIComponent(skillName)}`,
  };
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

export async function loadOneToOneComments(oneToOneIds) {
  if (!oneToOneIds || oneToOneIds.length === 0) return [];
  const { data, error } = await supabase
    .from('pd_one_to_one_comments')
    .select('*, author:author_id(id, name)')
    .in('one_to_one_id', oneToOneIds)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function addOneToOneComment(row) {
  const { data, error } = await supabase
    .from('pd_one_to_one_comments')
    .insert(row)
    .select('*, author:author_id(id, name)')
    .single();
  if (error) throw error;
  return data;
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

// ── Mandatory training (AML, CTF, ...) ───────────────────────────────────

export async function loadMandatoryTrainings({ includeInactive = false } = {}) {
  let q = supabase.from('pd_mandatory_training').select('*').order('display_order');
  if (!includeInactive) q = q.eq('active', true);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// Completions for one staff member (or every staff member when staffId omitted,
// for the admin team-compliance view).
export async function loadMandatoryCompletions(staffId) {
  let q = supabase
    .from('pd_mandatory_completion')
    .select('*')
    .order('completed_on', { ascending: false });
  if (staffId) q = q.eq('staff_id', staffId);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function recordMandatoryCompletion(row) {
  // expires_on is set by a DB trigger from the training's renewal period.
  const { data, error } = await supabase
    .from('pd_mandatory_completion')
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function createMandatoryTraining(row) {
  const { data, error } = await supabase
    .from('pd_mandatory_training')
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateMandatoryTraining(id, patch) {
  const { data, error } = await supabase
    .from('pd_mandatory_training')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Compliance status for a training given its latest completion.
export function mandatoryStatus(training, latestCompletion, today = new Date()) {
  if (!latestCompletion) return { key: 'missing', label: 'Not recorded' };
  if (!training.renewal_months || !latestCompletion.expires_on) {
    return { key: 'done', label: 'Done' };
  }
  const exp = new Date(latestCompletion.expires_on + 'T00:00:00Z');
  const days = Math.floor((exp - today) / 86400000);
  if (days < 0) return { key: 'overdue', label: 'Overdue', expires_on: latestCompletion.expires_on };
  if (days <= 60) return { key: 'due', label: `Due in ${days}d`, expires_on: latestCompletion.expires_on };
  return { key: 'valid', label: 'Valid', expires_on: latestCompletion.expires_on };
}
