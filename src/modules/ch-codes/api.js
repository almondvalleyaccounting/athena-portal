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

// ── Lifecycle stage — the authoritative board axis (see schema_ch_code_lifecycle) ──
// 1 Offer → 2 Decision → 3a Client verifying / 3b We verify → 4 Awaiting code
// → 5 Entered (Inform Direct + BM) → 6 Submitted ✓ / 7 Rejected·exit.
export const CH_STAGES = [
  { value: 's1_offer',     short: 'Stage 1',  label: 'Offer',            tone: 'neutral', chasing: true },
  { value: 's2_decision',  short: 'Stage 2',  label: 'Decision',         tone: 'info' },
  { value: 's3a_client',   short: 'Stage 3a', label: 'Client verifying', tone: 'info',    chasing: true },
  { value: 's3b_us',       short: 'Stage 3b', label: 'We verify',        tone: 'accent',  chasing: true },
  { value: 's4_code',      short: 'Stage 4',  label: 'Awaiting code',    tone: 'warning', chasing: true },
  { value: 's5_entered',   short: 'Stage 5',  label: 'Entered',          tone: 'info' },
  { value: 's6_submitted', short: 'Stage 6',  label: 'Submitted',        tone: 'success', terminal: true },
  { value: 's7_rejected',  short: 'Stage 7',  label: 'Rejected / exit',  tone: 'danger',  terminal: true },
];
export function stageMeta(v) { return CH_STAGES.find((s) => s.value === v) || CH_STAGES[0]; }

// `status` (legacy enum) kept in sync from `stage` for continuity with the
// still-disarmed automated chaser. `stage` is the source of truth.
const STAGE_STATUS = {
  s1_offer: 'pending_offer', s2_decision: 'awaiting_decision',
  s3a_client: 'awaiting_code', s3b_us: 'awaiting_id_poa', s4_code: 'awaiting_code',
  s5_entered: 'code_received', s6_submitted: 'entered_on_bm', s7_rejected: 'stalled',
};
// Every new stage starts its chase ladder fresh — EXCEPT the escalation,
// which is a permanent state once applied (see setComms / clearEscalation).
const RESET_COMMS = { emails_sent: 0, called_at: null, last_call_outcome: null, last_call_note: null, client_replied_at: null };
// Spread this instead when the row is to hand, so a non-escalated request
// still gets its call flag reset.
function resetComms(request) {
  return isEscalated(request) ? RESET_COMMS : { ...RESET_COMMS, escalation_status: 'none', escalated_at: null };
}
export function isEscalated(r) { return r?.escalation_status === 'escalated_tracy'; }

// What happened on the call. Sophie picks one when logging it.
export const CALL_OUTCOMES = [
  { value: 'no_answer',            label: 'No answer',              tone: 'warning' },
  { value: 'client_working_on_it', label: 'Client working on it',   tone: 'info' },
  { value: 'client_sending_id',    label: 'Client sending us ID',   tone: 'accent' },
  { value: 'other',                label: 'Other (see note)',       tone: 'neutral' },
];
export function callOutcomeMeta(v) { return CALL_OUTCOMES.find((o) => o.value === v) || null; }

// ── Comms ladder WITHIN a chasing stage: no emails → 1/2/3 emails → called →
// escalated. Resets every time the stage advances. Derived, not stored. ──
export const COMMS_STEPS = [
  { value: 'not_started',  label: 'No emails', tone: 'neutral' },
  { value: 'one_email',    label: '1 email',   tone: 'info' },
  { value: 'two_emails',   label: '2 emails',  tone: 'info' },
  { value: 'three_emails', label: '3 emails',  tone: 'warning' },
  { value: 'called',       label: 'Called',    tone: 'accent' },
  { value: 'escalated',    label: 'Escalated', tone: 'danger' },
];
export function commsOf(r) {
  if (isEscalated(r)) return 'escalated';
  if (r.called_at || r.escalation_status === 'call_needed') return 'called';
  const n = r.emails_sent || 0;
  if (n >= 3) return 'three_emails';
  if (n === 2) return 'two_emails';
  if (n === 1) return 'one_email';
  return 'not_started';
}

// Move a request to another lifecycle stage; each new stage starts its chase
// ladder fresh. Dedicated helpers (recordDecision, recordCodeReceived,
// submitRequest, rejectRequest) handle the stages with side effects.
export async function advanceStage(request, toStage, { actorId } = {}) {
  await supabase.from('ch_code_requests').update({
    stage: toStage, status: STAGE_STATUS[toStage] || request.status,
    ...resetComms(request), updated_at: new Date().toISOString(),
  }).eq('id', request.id);
  await logActivity(request.id, 'status_change', `Moved to ${stageMeta(toStage).short} — ${stageMeta(toStage).label}.`, actorId);
}

