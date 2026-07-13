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

// Editable service selection — gates conditional step groups, handover areas
// (the per-area "task owner") and the 3-month check-in tiles. Keys match
// onboarding_template_steps.service_condition.
export const SERVICE_OPTIONS = [
  { key: 'ct', label: 'Accounts & Corporation Tax' },
  { key: 'vat', label: 'Bookkeeping & VAT' },
  { key: 'paye', label: 'Payroll (PAYE)' },
  { key: 'sa', label: 'Self-Assessment' },
  { key: 'cis', label: 'CIS' },
  { key: 'software', label: 'Software' },
  { key: 'confirmation_statement', label: 'Confirmation statement' },
];

// One-off HMRC registrations — ticking one adds a tracked task step.
export const REGISTRATION_OPTIONS = [
  { key: 'vat', label: 'VAT', stepName: 'Register client for VAT with HMRC' },
  { key: 'paye', label: 'PAYE (employer)', stepName: 'Register client as an employer (PAYE) with HMRC' },
  { key: 'cis', label: 'CIS', stepName: 'Register client for CIS with HMRC' },
];

// Ad-hoc Companies House changes — each adds a tracked task step.
export const CH_TASK_OPTIONS = [
  { key: 'change_directors', label: 'Change directors', stepName: 'Companies House — update directors' },
  { key: 'change_shareholding', label: 'Change shareholding', stepName: 'Companies House — update shareholding' },
  { key: 'other', label: 'Other…', stepName: 'Companies House — ' },
];

export const REG_GROUP = 'HMRC Registration';
export const REG_GROUP_SORT = 900;
export const CH_GROUP = 'Companies House';
export const CH_GROUP_SORT = 950;

// Board view columns — the significant milestones staff want to see at a
// glance (akin to the old Excel tracker's columns), grouped the same way as
// onboarding_steps.group_name. A step counts for a column when it's flagged
// milestone=true AND its (group_name, name) appears in that column's match
// list. Some milestone names are reused verbatim across groups ("Received
// agent code and switched on BM" appears under both SA and PAYE) so matching
// must always use the (group_name, name) pair, never name alone. The
// standalone vat_reg/paye_reg templates use different group names/wording
// for the same real-world milestone as the company template — their steps
// are folded into the same column via extra match entries rather than
// getting their own near-empty columns.
export const MILESTONE_COLUMNS = [
  { key: 'loe', group: 'Onboarding', label: 'LOE signed', match: [{ group_name: 'Onboarding', name: 'Letter of Engagement signed and returned' }] },
  { key: 'id', group: 'Onboarding', label: '2 forms of ID', match: [{ group_name: 'Onboarding', name: 'Received 2 forms of ID' }] },
  { key: 'qb_licence', group: 'Onboarding', label: 'QB licence', match: [{ group_name: 'Onboarding', name: 'Assign QB licence to client (if applicable)' }] },
  { key: 'ch_auth_code', group: 'Onboarding', label: 'CH auth code', match: [{ group_name: 'Onboarding', name: 'Companies House authentication code entered' }] },
  { key: 'quote_accepted', group: 'Onboarding', label: 'Quote accepted', match: [{ group_name: 'Onboarding', name: 'Accepted quote' }] },

  { key: 'personal_utr', group: 'SA', label: 'Personal UTR', match: [{ group_name: 'SA', name: 'Received personal UTR' }] },
  { key: 'sa_agent_code', group: 'SA', label: 'Agent code', match: [{ group_name: 'SA', name: 'Received agent code and switched on BM' }] },
  { key: 'sa_billing_tracker', group: 'SA', label: 'Billing tracker', match: [{ group_name: 'SA', name: 'Added to billing tracker' }] },

  { key: 'company_utr', group: 'CT', label: 'Company UTR', match: [{ group_name: 'CT', name: 'Company UTR received and logged on BM' }] },
  { key: 'ct_agent_code', group: 'CT', label: 'Agent code', match: [{ group_name: 'CT', name: 'Received CT agent code and switched on BM' }] },

  {
    key: 'vat_number', group: 'VAT', label: 'VAT number',
    match: [
      { group_name: 'VAT', name: 'Enter VAT number on BM and validate' },
      { group_name: 'VAT Registration', name: 'Received VAT number' },
    ],
  },

  {
    key: 'paye_ref', group: 'PAYE', label: 'PAYE ref',
    match: [
      { group_name: 'PAYE', name: 'Receive PAYE ref / accounts office ref' },
      { group_name: 'PAYE Registration', name: 'Received PAYE ref from client — save to BM' },
    ],
  },
  {
    key: 'paye_agent_code', group: 'PAYE', label: 'Agent code',
    match: [
      { group_name: 'PAYE', name: 'Received agent code and switched on BM' },
      { group_name: 'PAYE Registration', name: 'Received agent code and switched on BM' },
    ],
  },
  { key: 'brightpay', group: 'PAYE', label: 'Brightpay setup', match: [{ group_name: 'PAYE', name: 'Setup on Brightpay' }] },

  { key: 'cis_code', group: 'CIS', label: 'CIS code', match: [{ group_name: 'CIS', name: 'Receive CIS code and switched on BM' }] },

  { key: 'live_billing', group: 'Billing', label: 'Live billing', match: [{ group_name: 'Billing', name: 'Committed to live billing (QB invoice / recurring in place)' }] },
];

