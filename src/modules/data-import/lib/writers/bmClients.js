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
  // Every row carries its people when the export has the person-reference
  // column, and import_bm_people (called below) owns them. Telling
  // import_bm_clients to skip its own contact block stops it minting a fresh
  // person per entity — the reason Athena held 417 person rows for 348
  // people. An export without the column falls back to the old path.
  const hasPersonRefs = parsedRows.some((r) => (r._people || []).length);

  const payload = {
    skip_people: hasPersonRefs,
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

  // People, keyed on BM's Person Internal Reference. Runs AFTER the entities
  // are in so the bm_client_id lookup resolves. One people row per human
  // rather than per (client, contact), and the Secondary block — 57 people,
  // previously dropped on the floor — comes in too.
  //
  // This never merges anything. Where it finds a legacy per-entity row that
  // it cannot adopt, it writes a proposal to bm_person_merge_review for a
  // human to apply. Merging live records that carry Companies House identity
  // codes and open code chases is not an import's decision to make.
  let peopleResult = null;
  if (hasPersonRefs) {
    const personRows = [];
    for (const r of parsedRows) {
      for (const p of r._people || []) {
        personRows.push({
          bm_client_id: r.bm_client_id,
          person_ref: p.person_ref,
          slot: p.slot,
          first_name: p.first_name,
          last_name: p.last_name,
          preferred_name: p.preferred_name,
          email: p.email,
          phone: p.phone,
          ni_number: p.ni_number,
          ch_personal_code: p.ch_personal_code,
          dob: p.dob,
        });
      }
    }
    if (personRows.length) {
      const { data: peData, error: peError } = await supabase.rpc('import_bm_people', {
        run_id: runId, payload: { rows: personRows },
      });
      if (peError) {
        // Non-fatal — the entities are already in, and the contacts they had
        // before this run are untouched. Surfaced so it isn't a silent skip.
        console.warn('[writeBmClients] import_bm_people failed:', peError.message);
        peopleResult = { error: peError.message };
      } else {
        peopleResult = peData;
      }
    }
  }

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

  // Side-load: the agent-authorisation flags per tax, when the export carried
  // those columns. Feeds the BrightManager leg of Onboarding → Cross-check.
  // Skipped entirely when no agent column was detected, so an export without
  // them leaves every flag exactly as it was.
  // A key is included only when its column was in the file, so a missing
  // column leaves the stored value alone (see import_bm_side_fields).
  const agentRows = parsedRows
    .filter((r) => r._agent_flags || r._loe_signed_date !== undefined)
    .map((r) => ({
      bm_client_id: r.bm_client_id,
      ...(r._agent_flags || {}),
      ...(r._loe_signed_date === undefined ? {} : { loe_signed_date: r._loe_signed_date }),
    }));
  let agentResult = null;
  if (agentRows.length) {
    const { data: agData, error: agError } = await supabase.rpc('import_bm_side_fields', {
      run_id: runId, payload: { rows: agentRows },
    });
    if (agError) {
      // Non-fatal — the clients are already in; the cross-check just keeps
      // reading "no data" for BM until the next import.
      console.warn('[writeBmClients] import_bm_side_fields failed:', agError.message);
      agentResult = { error: agError.message };
    } else {
      agentResult = agData;
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
    // One pair per person, carrying the person reference, so the code lands
    // on the person BM says it belongs to. Without the reference the RPC
    // falls back to "the primary contact, or anyone on this client with the
    // same first and last name" — which for the two David Boyds, father and
    // son and both contacts of the same two companies, matches either man.
    const pairs = hasPersonRefs
      ? parsedRows.flatMap((r) => (r._people || [])
        .filter((p) => p.ch_personal_code)
        .map((p) => ({
          bm_client_id: r.bm_client_id,
          code: p.ch_personal_code,
          person_ref: p.person_ref,
        })))
      : parsedRows
        .filter((r) => r._primary_ch_personal_code)
        .map((r) => ({ bm_client_id: r.bm_client_id, code: r._primary_ch_personal_code }));
    if (pairs.length) {
      const { data: rc } = await supabase.rpc('reconcile_ch_codes', { p_pairs: pairs });
      codeReconcile = rc;
    }
  } catch { /* non-fatal */ }

  return {
    ...data,
    people: peopleResult,
    reviewers: reviewerResult,
    bm_side_fields: agentResult,
    admin_tasks_confirmed: confirmedTasks + confirmedNlac,
    ch_code_reconcile: codeReconcile,
  };
}

// The merge proposals from the most recent runs, newest first. Read-only —
// applying is a separate, explicit call.
export async function fetchPersonMergeReview(verdicts = ['proposed', 'blocked']) {
  const { data, error } = await supabase
    .from('v_bm_person_merge_review')
    .select('*')
    .in('verdict', verdicts)
    .order('verdict', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return data || [];
}

// Apply reviewed merges. Only 'proposed' rows move; 'blocked' ones are
// refused by the RPC until someone clears the block deliberately.
export async function applyPersonMerges(ids) {
  const clean = [...new Set((ids || []).filter(Boolean))];
  if (!clean.length) return { applied: 0, failed: [] };
  const { data, error } = await supabase.rpc('apply_bm_person_merges', { p_ids: clean });
  if (error) throw error;
  return data;
}

export async function setPersonMergeVerdict(ids, verdict) {
  const clean = [...new Set((ids || []).filter(Boolean))];
  if (!clean.length) return 0;
  const { data, error } = await supabase.rpc('set_bm_person_merge_verdict', {
    p_ids: clean, p_verdict: verdict,
  });
  if (error) throw error;
  return data || 0;
}