// Comms-ladder actions within the current stage (call / escalate / clear the
// call flag). Escalation is deliberately NOT reachable from here in reverse —
// once a request is escalated it stays escalated; see clearEscalation.
export async function setComms(request, action, { actorId, calledAt, outcome, note } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  let patch; let body; let kind = 'system';
  switch (action) {
    case 'called': {
      const when = calledAt || new Date().toISOString();
      const oc = callOutcomeMeta(outcome)?.value || 'other';
      const clean = (note || '').trim() || null;
      await supabase.from('ch_code_calls').insert({
        request_id: request.id, called_at: when, outcome: oc, note: clean, created_by: actorId || null,
      });
      patch = { called_at: when, last_call_outcome: oc, last_call_note: clean };
      // The call flag is the pre-escalation rung of the ladder — never write
      // it over an escalation, which is what used to lose it.
      if (!isEscalated(request)) { patch.escalation_status = 'call_needed'; patch.escalated_at = today; }
      const when_s = new Date(when).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      body = `Call logged for ${when_s} — ${callOutcomeMeta(oc)?.label || oc}.${clean ? ` ${clean}` : ''}`;
      kind = 'status_change';
      break;
    }
    case 'escalated':
      if (isEscalated(request)) return;
      patch = { escalation_status: 'escalated_tracy', escalated_at: today };
      body = 'Escalated.';
      break;
    case 'reset':
      // Clears the CALL flag only. An escalated request keeps its escalation.
      patch = { called_at: null, last_call_outcome: null, last_call_note: null };
      if (!isEscalated(request)) { patch.escalation_status = 'none'; patch.escalated_at = null; }
      body = isEscalated(request) ? 'Call flag cleared (still escalated).' : 'Call flag cleared.';
      break;
    default: return;
  }
  patch.updated_at = new Date().toISOString();
  await supabase.from('ch_code_requests').update(patch).eq('id', request.id);
  await logActivity(request.id, kind, body, actorId);
}

// The one way back out of an escalation — deliberate, and logged as such.
export async function clearEscalation(request, { actorId } = {}) {
  await supabase.from('ch_code_requests')
    .update({ escalation_status: request.called_at ? 'call_needed' : 'none', updated_at: new Date().toISOString() })
    .eq('id', request.id);
  await logActivity(request.id, 'system', 'Escalation removed.', actorId);
}

// Calls logged against a request, newest first.
export async function listCalls(requestId) {
  const { data, error } = await supabase.from('ch_code_calls')
    .select('*, author:staff_profiles!ch_code_calls_created_by_fkey(id, name)')
    .eq('request_id', requestId).order('called_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// Email kinds that can be queued from a tile.
export const QUEUE_KINDS = {
  offer: 'Offer',
  reminder: 'Reminder (decision)',
  self_verify: 'Self-verify reminder',
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
  const [{ data: req, error: e1 }, { data: activity, error: e2 }, { data: documents, error: e3 }, { data: calls, error: e4 }] = await Promise.all([
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
    supabase.from('ch_code_calls')
      .select('*, author:staff_profiles!ch_code_calls_created_by_fkey(id, name)')
      .eq('request_id', id).order('called_at', { ascending: false }),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  if (e3) throw e3;
  if (e4) throw e4;

  // The request's entity_id is the CHASE ANCHOR (whichever company the chase
  // was seeded against) — not necessarily the person's own client record. A
  // director we chase via Company X may separately be their own client as a
  // sole trader. Look that up so the UI can link the person's NAME to their
  // own page, distinct from the anchor company's page.
  let ownEntity = null;
  if (req?.person_id) {
    const { data: own } = await supabase.from('entities')
      .select('id, name').eq('linked_person_id', req.person_id).limit(1).maybeSingle();
    ownEntity = own || null;
  }

  return { ...req, activity: activity || [], documents: documents || [], calls: calls || [], ownEntity };
}

export async function listStaff() {
  const { data, error } = await supabase.from('staff_profiles').select('id, name').eq('is_active', true).order('name');
  if (error) throw error;
  return data || [];
}

async function logActivity(requestId, kind, body, actorId) {
  await supabase.from('ch_code_activity').insert({ request_id: requestId, kind, body, created_by: actorId || null });
}

// Stage 2 → 3a/3b. "paid" (we do it) raises + sends the £20+VAT ID-check
// invoice — the UI guards on a client email first so it never becomes an
// unsent QBO draft. "self" moves to 3a (client self-verifies).
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
      decision: 'paid', stage: 's3b_us', status: STAGE_STATUS.s3b_us, billing_item_id: item.id,
      ...resetComms(request), updated_at: new Date().toISOString(),
    }).eq('id', request.id);
    await logActivity(request.id, 'status_change', 'Decision: we verify (£20+VAT invoice created and sent). Now at Stage 3b.', actorId);
    if (push?.results?.[0]?.error) {
      await logActivity(request.id, 'system', `⚠️ Invoice push had an issue: ${JSON.stringify(push.results[0].error)}`, actorId);
    }
    return push;
  }
  await supabase.from('ch_code_requests').update({
    decision: 'self', stage: 's3a_client', status: STAGE_STATUS.s3a_client,
    ...resetComms(request), updated_at: new Date().toISOString(),
  }).eq('id', request.id);
  await logActivity(request.id, 'status_change', 'Decision: client is self-verifying. Now at Stage 3a.', actorId);
  return null;
}