// Returns the step (or undefined) from an onboarding's steps that fills a
// given board column — undefined means the client's template doesn't
// include this milestone at all (renders as a blank cell, not 'na').
export function findMilestoneCell(steps, column) {
  return (steps || []).find((s) => s.milestone && column.match.some((m) => m.group_name === s.group_name && m.name === s.name));
}

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
      entity:entities!onboardings_entity_id_fkey(id, name, entity_status),
      template:onboarding_templates(id, code, name),
      owner:staff_profiles!onboardings_owner_id_fkey(id, name),
      lead:staff_profiles!onboardings_lead_id_fkey(id, name),
      steps:onboarding_steps(id, status, owner_type, requested_at, expected_days, chase_after_days, name, group_name, milestone),
      handovers:onboarding_handovers(area, due, done_at)
    `)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// ── Service-area handovers ──
// Defaults (customisable): who owns each area during onboarding, and which
// service condition makes the area relevant. Instantiated per onboarding.

export async function listHandoverDefaults() {
  const { data, error } = await supabase
    .from('onboarding_handover_defaults')
    .select('*')
    .order('sort');
  if (error) throw error;
  return data || [];
}

export async function saveHandoverDefault(def) {
  const { error } = await supabase
    .from('onboarding_handover_defaults')
    .upsert({ ...def, updated_at: new Date().toISOString() }, { onConflict: 'area' });
  if (error) throw error;
}

// Create any missing area rows from the defaults — areas with a service
// condition only apply when the client's quote/billing meets it (same
// resolution as conditional steps). Safe to call repeatedly.
export async function initHandovers(onboarding) {
  const defaults = await listHandoverDefaults();
  const have = new Set((onboarding.handovers || []).map((h) => h.area));
  const conds = onboarding.service_conditions || [];
  const rows = defaults
    .filter((d) => d.active && !have.has(d.area))
    .filter((d) => !d.service_condition || conds.includes(d.service_condition))
    .map((d) => ({
      onboarding_id: onboarding.id,
      area: d.area,
      service_condition: d.service_condition || null,
      owner_id: d.default_owner_id || onboarding.owner_id || null,
    }));
  if (rows.length) {
    const { error } = await supabase
      .from('onboarding_handovers')
      .upsert(rows, { onConflict: 'onboarding_id,area', ignoreDuplicates: true });
    if (error) throw error;
  }
  return rows.length;
}

export async function updateHandover(id, patch) {
  const { error } = await supabase.from('onboarding_handovers').update(patch).eq('id', id);
  if (error) throw error;
}

export async function addHandoverArea(onboardingId, area, ownerId) {
  const { error } = await supabase.from('onboarding_handovers').insert({
    onboarding_id: onboardingId, area: area.trim(), owner_id: ownerId || null,
  });
  if (error) throw error;
}

export async function removeHandover(id) {
  const { error } = await supabase.from('onboarding_handovers').delete().eq('id', id);
  if (error) throw error;
}

export async function getOnboarding(id) {
  const [{ data: ob, error: e1 }, { data: activity, error: e2 }, { data: documents, error: e3 }, { data: handovers }] = await Promise.all([
    supabase
      .from('onboardings')
      .select(`
        *,
        entity:entities!onboardings_entity_id_fkey(id, name, entity_status, prospect_email, billing_email),
        referred_by:entities!onboardings_referred_by_entity_id_fkey(id, name),
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
    supabase
      .from('onboarding_handovers')
      .select('*')
      .eq('onboarding_id', id)
      .order('created_at'),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  if (e3) throw e3;
  ob.steps = (ob.steps || []).sort((a, b) => a.group_sort - b.group_sort || a.sort - b.sort);
  return { ...ob, activity: activity || [], documents: documents || [], handovers: handovers || [] };
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

