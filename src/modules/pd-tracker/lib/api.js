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

export async function loadRoleProfileById(id) {
  if (!id) return null;
  const { data, error } = await supabase.from('pd_role_profiles').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

// Per-staff role-profile-text overlay (removed base items + per-section additions).
export async function loadStaffRoleProfile(staffId, roleProfileId) {
  if (!staffId || !roleProfileId) return null;
  const { data, error } = await supabase
    .from('pd_staff_role_profile')
    .select('*')
    .eq('staff_id', staffId)
    .eq('role_profile_id', roleProfileId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function saveStaffRoleProfile({ staff_id, role_profile_id, removed, additions }) {
  const { data, error } = await supabase
    .from('pd_staff_role_profile')
    .upsert({ staff_id, role_profile_id, removed, additions, updated_at: new Date().toISOString() }, { onConflict: 'staff_id,role_profile_id' })
    .select()
    .single();
  if (error) throw error;
  return data;
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

// ── CPD sharing + 360 feedback requests ──────────────────────────────────

// Grants this person has GIVEN (colleagues who can see their CPD).
export async function loadGrantsByOwner(ownerId) {
  const { data, error } = await supabase
    .from('pd_access_grants')
    .select('*, grantee:grantee_id(id, name)')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// Grants this person has RECEIVED (whose CPD they can see).
export async function loadGrantsToMe(granteeId) {
  const { data, error } = await supabase
    .from('pd_access_grants')
    .select('*, owner:owner_id(id, name)')
    .eq('grantee_id', granteeId);
  if (error) throw error;
  return data || [];
}

export async function createGrant({ owner_id, grantee_id, role }) {
  const { data, error } = await supabase
    .from('pd_access_grants')
    .upsert({ owner_id, grantee_id, role }, { onConflict: 'owner_id,grantee_id' })
    .select('*, grantee:grantee_id(id, name)')
    .single();
  if (error) throw error;
  return data;
}

export async function deleteGrant(id) {
  const { error } = await supabase.from('pd_access_grants').delete().eq('id', id);
  if (error) throw error;
}

// Ask colleagues for feedback on a 1-2-1 (no view access granted).
export async function createFeedbackRequests({ subject_id, responder_ids, one_to_one_id, message }) {
  const rows = responder_ids.map((rid) => ({ subject_id, responder_id: rid, one_to_one_id: one_to_one_id || null, message: message || null }));
  const { data, error } = await supabase.from('pd_feedback_requests').insert(rows).select();
  if (error) throw error;
  return data || [];
}

// Requests directed AT me (I'm the responder).
export async function loadFeedbackRequestsForMe(responderId) {
  const { data, error } = await supabase
    .from('pd_feedback_requests')
    .select('*, subject:subject_id(id, name), meeting:one_to_one_id(id, meeting_date, what_went_well, what_didnt, blockers, notes)')
    .eq('responder_id', responderId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// Requests I raised (as the subject).
export async function loadFeedbackRequestsBySubject(subjectId) {
  const { data, error } = await supabase
    .from('pd_feedback_requests')
    .select('*, responder:responder_id(id, name)')
    .eq('subject_id', subjectId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function updateFeedbackRequest(id, patch) {
  const { data, error } = await supabase.from('pd_feedback_requests').update(patch).eq('id', id).select().single();
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

/*
  ── Discussion points (sql/211) ────────────────────────────────────────────
  Each section of a 1-2-1 is a list of points, not a blob of text. The
  headline is what lands on the summary tile; the detail is the fuller story,
  revealed on hover and printed in full on the PDF.

  The legacy text columns on pd_one_to_ones are kept in step as a plain-text
  rendering of the headlines, so the dashboard teaser and the 360-feedback
  request can keep reading one field. Points are the source of truth.
*/
export const POINT_SECTIONS = [
  { key: 'went_well', column: 'what_went_well', label: 'What went well',                   bg: '#dcfce7' },
  { key: 'improve',   column: 'what_didnt',     label: 'Areas to target for improvement',  bg: '#fef3c7' },
  { key: 'blockers',  column: 'blockers',       label: 'Blockers',                         bg: '#fee2e2' },
  { key: 'notes',     column: 'notes',          label: 'Other notes',                      bg: '#f1f5f9' },
];

export async function loadPoints(oneToOneIds) {
  if (!oneToOneIds || oneToOneIds.length === 0) return [];
  const { data, error } = await supabase
    .from('pd_one_to_one_points')
    .select('*')
    .in('one_to_one_id', oneToOneIds)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data || [];
}

// The text kept on the legacy column for a section — headlines only, one per
// line, in the "- bullet" shape people were typing by hand.
export function pointsToText(points) {
  const lines = (points || []).map((p) => `- ${(p.headline || '').trim()}`).filter((l) => l !== '- ');
  return lines.length ? lines.join('\n') : null;
}

// Replace every point on a meeting in one go. The form always submits the
// full set, so a delete-then-insert keeps ordering and removals honest
// without diffing row by row.
export async function savePoints(oneToOneId, bySection) {
  const rows = [];
  for (const s of POINT_SECTIONS) {
    (bySection[s.key] || []).forEach((p) => {
      const headline = (p.headline || '').trim();
      if (!headline) return;
      rows.push({
        one_to_one_id: oneToOneId,
        section: s.key,
        headline,
        detail: (p.detail || '').trim() || null,
        sort_order: rows.filter((r) => r.section === s.key).length,
      });
    });
  }
  const { error: delErr } = await supabase.from('pd_one_to_one_points').delete().eq('one_to_one_id', oneToOneId);
  if (delErr) throw delErr;
  if (rows.length) {
    const { error } = await supabase.from('pd_one_to_one_points').insert(rows);
    if (error) throw error;
  }
  return rows;
}

// The derived text columns for a meeting, from the same submitted points.
export function pointsToColumns(bySection) {
  const patch = {};
  for (const s of POINT_SECTIONS) patch[s.column] = pointsToText(bySection[s.key]);
  return patch;
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

/*
  Copying 1-2-1 actions onto the work planner is DELIBERATELY OFF.

  The planner is a team-wide surface — everyone sees everyone's tasks — while
  a 1-2-1 action can be a personal development matter ("consider next steps on
  courses / career path"). Putting one on the planner publishes it to the whole
  team, so the owner tag stays inside the CPD tracker for now.

  (It never actually worked anyway: the insert set service 'PD' and source
  'pd_tracker', both of which fail the CHECK constraints on quick_tasks, so
  every attempt was silently rejected. The values below are the valid ones,
  left in place for whenever this is switched on.)

  To enable: flip this to true. The mirroring on edit/complete/delete below is
  keyed off quick_task_id, so existing actions without one stay untouched and
  only new actions start appearing on planners.
*/
const MIRROR_ACTIONS_TO_PLANNER = false;

export async function createAction(row) {
  const ownerId = row.owner_id || row.staff_id;
  let quickTaskId = null;
  if (MIRROR_ACTIONS_TO_PLANNER) {
    try {
      const qt = {
        title: row.action,
        service: 'Admin',
        assignee_id: ownerId,
        due_date: row.due_date ? new Date(row.due_date).toISOString() : null,
        duration: 15,
        notes: 'From 1-2-1 action',
        created_by: ownerId,
        source: 'manual',
      };
      const { data: qtRow, error: qtErr } = await supabase
        .from('quick_tasks')
        .insert(qt)
        .select()
        .single();
      if (!qtErr && qtRow) quickTaskId = qtRow.id;
    } catch { /* fall through - don't block action creation if QT insert fails */ }
  }

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
  } else if (data?.quick_task_id && ('action' in patch || 'due_date' in patch || 'owner_id' in patch)) {
    // Reworded, re-dated or handed to someone else on an edit — keep the
    // planner copy in step so it sits on the right person's list.
    const qtPatch = {};
    if ('action' in patch) qtPatch.title = patch.action;
    if ('due_date' in patch) qtPatch.due_date = patch.due_date ? new Date(patch.due_date).toISOString() : null;
    if ('owner_id' in patch) qtPatch.assignee_id = patch.owner_id;
    try { await supabase.from('quick_tasks').update(qtPatch).eq('id', data.quick_task_id); } catch { /* silent */ }
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

// ── Private 1-2-1 prep notes (sql/183) ───────────────────────────────────
// These are the ONLY pd_* rows that aren't visible to all active staff:
// RLS is author_id = auth.uid(), so the person a note is about can never read
// it. The UI must never present them as shared.

export const PREP_KINDS = [
  { key: 'work',        label: 'Work',        hint: 'Jobs, clients, capacity, quality — what we need to talk through.' },
  { key: 'development', label: 'Development', hint: 'Growth, behaviours, feedback to give, career conversation.' },
];

export const WORK_FEED_SOURCES = [
  { key: 'bm_job',          label: 'Client jobs' },
  { key: 'job_review',      label: 'Job review' },
  { key: 'onboarding_step', label: 'Onboarding' },
  { key: 'planner_task',    label: 'Planner' },
  { key: 'quick_task',      label: 'Quick tasks' },
  { key: 'objective',       label: 'Objectives' },
  { key: 'bug',             label: 'Bugs' },
  { key: 'issue',           label: 'Issues' },
];

// Every note I hold on one person (open, parked and already-discussed).
export async function loadPrepNotes(authorId, subjectId) {
  const { data, error } = await supabase
    .from('pd_prep_notes')
    .select('*')
    .eq('author_id', authorId)
    .eq('subject_id', subjectId)
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// Open-note counts per subject, for the "who have I got points for?" strip.
export async function loadPrepNoteCounts(authorId) {
  const { data, error } = await supabase
    .from('pd_prep_notes')
    .select('subject_id, kind')
    .eq('author_id', authorId)
    .eq('status', 'open');
  if (error) throw error;
  const counts = {};
  for (const r of data || []) {
    const c = counts[r.subject_id] || (counts[r.subject_id] = { work: 0, development: 0, total: 0 });
    c[r.kind] = (c[r.kind] || 0) + 1;
    c.total += 1;
  }
  return counts;
}

export async function createPrepNote(row) {
  const { data, error } = await supabase
    .from('pd_prep_notes')
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updatePrepNote(id, patch) {
  const { data, error } = await supabase
    .from('pd_prep_notes')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deletePrepNote(id) {
  const { error } = await supabase.from('pd_prep_notes').delete().eq('id', id);
  if (error) throw error;
}

// Carry a set of prep notes into a logged 1-2-1: they stop being agenda and
// become the record of what was raised. Still private to the author.
export async function markPrepNotesDiscussed(ids, oneToOneId) {
  if (!ids || ids.length === 0) return [];
  const { data, error } = await supabase
    .from('pd_prep_notes')
    .update({ status: 'discussed', discussed_at: new Date().toISOString(), one_to_one_id: oneToOneId || null })
    .in('id', ids)
    .select();
  if (error) throw error;
  return data || [];
}

// Everything currently on a person's plate, across modules (v_staff_work_feed).
// Rows the caller has no permission to see are filtered out by the underlying
// tables' RLS, not by this query.
export async function loadWorkFeed(staffId) {
  const { data, error } = await supabase
    .from('v_staff_work_feed')
    .select('*')
    .eq('staff_id', staffId)
    .order('sort_date', { ascending: true, nullsFirst: false })
    .limit(600);
  if (error) throw error;
  return data || [];
}

// ── Contributions to my prep notes (sql/184) ─────────────────────────────
// "Ask Tracy for feedback on Sophie." Three lanes, all RLS-enforced:
// requester sees the ask + every contribution; contributor sees the ask + only
// what they wrote; the subject sees nothing at all.

// Asks I've sent about one person.
export async function loadPrepRequestsBySubject(requesterId, subjectId) {
  const { data, error } = await supabase
    .from('pd_prep_feedback_requests')
    .select('*, responder:responder_id(id, name)')
    .eq('requester_id', requesterId)
    .eq('subject_id', subjectId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// Asks pointed at me — my inbox, regardless of who they're about.
export async function loadPrepRequestsForMe(responderId) {
  const { data, error } = await supabase
    .from('pd_prep_feedback_requests')
    .select('*, requester:requester_id(id, name), subject:subject_id(id, name)')
    .eq('responder_id', responderId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createPrepRequests({ requester_id, subject_id, responder_ids, message }) {
  const rows = (responder_ids || []).map((rid) => ({
    requester_id, subject_id, responder_id: rid, message: message?.trim() || null,
  }));
  if (!rows.length) return [];
  const { data, error } = await supabase
    .from('pd_prep_feedback_requests')
    .insert(rows)
    .select('*, responder:responder_id(id, name)');
  if (error) throw error;
  return data || [];
}

export async function updatePrepRequest(id, patch) {
  const { data, error } = await supabase
    .from('pd_prep_feedback_requests')
    .update(patch)
    .eq('id', id)
    .select('*, requester:requester_id(id, name), subject:subject_id(id, name), responder:responder_id(id, name)')
    .single();
  if (error) throw error;
  return data;
}

export async function deletePrepRequest(id) {
  const { error } = await supabase.from('pd_prep_feedback_requests').delete().eq('id', id);
  if (error) throw error;
}

// Everything colleagues have contributed to my prep on one person.
export async function loadPrepContributions(requesterId, subjectId) {
  const { data, error } = await supabase
    .from('pd_prep_contributions')
    .select('*, contributor:contributor_id(id, name)')
    .eq('requester_id', requesterId)
    .eq('subject_id', subjectId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// What I've contributed to other people's prep (so I can see/edit my own words).
export async function loadMyPrepContributions(contributorId) {
  const { data, error } = await supabase
    .from('pd_prep_contributions')
    .select('*, subject:subject_id(id, name), requester:requester_id(id, name)')
    .eq('contributor_id', contributorId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// Answer a request. Marks it answered in the same round trip.
export async function addPrepContribution({ request, contributor_id, kind, body }) {
  const { data, error } = await supabase
    .from('pd_prep_contributions')
    .insert({
      request_id: request.id,
      requester_id: request.requester_id,
      subject_id: request.subject_id,
      contributor_id,
      kind,
      body: body.trim(),
    })
    .select('*, contributor:contributor_id(id, name)')
    .single();
  if (error) throw error;
  await updatePrepRequest(request.id, { status: 'answered', responded_at: new Date().toISOString() });
  return data;
}

export async function updatePrepContribution(id, patch) {
  const { data, error } = await supabase
    .from('pd_prep_contributions')
    .update(patch)
    .eq('id', id)
    .select('*, contributor:contributor_id(id, name)')
    .single();
  if (error) throw error;
  return data;
}

export async function deletePrepContribution(id) {
  const { error } = await supabase.from('pd_prep_contributions').delete().eq('id', id);
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
