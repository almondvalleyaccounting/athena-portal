// confirmation-statement-update — Athena Portal
//
// The writes behind the confirmation-statement section of the admin task list:
// set where a statement has got to, set what we do next about it, and add a
// note to its thread.
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
// Body: { entity_id, action: "set_status" | "set_next_action" | "add_note",
//         status?, next_action?, next_action_due?, body? }
//   set_status      — where the statement is, or null to clear it.
//   set_next_action — what we do next and by when. Both fields are written on
//                     every call, so clearing the action clears its date with
//                     it; a date left behind by an action nobody is doing any
//                     more is a plan that reads as live and is not.
//   add_note        — body is the note text.
//
// status and next_action answer different questions and are set separately
// (sql/273). "Awaiting Approval" does not say whether to ring or email; "Phone
// Client" does not say what the statement is waiting on.
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

// Must match the CHECK constraints in sql/273 (which supersede sql/268-272).
// Kept as lists here too so a bad value is a 400 with a readable message
// rather than a constraint violation.
//
// "call_needed" is deliberately absent: it was never a state, and sql/273
// moved it to next_action = "phone_client". A stale tab still sending it gets
// a 400 rather than a silent write, which is the right way for an old client
// to fail.
const STATUSES = [
  // Working on it, in order.
  "awaiting_ch_code",
  "awaiting_client_approval",
  "to_be_billed",
  "awaiting_payment",
  "to_be_filed",
  // Parked — the general case, then the two that say why.
  "on_hold",
  "client_unresponsive",
  "allow_to_drift",
  // Not filing this one (apply_to_close -> strike_off_submitted is one path in
  // two stages). Nothing outside the five steps takes the row off the list or
  // clears its overdue flag.
  "apply_to_close",
  "strike_off_submitted",
];

const NEXT_ACTIONS = [
  "send_statement",
  "send_email",
  "process_amendments",
  "phone_client",
];

// A date and nothing else, so a caller cannot smuggle an expression in.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function isRealDate(iso: string) {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === iso;
}

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
  if (action !== "set_status" && action !== "set_next_action" && action !== "add_note") {
    return json({ success: false, error: "action must be set_status, set_next_action or add_note" }, 400);
  }

  // Validate the payload before touching the database — cheaper, and it means a
  // new status can be confirmed live without writing to anybody's row: send it
  // with an entity that has no open statement and a 404 (rather than a 400)
  // says the value was accepted. Testing that against a real client is how a
  // status Sophie had set got overwritten.
  //
  // An empty dropdown clears the status. That is a real state — "on the list,
  // nobody has started" — and distinct from all ten.
  const blank = (v: unknown) => v === null || v === undefined || v === "";
  const rawStatus = payload.status;
  const status: string | null = blank(rawStatus) ? null : String(rawStatus);
  if (action === "set_status" && status !== null && !STATUSES.includes(status)) {
    return json({ success: false, error: `Unknown status: ${status}` }, 400);
  }

  // An empty next action clears the date with it — see the note at the top.
  const nextAction: string | null = blank(payload.next_action) ? null : String(payload.next_action);
  const nextActionDue: string | null =
    nextAction === null || blank(payload.next_action_due) ? null : String(payload.next_action_due);
  if (action === "set_next_action") {
    if (nextAction !== null && !NEXT_ACTIONS.includes(nextAction)) {
      return json({ success: false, error: `Unknown next action: ${nextAction}` }, 400);
    }
    // Shape first, then that it is a real day — 2026-02-31 passes the regex and
    // would come back as a 500 from the date column otherwise. Round-tripping
    // through Date catches both that (it rolls to 3 March) and an unparseable
    // month (NaN, so the round trip is empty rather than equal).
    if (nextActionDue !== null && (!ISO_DATE.test(nextActionDue) || !isRealDate(nextActionDue))) {
      return json({ success: false, error: "next_action_due must be a real date, YYYY-MM-DD" }, 400);
    }
  }

  const noteBody = String(payload.body ?? "").trim();
  if (action === "add_note") {
    if (!noteBody) return json({ success: false, error: "body required" }, 400);
    if (noteBody.length > MAX_NOTE) return json({ success: false, error: "Note too long" }, 400);
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
      const progress = await ensureProgress({
        status,
        status_set_by: caller.userId,
        status_set_at: new Date().toISOString(),
      });
      return json({ success: true, progress });
    }

    if (action === "set_next_action") {
      const progress = await ensureProgress({
        next_action: nextAction,
        next_action_due: nextActionDue,
        next_action_set_by: caller.userId,
        next_action_set_at: new Date().toISOString(),
      });
      return json({ success: true, progress });
    }

    const progress = await ensureProgress();
    const { data: note, error: nErr } = await service
      .from("confirmation_statement_notes")
      .insert({ progress_id: progress.id, author_id: caller.userId, body: noteBody })
      .select("*")
      .single();
    if (nErr) return json({ success: false, error: nErr.message }, 500);
    return json({ success: true, progress, note });
  } catch (e) {
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