// Stage 3b: ID + proof of address received & verified → Stage 4 (awaiting code).
export async function recordIdPoaReceived(request, { actorId } = {}) {
  await supabase.from('ch_code_requests').update({
    stage: 's4_code', status: STAGE_STATUS.s4_code, ...resetComms(request), updated_at: new Date().toISOString(),
  }).eq('id', request.id);
  await logActivity(request.id, 'status_change', 'ID/POA received & verified — now awaiting the code (Stage 4).', actorId);
}

// Stage 4 → 5. Save the code on the person, move to Entered, and drop the
// "add to BM" task (auto-confirmed by the BM import when the code matches).
export async function recordCodeReceived(request, code, { actorId } = {}) {
  const trimmed = code.trim();
  await supabase.from('people').update({ ch_personal_code: trimmed }).eq('id', request.person_id);
  await supabase.from('ch_code_requests').update({
    stage: 's5_entered', status: STAGE_STATUS.s5_entered, ...resetComms(request), updated_at: new Date().toISOString(),
  }).eq('id', request.id);
  await logActivity(request.id, 'status_change', `Code received: ${trimmed}. Now at Stage 5 (entering on Inform Direct & BM).`, actorId);
  await supabase.from('admin_tasks').insert({
    kind: 'bm_code', entity_id: request.entity_id, person_id: request.person_id,
    field: 'ch_personal_code', value: trimmed,
    title: `Add personal code for ${request.person?.name || 'director/PSC'} to BM`,
    detail: `Companies House personal code: ${trimmed}`,
    source: 'ch_code_chase', created_by: actorId || null,
  });
}

// ── Stage 5 sub-steps ──
export async function markInformDirect(request, on = true, { actorId } = {}) {
  await supabase.from('ch_code_requests').update({ entered_inform_direct_at: on ? new Date().toISOString() : null, updated_at: new Date().toISOString() }).eq('id', request.id);
  await logActivity(request.id, 'status_change', on ? 'Entered on Inform Direct.' : 'Cleared Inform Direct entry.', actorId);
}
export async function markEnteredBm(request, on = true, { actorId } = {}) {
  await supabase.from('ch_code_requests').update({ entered_bm_at: on ? new Date().toISOString() : null, bm_code_mismatch: null, updated_at: new Date().toISOString() }).eq('id', request.id);
  await logActivity(request.id, 'status_change', on ? 'Entered on BrightManager.' : 'Cleared BM entry.', actorId);
}

