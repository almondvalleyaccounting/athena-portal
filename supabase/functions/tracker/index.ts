// tracker — writes for the Tracker tab (sql/332): typed cells, control-account
// lines and queries, and an on-demand refresh of a client's bank rec dates.
// Reads go straight to v_tracker / the tables under RLS; every write comes
// through here as service_role with the caller checked as active staff.
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const COLS = new Set(["cadence", "me_journals", "notes", "payroll", "vat_qtr"]);
const KINDS = new Set(["control", "query"]);

class BadRequest extends Error { status: number; constructor(m: string, status = 400) { super(m); this.status = status; } }
function uuid(v: unknown, field: string): string { const s = String(v ?? ""); if (!UUID.test(s)) throw new BadRequest(`${field} must be a uuid`); return s; }
function optDate(v: unknown, field: string): string | null { if (v === null || v === undefined || v === "") return null; const s = String(v); if (!ISO.test(s)) throw new BadRequest(`${field} must be YYYY-MM-DD`); return s; }
function optText(v: unknown, max: number): string | null { if (v === null || v === undefined) return null; const s = String(v).trim(); return s ? s.slice(0, max) : null; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);
  let caller;
  try { caller = await requireStaffOrService(req, { allowService: false }); }
  catch (e) { return authErrorResponse(e, cors); }
  const me = caller.userId!;
  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const p = await req.json().catch(() => ({}));
  const now = new Date().toISOString();
  try {
    switch (p.action) {
      case "set_cell": {
        const entityId = uuid(p.entity_id, "entity_id");
        const col = String(p.col || "");
        if (!COLS.has(col)) throw new BadRequest("Unknown column");
        const value = optText(p.value, col === "notes" ? 2000 : 80);
        if (value === null) {
          const { error } = await db.from("tracker_cells").delete().eq("entity_id", entityId).eq("col", col);
          if (error) throw new Error(error.message);
        } else {
          const { error } = await db.from("tracker_cells").upsert({ entity_id: entityId, col, value, updated_by: me, updated_at: now }, { onConflict: "entity_id,col" });
          if (error) throw new Error(error.message);
        }
        return json({ success: true });
      }
      case "save_line": {
        const entityId = uuid(p.entity_id, "entity_id");
        const account = optText(p.account, 160);
        if (!account) throw new BadRequest("account is required");
        const kind = KINDS.has(String(p.kind)) ? String(p.kind) : "control";
        const row: Record<string, unknown> = {
          entity_id: entityId, account, kind, last_date: optDate(p.last_date, "last_date"),
          amount: p.amount === null || p.amount === undefined || p.amount === "" ? null : Number(p.amount),
          note: optText(p.note, 2000), updated_by: me, updated_at: now,
        };
        if (row.amount !== null && !Number.isFinite(row.amount as number)) throw new BadRequest("amount must be a number");
        if (p.resolved === true) { row.resolved_at = now; row.resolved_by = me; }
        if (p.resolved === false) { row.resolved_at = null; row.resolved_by = null; }
        let id: string;
        if (p.id) {
          id = uuid(p.id, "id");
          const { error } = await db.from("tracker_control_lines").update(row).eq("id", id);
          if (error) throw new Error(error.message);
        } else {
          const { data, error } = await db.from("tracker_control_lines").insert({ ...row, created_by: me }).select("id").single();
          if (error) throw new Error(error.message);
          id = data.id;
        }
        return json({ success: true, id });
      }
      case "delete_line": {
        const id = uuid(p.id, "id");
        const { error } = await db.from("tracker_control_lines").delete().eq("id", id);
        if (error) throw new Error(error.message);
        return json({ success: true });
      }
      // Pull this client's bank rec dates from QuickBooks now rather than tonight.
      case "refresh_recs": {
        const entityId = uuid(p.entity_id, "entity_id");
        const { data: conn } = await db.from("qbo_report_connections").select("realm_id, is_practice").eq("entity_id", entityId).eq("status", "active").maybeSingle();
        if (!conn?.realm_id) throw new BadRequest("This client has no active QuickBooks connection");
        if (conn.is_practice) throw new BadRequest("Not for the practice's own file");
        const r = await fetch(`${SUPABASE_URL}/functions/v1/dashboard-qbo-pull`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, apikey: SUPABASE_SERVICE_ROLE_KEY },
          body: JSON.stringify({ realmId: conn.realm_id, refresh: true, metrics: ["bank_recs"] }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok || body?.success === false) throw new Error(body?.error || `QuickBooks pull failed (${r.status})`);
        return json({ success: true, result: body?.metrics?.bank_recs ?? null });
      }
      default:
        throw new BadRequest("Unknown action");
    }
  } catch (e) {
    if (e instanceof BadRequest) return json({ success: false, error: e.message }, e.status);
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
