// CRUD helpers for the Ready Now change-request queue. The queue is a
// staging area for Grade / BM Target / Assignee edits before an admin
// applies them in BrightManager. See sql/076_ready_now_change_requests.sql.

import { supabase } from '../../../lib/supabase';

export async function fetchPendingChangeRequests() {
  const { data, error } = await supabase
    .from('ready_now_change_requests')
    .select('id, entity_id, service, period_end, field, current_value, proposed_value, note, status, created_by, created_at, applied_at, applied_by, entities(name)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// Upsert by (entity_id, service, period_end, field) for status='pending'.
// Re-editing the same field overwrites the existing pending row instead
// of stacking duplicates.
export async function upsertChangeRequest(req) {
  const match = supabase
    .from('ready_now_change_requests')
    .select('id')
    .eq('entity_id', req.entity_id)
    .eq('service', req.service)
    .eq('field', req.field)
    .eq('status', 'pending');
  if (req.period_end) match.eq('period_end', req.period_end);
  else match.is('period_end', null);
  const { data: existing, error: lookupErr } = await match.maybeSingle();
  if (lookupErr) throw lookupErr;

  const payload = {
    entity_id: req.entity_id,
    service: req.service,
    period_end: req.period_end || null,
    field: req.field,
    current_value: req.current_value ?? null,
    proposed_value: req.proposed_value ?? null,
    note: req.note ?? null,
    status: 'pending',
  };

  if (existing?.id) {
    const { data, error } = await supabase
      .from('ready_now_change_requests')
      .update(payload)
      .eq('id', existing.id)
      .select('id, entity_id, service, period_end, field, current_value, proposed_value, note, status, created_at, entities(name)')
      .single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase
    .from('ready_now_change_requests')
    .insert(payload)
    .select('id, entity_id, service, period_end, field, current_value, proposed_value, note, status, created_at, entities(name)')
    .single();
  if (error) throw error;
  return data;
}

export async function markChangeRequestApplied(id) {
  const { error } = await supabase
    .from('ready_now_change_requests')
    .update({ status: 'applied', applied_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function cancelChangeRequest(id) {
  const { error } = await supabase
    .from('ready_now_change_requests')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}
