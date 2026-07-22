// Recruitment module — data layer.
//
// Direct RLS-gated table access (like the Triage board). Two RLS tiers:
// vacancies/adverts/applications need can_view_recruitment; candidate PII
// and per-application notes need can_view_recruitment_applicants. A viewer
// without the PII flag still loads applications, but candidate rows won't
// return — the board falls back to "Candidate (restricted)".
import { supabase } from '../../lib/supabase';

// ── Staff (for assignment + hiring manager pickers) ──────────────────
export async function listStaff() {
  const { data, error } = await supabase
    .from('staff_profiles')
    .select('id, name, is_active')
    .order('name');
  if (error) throw error;
  return data || [];
}

// ── Vacancies ────────────────────────────────────────────────────────
export async function listVacancies() {
  const { data, error } = await supabase
    .from('recruitment_vacancies')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getVacancy(id) {
  const { data, error } = await supabase
    .from('recruitment_vacancies')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

export async function createVacancy(patch, createdBy) {
  const { data, error } = await supabase
    .from('recruitment_vacancies')
    .insert({ ...patch, created_by: createdBy || null })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function updateVacancy(id, patch) {
  const { data, error } = await supabase
    .from('recruitment_vacancies')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

// ── Adverts ──────────────────────────────────────────────────────────
export async function listAdverts(vacancyId) {
  const { data, error } = await supabase
    .from('recruitment_adverts')
    .select('*')
    .eq('vacancy_id', vacancyId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createAdvert(patch) {
  const { data, error } = await supabase
    .from('recruitment_adverts')
    .insert(patch)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function updateAdvert(id, patch) {
  const { data, error } = await supabase
    .from('recruitment_adverts')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function deleteAdvert(id) {
  const { error } = await supabase.from('recruitment_adverts').delete().eq('id', id);
  if (error) throw error;
}

// ── Candidates (PII) ─────────────────────────────────────────────────
// Find-or-create by email so re-applicants become one shared person record.
export async function findCandidateByEmail(email) {
  const e = (email || '').trim().toLowerCase();
  if (!e) return null;
  const { data, error } = await supabase
    .from('recruitment_candidates')
    .select('*')
    .ilike('email', e)
    .limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

export async function createCandidate(patch, createdBy) {
  const { data, error } = await supabase
    .from('recruitment_candidates')
    .insert({ ...patch, created_by: createdBy || null })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function updateCandidate(id, patch) {
  const { data, error } = await supabase
    .from('recruitment_candidates')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

// ── Applications (pipeline cards) ────────────────────────────────────
// Load a vacancy's pipeline. Candidate is joined; when the caller lacks the
// PII flag the embedded candidate comes back null (RLS), which the UI handles.
export async function listApplications(vacancyId) {
  const { data, error } = await supabase
    .from('recruitment_applications')
    .select('*, candidate:recruitment_candidates(id, full_name, email, phone, location, cv_url, linkedin_url, source, notes)')
    .eq('vacancy_id', vacancyId)
    .order('sort', { ascending: true })
    .order('applied_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// Add an application: find-or-create the candidate, then insert the card.
// Returns the application with its candidate embedded.
export async function addApplication({ vacancyId, candidate, source, coverNote, createdBy }) {
  let cand = null;
  if (candidate.id) {
    cand = candidate;
  } else if (candidate.email) {
    cand = await findCandidateByEmail(candidate.email);
  }
  if (!cand) {
    cand = await createCandidate({
      full_name: candidate.full_name,
      email: candidate.email || null,
      phone: candidate.phone || null,
      location: candidate.location || null,
      linkedin_url: candidate.linkedin_url || null,
      cv_url: candidate.cv_url || null,
      source: source || null,
    }, createdBy);
  }
  const { data, error } = await supabase
    .from('recruitment_applications')
    .insert({
      vacancy_id: vacancyId,
      candidate_id: cand.id,
      source: source || null,
      cover_note: coverNote || null,
      created_by: createdBy || null,
    })
    .select('*, candidate:recruitment_candidates(id, full_name, email, phone, location, cv_url, linkedin_url, source, notes)')
    .single();
  if (error) throw error;
  return data;
}

export async function updateApplication(id, patch) {
  const body = { ...patch, updated_at: new Date().toISOString() };
  if (patch.stage) body.stage_changed_at = new Date().toISOString();
  const { data, error } = await supabase
    .from('recruitment_applications')
    .update(body)
    .eq('id', id)
    .select('*, candidate:recruitment_candidates(id, full_name, email, phone, location, cv_url, linkedin_url, source, notes)')
    .single();
  if (error) throw error;
  return data;
}

// ── Notes (per application) ──────────────────────────────────────────
export async function listNotes(applicationId) {
  const { data, error } = await supabase
    .from('recruitment_notes')
    .select('*')
    .eq('application_id', applicationId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function addNote(applicationId, body, authorId) {
  const text = (body || '').trim();
  if (!text) return null;
  const { data, error } = await supabase
    .from('recruitment_notes')
    .insert({ application_id: applicationId, body: text, author_id: authorId || null })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

// ── Communications (P2) ──────────────────────────────────────────────
export async function listMessages(applicationId) {
  const { data, error } = await supabase
    .from('recruitment_messages')
    .select('*')
    .eq('application_id', applicationId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

// Send an email to the applicant via the recruitment-email edge function
// (Resend + server-side log). Uses the shared error-unwrapping idiom.
export async function sendApplicantEmail({ applicationId, to, subject, body, replyTo }) {
  const { data, error } = await supabase.functions.invoke('recruitment-email', {
    body: { application_id: applicationId, to, subject, body, reply_to: replyTo || undefined },
  });
  if (error) {
    let detail = error.message;
    try { const b = await error.context?.json(); if (b?.error) detail = b.error; } catch { /* keep */ }
    throw new Error(detail);
  }
  if (data && data.success === false) throw new Error(data.error || 'Send failed');
  return data;
}

// Send an SMS/WhatsApp via the shared sms-send function, then mirror a row
// into recruitment_messages so it lands on the applicant timeline (sms-send
// logs its own sms_messages row too, keyed by number).
export async function sendApplicantSms({ applicationId, candidateId, to, body, channel = 'sms', createdBy }) {
  const { data, error } = await supabase.functions.invoke('sms-send', { body: { to, body, channel } });
  if (error) {
    let detail = error.message;
    try { const b = await error.context?.json(); if (b?.error) detail = b.error; } catch { /* keep */ }
    throw new Error(detail);
  }
  if (data && data.success === false) throw new Error(data.error || 'Send failed');
  await supabase.from('recruitment_messages').insert({
    application_id: applicationId, candidate_id: candidateId || null, channel,
    direction: 'out', body, to_addr: to, status: 'sent',
    provider_id: data?.provider_id || null, created_by: createdBy || null,
  });
  return data;
}

// ── Interviews (P3) ──────────────────────────────────────────────────
export async function listInterviews(applicationId) {
  const { data, error } = await supabase
    .from('recruitment_interviews')
    .select('*')
    .eq('application_id', applicationId)
    .order('scheduled_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function createInterview(patch, createdBy) {
  const { data, error } = await supabase
    .from('recruitment_interviews')
    .insert({ ...patch, created_by: createdBy || null })
    .select('*').single();
  if (error) throw error;
  return data;
}

export async function updateInterview(id, patch) {
  const { data, error } = await supabase
    .from('recruitment_interviews')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id).select('*').single();
  if (error) throw error;
  return data;
}

export async function deleteInterview(id) {
  const { error } = await supabase.from('recruitment_interviews').delete().eq('id', id);
  if (error) throw error;
}

// Cross-vacancy upcoming interviews for the module-level schedule view.
export async function upcomingInterviews() {
  const { data, error } = await supabase
    .from('recruitment_interviews')
    .select('*, application:recruitment_applications(id, vacancy_id, candidate:recruitment_candidates(full_name), vacancy:recruitment_vacancies(title))')
    .in('status', ['scheduled'])
    .order('scheduled_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

// ── Offers (P5) ──────────────────────────────────────────────────────
export async function getOffer(applicationId) {
  const { data, error } = await supabase
    .from('recruitment_offers')
    .select('*').eq('application_id', applicationId)
    .order('created_at', { ascending: false }).limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

export async function upsertOffer(applicationId, patch, createdBy) {
  const existing = await getOffer(applicationId);
  if (existing) {
    const { data, error } = await supabase.from('recruitment_offers')
      .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', existing.id).select('*').single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from('recruitment_offers')
    .insert({ ...patch, application_id: applicationId, created_by: createdBy || null }).select('*').single();
  if (error) throw error;
  return data;
}

// ── Contracts (P5) ───────────────────────────────────────────────────
export async function getContract(applicationId) {
  const { data, error } = await supabase
    .from('recruitment_contracts')
    .select('*').eq('application_id', applicationId)
    .order('created_at', { ascending: false }).limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

export async function upsertContract(applicationId, patch, createdBy) {
  const existing = await getContract(applicationId);
  if (existing) {
    const { data, error } = await supabase.from('recruitment_contracts')
      .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', existing.id).select('*').single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from('recruitment_contracts')
    .insert({ ...patch, application_id: applicationId, created_by: createdBy || null }).select('*').single();
  if (error) throw error;
  return data;
}

// ── Induction (P6) ───────────────────────────────────────────────────
export async function listInduction(applicationId) {
  const { data, error } = await supabase
    .from('recruitment_induction_items')
    .select('*').eq('application_id', applicationId)
    .order('sort', { ascending: true });
  if (error) throw error;
  return data || [];
}

// Seed the default checklist for a hire (human-in-the-loop — called from a
// deliberate "Start induction" button, never automatically).
export async function startInduction(applicationId, items) {
  const rows = items.map((label, i) => ({ application_id: applicationId, label, sort: i }));
  const { data, error } = await supabase.from('recruitment_induction_items').insert(rows).select('*');
  if (error) throw error;
  return data || [];
}

export async function toggleInductionItem(id, done, byWho) {
  const { data, error } = await supabase.from('recruitment_induction_items')
    .update({ done, done_at: done ? new Date().toISOString() : null, done_by: done ? (byWho || null) : null })
    .eq('id', id).select('*').single();
  if (error) throw error;
  return data;
}

// Count applications per vacancy (for the vacancies list), excluding exits.
export async function applicationCounts() {
  const { data, error } = await supabase
    .from('recruitment_applications')
    .select('vacancy_id, stage');
  if (error) throw error;
  const counts = {};
  for (const a of data || []) {
    if (a.stage === 'rejected' || a.stage === 'withdrawn') continue;
    counts[a.vacancy_id] = (counts[a.vacancy_id] || 0) + 1;
  }
  return counts;
}
