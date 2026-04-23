import { supabase } from '../../../../lib/supabase';

export function isNstTask(name) {
  return typeof name === 'string' && name.startsWith('NST');
}

// Classify each parsed BM task row against existing state:
//   • entity (via client_reference → entities.bm_client_id)
//   • assignee (via bm_staff_aliases → staff_profiles)
//   • rule (first prefix match on task name)
//   • existing schedule row (idempotency / manual-override preview)
// Returns a map: { bm_task_id -> classification object }
export async function classifyBmTasks(parsedRows) {
  const inputs = parsedRows.map((r) => ({
    bm_task_id:       r.bm_task_id,
    client_reference: r.client_reference,
    assignee_name:    r.assignee_name,
    task_name:        r.bm_task_name,
  }));
  const { data, error } = await supabase.rpc('match_bm_tasks', { rows: inputs });
  if (error) throw error;
  const map = {};
  for (const m of data || []) {
    if (m.bm_task_id) map[m.bm_task_id] = m;
  }
  return map;
}

// Upsert NST-prefixed BM rows into quick_tasks (keyed on bm_task_id).
// These are pre-arranged ad-hoc tasks in BM and shouldn't go through
// the statutory scheduler. Runs its own disappearance sweep scoped to
// source='bm_nst': anything that was in quick_tasks last time but
// isn't in this CSV gets deleted, mirroring the golden rule that BM
// upload is truth.
async function writeNstQuickTasks(nstRows, matchMap) {
  const seenNstTaskIds = nstRows.map((r) => r.bm_task_id).filter(Boolean);

  // Upsert each NST row. We enrich from matchMap for entity/assignee
  // resolution so NST rows get the same alias handling as regular ones.
  const now = new Date().toISOString();
  const upserts = nstRows.map((r) => {
    const match = matchMap[r.bm_task_id] || {};
    const minutesFromDefault = 60; // NST defaults to 1h; user can edit after
    return {
      bm_task_id:    r.bm_task_id,
      source:        'bm_nst',
      title:         r.bm_task_name,
      entity_id:     match.entity_id || null,
      assignee_id:   match.assignee_id || null,
      service:       null, // BM services don't map to quick_tasks enum cleanly
      due_date:      r.deadline ? new Date(r.deadline).toISOString() : null,
      planned_date:  r.target_date ? new Date(r.target_date).toISOString() : null,
      duration:      minutesFromDefault,
      notes:         'Imported from BM (NST prefix)',
      sort_order:    0,
      updated_at:    now,
    };
  });

  let upserted = 0;
  if (upserts.length) {
    const { error: upErr } = await supabase
      .from('quick_tasks')
      .upsert(upserts, { onConflict: 'bm_task_id' });
    if (upErr) throw upErr;
    upserted = upserts.length;
  }

  // Disappearance sweep — delete any bm_nst quick_tasks whose bm_task_id
  // isn't in this CSV. Emulates the statutory writer's behaviour.
  let removed = 0;
  const { data: existing, error: listErr } = await supabase
    .from('quick_tasks')
    .select('id, bm_task_id')
    .eq('source', 'bm_nst');
  if (listErr) throw listErr;

  const seenSet = new Set(seenNstTaskIds);
  const toDelete = (existing || [])
    .filter((q) => q.bm_task_id && !seenSet.has(q.bm_task_id))
    .map((q) => q.id);

  if (toDelete.length) {
    const { error: delErr } = await supabase
      .from('quick_tasks')
      .delete()
      .in('id', toDelete);
    if (delErr) throw delErr;
    removed = toDelete.length;
  }

  return { upserted, removed };
}

// Call the import RPC. Unlike bm_clients, BM Tasks has no
// prospect-conversion step — the matcher is deterministic. We pass
// every parsed row and the full list of seen task_ids so the server
// can run the disappearance sweep.
//
// NST-prefixed rows are split out and written to quick_tasks instead;
// the regular RPC only sees the statutory subset.
export async function writeBmTasks(runId, parsedRows, seenTaskIds = []) {
  const nstRows = parsedRows.filter((r) => isNstTask(r.bm_task_name));
  const regularRows = parsedRows.filter((r) => !isNstTask(r.bm_task_name));

  // Need matchMap for NST enrichment (entity + assignee). classifyBmTasks
  // hits match_bm_tasks RPC — safe to re-run here; it's a pure read.
  let nstResult = { upserted: 0, removed: 0 };
  if (nstRows.length) {
    const matchMap = await classifyBmTasks(nstRows);
    nstResult = await writeNstQuickTasks(nstRows, matchMap);
  }

  const regularSeenIds = seenTaskIds.filter((id) => {
    const r = regularRows.find((x) => x.bm_task_id === id);
    return !!r;
  });

  const payload = {
    rows: regularRows.map((r) => ({
      bm_task_id:          r.bm_task_id,
      bm_task_name:        r.bm_task_name,
      client_reference:    r.client_reference,
      client_name:         r.client_name,
      assignee_name:       r.assignee_name,
      task_progress:       r.task_progress,
      latest_action_date:  r.latest_action_date,
      target_date:         r.target_date,
      deadline:            r.deadline,
    })),
    seen_task_ids: regularSeenIds,
  };
  const { data, error } = await supabase.rpc('import_bm_tasks', {
    run_id: runId, payload,
  });
  if (error) throw error;
  return {
    ...(data || {}),
    nst_upserted: nstResult.upserted,
    nst_removed: nstResult.removed,
  };
}
