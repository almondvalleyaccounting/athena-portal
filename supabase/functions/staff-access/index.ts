// staff-access — Athena Portal
//
// Every write behind Staff & Permissions (sql/328). The browser holds SELECT on
// app_modules / staff_module_access / staff_client_access and nothing else,
// because a new mutating path is an edge function (CLAUDE.md). Portal admins only:
// an admin sees every module and every client, and is the only person who can
// change what anyone else sees. Attribution is the JWT's user, never the body.
//
// Body: { action, ...fields }
//   set_module        { staff_id, module_key, level }   level: "on" | "submitter" | "approver" | null (= off)
//   set_ability       { staff_id, flag, value }         one of ABILITY_FLAGS
//   set_admin         { staff_id, value }               cannot remove your own admin
//   set_clients       { staff_id, entity_ids, enabled } bulk on/off, up to 2,000 at once
//   copy_access       { from_staff_id, to_staff_id, what }  what: "modules" | "clients" | "both"
//   set_module_status { module_key, status }            "live" | "in_development"
//   set_setting       { key, value }                    new_client_figures_default: boolean
//
// Module access drives the legacy staff_profiles flags by trigger, so a module
// switch here is also the flag every existing policy and function reads.

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

// Abilities inside a module, set directly. Module-level flags (can_view_billing,
// can_view_reports, work_planner …) are derived from module access and are
// deliberately NOT here — writing them would be overwritten by the next sync.
const ABILITY_FLAGS = new Set([
  "can_edit_quotes", "can_approve_quotes", "can_edit_fee_schedule", "can_view_client_fees",
  "can_view_practice_financials", "can_manage_portal", "can_import_data", "can_view_ch_codes",
  "can_view_admin_report", "can_view_pushed_invoices", "can_manage_task_pipeline",
  "can_manage_recruitment", "can_view_recruitment_applicants", "can_triage_bugs",
  "can_approve_bk_priority", "can_manage_kpi_packs",
]);
const LEVELS = new Set(["on", "submitter", "approver"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BULK = 2000;

class BadRequest extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
function uuid(v: unknown, field: string): string {
  const s = String(v ?? "");
  if (!UUID.test(s)) throw new BadRequest(`${field} must be a uuid`);
  return s;
}
function bool(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw new BadRequest(`${field} must be true or false`);
  return v;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  // Portal admins only, and never a machine: every change is someone's decision.
  let caller;
  try { caller = await requireStaffOrService(req, { flag: "is_portal_admin", allowService: false }); }
  catch (e) { return authErrorResponse(e, cors); }
  const me = caller.userId;

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const p = await req.json().catch(() => ({}));
  const now = new Date().toISOString();

  async function staff(id: string) {
    const { data } = await db.from("staff_profiles").select("id, is_portal_admin").eq("id", id).maybeSingle();
    if (!data) throw new BadRequest("Staff member not found", 404);
    return data;
  }
  async function moduleRow(key: string) {
    const { data } = await db.from("app_modules").select("key, grantable, status").eq("key", key).maybeSingle();
    if (!data) throw new BadRequest("Unknown module", 404);
    return data;
  }

  try {
    switch (p.action) {
      case "set_module": {
        const staffId = uuid(p.staff_id, "staff_id");
        await staff(staffId);
        const key = String(p.module_key ?? "");
        const mod = await moduleRow(key);
        if (!mod.grantable && mod.status !== "in_development") {
          throw new BadRequest("This page follows its module — switch the module instead");
        }
        if (p.level === null || p.level === undefined || p.level === "off") {
          const { error } = await db.from("staff_module_access").delete().eq("staff_id", staffId).eq("module_key", key);
          if (error) throw new Error(error.message);
          return json({ success: true });
        }
        const level = String(p.level);
        if (!LEVELS.has(level)) throw new BadRequest("level must be on, submitter, approver or null");
        if (key !== "billing" && level !== "on") throw new BadRequest("Only Billing has levels");
        if (key === "billing" && level === "on") throw new BadRequest("Billing is submitter or approver");
        const { error } = await db.from("staff_module_access").upsert(
          { staff_id: staffId, module_key: key, level, granted_at: now, granted_by: me },
          { onConflict: "staff_id,module_key" },
        );
        if (error) throw new Error(error.message);
        return json({ success: true });
      }

      case "set_ability": {
        const staffId = uuid(p.staff_id, "staff_id");
        await staff(staffId);
        const flag = String(p.flag ?? "");
        if (!ABILITY_FLAGS.has(flag)) throw new BadRequest("Not a settable ability");
        const { error } = await db.from("staff_profiles").update({ [flag]: bool(p.value, "value") }).eq("id", staffId);
        if (error) throw new Error(error.message);
        return json({ success: true });
      }

      case "set_admin": {
        const staffId = uuid(p.staff_id, "staff_id");
        await staff(staffId);
        const value = bool(p.value, "value");
        // Locking yourself out would leave nobody able to undo it.
        if (!value && staffId === me) throw new BadRequest("You can't remove your own admin access", 409);
        const { error } = await db.from("staff_profiles").update({ is_portal_admin: value }).eq("id", staffId);
        if (error) throw new Error(error.message);
        return json({ success: true });
      }

      case "set_clients": {
        const staffId = uuid(p.staff_id, "staff_id");
        await staff(staffId);
        const enabled = bool(p.enabled, "enabled");
        const ids = Array.isArray(p.entity_ids) ? p.entity_ids.map((v: unknown) => uuid(v, "entity_ids")) : [];
        if (ids.length === 0) throw new BadRequest("entity_ids required");
        if (ids.length > MAX_BULK) throw new BadRequest(`At most ${MAX_BULK} clients at once`);
        const rows = ids.map((entity_id: string) => ({ staff_id: staffId, entity_id, enabled, updated_at: now, updated_by: me }));
        const { error } = await db.from("staff_client_access").upsert(rows, { onConflict: "staff_id,entity_id" });
        if (error) throw new Error(error.message);
        return json({ success: true, changed: ids.length });
      }

      case "copy_access": {
        const from = uuid(p.from_staff_id, "from_staff_id");
        const to = uuid(p.to_staff_id, "to_staff_id");
        if (from === to) throw new BadRequest("Pick someone else to copy from");
        await staff(from); await staff(to);
        const what = String(p.what ?? "both");
        if (!["modules", "clients", "both"].includes(what)) throw new BadRequest("what must be modules, clients or both");

        if (what !== "clients") {
          const { data: mods, error: e1 } = await db.from("staff_module_access").select("module_key, level").eq("staff_id", from);
          if (e1) throw new Error(e1.message);
          const { error: e2 } = await db.from("staff_module_access").delete().eq("staff_id", to);
          if (e2) throw new Error(e2.message);
          if (mods?.length) {
            const { error: e3 } = await db.from("staff_module_access").insert(
              mods.map((m) => ({ staff_id: to, module_key: m.module_key, level: m.level, granted_at: now, granted_by: me })),
            );
            if (e3) throw new Error(e3.message);
          }
        }
        if (what !== "modules") {
          // Page through: a person has one row per client, past the 1,000-row cap.
          const rows: { entity_id: string; enabled: boolean }[] = [];
          for (let off = 0; ; off += 1000) {
            const { data, error } = await db.from("staff_client_access").select("entity_id, enabled")
              .eq("staff_id", from).order("entity_id").range(off, off + 999);
            if (error) throw new Error(error.message);
            rows.push(...(data ?? []));
            if (!data || data.length < 1000) break;
          }
          for (let i = 0; i < rows.length; i += 1000) {
            const { error } = await db.from("staff_client_access").upsert(
              rows.slice(i, i + 1000).map((r) => ({ staff_id: to, entity_id: r.entity_id, enabled: r.enabled, updated_at: now, updated_by: me })),
              { onConflict: "staff_id,entity_id" },
            );
            if (error) throw new Error(error.message);
          }
        }
        return json({ success: true });
      }

      case "set_module_status": {
        const key = String(p.module_key ?? "");
        await moduleRow(key);
        const status = String(p.status ?? "");
        if (!["live", "in_development"].includes(status)) throw new BadRequest("status must be live or in_development");
        const { error } = await db.from("app_modules").update({ status, updated_at: now, updated_by: me }).eq("key", key);
        if (error) throw new Error(error.message);
        return json({ success: true });
      }

      case "set_setting": {
        if (p.key !== "new_client_figures_default") throw new BadRequest("Unknown setting");
        const { error } = await db.from("app_settings")
          .update({ setting_value: bool(p.value, "value"), updated_at: now, updated_by: me })
          .eq("setting_key", "new_client_figures_default");
        if (error) throw new Error(error.message);
        return json({ success: true });
      }

      default:
        throw new BadRequest("Unknown action");
    }
  } catch (e) {
    if (e instanceof BadRequest) return json({ success: false, error: e.message }, e.status);
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