// Mirrors the Clients page insert so prospects can be created mid-flow
export async function createEntity({ name, prospectEmail, type }) {
  const { data, error } = await supabase
    .from('entities')
    .insert({
      name,
      type: type || 'limited_company',
      entity_status: 'prospect',
      prospect_email: prospectEmail || null,
      source: 'athena',
    })
    .select('id, name, entity_status')
    .single();
  if (error) throw error;
  return data;
}

// Layer SA steps for an additional director (BM can't do this) — copies the
// template's SA group onto the live onboarding as "SA — <name>".
export async function addDirectorSa(onboarding, directorName, { actorId } = {}) {
  const { data: tSteps, error: e1 } = await supabase
    .from('onboarding_template_steps')
    .select('*')
    .eq('template_id', onboarding.template_id)
    .eq('group_name', 'SA')
    .order('sort');
  if (e1) throw e1;
  if (!tSteps?.length) throw new Error('This template has no SA group to copy.');

  const maxGroupSort = Math.max(0, ...onboarding.steps.map((s) => s.group_sort));
  const rows = tSteps.map((ts) => ({
    onboarding_id: onboarding.id,
    template_step_id: ts.id,
    group_name: `SA — ${directorName}`,
    group_sort: maxGroupSort + 1,
    sort: ts.sort,
    name: ts.name,
    description: ts.description,
    owner_type: ts.owner_type,
    assignee_id: ts.assignee_id || onboarding.owner_id || null,
    status: 'pending',
    expected_days: ts.expected_days,
    chase_after_days: ts.chase_after_days,
    client_label: ts.client_label,
    milestone: ts.milestone,
    service_condition: ts.service_condition,
  }));
  const { error: e2 } = await supabase.from('onboarding_steps').insert(rows);
  if (e2) throw e2;
  await supabase.from('onboarding_activity').insert({
    onboarding_id: onboarding.id, kind: 'system',
    body: `Self-assessment steps added for director: ${directorName}`,
    created_by: actorId || null,
  });
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

// Best active quote + its service ids — used to resolve conditional steps
// and the 'quote_accepted' auto-check. A new prospect's quote is usually
// still 'sent' (commit is the terminal billing step, at go-live), so we
// take the most advanced non-deleted quote rather than requiring committed.
const QUOTE_PRIORITY = { committed: 5, accepted: 4, sent: 3, approved: 2, pending_approval: 1, draft: 0 };
export async function findActiveQuote(entityId) {
  const { data, error } = await supabase
    .from('quotes')
    .select('id, quote_ref, status, created_at, dd_mandate_status, line_items:quote_line_items(service_id)')
    .eq('entity_id', entityId)
    .neq('status', 'deleted');
  if (error) throw error;
  const quote = (data || []).sort((a, b) =>
    (QUOTE_PRIORITY[b.status] ?? 0) - (QUOTE_PRIORITY[a.status] ?? 0)
    || new Date(b.created_at) - new Date(a.created_at))[0] || null;
  const serviceIds = new Set((quote?.line_items || []).map((li) => li.service_id));
  return { quote, serviceIds };
}

// Active QBO billing for the entity — existing clients have no quote, but
// their live_billing row carries service names ("Bookkeeping & VAT Returns")
// we can resolve conditions from.
export async function findLiveBilling(entityId) {
  const { data, error } = await supabase
    .from('live_billing')
    .select('id, status, services')
    .eq('entity_id', entityId)
    .eq('status', 'active');
  if (error) throw error;
  const rows = data || [];
  const serviceNames = rows.flatMap((r) => (r.services || []).map((s) => s.service_id).filter(Boolean));
  return { hasBilling: rows.length > 0, serviceNames };
}

export async function hasLiveBilling(entityId) {
  return (await findLiveBilling(entityId)).hasBilling;
}

// QBO billing service display names → onboarding condition keys (keyword match)
const BILLING_CONDITION_RULES = [
  [/vat/i, 'vat'],
  [/payroll/i, 'paye'],
  [/self assessment|sole trader/i, 'sa'],
  [/accounts|business tax|package|retainer/i, 'ct'],
  [/confirmation statement/i, 'confirmation_statement'],
  [/software/i, 'software'],
  [/cis|construction/i, 'cis'],
];

// Union of condition keys met by the quote's line items and/or the live
// billing service names.
export function metConditions({ serviceIds, billingNames }) {
  const met = new Set();
  for (const [key, ids] of Object.entries(SERVICE_CONDITION_MAP)) {
    if (ids.some((sid) => serviceIds?.has(sid))) met.add(key);
  }
  for (const name of billingNames || []) {
    for (const [re, key] of BILLING_CONDITION_RULES) {
      if (re.test(name)) met.add(key);
    }
  }
  return met;
}

// Resolve what will happen to each template step for a given entity.
// Returns [{ templateStep, initialStatus, reason }]
export function resolveSteps(templateSteps, { quote, serviceIds, liveBilling, billingNames }) {
  const hasServiceSource = Boolean(quote) || (billingNames || []).length > 0;
  const met = metConditions({ serviceIds, billingNames });
  const source = quote ? 'quote' : 'billing';
  return templateSteps.map((ts) => {
    let initialStatus = 'pending';
    let reason = null;
    if (ts.service_condition && hasServiceSource && !met.has(ts.service_condition)) {
      initialStatus = 'na';
      reason = ts.service_condition === 'cis'
        ? `No CIS service on the ${source} — toggle on if needed`
        : `No ${ts.service_condition.replace(/_/g, ' ')} service on the ${source}`;
    }
    if (initialStatus === 'pending' && ts.auto_check === 'quote_accepted') {
      if (quote && ['committed', 'accepted'].includes(quote.status)) {
        initialStatus = 'complete';
        reason = `Auto-verified: quote ${quote.quote_ref || ''} is ${quote.status}`;
      } else if (!quote && liveBilling) {
        initialStatus = 'na';
        reason = 'Existing client billed via QBO — no quote to accept';
      }
    }
    if (initialStatus === 'pending' && ts.auto_check === 'live_billing' && liveBilling) {
      initialStatus = 'complete';
      reason = 'Auto-verified: active QBO billing exists for this client';
    }
    return { templateStep: ts, initialStatus, reason };
  });
}

export async function createOnboarding({ entityId, template, ownerId, leadId, targetDate, referredById, actorId }) {
  const { quote, serviceIds } = await findActiveQuote(entityId);
  const { hasBilling, serviceNames } = await findLiveBilling(entityId);
  const resolved = resolveSteps(template.steps, { quote, serviceIds, liveBilling: hasBilling, billingNames: serviceNames });

  // Authoritative service selection = conditions that have at least one
  // applicable (non-na) step. Editable afterwards in the Services panel.
  const conditions = [...new Set(
    resolved
      .filter((r) => r.templateStep.service_condition && r.initialStatus !== 'na')
      .map((r) => r.templateStep.service_condition),
  )];

  const { data: ob, error: e1 } = await supabase
    .from('onboardings')
    .insert({
      entity_id: entityId,
      template_id: template.id,
      quote_id: quote?.id || null,
      owner_id: ownerId || null,
      lead_id: leadId || null,
      target_date: targetDate || null,
      referred_by_entity_id: referredById || null,
      service_conditions: conditions,
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
    milestone: ts.milestone,
    service_condition: ts.service_condition,
    completed_at: initialStatus === 'complete' ? now : null,
  }));
  const { error: e2 } = await supabase.from('onboarding_steps').insert(stepRows);
  if (e2) throw e2;

  const autoNotes = resolved
    .filter((r) => r.reason)
    .map((r) => `${r.templateStep.name} → ${r.initialStatus === 'na' ? 'N/A' : 'complete'} (${r.reason})`);
  const body = [
    `Onboarding started — template "${template.name}"${quote ? `, linked to ${quote.status} quote ${quote.quote_ref || quote.id}` : ', no quote found in the fee engine'}`,
    ...autoNotes,
  ].join('\n');
  await supabase.from('onboarding_activity').insert({
    onboarding_id: ob.id, kind: 'system', body, created_by: actorId || null,
  });

  // Companies: fire the Companies House lookup in the background — it
  // auto-completes the search step and pre-fills the director list.
  if (template.client_type === 'company') {
    supabase.functions.invoke('ch-lookup', { body: { onboarding_id: ob.id } }).catch(() => {});
  }

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

// Set the onboarding-level status (Complete / Reopen quick actions on the
// list). Mirrors OnboardingDetailView.handleObStatus: 'complete' stamps
// completed_at, anything else clears it.
export async function setOnboardingStatus(id, status, { actorId, prevStatus } = {}) {
  const patch = { status, completed_at: status === 'complete' ? new Date().toISOString() : null };
  await updateOnboarding(id, patch, {
    actorId,
    logBody: `Onboarding status: ${prevStatus || '?'} → ${status}`,
  });
}

// Archive / restore — filed away from the working List and Board without
// changing status (a completed client stays completed once archived).
export async function setOnboardingArchived(id, archived, { actorId } = {}) {
  await updateOnboarding(id, { archived_at: archived ? new Date().toISOString() : null }, {
    actorId,
    logBody: archived ? 'Onboarding archived' : 'Onboarding restored from archive',
  });
}

// Edit the client's service selection. Re-syncs (never touching completed
// steps): conditional steps flip na<->to-do; handover areas (the "task owner"
// tiles) and — through them — the check-in tiles appear/disappear.
export async function setServiceConditions(ob, next, { actorId } = {}) {
  const prev = ob.service_conditions || [];
  const added = next.filter((c) => !prev.includes(c));
  const removed = prev.filter((c) => !next.includes(c));
  if (added.length === 0 && removed.length === 0) return;

  const steps = ob.steps || [];
  const toPending = steps.filter((s) => added.includes(s.service_condition) && s.status === 'na');
  const toNa = steps.filter((s) => removed.includes(s.service_condition) && !['complete', 'na'].includes(s.status));
  const now = new Date().toISOString();
  if (toPending.length) {
    const { error } = await supabase.from('onboarding_steps')
      .update({ status: 'pending', updated_at: now }).in('id', toPending.map((s) => s.id));
    if (error) throw error;
  }
  if (toNa.length) {
    const { error } = await supabase.from('onboarding_steps')
      .update({ status: 'na', updated_at: now }).in('id', toNa.map((s) => s.id));
    if (error) throw error;
  }

  const { error: eSel } = await supabase.from('onboardings').update({ service_conditions: next }).eq('id', ob.id);
  if (eSel) throw eSel;

  // Sync handover areas from the team defaults for the changed conditions.
  const defaults = await listHandoverDefaults();
  const haveConds = new Set((ob.handovers || []).map((h) => h.service_condition).filter(Boolean));
  const addRows = defaults
    .filter((d) => d.active && d.service_condition && added.includes(d.service_condition) && !haveConds.has(d.service_condition))
    .map((d) => ({
      onboarding_id: ob.id, area: d.area, service_condition: d.service_condition,
      owner_id: d.default_owner_id || ob.owner_id || null,
    }));
  if (addRows.length) {
    const { error } = await supabase.from('onboarding_handovers')
      .upsert(addRows, { onConflict: 'onboarding_id,area', ignoreDuplicates: true });
    if (error) throw error;
  }
  const removeIds = (ob.handovers || [])
    .filter((h) => h.service_condition && removed.includes(h.service_condition) && !h.done_at)
    .map((h) => h.id);
  if (removeIds.length) {
    const { error } = await supabase.from('onboarding_handovers').delete().in('id', removeIds);
    if (error) throw error;
  }

  const parts = [];
  if (added.length) parts.push(`added ${added.join(', ')}`);
  if (removed.length) parts.push(`removed ${removed.join(', ')}`);
  await supabase.from('onboarding_activity').insert({
    onboarding_id: ob.id, kind: 'system',
    body: `Services updated — ${parts.join('; ')}.`, created_by: actorId || null,
  });
}

// Add a tracked task step (HMRC registration / Companies House change).
export async function addAdHocStep(ob, { group, groupSort, name, assigneeId, note, actorId } = {}) {
  const inGroup = (ob.steps || []).filter((s) => s.group_name === group);
  const { error } = await supabase.from('onboarding_steps').insert({
    onboarding_id: ob.id,
    group_name: group,
    group_sort: groupSort,
    sort: Math.max(0, ...inGroup.map((s) => s.sort || 0)) + 1,
    name,
    owner_type: 'staff',
    assignee_id: assigneeId || ob.owner_id || null,
    status: 'pending',
    note: note || null,
    milestone: false,
  });
  if (error) throw error;
  await supabase.from('onboarding_activity').insert({
    onboarding_id: ob.id, kind: 'system', body: `Task added — ${name}`, created_by: actorId || null,
  });
}

export async function deleteOnboardingStep(stepId) {
  const { error } = await supabase.from('onboarding_steps').delete().eq('id', stepId);
  if (error) throw error;
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

// Staff-side upload (interview PDFs, documents received by email/post).
// Lands in the same bucket + table as portal uploads, so the extraction
// trigger reads it automatically.
export async function uploadStaffDocument(onboarding, file, { actorId } = {}) {
  const safeName = file.name.replace(/[^\w.\- ]+/g, '_');
  const path = `${onboarding.entity_id}/${crypto.randomUUID()}-${safeName}`;
  const { error: upErr } = await supabase.storage
    .from('client-documents')
    .upload(path, file, { contentType: file.type || undefined });
  if (upErr) throw upErr;
  const { error } = await supabase.from('onboarding_documents').insert({
    onboarding_id: onboarding.id,
    entity_id: onboarding.entity_id,
    uploaded_by_kind: 'staff',
    uploaded_by: actorId || null,
    storage_path: path,
    original_name: file.name,
    mime_type: file.type || null,
    size_bytes: file.size,
  });
  if (error) throw error;
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

// ── Companies House (edge fn ch-lookup) ──
// Resolves the company, caches profile + officers on the onboarding, and
// auto-completes the "Companies House search" step.
export async function runChLookup(onboardingId) {
  const { data, error } = await supabase.functions.invoke('ch-lookup', {
    body: { onboarding_id: onboardingId },
  });
  if (error) {
    try {
      const body = await error.context?.json?.();
      if (body?.error) throw new Error(body.error);
    } catch (inner) { if (inner instanceof Error && inner.message !== error.message) throw inner; }
    throw error;
  }
  return data;
}

// ── Client emails (edge fn onboarding-emails) ──
// kind 'welcome': warm intro + portal link + what we need
// kind 'pause': graceful stop-chasing email (sets escalation to paused)
export async function sendOnboardingEmail(onboardingId, kind, to = null) {
  const { data, error } = await supabase.functions.invoke('onboarding-emails', {
    body: { onboarding_id: onboardingId, kind, to },
  });
  if (error) {
    try {
      const body = await error.context?.json?.();
      if (body?.error) throw new Error(body.error);
    } catch (inner) { if (inner instanceof Error && inner.message !== error.message) throw inner; }
    throw error;
  }
  return data;
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
