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

  return { ...data, reviewers: reviewerResult };
}
