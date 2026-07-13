import { supabase } from '../../../../lib/supabase';

// Classify each incoming BM row against existing prospects in the DB.
// Returns a map: { bm_client_id -> {tier, prospect_id, prospect_name, score} }
export async function classifyBmProspects(parsedRows) {
  const inputs = parsedRows.map((r) => ({
    bm_client_id: r.bm_client_id,
    company_number: r.company_number,
    name: r.name,
  }));
  const { data, error } = await supabase.rpc('match_bm_prospects', { rows: inputs });
  if (error) throw error;
  const map = {};
  for (const m of data || []) {
    if (m.tier) map[m.bm_client_id] = m;
  }
  return map;
}

// Read-only: given the bm_client_ids present in the upload, return the
// active BrightManager entities that have dropped out of the export and are
// therefore candidates for archiving. Surfaced in the preview so the user
// reviews them before anything is written.
export async function fetchArchiveCandidates(presentBmIds) {
  const ids = [...new Set((presentBmIds || []).filter(Boolean))];
  const { data, error } = await supabase.rpc('preview_bm_archive_candidates', {
    p_bm_client_ids: ids,
  });
  if (error) throw error;
  return data || [];
}

// Flip the given bm_client_ids to entity_status='archived'. The RPC only
// touches currently-active BrightManager entities, so passing a deselected
// or already-archived id is a harmless no-op.
export async function archiveBmClients(runId, bmClientIds) {
  const ids = [...new Set((bmClientIds || []).filter(Boolean))];
  if (!ids.length) return { archived: 0, archived_ids: [] };
  const { data, error } = await supabase.rpc('archive_bm_clients', {
    run_id: runId, p_bm_client_ids: ids,
  });
  if (error) throw error;
  return data;
}

// Call the import RPC. `decisions` is a map of bm_client_id -> prospect uuid
// for approved conversions (omit a bm_client_id to create a new entity).
export async function writeBmClients(runId, parsedRows, decisions = {}) {
  const payload = {
    rows: parsedRows.map((r) => ({
      bm_client_id: r.bm_client_id,
      name: r.name,
      type: r.type,
      company_number: r.company_number,
      utr: r.utr,
      vat_number: r.vat_number,
      paye_ref: r.paye_ref,
      accounts_office_ref: r.accounts_office_ref,
      ch_auth_code: r.ch_auth_code,
      manager: r.manager,
      grade: r.grade,
      convert_prospect_id: decisions[r.bm_client_id] || null,
      // Primary contact — RPC writes into people + entity_people.
      _primary_email: r._primary_email || null,
      _primary_first_name: r._primary_first_name || null,
      _primary_last_name: r._primary_last_name || null,
      _primary_preferred_name: r._primary_preferred_name || null,
      _primary_name: r._primary_name || null,
    })),
  };
  const { data, error } = await supabase.rpc('import_bm_clients', {
    run_id: runId, payload,
  });
  if (error) throw error;

  // Side-load: VAT + Accounts reviewers from the "Monitor" columns into
  // service_reviewers. Runs AFTER entities have been upserted so the
  // entity lookup by bm_client_id resolves. Manual overrides in the UI
  // are preserved (the RPC won't touch rows where source='manual').
  const reviewerRows = parsedRows
    .filter((r) => r.vat_reviewer_name || r.accounts_reviewer_name)
    .map((r) => ({
      bm_client_id: r.bm_client_id,
      vat_reviewer_name: r.vat_reviewer_name || null,
      accounts_reviewer_name: r.accounts_reviewer_name || null,
    }));
  let reviewerResult = null;
  if (reviewerRows.length) {
    const { data: revData, error: revError } = await supabase.rpc('import_bm_reviewers', {
      run_id: runId, payload: { rows: reviewerRows },
    });
    if (revError) {
      // Non-fatal — clients are already in. Log so the user sees it.
      console.warn('[writeBmClients] import_bm_reviewers failed:', revError.message);
      reviewerResult = { error: revError.message };
    } else {
      reviewerResult = revData;
    }
  }

  // The BM upload is the source of truth for entity codes — confirm and
  // clear any admin_tasks (Sophie's BM list) the fresh data now satisfies.
  let confirmedTasks = 0;
  try {
    const { data: confirmed } = await supabase.rpc('admin_tasks_confirm_from_bm');
    confirmedTasks = confirmed || 0;
  } catch { /* non-fatal — the admin tasks page re-checks on load */ }

  // Silently confirm "archive in BM" tasks for clients marked no-longer-a-client
  // in Athena that have now dropped out of the BM client export (Sophie has
  // archived them in BM → their bm_client_id is absent from this upload).
  let confirmedNlac = 0;
  try {
    const presentIds = [...new Set(parsedRows.map((r) => r.bm_client_id).filter(Boolean))];
    const { data: n } = await supabase.rpc('confirm_nlac_mirror_tasks', { p_bm_client_ids: presentIds });
    confirmedNlac = n || 0;
  } catch { /* non-fatal */ }

  // CH personal-code reconciliation (Stage 5) — only fires once the export
  // carries the code column (see parser _primary_ch_personal_code). Inert
  // otherwise.
  let codeReconcile = null;
  try {
    const pairs = parsedRows
      .filter((r) => r._primary_ch_personal_code)
      .map((r) => ({ bm_client_id: r.bm_client_id, code: r._primary_ch_personal_code }));
    if (pairs.length) {
      const { data: rc } = await supabase.rpc('reconcile_ch_codes', { p_pairs: pairs });
      codeReconcile = rc;
    }
  } catch { /* non-fatal */ }

  return { ...data, reviewers: reviewerResult, admin_tasks_confirmed: confirmedTasks + confirmedNlac, ch_code_reconcile: codeReconcile };
}
