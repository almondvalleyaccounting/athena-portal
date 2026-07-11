// Data layer for the monthly Job Review feedback loop.
// Cohort + cycles come from the SQL side (ready_now_jobs view + job_review_*
// tables + open_job_review_cycle() RPC, migrations 087–089).

import { supabase } from '../../lib/supabase';
import { upsertChangeRequest } from '../work-planner/lib/readyNowChanges';

// The currently-open cycle (most recent by period_month). null if none open.
export async function fetchOpenCycle() {
  const { data, error } = await supabase
    .from('job_review_cycle')
    .select('*')
    .eq('status', 'open')
    .order('period_month', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function fetchReasons() {
  const { data, error } = await supabase
    .from('job_review_reason')
    .select('code, label, triggers_client_chase, sort')
    .eq('active', true)
    .order('sort');
  if (error) throw error;
  return data || [];
}

// All items for a cycle (manager view + dashboard radar). Embeds the primary
// assignee's name via the assignee_id → staff_profiles FK.
export async function fetchCycleItems(cycleId) {
  const { data, error } = await supabase
    .from('job_review_item')
    .select('*, assignee:assignee_id(name)')
    .eq('cycle_id', cycleId)
    .order('days_past', { ascending: false });
  if (error) throw error;
  return data || [];
}

// One assignee's items for a cycle (the "My Review" page).
export async function fetchMyItems(cycleId, staffId) {
  const { data, error } = await supabase
    .from('job_review_item')
    .select('*')
    .eq('cycle_id', cycleId)
    .eq('assignee_id', staffId)
    .order('days_past', { ascending: false });
  if (error) throw error;
  return data || [];
}

// Admin: open (or reuse) the cycle for the current month + snapshot the cohort.
export async function openCurrentCycle() {
  const { data, error } = await supabase.rpc('open_job_review_cycle');
  if (error) throw error;
  // returns [{ out_cycle_id, out_items_inserted, out_total_items }]
  return Array.isArray(data) ? data[0] : data;
}

// Admin: send the nudge/chase emails for the open cycle via the edge function.
// Invoke passes the caller's JWT, so the function authorises on their admin flag.
//   { dryRun } true  → returns the recipient plan, sends nothing
//   { reminder } true → chase tone, only unanswered items
export async function sendNudges({ dryRun = false, reminder = false, testRecipient = null } = {}) {
  const body = { dry_run: dryRun, reminder, only_unanswered: reminder };
  if (testRecipient) body.test_recipient = testRecipient;
  const { data, error } = await supabase.functions.invoke('job-review-notify', { body });
  if (error) throw error;
  return data;
}

// Save one job's feedback. Setting a done-by date also queues a bm_target
// change request so Sophie updates BrightManager (keeps BM the source of truth).
export async function submitItemResponse(item, patch, responder) {
  let changeRequestId = item.change_request_id || null;

  if (patch.done_by && patch.done_by !== item.bm_target_date) {
    try {
      const cr = await upsertChangeRequest({
        entity_id: item.entity_id,
        service: item.service,
        period_end: item.period_end,
        field: 'bm_target',
        current_value: item.bm_target_date || null,
        proposed_value: patch.done_by,
        note: `Done-by set in ${responder?.name || 'Job Review'} — update BM target date to match.`,
      });
      changeRequestId = cr?.id || changeRequestId;
    } catch (e) {
      // Don't block the response on the change-request write; surface softly.
      console.warn('[job-review] change request queue failed', e);
    }
  }

  const { data, error } = await supabase
    .from('job_review_item')
    .update({
      done_by: patch.done_by || null,
      reason_code: patch.reason_code || null,
      confidence: patch.confidence || null,
      needs_help: !!patch.needs_help,
      note: patch.note || null,
      responded_at: new Date().toISOString(),
      responded_by: responder?.id || null,
      change_request_id: changeRequestId,
    })
    .eq('id', item.id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}