// Stage 5 → 6: Confirmation Statement filed via Inform Direct.
export async function submitRequest(request, { actorId } = {}) {
  await supabase.from('ch_code_requests').update({
    stage: 's6_submitted', status: STAGE_STATUS.s6_submitted, submitted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', request.id);
  await logActivity(request.id, 'status_change', 'Confirmation Statement submitted via Inform Direct. ✅', actorId);
}

// Stage 7: rejected (technical) or exit (won't pursue). Available from any stage.
export async function rejectRequest(request, reason, { actorId } = {}) {
  await supabase.from('ch_code_requests').update({
    stage: 's7_rejected', status: STAGE_STATUS.s7_rejected, rejected_at: new Date().toISOString(), rejected_reason: reason || null, updated_at: new Date().toISOString(),
  }).eq('id', request.id);
  await logActivity(request.id, 'system', `Rejected / exited${reason ? `: ${reason}` : ''}.`, actorId);
}

// Bring a terminal request back to Stage 1.
export async function reopenRequest(request, { actorId } = {}) {
  await supabase.from('ch_code_requests').update({
    stage: 's1_offer', status: STAGE_STATUS.s1_offer, rejected_at: null, rejected_reason: null, submitted_at: null,
    // Reopening is an explicit fresh start, so this is the one stage move
    // that also drops the escalation.
    ...RESET_COMMS, escalation_status: 'none', escalated_at: null, updated_at: new Date().toISOString(),
  }).eq('id', request.id);
  await logActivity(request.id, 'status_change', 'Reopened to Stage 1.', actorId);
}

export async function addNote(requestId, body, { actorId } = {}) {
  await logActivity(requestId, 'note', body, actorId);
}

// Capture/patch a person's email. Used wherever a chase is blocked for want of
// an address — the Stage-3b invoice guard, the queue buttons, and the add/edit
// controls on the tiles and detail page. Logged against the request when we
// know which one prompted it, so the chase history shows where it came from.
export async function setPersonEmail(personId, email, { requestId, actorId } = {}) {
  const clean = String(email || '').trim();
  if (!clean.includes('@')) throw new Error('That doesn’t look like an email address.');
  const { error } = await supabase.from('people').update({ email: clean }).eq('id', personId);
  if (error) throw error;
  if (requestId) await logActivity(requestId, 'note', `Email set to ${clean}.`, actorId);
  return clean;
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

// Shared, editable email signature (Sophie by default) appended to every
// rendered CH-code email. Stored on the config singleton.
export async function getEmailSignature() {
  const { data, error } = await supabase.from('ch_code_chase_config').select('email_signature_html').eq('id', true).maybeSingle();
  if (error) throw error;
  return data?.email_signature_html || '';
}

export async function saveEmailSignature(html) {
  const { error } = await supabase.from('ch_code_chase_config')
    .update({ email_signature_html: html, updated_at: new Date().toISOString() }).eq('id', true);
  if (error) throw error;
}

// ── Queue ──
// Render the chosen template against this request and drop it on the queue.
// Nothing sends until someone reviews the queue and hits "Send All".
export async function queueEmail(request, kind, { actorId } = {}) {
  const to = firstEmail(request.person?.email);
  if (!to) throw new Error(`No email on file for ${request.person?.name || 'this person'} — add one to their people record first.`);

  const [{ data: tpl, error: tErr }, signatureHtml] = await Promise.all([
    supabase.from('ch_code_email_templates').select('*').eq('key', kind).single(),
    getEmailSignature().catch(() => ''),
  ]);
  if (tErr) throw tErr;

  const { subject, html, text } = renderTemplate(tpl, {
    person: request.person?.name || 'there',
    entity: request.entity?.name || 'your company',
  }, { signatureHtml });

  const { error } = await supabase.from('ch_code_email_queue').insert({
    request_id: request.id, kind, to_email: to, subject, html, text, status: 'queued', created_by: actorId || null,
  });
  if (error) throw error;
  await logActivity(request.id, 'note', `Queued a ${QUEUE_KINDS[kind] || kind} email to ${to}.`, actorId);
}

// ── Dashboard data ──
// Lightweight rows for the stage × sub-stage matrix.
export async function listChCodeStageRows() {
  const { data, error } = await supabase.from('ch_code_requests').select('stage, emails_sent, escalation_status, called_at');
  if (error) throw error;
  return data || [];
}

// Activity since a timestamp — for the rolling weekly emails/calls series.
export async function listChCodeActivitySince(sinceIso) {
  const { data, error } = await supabase.from('ch_code_activity')
    .select('kind, body, created_at')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

// Count of queued (not-yet-sent) emails per request — for tile badges.
export async function queuedCountsByRequest() {
  const { data, error } = await supabase.from('ch_code_email_queue').select('request_id').eq('status', 'queued');
  if (error) throw error;
  const map = {};
  for (const row of data || []) map[row.request_id] = (map[row.request_id] || 0) + 1;
  return map;
}

// Which email kinds are already queued per request — so a tile can show that
// button as "Queued" and stop us dropping the same email on the queue twice.
export async function queuedKindsByRequest() {
  const { data, error } = await supabase.from('ch_code_email_queue').select('request_id, kind').eq('status', 'queued');
  if (error) throw error;
  const map = {};
  for (const row of data || []) {
    if (!map[row.request_id]) map[row.request_id] = {};
    map[row.request_id][row.kind] = true;
  }
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
