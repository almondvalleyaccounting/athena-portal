// telnyx-inbound — Athena Portal
// Webhook Telnyx calls for inbound SMS and delivery receipts. Deployed with
// verify_jwt OFF; authenticated by the ?secret= query param matching
// telnyx_config.webhook_secret (set on the Telnyx messaging profile as
// .../functions/v1/telnyx-inbound?secret=<hex>).
//
//   message.received  → log into sms_messages (direction 'in'), match the
//     sender to a client by phone-number suffix, note any open triage case,
//     and notify portal staff.
//   message.finalized → stamp delivery outcome on the matching outbound row.
//
// Always answers 200 so Telnyx doesn't retry storms; problems are logged.
//
// RELAY: this function is the PRIMARY webhook on the Telnyx messaging
// profile; Clerk SMS (MS Teams) used to be. So Teams keeps working, every
// event is re-posted VERBATIM (raw body + Telnyx signature headers) to
// telnyx_config.relay_url — Clerk's endpoint. Clerk is also the profile's
// failover URL, so if this function is ever down Telnyx delivers to Clerk
// directly. The relay must never block or fail the main handling.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function ok(data: unknown = { received: true }) {
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
}

function digitsSuffix(raw: string, n = 9): string {
  const d = String(raw || "").replace(/\D/g, "");
  return d.slice(-n);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret") || "";

  const { data: cfg } = await service.from("telnyx_config").select("webhook_secret, relay_url").eq("id", true).maybeSingle();
  if (!cfg || !secret || secret !== cfg.webhook_secret) {
    return new Response(JSON.stringify({ error: "bad secret" }), { status: 401 });
  }

  const rawBody = await req.text().catch(() => "");

  // Relay to Clerk SMS FIRST (verbatim body + Telnyx signature headers so
  // Clerk's own verification still passes) — Teams delivery must not depend
  // on anything below succeeding.
  if (cfg.relay_url) {
    try {
      const relayHeaders: Record<string, string> = { "Content-Type": req.headers.get("Content-Type") || "application/json" };
      for (const h of ["telnyx-signature-ed25519", "telnyx-timestamp"]) {
        const v = req.headers.get(h);
        if (v) relayHeaders[h] = v;
      }
      await fetch(cfg.relay_url, { method: "POST", headers: relayHeaders, body: rawBody });
    } catch (e) {
      console.log(`relay to clerk failed: ${(e as Error).message}`);
    }
  }

  let body: any = null;
  try { body = JSON.parse(rawBody); } catch { /* ignore */ }
  const eventType: string = body?.data?.event_type || "";
  const payload = body?.data?.payload || {};

  try {
    if (eventType === "message.received") {
      const telnyxId: string | null = payload.id || null;
      const from: string = payload?.from?.phone_number || "";
      const to: string = payload?.to?.[0]?.phone_number || "";
      const text: string = payload?.text || "";
      if (!from || !text) return ok();

      // Match a client by number suffix (prospect_phone formats vary).
      let entityId: string | null = null;
      let entityName: string | null = null;
      const suffix = digitsSuffix(from);
      if (suffix.length >= 7) {
        const { data: ents } = await service.from("entities")
          .select("id, name, prospect_phone")
          .not("prospect_phone", "is", null);
        const hit = (ents || []).find((e) => digitsSuffix(e.prospect_phone) === suffix);
        if (hit) { entityId = hit.id; entityName = hit.name; }
      }

      const { error: insErr } = await service.from("sms_messages").insert({
        direction: "in", entity_id: entityId, to_number: to, from_number: from,
        body: text, telnyx_message_id: telnyxId, status: "received",
      });
      if (insErr) return ok({ received: true, dedup: true }); // unique violation = retry already handled

      // Note any open triage case for the client.
      if (entityId) {
        const { data: openCase } = await service.from("triage_cases")
          .select("id").eq("entity_id", entityId).eq("status", "open").limit(1).maybeSingle();
        if (openCase) {
          await service.from("triage_case_notes").insert({
            case_id: openCase.id,
            body: `SMS received from ${from}: "${text.slice(0, 300)}${text.length > 300 ? "…" : ""}"`,
          });
        }
      }

      // Notify portal staff.
      const { data: staff } = await service.from("staff_profiles")
        .select("id, is_active, is_portal_admin, can_manage_portal").eq("is_active", true);
      const recipients = (staff || []).filter((s) => s.is_portal_admin || s.can_manage_portal);
      for (const s of recipients) {
        await service.from("notifications").insert({
          recipient_id: s.id, kind: "sms_received",
          title: `Text from ${entityName || from}: ${text.slice(0, 80)}`,
          link_path: entityId ? `/clients/${entityId}` : "/home",
        });
      }
      return ok({ received: true, matched: !!entityId });
    }

    if (eventType === "message.finalized") {
      const telnyxId: string | null = payload.id || null;
      if (!telnyxId) return ok();
      const outcome = payload?.to?.[0]?.status || "";
      const delivered = outcome === "delivered";
      await service.from("sms_messages").update({
        status: delivered ? "delivered" : "failed",
        error: delivered ? null : (outcome || "not delivered"),
        delivered_at: delivered ? new Date().toISOString() : null,
      }).eq("telnyx_message_id", telnyxId);
      return ok();
    }

    return ok({ received: true, ignored: eventType });
  } catch (_e) {
    return ok({ received: true, error: "handled" });
  }
});
