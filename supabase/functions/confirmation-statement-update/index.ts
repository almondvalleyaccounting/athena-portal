// confirmation-statement-update — Athena Portal
//
// The two writes behind the confirmation-statement section of the admin task
// list: set where a statement has got to, and add a note to its thread.
//
// Why a function and not a table write. The browser holds SELECT on
// confirmation_statement_progress / _notes and nothing else (sql/268), because
// a new mutating path is an edge function (CLAUDE.md). Two things follow that
// a direct write could not give:
//
//   * The period is resolved here, from the live deadlines row, rather than
//     taken from the caller. A stale tab holding last month's due_date would
//     otherwise write a status against a period that has already rolled — and
//     it would look exactly like real progress. The client sends the entity;
//     the server decides which statement that means.
//   * Attribution is the JWT's user, not a field in the body.
//
// Body: { entity_id, action: "set_status" | "add_note", status?, body? }
//   set_status — status is one of the five steps, or null to clear it.
//   add_note   — body is the note text.
//
// Returns { success, progress, note? } with the row the caller should render.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });
}

// Must match the CHECK constraint in sql/268, extended by sql/269 and sql/270.
// Kept as a list here too so a bad value is a 400 with a readable message
// rather than a constraint violation.
const STATUSES = [
  // Working on it, in order.
  "awaiting_ch_code",
  "awaiting_client_approval",
  "to_be_billed",
  "awaiting_payment",
  "to_be_filed",
  // Stuck, then the two ways it ends without filing. None of these is a
  // further step, and none takes the row off the list or clears its overdue
  // flag.
  "client_unresponsive",
  "allow_to_drift",
  "apply_to_close",
];

const MAX_NOTE = 4000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  let caller;
  try { caller = await requireStaffOrService(req); }
  catch (e) { return authErrorResponse(e, cors); }

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const payload = await req.json().catch(() => ({}));
  const entityId: string = payload.entity_id;
  const action: string = payload.action;
  if (!entityId) return json({ success: false, error: "entity_id required" }, 400);
  if (action !== "set_status" && action !== "add_note") {
    return json({ success: false, error: "action must be set_status or add_note" }, 400);
  }

  // Which period this is. Read from deadlines, not from the caller — the whole
  // point of resolving it server-side. `status <> 'complete'` and the tag match
  // what v_confirmation_statements_due selects on, so a row you cannot see on
  // the list is a row you cannot write against either.
  const { data: deadline, error: dErr } = await service
    .from("deadlines")
    .select("id, due_date")
    .eq("entity_id", entityId)
    .eq("tag", "Confirmation Statement")
    .neq("status", "complete")
    .maybeSingle();
  if (dErr) return json({ success: false, error: dErr.message }, 500);
  if (!deadline?.due_date) {
    return json({ success: false, error: "No open confirmation statement for this client" }, 404);
  }
  const dueDate: string = deadline.due_date;

  // The progress row for that period, created on first use. Two staff hitting
  // the dropdown at once race here, which the unique (entity_id, due_date)
  // settles — upsert with that conflict target means the loser reads the
  // winner's row rather than failing.
  async function ensureProgress(patch: Record<string, unknown> = {}) {
    const { data, error } = await service
      .from("confirmation_statement_progress")
      .upsert(
        { entity_id: entityId, due_date: dueDate, updated_at: new Date().toISOString(), ...patch },
        { onConflict: "entity_id,due_date" },
      )
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return data;
  }

  try {
    if (action === "set_status") {
      const raw = payload.status;
      // An empty dropdown clears the status. That is a real state — "on the
      // list, nobody has started" — and distinct from any of the five.
      const status: string | null = raw === null || raw === undefined || raw === "" ? null : String(raw);
      if (status !== null && !STATUSES.includes(status)) {
        return json({ success: false, error: `Unknown status: ${status}` }, 400);
      }
      const progress = await ensureProgress({
        status,
        status_set_by: caller.userId,
        status_set_at: new Date().toISOString(),
      });
      return json({ success: true, progress });
    }

    const text = String(payload.body ?? "").trim();
    if (!text) return json({ success: false, error: "body required" }, 400);
    if (text.length > MAX_NOTE) return json({ success: false, error: "Note too long" }, 400);

    const progress = await ensureProgress();
    const { data: note, error: nErr } = await service
      .from("confirmation_statement_notes")
      .insert({ progress_id: progress.id, author_id: caller.userId, body: text })
      .select("*")
      .single();
    if (nErr) return json({ success: false, error: nErr.message }, 500);
    return json({ success: true, progress, note });
  } catch (e) {
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
