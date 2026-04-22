import { supabase } from '../../../../lib/supabase';

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

// Call the import RPC. Unlike bm_clients, BM Tasks has no
// prospect-conversion step — the matcher is deterministic. We pass
// every parsed row and the full list of seen task_ids so the server
// can run the disappearance sweep.
export async function writeBmTasks(runId, parsedRows, seenTaskIds = []) {
  const payload = {
    rows: parsedRows.map((r) => ({
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
    seen_task_ids: seenTaskIds,
  };
  const { data, error } = await supabase.rpc('import_bm_tasks', {
    run_id: runId, payload,
  });
  if (error) throw error;
  return data;
}
