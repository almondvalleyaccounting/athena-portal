// payroll-tracker — the writes behind the Payroll tab (sql/333).
//
// The team's weekly and monthly BrightPay checklists, as an interactive tick
// list. Every tick records who and when. Pay date, cut-off, runner and the
// standing note are held once per client. Any active staff member may write;
// the browser never writes these tables directly.
//
// Actions:
//   set_tick     { client_id, period_id, step, state: 'done' | 'na' | null }  null clears
//   add_note     { client_id, period_id, note }
//   save_client  { id?, name, entity_id?, frequency, pay_day?, cutoff?, pay_type?, runner_id?,
//                  runner_name?, cover_id?, batch?, na_steps?, standing_note?, active?, ceased_on?, sort_order? }
//   delete_note  { id }

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
class BadRequest extends Error { status: number; constructor(m: string, s = 400) { super(m); this.status = s; } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const STEPS = new Set(["approval", "hours", "processed", "fps", "payslips", "modulr", "pension", "eps"]);
const FREQ = new Set(["weekly", "monthly", "eps_only"]);
const PAY_TYPES = new Set(["fixed", "variable", "entry"]);
function uuid(v: unknown, f: string): string { const s = String(v ?? ""); if (!UUID.test(s)) throw new BadRequest(`${f} must be a uuid`); return s; }
function optUuid(v: unknown, f: string): string | null { if (v === null || v === undefined || v === "") return null; return uuid(v, f); }
function optText(v: unknown, max = 2000): string | null { if (v === null || v === undefined) return null; const s = String(v).trim(); return s ? s.slice(0, max) : null; }

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
    const { data: meRow } = await db.from("staff_profiles").select("name, is_active").eq("id", me).maybeSingle();
    if (!meRow?.is_active) throw new BadRequest("Active staff only", 403);
    const action = String(p.action || "");

    switch (action) {
      case "set_tick": {
        const clientId = uuid(p.client_id, "client_id");
        const periodId = uuid(p.period_id, "period_id");
        const step = String(p.step || "");
        if (!STEPS.has(step)) throw new BadRequest("Unknown step");
        const state = p.state === null || p.state === undefined || p.state === "" ? null : String(p.state);
        if (state !== null && state !== "done" && state !== "na") throw new BadRequest("state must be done, na or null");
        if (state === null) {
          const { error } = await db.from("payroll_ticks").delete().eq("client_id", clientId).eq("period_id", periodId).eq("step", step);
          if (error) throw new Error(error.message);
        } else {
          const { error } = await db.from("payroll_ticks").upsert({ client_id: clientId, period_id: periodId, step, state, by_id: me, by_name: meRow.name, at: now, source: "athena" }, { onConflict: "client_id,period_id,step" });
          if (error) throw new Error(error.message);
        }
        return json({ success: true });
      }

      case "add_note": {
        const clientId = uuid(p.client_id, "client_id");
        const periodId = uuid(p.period_id, "period_id");
        const note = optText(p.note, 4000);
        if (!note) throw new BadRequest("note required");
        const { data, error } = await db.from("payroll_period_notes").insert({ client_id: clientId, period_id: periodId, note, by_id: me, by_name: meRow.name, at: now }).select("id").single();
        if (error) throw new Error(error.message);
        return json({ success: true, id: data.id });
      }

      case "delete_note": {
        const id = uuid(p.id, "id");
        const { error } = await db.from("payroll_period_notes").delete().eq("id", id);
        if (error) throw new Error(error.message);
        return json({ success: true });
      }

      case "save_client": {
        const id = optUuid(p.id, "id");
        const row: Record<string, unknown> = { updated_at: now, updated_by: me };
        if (p.name !== undefined) { const n = optText(p.name, 200); if (!n) throw new BadRequest("name required"); row.name = n; }
        // A payroll client is always an Athena client (Bobby, 2026-09-27): the
        // link is required on create and cannot be cleared. The display name
        // follows the entity.
        if (p.entity_id !== undefined) {
          const eid = optUuid(p.entity_id, "entity_id");
          if (!eid) throw new BadRequest("Pick the Athena client this payroll belongs to");
          const { data: ent } = await db.from("entities").select("id, name").eq("id", eid).maybeSingle();
          if (!ent) throw new BadRequest("Client not found", 404);
          row.entity_id = eid; row.name = ent.name;
        }
        if (p.realm_id !== undefined) row.realm_id = optText(p.realm_id, 40);
        if (p.employer_id !== undefined) row.employer_id = p.employer_id === null || p.employer_id === "" ? null : Number(p.employer_id);
        if (p.frequency !== undefined) { if (!FREQ.has(String(p.frequency))) throw new BadRequest("frequency must be weekly, monthly or eps_only"); row.frequency = p.frequency; }
        if (p.pay_day !== undefined) row.pay_day = optText(p.pay_day, 60);
        if (p.cutoff !== undefined) row.cutoff = optText(p.cutoff, 60);
        if (p.pay_type !== undefined) { const t = optText(p.pay_type, 20); if (t && !PAY_TYPES.has(t)) throw new BadRequest("pay_type must be fixed, variable or entry"); row.pay_type = t; }
        if (p.runner_id !== undefined) row.runner_id = optUuid(p.runner_id, "runner_id");
        if (p.runner_name !== undefined) row.runner_name = optText(p.runner_name, 60);
        if (p.cover_id !== undefined) row.cover_id = optUuid(p.cover_id, "cover_id");
        if (p.batch !== undefined) row.batch = !!p.batch;
        if (p.na_steps !== undefined) {
          const arr = Array.isArray(p.na_steps) ? p.na_steps.map(String).filter((s: string) => STEPS.has(s)) : [];
          row.na_steps = arr;
        }
        if (p.standing_note !== undefined) row.standing_note = optText(p.standing_note, 4000);
        if (p.active !== undefined) row.active = !!p.active;
        if (p.ceased_on !== undefined) { const d = optText(p.ceased_on, 10); if (d && !ISO.test(d)) throw new BadRequest("ceased_on must be YYYY-MM-DD"); row.ceased_on = d; }
        if (p.sort_order !== undefined) row.sort_order = p.sort_order === null ? null : Number(p.sort_order);
        if (id) {
          const { data, error } = await db.from("payroll_clients").update(row).eq("id", id).select("*").single();
          if (error) throw new Error(error.message);
          return json({ success: true, client: data });
        }
        if (!row.entity_id) throw new BadRequest("Pick the Athena client this payroll belongs to");
        if (!row.frequency) throw new BadRequest("frequency required");
        const { data, error } = await db.from("payroll_clients").insert(row).select("*").single();
        if (error) throw new Error(error.message);
        return json({ success: true, client: data });
      }

      default:
        throw new BadRequest("Unknown action");
    }
  } catch (e) {
    if (e instanceof BadRequest) return json({ success: false, error: e.message }, e.status);
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
