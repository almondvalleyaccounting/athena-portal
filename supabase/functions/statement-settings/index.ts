// statement-settings
//
// Reads and saves a client's letterhead for the customer statements they
// download from the Overdue invoices tab: logo, contact details, how to pay,
// a footer note. One row per client in client_statement_settings (sql/361),
// which no browser role can touch, so this function is the only way in.
//
// Two kinds of caller, and the database cannot tell them apart — both hold
// `authenticated` — so this function asks:
//
//   • A portal client: an unrevoked client_dashboard_access grant for this
//     entity, on their own verified email, with show_debtors on. That is the
//     flag the Overdue invoices tab rides on, so anyone who can download a
//     statement can set what it looks like, and nobody else at the client can.
//   • Staff: active, and either a portal admin (can_manage_portal) or someone
//     with this client's dashboard figures switched on (can_view_reports +
//     staff_figures_visible), so the letterhead can be set up on a client's
//     behalf from the staff tab.
//
// The anon key and the service key are refused by role claim before anything
// else: neither is a person, and this function only ever acts for one.
//
// body: { entityId, action: "get" | "save", settings? }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function jr(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });
}

// Field → maximum length. Mirrors the CHECK in sql/361, which holds whatever
// this function lets through.
const TEXT_FIELDS: Record<string, number> = {
  business_name: 200, address: 600, email: 200, phone: 60, website: 200,
  company_number: 40, vat_number: 40, payment_details: 800, footer_note: 800,
};
const COLUMNS = ["entity_id", "logo_data_url", ...Object.keys(TEXT_FIELDS), "updated_at"].join(", ");
const LOGO = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;
const LOGO_MAX = 400000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return jr({ success: false, error: "POST required" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? req.headers.get("authorization");
    const token = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || null;
    if (!token) return jr({ success: false, error: "Missing authorization" }, 401);
    try {
      const part = token.split(".")[1];
      const pad = "=".repeat((4 - (part.length % 4)) % 4);
      const role = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/") + pad))?.role;
      if (role === "anon" || role === "service_role") return jr({ success: false, error: "Not authorised" }, 403);
    } catch { /* not a decodable JWT — getUser will reject it */ }

    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user }, error: authErr } = await anon.auth.getUser();
    if (authErr || !user?.email) return jr({ success: false, error: "Invalid token" }, 401);

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json().catch(() => ({}));
    const entityId = String(body.entityId || "");
    if (!/^[0-9a-f-]{36}$/i.test(entityId)) return jr({ success: false, error: "entityId required" }, 400);

    // WHO, and for which client.
    let allowed = false;
    const { data: staff } = await sb
      .from("staff_profiles")
      .select("is_active, can_manage_portal, can_view_reports")
      .eq("id", user.id)
      .maybeSingle();
    if (staff) {
      if (staff.is_active && staff.can_manage_portal) allowed = true;
      else if (staff.is_active && staff.can_view_reports) {
        const { data: ok } = await sb.rpc("staff_figures_visible", {
          p_staff: user.id, p_modules: ["cw-dashboard"], p_entity: entityId, p_realm: null,
        });
        allowed = ok === true;
      }
    } else {
      const { data: grant } = await sb
        .from("client_dashboard_access")
        .select("id, show_debtors")
        .eq("entity_id", entityId)
        .ilike("email", user.email)
        .is("revoked_at", null)
        .maybeSingle();
      allowed = !!grant?.show_debtors;
    }
    if (!allowed) return jr({ success: false, error: "Not authorised" }, 403);

    if (body.action === "save") {
      const s = body.settings || {};
      const row: Record<string, unknown> = {
        entity_id: entityId,
        updated_at: new Date().toISOString(),
        updated_by_email: user.email,
      };
      for (const [k, max] of Object.entries(TEXT_FIELDS)) {
        const v = typeof s[k] === "string" ? s[k].trim() : "";
        if (v.length > max) return jr({ success: false, error: `${k.replace(/_/g, " ")} is too long` }, 400);
        row[k] = v || null;
      }
      const logo = s.logo_data_url;
      if (logo == null || logo === "") row.logo_data_url = null;
      else if (typeof logo !== "string" || !LOGO.test(logo) || logo.length > LOGO_MAX) {
        return jr({ success: false, error: "The logo must be a PNG or JPEG under about 300 KB" }, 400);
      } else row.logo_data_url = logo;

      const { data, error } = await sb
        .from("client_statement_settings")
        .upsert(row, { onConflict: "entity_id" })
        .select(COLUMNS)
        .single();
      if (error) return jr({ success: false, error: "Could not save the settings" }, 500);
      return jr({ success: true, settings: data });
    }

    const { data } = await sb
      .from("client_statement_settings")
      .select(COLUMNS)
      .eq("entity_id", entityId)
      .maybeSingle();
    return jr({ success: true, settings: data || null });
  } catch (err) {
    return jr({ success: false, error: (err as Error).message }, 500);
  }
});
