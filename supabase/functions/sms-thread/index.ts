// sms-thread — work the Text Messages / WhatsApp queue (sql/369).
//
// A conversation (channel + the other party's number) is open while it holds an
// inbound message newer than its last clear. This is the one write path to
// sms_threads; the browser only reads v_sms_threads.
//
// POST { action, channel: 'sms' | 'whatsapp', number, ... }
//   assign     { assignee_id | null }   who deals with it (notifies them)
//   clear      { note? }                done — off the open queue until the next text
//   reopen                              back onto the open queue
//   set_client { entity_id | null }     which client it is (null = back to the phone match)
//
// Staff only.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  let caller;
  try { caller = await requireStaffOrService(req, { allowService: false }); }
  catch (e) { return authErrorResponse(e, corsHeaders); }
  const me = caller.userId;

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");
  const channel = body.channel === "whatsapp" ? "whatsapp" : "sms";
  // Numbers are E.164 for people, but short codes and sender names ("Google") text in too.
  const number = String(body.number || "").trim();
  if (!number || number.length > 40) return json({ success: false, error: "number required" }, 400);

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const now = new Date().toISOString();
  const key = { channel, number };

  // Only a conversation that exists can be worked.
  const { data: exists } = await service.from("v_sms_threads")
    .select("number, entity_id").eq("channel", channel).eq("number", number).maybeSingle();
  if (!exists) return json({ success: false, error: "No such conversation" }, 404);

  let patch: Record<string, unknown>;
  if (action === "assign") {
    const assignee = body.assignee_id ? String(body.assignee_id) : null;
    if (assignee) {
      if (!UUID.test(assignee)) return json({ success: false, error: "assignee_id invalid" }, 400);
      const { data: s } = await service.from("staff_profiles").select("id, is_active").eq("id", assignee).maybeSingle();
      if (!s?.is_active) return json({ success: false, error: "Not an active team member" }, 400);
    }
    patch = { assigned_to: assignee, assigned_by: assignee ? me : null, assigned_at: assignee ? now : null };
  } else if (action === "clear") {
    const note = body.note ? String(body.note).slice(0, 300) : null;
    patch = { cleared_at: now, cleared_by: me, cleared_note: note };
  } else if (action === "reopen") {
    patch = { cleared_at: null, cleared_by: null, cleared_note: null };
  } else if (action === "set_client") {
    const entity = body.entity_id ? String(body.entity_id) : null;
    if (entity) {
      if (!UUID.test(entity)) return json({ success: false, error: "entity_id invalid" }, 400);
      const { data: e } = await service.from("entities").select("id").eq("id", entity).maybeSingle();
      if (!e) return json({ success: false, error: "No such client" }, 400);
    }
    patch = { entity_id: entity };
  } else {
    return json({ success: false, error: "Unknown action" }, 400);
  }

  const { error } = await service.from("sms_threads")
    .upsert({ ...key, ...patch, updated_at: now }, { onConflict: "channel,number" });
  if (error) return json({ success: false, error: error.message }, 500);

  // Tell the person it was handed to (not yourself).
  if (action === "assign" && patch.assigned_to && patch.assigned_to !== me) {
    let who = number;
    if (exists.entity_id) {
      const { data: e } = await service.from("entities").select("name").eq("id", exists.entity_id).maybeSingle();
      if (e?.name) who = e.name;
    }
    await service.from("notifications").insert({
      recipient_id: patch.assigned_to,
      kind: "sms_assigned",
      title: `${channel === "whatsapp" ? "WhatsApp" : "Text"} from ${who} assigned to you`,
      link_path: `/comms/${channel}?number=${encodeURIComponent(number)}`,
    });
  }

  return json({ success: true });
});
