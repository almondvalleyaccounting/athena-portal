// sms-send — Athena Portal
// Sends an SMS (or WhatsApp message) through Telnyx from the practice number.
// Deployed with verify_jwt OFF; verifies a staff JWT itself (any active staff
// member — the Communications module is the whole team's). The Telnyx API key
// lives in telnyx_config (service-role only — no RLS policies), never in the
// browser.
//
// Body: { body: string, to?: "+44...", entity_id?: uuid, triage_case_id?: uuid,
//         channel?: 'sms' | 'whatsapp' }
//   to falls back to the entity's prospect_phone. UK numbers are normalised
//   to E.164 (07… → +447…). channel 'whatsapp' rides the same Telnyx Messages
//   API with type WHATSAPP — outside a 24h session window Telnyx will reject
//   non-template sends; the error lands on the sms_messages row.
//
// Every send is logged to sms_messages; a triage_case_id also drops a note
// on the case — this is the send primitive the escalation ladder will call.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });
}

// 07700 900123 → +447700900123; tolerate spaces/dashes/parens; keep +.
export function normalisePhone(raw: string): string | null {
  const digits = String(raw || "").replace(/[^\d+]/g, "");
  if (!digits) return null;
  if (digits.startsWith("+")) return digits;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (digits.startsWith("07") && digits.length === 11) return `+44${digits.slice(1)}`;
  if (digits.startsWith("44")) return `+${digits}`;
  return `+${digits}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Staff auth.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ success: false, error: "Missing authorization" }, 401);
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: authErr } = await anon.auth.getUser();
  if (authErr || !user) return json({ success: false, error: "Invalid token" }, 401);
  const { data: prof } = await service.from("staff_profiles").select("is_active").eq("id", user.id).single();
  if (!prof?.is_active) return json({ success: false, error: "Not authorised" }, 403);

  const body = await req.json().catch(() => ({}));
  const channel = body.channel === "whatsapp" ? "whatsapp" : "sms";
  const text = String(body.body || "").trim();
  if (!text) return json({ success: false, error: "body (message text) required" }, 400);
  if (text.length > 1200) return json({ success: false, error: "Message too long" }, 400);

  const { data: cfg } = await service.from("telnyx_config").select("*").eq("id", true).maybeSingle();
  if (!cfg?.api_key || !cfg?.from_number) {
    return json({ success: false, error: "Telnyx isn't configured yet (api_key/from_number missing in telnyx_config)." }, 400);
  }
  if (!cfg.enabled) return json({ success: false, error: "SMS sending is disabled in telnyx_config." }, 400);

  // Resolve destination.
  let to: string | null = body.to ? normalisePhone(body.to) : null;
  const entityId: string | null = body.entity_id || null;
  if (!to && entityId) {
    const { data: ent } = await service.from("entities").select("id, name, prospect_phone").eq("id", entityId).maybeSingle();
    to = ent?.prospect_phone ? normalisePhone(ent.prospect_phone) : null;
    if (!to) return json({ success: false, error: "No phone number on the client record." }, 400);
  }
  if (!to) return json({ success: false, error: "No destination number (to or entity_id required)." }, 400);

  // Log first, then send.
  const { data: row, error: insErr } = await service.from("sms_messages").insert({
    direction: "out", entity_id: entityId, to_number: to, from_number: cfg.from_number,
    body: text, triage_case_id: body.triage_case_id || null, sent_by: user.id, channel,
  }).select("id").single();
  if (insErr) return json({ success: false, error: `Could not log message: ${insErr.message}` }, 500);

  const resp = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: { "Authorization": `Bearer ${cfg.api_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: cfg.from_number, to, text,
      ...(channel === "whatsapp" ? { type: "WHATSAPP" } : {}),
      ...(cfg.messaging_profile_id ? { messaging_profile_id: cfg.messaging_profile_id } : {}),
    }),
  });
  const tj = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const err = tj?.errors?.[0]?.detail || tj?.errors?.[0]?.title || `Telnyx ${resp.status}`;
    await service.from("sms_messages").update({ status: "failed", error: err }).eq("id", row.id);
    return json({ success: false, error: err }, 502);
  }

  await service.from("sms_messages").update({
    status: "sent", telnyx_message_id: tj?.data?.id || null,
  }).eq("id", row.id);

  if (body.triage_case_id) {
    await service.from("triage_case_notes").insert({
      case_id: body.triage_case_id, author_id: user.id,
      body: `${channel === "whatsapp" ? "WhatsApp" : "SMS"} sent to ${to}: "${text.slice(0, 200)}${text.length > 200 ? "…" : ""}"`,
    });
  }
  await service.from("audit_log").insert({
    user_id: user.id, action: "sms_sent", entity_type: "entity", entity_id: entityId,
    detail: { to, chars: text.length, sms_id: row.id, telnyx_id: tj?.data?.id || null, channel },
  });

  return json({ success: true, id: row.id, telnyx_id: tj?.data?.id || null });
});
