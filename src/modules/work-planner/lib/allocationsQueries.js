import { supabase } from '../../../lib/supabase';
import { fetchAllRows } from '../../../lib/fetchAllRows';

// The five canonical services driven by the Allocations matrix.
// Order here = column order in the matrix.
export const ALLOCATION_SERVICES = [
  { id: 'bookkeeping',          label: 'Bookkeeping',          cadence: 'monthly'   },
  { id: 'vat_review',           label: 'VAT Reviews',          cadence: 'quarterly' },
  { id: 'accounts_preparation', label: 'Accounts Preparation', cadence: 'annual'    },
  { id: 'accounts_submission',  label: 'Accounts Submission',  cadence: 'annual'    },
  { id: 'self_assessment',      label: 'Self Assessment',      cadence: 'annual'    },
];

// ── Actuals (advisory) ──
// Timesheet service labels → canonical estimate services. Corporation Tax,
// Admin, Payroll and Company Secretarial have no estimate column, so they
// deliberately don't map.
const TIMESHEET_TO_CANONICAL = {
  'Bookkeeping': 'bookkeeping',
  'VAT': 'vat_review',
  'Self Assessment': 'self_assessment',
  'Accounts Production': 'accounts_preparation',
};

// Total LOGGED minutes per (entity, canonical service) over the last 12
// months — timesheet entries plus completed-task minutes. Advisory input for
// the Estimates screen: reality shown next to the hand-typed estimate.
export async function fetchActualMinutes() {
  const since = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const [{ data: ts, error: e1 }, { data: ct, error: e2 }] = await Promise.all([
    supabase.from('timesheet_entries')
      .select('entity_id, service, minutes')
      .gte('work_date', since).not('entity_id', 'is', null),
    supabase.from('completed_tasks')
      .select('entity_id, service, completion_mins')
      .gte('completed_at', since).not('entity_id', 'is', null),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  const map = new Map(); // `${entity_id}__${canonical}` → total minutes
  const add = (entityId, service, minutes) => {
    const canonical = TIMESHEET_TO_CANONICAL[service];
    if (!canonical || !minutes) return;
    const key = `${entityId}__${canonical}`;
    map.set(key, (map.get(key) || 0) + Number(minutes));
  };
  for (const r of ts || []) add(r.entity_id, r.service, r.minutes);
  for (const r of ct || []) add(r.entity_id, r.service, r.completion_mins);
  return map;
}

// ── Entities ──

export async function fetchAllocationEntities() {
  const { data, error } = await supabase
    .from('entities')
    .select('id, name, type, entity_status, linked_person_id')
    .order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}

// ── Client groups (computed from people + entity_people links) ──

export async function fetchClientGroups() {
  // Returns rows: { entity_id, label_person_id, label_person_name, member_entity_ids }
  const { data, error } = await supabase
    .from('v_client_groups')
    .select('*');
  if (error) throw error;
  return data || [];
}

// ── BM-inferred allocations (read-only view) ──

export async function fetchInferredAllocations() {
  // 909 rows today. Paged because the API stops at 1000 without saying so, and a
  // truncated allocation matrix silently drops clients' work.
  return fetchAllRows(() => supabase
    .from('v_inferred_allocations')
    .select('*')
    .order('entity_id').order('canonical_service_id'));
}

// ── People + entity_people (for the group detail panel) ──

export async function fetchPeople() {
  const { data, error } = await supabase
    .from('people')
    .select('id, name, source, dob_year, dob_month, ch_officer_id, ch_psc_id')
    .order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function fetchEntityPeople(entityIds) {
  if (!entityIds || !entityIds.length) return [];
  // entity_people holds 1,785 rows, so asking for a few hundred entities at once
  // can exceed the 1000-row cap even though it is filtered.
  return fetchAllRows(() => supabase
    .from('entity_people')
    .select('entity_id, person_id, role, role_pct, ended_on, source')
    .in('entity_id', entityIds)
    .order('entity_id').order('person_id'));
}

export async function mergePeople(sourceId, targetId) {
  const { error } = await supabase.rpc('merge_people', { source_id: sourceId, target_id: targetId });
  if (error) throw error;
}

// ── Allocation drafts (reallocation proposals) ──

export async function fetchAllocationDrafts() {
  const { data, error } = await supabase
    .from('allocation_changes')
    .select('*')
    .eq('status', 'draft');
  if (error) throw error;
  return data || [];
}

export async function upsertAllocationDraft(draft) {
  const existing = await supabase
    .from('allocation_changes')
    .select('id')
    .eq('entity_id', draft.entity_id)
    .eq('canonical_service_id', draft.canonical_service_id)
    .eq('status', 'draft')
    .maybeSingle();
  if (existing.error) throw existing.error;

  const payload = {
    entity_id: draft.entity_id,
    canonical_service_id: draft.canonical_service_id,
    proposed_fee_earner_id: draft.proposed_fee_earner_id ?? null,
    proposed_manager_id: null,
    proposed_effort_hours: draft.proposed_effort_hours ?? null,
    note: draft.note ?? null,
    status: 'draft',
    created_by: draft.created_by ?? null,
  };

  if (existing.data?.id) {
    const { data, error } = await supabase
      .from('allocation_changes')
      .update(payload)
      .eq('id', existing.data.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  } else {
    const { data, error } = await supabase
      .from('allocation_changes')
      .insert(payload)
      .select()
      .single();
    if (error) throw error;
    return data;
  }
}

export async function discardAllocationDraft(id) {
  const { error } = await supabase
    .from('allocation_changes')
    .update({ status: 'discarded' })
    .eq('id', id);
  if (error) throw error;
}

// Marks a draft as applied in BM. Provisional, not final — the next BM
// tasks import re-checks it (reconcile_allocation_changes) and reverts it
// back to 'draft' if BM still shows a different assignee.
export async function commitAllocationDraft(id, staffId) {
  const { error } = await supabase
    .from('allocation_changes')
    .update({ status: 'committed', committed_at: new Date().toISOString(), committed_by: staffId ?? null })
    .eq('id', id);
  if (error) throw error;
}

// ── Service reviewers (independent of BM fee earners) ──
// Two reviewer roles: vat_review, accounts_preparation. Sourced
// from BM's "Monitor" columns at import time; users override in
// the Allocations matrix (Capacity Planner). Manual overrides
// survive subsequent BM imports.

export const REVIEWER_SERVICES = [
  { id: 'vat_review',           label: 'VAT Reviewer' },
  { id: 'accounts_preparation', label: 'Accounts Reviewer' },
];

export async function fetchServiceReviewers() {
  const { data, error } = await supabase
    .from('service_reviewers')
    .select('entity_id, canonical_service_id, reviewer_id, source');
  if (error) throw error;
  return data || [];
}

export async function upsertServiceReviewer({ entity_id, canonical_service_id, reviewer_id, updated_by }) {
  const payload = {
    entity_id,
    canonical_service_id,
    reviewer_id: reviewer_id ?? null,
    source: 'manual',
    updated_by: updated_by ?? null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('service_reviewers')
    .upsert(payload, { onConflict: 'entity_id,canonical_service_id' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteServiceReviewer({ entity_id, canonical_service_id }) {
  const { error } = await supabase
    .from('service_reviewers')
    .delete()
    .eq('entity_id', entity_id)
    .eq('canonical_service_id', canonical_service_id);
  if (error) throw error;
}

// ── Effort defaults / overrides / cadence ──

export async function fetchEffortDefaults() {
  const { data, error } = await supabase
    .from('service_effort_defaults')
    .select('*');
  if (error) throw error;
  return data || [];
}

export async function fetchEffortOverrides() {
  const { data, error } = await supabase
    .from('service_effort_overrides')
    .select('*');
  if (error) throw error;
  return data || [];
}

export async function upsertEffortOverride({ entity_id, canonical_service_id, minutes_per_job, updated_by }) {
  const payload = {
    entity_id,
    canonical_service_id,
    minutes_per_job,
    updated_by: updated_by ?? null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('service_effort_overrides')
    .upsert(payload, { onConflict: 'entity_id,canonical_service_id' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteEffortOverride({ entity_id, canonical_service_id }) {
  const { error } = await supabase
    .from('service_effort_overrides')
    .delete()
    .eq('entity_id', entity_id)
    .eq('canonical_service_id', canonical_service_id);
  if (error) throw error;
}

export async function fetchServiceCadence() {
  // 904 rows today — one intake away from the 1000 cap.
  return fetchAllRows(() => supabase
    .from('v_service_cadence')
    .select('*')
    .order('entity_id').order('canonical_service_id'));
}

// ── Capacity load + shifts ──

export async function fetchBmLoadClassified() {
  // WAS TRUNCATED: 2,059 rows behind a .limit(50000) that the API ignores, so
  // Capacity was reading 1,000 of them and under-stating the load.
  return fetchAllRows(() => supabase
    .from('v_bm_load_classified')
    .select('*')
    .order('entity_id').order('canonical_service_id').order('month'));
}

export async function fetchCapacityShifts(status = null) {
  let q = supabase.from('capacity_shifts').select('*');
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function upsertCapacityShift(shift) {
  const payload = {
    staff_id: shift.staff_id,
    source_month: shift.source_month,
    target_month: shift.target_month,
    hours: shift.hours,
    status: shift.status || 'draft',
    note: shift.note ?? null,
    created_by: shift.created_by ?? null,
  };
  if (shift.id) {
    const { data, error } = await supabase
      .from('capacity_shifts')
      .update(payload)
      .eq('id', shift.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  } else {
    const { data, error } = await supabase
      .from('capacity_shifts')
      .insert(payload)
      .select()
      .single();
    if (error) throw error;
    return data;
  }
}

export async function commitCapacityShifts(ids) {
  if (!ids.length) return;
  const { error } = await supabase
    .from('capacity_shifts')
    .update({ status: 'committed', committed_at: new Date().toISOString() })
    .in('id', ids);
  if (error) throw error;
}

export async function discardCapacityShift(id) {
  const { error } = await supabase
    .from('capacity_shifts')
    .update({ status: 'discarded' })
    .eq('id', id);
  if (error) throw error;
}

export async function updateStaffCapacityHours(staffId, hours) {
  const { error } = await supabase
    .from('staff_profiles')
    .update({ weekly_capacity_hours: hours })
    .eq('id', staffId);
  if (error) throw error;
}
