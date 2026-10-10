// Cross-check overrides (sql/367): a person marks one check on one client as
// explained, with a comment, or takes that back.
//
//   set   { entity_id, check_key, issue, comment }  issue = the check's wording
//         as the screen showed it; the override only applies while it still
//         reads the same, so a changed problem resurfaces.
//   clear { entity_id, check_key }

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
const CHECKS = ["loe", "ct", "sa", "vat", "paye", "bp", "tc", "qbo", "fee"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  // A person's judgement, so no service-role path.
  let caller;
  try { caller = await requireStaffOrService(req, { allowService: false }); }
  catch (e) { return authErrorResponse(e, cors); }

  const p = await req.json().catch(() => ({}));
  const entityId = String(p.entity_id ?? "");
  const checkKey = String(p.check_key ?? "");
  if (!UUID.test(entityId)) return json({ success: false, error: "entity_id must be a uuid" }, 400);
  if (!CHECKS.includes(checkKey)) return json({ success: false, error: "unknown check_key" }, 400);

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  if (p.action === "set") {
    const issue = String(p.issue ?? "").trim();
    const comment = String(p.comment ?? "").trim();
    if (!issue) return json({ success: false, error: "issue required" }, 400);
    if (!comment) return json({ success: false, error: "A comment is required" }, 400);
    const { error } = await db.from("onboarding_crosscheck_overrides").upsert({
      entity_id: entityId, check_key: checkKey, issue: issue.slice(0, 2000), comment: comment.slice(0, 2000),
      created_by: caller.userId, created_at: new Date().toISOString(),
    });
    if (error) return json({ success: false, error: error.message }, 500);
    return json({ success: true });
  }

  if (p.action === "clear") {
    const { error } = await db.from("onboarding_crosscheck_overrides")
      .delete().eq("entity_id", entityId).eq("check_key", checkKey);
    if (error) return json({ success: false, error: error.message }, 500);
    return json({ success: true });
  }

  return json({ success: false, error: "action must be set or clear" }, 400);
});
