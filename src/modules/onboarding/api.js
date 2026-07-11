import { supabase } from '../../lib/supabase';

/*
  Onboarding data layer.

  Instantiation model: template steps are COPIED onto the onboarding at
  creation so templates can evolve without rewriting history. At creation
  we resolve, from the client's committed/accepted quote:
    - service_condition  → steps whose condition isn't met start as 'na'
    - auto_check         → steps Athena can verify are completed immediately
*/

// Maps template service_condition keys → fee-engine service_ids (quote_line_items.service_id)
export const SERVICE_CONDITION_MAP = {
  sa: ['directors_tax_return'],
  ct: ['accounts_ct'],
  vat: ['bookkeeping_vat', 'vat_returns'],
  paye: ['payroll', 'auto_enrolment'],
  // No fee-engine service maps to CIS yet — CIS steps default to N/A and are toggled on manually
  cis: [],
  software: ['software_accounting', 'software'],
  confirmation_statement: ['confirmation_statement'],
};

export const STEP_STATUSES = [
  { value: 'pending', label: 'To do', tone: 'neutral' },
  { value: 'waiting_client', label: 'Waiting on client', tone: 'warning' },
  { value: 'waiting_external', label: 'Waiting on HMRC / 3rd party', tone: 'accent' },
  { value: 'blocked', label: 'Blocked', tone: 'danger' },
  { value: 'received', label: 'Received — to check', tone: 'info' },
  { value: 'complete', label: 'Complete', tone: 'success' },
  { value: 'na', label: 'N/A', tone: 'neutral' },
];

export const ONBOARDING_STATUSES = [
  { value: 'active', label: 'Active', tone: 'info' },
  { value: 'on_hold', label: 'On hold', tone: 'warning' },
  { value: 'issues', label: 'Issues', tone: 'danger' },
  { value: 'complete', label: 'Complete', tone: 'success' },
  { value: 'cancelled', label: 'Cancelled', tone: 'neutral' },
];

const dayMs = 24 * 60 * 60 * 1000;
export function daysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / dayMs);
}

// A step is overdue when it has sat in a waiting state past its expected turnaround
export function isOverdue(step) {
  if (!['waiting_client', 'waiting_external'].includes(step.status)) return false;
  const waited = daysSince(step.requested_at);
  if (waited == null) return false;
  const limit = step.status === 'waiting_client'
    ? (step.chase_after_days ?? step.expected_days)
    : (step.expected_days ?? step.chase_after_days);
  return limit != null && waited > limit;
}

export async function listStaff() {
  const { data, error } = await supabase
    .from('staff_profiles')
    .select('id, name')
    .eq('is_active', true)
    .order('name');
  if (error) throw error;
  return data || [];
}

export async function listTemplates() {
  const { data, error } = await supabase
    .from('onboarding_templates')
    .select('*, steps:onboarding_template_steps(*)')
    .eq('active', true)
    .order('created_at');
  if (error) throw error;
  return (data || []).map((t) => ({
    ...t,
    steps: (t.steps || []).sort((a, b) => a.group_sort - b.group_sort || a.sort - b.sort),
  }));
}

