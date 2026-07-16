import { supabase } from '../../../lib/supabase';

// The five canonical services driven by the Allocations matrix.
// Order here = column order in the matrix.
export const ALLOCATION_SERVICES = [
  { id: 'bookkeeping',          label: 'Bookkeeping',          cadence: 'monthly'   },
  { id: 'vat_review',           label: 'VAT Reviews',          cadence: 'quarterly' },
  { id: 'accounts_preparation', label: 'Accounts Preparation', cadence: 'annual'    },
  { id: 'accounts_submission',  label: 'Accounts Submission',  cadence: 'annual'    },
  { id: 'self_assessment',      label: 'Self Assessment',      cadence: 'annual'    },
];

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
  const { data, error } = await supabase
    .from('v_inferred_allocations')
    .select('*');
  if (error) throw error;
  return data || [];
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
  const { data, error } = await supabase
    .from('entity_people')
    .select('entity_id, person_id, role, role_pct, ended_on, source')
    .in('entity_id', entityIds);
  if (error) throw error;
  return data || [];
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
  const { data, error } = await supabase
    .from('v_service_cadence')
    .select('*');
  if (error) throw error;
  return data || [];
}

// ── Capacity load + shifts ──

export async function fetchBmLoadClassified() {
  const { data, error } = await supabase
    .from('v_bm_load_classified')
    .select('*')
    .limit(50000);
  if (error) throw error;
  return data || [];
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
