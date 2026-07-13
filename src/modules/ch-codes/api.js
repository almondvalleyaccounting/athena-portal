import { supabase } from '../../lib/supabase';
import { pushBillingItems } from '../../lib/qboApi';
import { renderTemplate } from './emailRender';

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

// "Who's doing it" — Sophie's manual responsibility toggle, independent of
// the pipeline status. Not Started / Client / Us / Awaiting Response.
export const HANDLING_OPTIONS = [
  { value: 'not_started', label: 'Not started', tone: 'neutral' },
  { value: 'client', label: 'Client', tone: 'info' },
  { value: 'us', label: 'Us', tone: 'accent' },
  { value: 'awaiting_response', label: 'Awaiting response', tone: 'warning' },
];

// Chase stage — how far along the chasing is. This is the board grouping.
// Derived from emails_sent + escalation_status (no separate column), so it
// stays in step with real queue sends and the automated chaser; Sophie can
// also set it directly from a tile, which writes those same fields.
export const CH_STAGES = [
  { value: 'not_started', label: 'Not started', tone: 'neutral' },
  { value: 'one_email', label: 'One email', tone: 'info' },
  { value: 'two_emails', label: 'Two emails', tone: 'warning' },
  { value: 'called', label: 'Called', tone: 'accent' },
  { value: 'escalated', label: 'Escalated', tone: 'danger' },
];

export function stageOf(r) {
  if (r.escalation_status === 'escalated_tracy') return 'escalated';
  if (r.escalation_status === 'call_needed') return 'called';
  const n = r.emails_sent || 0;
  if (n >= 2) return 'two_emails';
  if (n === 1) return 'one_email';
  return 'not_started';
}

export async function setStage(request, stage, { actorId } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  let patch;
  switch (stage) {
    case 'not_started': patch = { emails_sent: 0, escalation_status: 'none', escalated_at: null }; break;
    case 'one_email':   patch = { emails_sent: 1, escalation_status: 'none', escalated_at: null }; break;
    case 'two_emails':  patch = { emails_sent: 2, escalation_status: 'none', escalated_at: null }; break;
    case 'called':      patch = { escalation_status: 'call_needed', escalated_at: today }; break;
    case 'escalated':   patch = { escalation_status: 'escalated_tracy', escalated_at: today }; break;
    default: return;
  }
  patch.updated_at = new Date().toISOString();
  await supabase.from('ch_code_requests').update(patch).eq('id', request.id);
  const label = CH_STAGES.find((s) => s.value === stage)?.label || stage;
  await logActivity(request.id, 'status_change', `Stage set to "${label}".`, actorId);
}

// Email kinds that can be queued from a tile.
export const QUEUE_KINDS = {
  offer: 'Offer',
  reminder: 'Reminder (decision)',
  id_poa: 'ID & POA request',
  code: 'Code reminder',
};

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

// ── Who's-doing-it toggle ──
export async function setHandling(requestId, handling, { actorId } = {}) {
  const opt = HANDLING_OPTIONS.find((o) => o.value === handling);
  await supabase.from('ch_code_requests').update({ handling, updated_at: new Date().toISOString() }).eq('id', requestId);
  await logActivity(requestId, 'note', `Marked "${opt?.label || handling}" as who's handling it.`, actorId);
}

// ── Emails-sent counter (Sophie can seed it with emails already sent by hand) ──
export async function setEmailsSent(requestId, count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  await supabase.from('ch_code_requests').update({ emails_sent: n, updated_at: new Date().toISOString() }).eq('id', requestId);
  return n;
}

// ── Templates ──
export async function listTemplates() {
  const { data, error } = await supabase.from('ch_code_email_templates').select('*').order('key');
  if (error) throw error;
  return data || [];
}

export async function saveTemplate(key, { subject, body_html }, { actorId } = {}) {
  const { error } = await supabase.from('ch_code_email_templates')
    .update({ subject, body_html, updated_by: actorId || null, updated_at: new Date().toISOString() })
    .eq('key', key);
  if (error) throw error;
}

// ── Queue ──
// Render the chosen template against this request and drop it on the queue.
// Nothing sends until someone reviews the queue and hits "Send All".
export async function queueEmail(request, kind, { actorId } = {}) {
  const to = firstEmail(request.person?.email);
  if (!to) throw new Error(`No email on file for ${request.person?.name || 'this person'} — add one to their people record first.`);

  const { data: tpl, error: tErr } = await supabase.from('ch_code_email_templates').select('*').eq('key', kind).single();
  if (tErr) throw tErr;

  const { subject, html, text } = renderTemplate(tpl, {
    person: request.person?.name || 'there',
    entity: request.entity?.name || 'your company',
  });

  const { error } = await supabase.from('ch_code_email_queue').insert({
    request_id: request.id, kind, to_email: to, subject, html, text, status: 'queued', created_by: actorId || null,
  });
  if (error) throw error;
  await logActivity(request.id, 'note', `Queued a ${QUEUE_KINDS[kind] || kind} email to ${to}.`, actorId);
}

// Count of queued (not-yet-sent) emails per request — for tile badges.
export async function queuedCountsByRequest() {
  const { data, error } = await supabase.from('ch_code_email_queue').select('request_id').eq('status', 'queued');
  if (error) throw error;
  const map = {};
  for (const row of data || []) map[row.request_id] = (map[row.request_id] || 0) + 1;
  return map;
}

export async function listQueue(status = 'queued') {
  const { data, error } = await supabase.from('ch_code_email_queue')
    .select(`
      *,
      request:ch_code_requests(
        id,
        person:people(id, name, email),
        entity:entities!ch_code_requests_entity_id_fkey(id, name)
      )
    `)
    .eq('status', status)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function cancelQueued(id) {
  const { error } = await supabase.from('ch_code_email_queue').update({ status: 'cancelled' }).eq('id', id);
  if (error) throw error;
}

// Fires the edge function that actually sends. ids omitted = send every queued row.
export async function sendQueue(ids) {
  const { data, error } = await supabase.functions.invoke('ch-code-queue-send', {
    body: ids && ids.length ? { ids } : {},
  });
  if (error) throw error;
  if (data && data.success === false) throw new Error(data.error || 'Send failed');
  return data;
}

function firstEmail(raw) {
  if (!raw) return null;
  const e = String(raw).split(/[;,]/)[0].trim();
  return e.includes('@') ? e : null;
}
