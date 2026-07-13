import { supabase } from '../../lib/supabase';
import { pushBillingItems } from '../../lib/qboApi';

/*
  Companies House personal code chase — data layer.
  One ch_code_requests row per person (director/PSC); the code itself lives
  on people.ch_personal_code since it applies across all their companies.
  Response capture (decision / ID+POA / code) is manual here for now — the
  client portal step is a later phase (see plan).
*/

export const CH_CODE_STATUSES = [
  { value: 'pending_offer', label: 'Offer not sent', tone: 'neutral' },
  { value: 'awaiting_decision', label: 'Awaiting decision', tone: 'warning' },
  { value: 'awaiting_id_poa', label: 'Awaiting ID/POA', tone: 'warning' },
  { value: 'awaiting_code', label: 'Awaiting code', tone: 'warning' },
  { value: 'code_received', label: 'Code received', tone: 'info' },
  { value: 'entered_on_bm', label: 'Entered on BM', tone: 'success' },
  { value: 'stalled', label: 'Stalled', tone: 'neutral' },
];

const dayMs = 24 * 60 * 60 * 1000;
export function daysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / dayMs);
}

export async function listChCodeRequests() {
  const { data, error } = await supabase
    .from('ch_code_requests')
    .select(`
      *,
      person:people(id, name, email),
      entity:entities!ch_code_requests_entity_id_fkey(id, name),
      owner:staff_profiles!ch_code_requests_owner_id_fkey(id, name)
    `)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getChCodeRequest(id) {
  const [{ data: req, error: e1 }, { data: activity, error: e2 }, { data: documents, error: e3 }] = await Promise.all([
    supabase.from('ch_code_requests')
      .select(`
        *,
        person:people(id, name, email),
        entity:entities!ch_code_requests_entity_id_fkey(id, name, billing_email, billing_line1, billing_postcode),
        owner:staff_profiles!ch_code_requests_owner_id_fkey(id, name)
      `)
      .eq('id', id).single(),
    supabase.from('ch_code_activity')
      .select('*, author:staff_profiles!ch_code_activity_created_by_fkey(id, name)')
      .eq('request_id', id).order('created_at', { ascending: false }),
    supabase.from('ch_code_documents').select('*').eq('request_id', id).order('created_at', { ascending: false }),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  if (e3) throw e3;
  return { ...req, activity: activity || [], documents: documents || [] };
}

export async function listStaff() {
  const { data, error } = await supabase.from('staff_profiles').select('id, name').eq('is_active', true).order('name');
  if (error) throw error;
  return data || [];
}

async function logActivity(requestId, kind, body, actorId) {
  await supabase.from('ch_code_activity').insert({ request_id: requestId, kind, body, created_by: actorId || null });
}

export async function recordDecision(request, decision, { actorId } = {}) {
  if (decision === 'paid') {
    const { data: item, error: billErr } = await supabase.from('billing_items').insert({
      entity_id: request.entity_id, service: 'CH Personal Code — ID Verification', description: `Identity verification for ${request.person?.name || 'director/PSC'}`,
      net_amount: 20, vat_amount: 4, gross_amount: 24,
      lines: [{ service: 'CH Personal Code — ID Verification', description: 'Companies House identity verification', net: 20, vat: 4, gross: 24 }],
      status: 'approved', created_by: actorId || null,
    }).select('id').single();
    if (billErr) throw billErr;
    const push = await pushBillingItems([item.id], true, actorId);
    await supabase.from('ch_code_requests').update({
      decision: 'paid', status: 'awaiting_id_poa', billing_item_id: item.id, updated_at: new Date().toISOString(),
    }).eq('id', request.id);
    await logActivity(request.id, 'status_change', 'Decision recorded: paid (£20+VAT). Invoice created and sent.', actorId);
    if (push?.results?.[0]?.error) {
      await logActivity(request.id, 'system', `⚠️ Invoice push had an issue: ${JSON.stringify(push.results[0].error)}`, actorId);
    }
    return push;
  }
  await supabase.from('ch_code_requests').update({ decision: 'self', status: 'awaiting_code', updated_at: new Date().toISOString() }).eq('id', request.id);
  await logActivity(request.id, 'status_change', 'Decision recorded: self-verify.', actorId);
  return null;
}

export async function recordIdPoaReceived(requestId, { actorId } = {}) {
  await supabase.from('ch_code_requests').update({ status: 'awaiting_code', updated_at: new Date().toISOString() }).eq('id', requestId);
  await logActivity(requestId, 'status_change', 'ID/POA received — verified.', actorId);
}

export async function recordCodeReceived(request, code, { actorId } = {}) {
  const trimmed = code.trim();
  await supabase.from('people').update({ ch_personal_code: trimmed }).eq('id', request.person_id);
  await supabase.from('ch_code_requests').update({ status: 'code_received', updated_at: new Date().toISOString() }).eq('id', request.id);
  await logActivity(request.id, 'status_change', 'Code received.', actorId);
  await supabase.from('admin_tasks').insert({
    kind: 'bm_code', entity_id: request.entity_id, person_id: request.person_id,
    field: 'ch_personal_code', value: trimmed,
    title: `Add personal code for ${request.person?.name || 'director/PSC'} to BM`,
    detail: `Companies House personal code: ${trimmed}`,
    source: 'ch_code_chase', created_by: actorId || null,
  });
}

export async function markEnteredOnBm(requestId, { actorId } = {}) {
  await supabase.from('ch_code_requests').update({ status: 'entered_on_bm', updated_at: new Date().toISOString() }).eq('id', requestId);
  await logActivity(requestId, 'status_change', 'Entered on BrightManager.', actorId);
}

export async function resendOffer(requestId, { actorId } = {}) {
  await supabase.from('ch_code_requests').update({ chase_count: 0, escalation_status: 'none', updated_at: new Date().toISOString() }).eq('id', requestId);
  await logActivity(requestId, 'note', 'Marked for a fresh offer — will go out on the next chase run.', actorId);
}

export async function escalateNow(requestId, { actorId } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  await supabase.from('ch_code_requests').update({ escalation_status: 'call_needed', escalated_at: today, updated_at: new Date().toISOString() }).eq('id', requestId);
  await logActivity(requestId, 'system', 'Manually escalated — call needed.', actorId);
}

export async function addNote(requestId, body, { actorId } = {}) {
  await logActivity(requestId, 'note', body, actorId);
}

export async function markStalled(requestId, { actorId } = {}) {
  await supabase.from('ch_code_requests').update({ status: 'stalled', updated_at: new Date().toISOString() }).eq('id', requestId);
  await logActivity(requestId, 'system', 'Marked stalled — no longer chased.', actorId);
}

// Manual "record a reply" — staff logs what a client said in an actual
// email reply, since inbound-email parsing doesn't exist yet.
export async function recordClientReply(requestId, body, { actorId } = {}) {
  await logActivity(requestId, 'client_reply', body, actorId);
}