export async function listOnboardings() {
  const { data, error } = await supabase
    .from('onboardings')
    .select(`
      *,
      entity:entities(id, name, entity_status),
      template:onboarding_templates(id, code, name),
      owner:staff_profiles!onboardings_owner_id_fkey(id, name),
      lead:staff_profiles!onboardings_lead_id_fkey(id, name),
      steps:onboarding_steps(id, status, owner_type, requested_at, expected_days, chase_after_days)
    `)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getOnboarding(id) {
  const [{ data: ob, error: e1 }, { data: activity, error: e2 }, { data: documents, error: e3 }] = await Promise.all([
    supabase
      .from('onboardings')
      .select(`
        *,
        entity:entities(id, name, entity_status),
        template:onboarding_templates(id, code, name),
        owner:staff_profiles!onboardings_owner_id_fkey(id, name),
        lead:staff_profiles!onboardings_lead_id_fkey(id, name),
        steps:onboarding_steps(*)
      `)
      .eq('id', id)
      .single(),
    supabase
      .from('onboarding_activity')
      .select('*, author:staff_profiles!onboarding_activity_created_by_fkey(id, name)')
      .eq('onboarding_id', id)
      .order('created_at', { ascending: false }),
    supabase
      .from('onboarding_documents')
      .select('*')
      .eq('onboarding_id', id)
      .order('created_at', { ascending: false }),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  if (e3) throw e3;
  ob.steps = (ob.steps || []).sort((a, b) => a.group_sort - b.group_sort || a.sort - b.sort);
  return { ...ob, activity: activity || [], documents: documents || [] };
}

export async function searchEntities(term) {
  let q = supabase
    .from('entities')
    .select('id, name, entity_status')
    .order('name')
    .limit(25);
  if (term) q = q.ilike('name', `%${term}%`);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function activeOnboardingsForEntity(entityId) {
  const { data, error } = await supabase
    .from('onboardings')
    .select('id, status')
    .eq('entity_id', entityId)
    .in('status', ['active', 'on_hold', 'issues']);
  if (error) throw error;
  return data || [];
}

// Latest committed/accepted quote + its service ids — used to resolve
// conditional steps and the 'quote_accepted' auto-check.
export async function findCommittedQuote(entityId) {
  const { data, error } = await supabase
    .from('quotes')
    .select('id, quote_ref, status, created_at, line_items:quote_line_items(service_id)')
    .eq('entity_id', entityId)
    .in('status', ['committed', 'accepted'])
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const quote = data?.[0] || null;
  const serviceIds = new Set((quote?.line_items || []).map((li) => li.service_id));
  return { quote, serviceIds };
}

export async function hasLiveBilling(entityId) {
  const { data, error } = await supabase
    .from('live_billing')
    .select('id')
    .eq('entity_id', entityId)
    .limit(1);
  if (error) throw error;
  return (data || []).length > 0;
}

// Resolve what will happen to each template step for a given entity.
// Returns [{ templateStep, initialStatus, reason }]
export function resolveSteps(templateSteps, { quote, serviceIds, liveBilling }) {
  return templateSteps.map((ts) => {
    let initialStatus = 'pending';
    let reason = null;
    if (ts.service_condition && quote) {
      const mapped = SERVICE_CONDITION_MAP[ts.service_condition] || [];
      const met = mapped.some((sid) => serviceIds.has(sid));
      if (!met) {
        initialStatus = 'na';
        reason = ts.service_condition === 'cis'
          ? 'No CIS mapping from the quote — toggle on if needed'
          : `Quote has no ${ts.service_condition.replace(/_/g, ' ')} service`;
      }
    }
    if (initialStatus === 'pending' && ts.auto_check === 'quote_accepted' && quote) {
      initialStatus = 'complete';
      reason = `Auto-verified: quote ${quote.quote_ref || ''} is ${quote.status}`;
    }
    if (initialStatus === 'pending' && ts.auto_check === 'live_billing' && liveBilling) {
      initialStatus = 'complete';
      reason = 'Auto-verified: live billing exists for this client';
    }
    return { templateStep: ts, initialStatus, reason };
  });
}

export async function createOnboarding({ entityId, template, ownerId, leadId, targetDate, actorId }) {
  const { quote, serviceIds } = await findCommittedQuote(entityId);
  const liveBilling = await hasLiveBilling(entityId);
  const resolved = resolveSteps(template.steps, { quote, serviceIds, liveBilling });

  const { data: ob, error: e1 } = await supabase
    .from('onboardings')
    .insert({
      entity_id: entityId,
      template_id: template.id,
      quote_id: quote?.id || null,
      owner_id: ownerId || null,
      lead_id: leadId || null,
      target_date: targetDate || null,
      created_by: actorId || null,
    })
    .select('id')
    .single();
  if (e1) throw e1;

  const now = new Date().toISOString();
  const stepRows = resolved.map(({ templateStep: ts, initialStatus }) => ({
    onboarding_id: ob.id,
    template_step_id: ts.id,
    group_name: ts.group_name,
    group_sort: ts.group_sort,
    sort: ts.sort,
    name: ts.name,
    description: ts.description,
    owner_type: ts.owner_type,
    assignee_id: ts.assignee_id || ownerId || null,
    status: initialStatus,
    expected_days: ts.expected_days,
    chase_after_days: ts.chase_after_days,
    auto_check: ts.auto_check,
    client_label: ts.client_label,
    completed_at: initialStatus === 'complete' ? now : null,
  }));
  const { error: e2 } = await supabase.from('onboarding_steps').insert(stepRows);
  if (e2) throw e2;

  const autoNotes = resolved
    .filter((r) => r.reason)
    .map((r) => `${r.templateStep.name} → ${r.initialStatus === 'na' ? 'N/A' : 'complete'} (${r.reason})`);
  const body = [
    `Onboarding started — template "${template.name}"${quote ? `, linked to quote ${quote.quote_ref || quote.id}` : ', no committed quote found'}`,
    ...autoNotes,
  ].join('\n');
  await supabase.from('onboarding_activity').insert({
    onboarding_id: ob.id, kind: 'system', body, created_by: actorId || null,
  });

  return ob.id;
}

export async function updateOnboarding(id, patch, { actorId, logBody } = {}) {
  const { error } = await supabase.from('onboardings').update(patch).eq('id', id);
  if (error) throw error;
  if (logBody) {
    await supabase.from('onboarding_activity').insert({
      onboarding_id: id, kind: 'status_change', body: logBody, created_by: actorId || null,
    });
  }
}

export async function updateStep(step, patch, { actorId, logBody } = {}) {
  const { error } = await supabase
    .from('onboarding_steps')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', step.id);
  if (error) throw error;
  if (logBody) {
    await supabase.from('onboarding_activity').insert({
      onboarding_id: step.onboarding_id, step_id: step.id,
      kind: 'status_change', body: logBody, created_by: actorId || null,
    });
  }
}

// ── Chaser engine (edge function onboarding-chase) ──

export async function getChaseConfig() {
  const { data, error } = await supabase
    .from('onboarding_chase_config')
    .select('*')
    .eq('id', true)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function setChaseConfig(patch) {
  const { error } = await supabase
    .from('onboarding_chase_config')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', true);
  if (error) throw error;
}

// Dry run: returns { client_chases: [...], digests: [...] } — nothing is sent.
export async function runChaseDryRun() {
  const { data, error } = await supabase.functions.invoke('onboarding-chase', {
    body: { dry_run: true },
  });
  if (error) throw error;
  return data;
}

// Sends ONE sample client email + ONE sample digest to the given address.
export async function runChaseTestSend(testRecipient) {
  const { data, error } = await supabase.functions.invoke('onboarding-chase', {
    body: { dry_run: false, test_recipient: testRecipient },
  });
  if (error) throw error;
  return data;
}

// ── Documents + Google Drive ──

export async function getDriveConnection() {
  const { data, error } = await supabase
    .from('gdrive_connections')
    .select('id, account_email, status, connected_at')
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Kicks off the Google consent flow; the callback lands back on returnTo.
export function driveConnectUrl(staffId, returnTo = '/onboarding') {
  const base = import.meta.env.VITE_SUPABASE_URL;
  return `${base}/functions/v1/drive-auth-init?staff_id=${staffId || ''}&return_to=${encodeURIComponent(returnTo)}`;
}

export async function saveDocumentsToDrive(onboardingId) {
  const { data, error } = await supabase.functions.invoke('drive-save-documents', {
    body: { onboarding_id: onboardingId },
  });
  if (error) {
    // FunctionsHttpError carries the response — surface the server's message
    try {
      const body = await error.context?.json?.();
      if (body?.error) throw new Error(body.error);
    } catch (inner) { if (inner instanceof Error && inner.message !== error.message) throw inner; }
    throw error;
  }
  return data;
}

// AI extraction (edge fn doc-extract) — runs automatically on upload via a
// DB trigger; this is the manual (re-)run for errors or re-reads.
export async function extractDocument(documentId, force = true) {
  const { data, error } = await supabase.functions.invoke('doc-extract', {
    body: { document_id: documentId, force },
  });
  if (error) throw error;
  return data;
}

export async function getDocumentUrl(storagePath) {
  const { data, error } = await supabase.storage
    .from('client-documents')
    .createSignedUrl(storagePath, 3600);
  if (error) throw error;
  return data.signedUrl;
}

// ── Client portal access (separate app: athena-client-portal.vercel.app) ──

export async function listPortalAccess(entityId) {
  const { data, error } = await supabase
    .from('client_portal_invites')
    .select('id, email, created_at, claimed_at')
    .eq('entity_id', entityId)
    .order('created_at');
  if (error) throw error;
  return data || [];
}

export async function invitePortalUser(entityId, email, { actorId, onboardingId } = {}) {
  const { error } = await supabase.from('client_portal_invites').insert({
    entity_id: entityId,
    email: email.trim().toLowerCase(),
    invited_by: actorId || null,
  });
  if (error) throw error;
  if (onboardingId) {
    await supabase.from('onboarding_activity').insert({
      onboarding_id: onboardingId, kind: 'system',
      body: `Portal access granted for ${email.trim().toLowerCase()} — they can now sign in at the client portal.`,
      created_by: actorId || null,
    });
  }
}

export async function removePortalInvite(inviteId) {
  const { error } = await supabase.from('client_portal_invites').delete().eq('id', inviteId);
  if (error) throw error;
}

export async function addNote(onboardingId, body, { actorId, stepId } = {}) {
  const { error } = await supabase.from('onboarding_activity').insert({
    onboarding_id: onboardingId, step_id: stepId || null,
    kind: 'note', body, created_by: actorId || null,
  });
  if (error) throw error;
}
