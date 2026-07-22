// clerk-inbound — Athena Portal
// Webhook Clerk Chat calls for message events (registered in the Clerk
// dashboard: Settings → Webhooks). Deployed with verify_jwt OFF;
// authenticated by the request's Authorization header matching
// clerk_config.webhook_secret (set the secret as the webhook's custom auth
// header value in Clerk).
//
// Why this exists: Clerk holds the practice number's WhatsApp Business
// registration (it bridges WhatsApp + SMS into MS Teams), so WhatsApp
// traffic never touches Telnyx — this webhook is how it reaches Athena.
// SMS events are IGNORED here: telnyx-inbound is the source of truth for
// SMS (it relays to Clerk, so Clerk sees SMS too and we'd double-log).
//
//   message.received (channel whatsapp) → sms_messages (direction 'in'),
//     client match by phone-number suffix, note on any open triage case,
//     staff notifications — same treatment as telnyx-inbound.
//   message.delivered / message.failed → stamp the matching outbound row
//     (outbound Clerk sends store their id as 'clerk:<id>').
//
// Clerk's exact payload field names aren't documented exhaustively, so
// parsing is tolerant (several spellings tried) and every event's raw body
// is console-logged truncated — check the function logs to refine mapping.
// Always answers 200 so Clerk doesn't retry-storm.

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

function firstString(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
    if (Array.isArray(v) && v.length) {
      const s = firstString(v[0]);
      if (s) return s;
    }
  }
  return "";
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: cfg } = await service.from("clerk_config")
    .select("webhook_secret, enabled").eq("id", true).maybeSingle();
  const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!cfg?.webhook_secret || !auth || auth !== cfg.webhook_secret) {
    return new Response(JSON.stringify({ error: "bad secret" }), { status: 401 });
  }

  const rawBody = await req.text().catch(() => "");
  console.log(`clerk event: ${rawBody.slice(0, 1500)}`);

  let b: any = null;
  try { b = JSON.parse(rawBody); } catch { return ok({ received: true, parse: "failed" }); }

  const eventType = String(b?.event || b?.type || b?.eventType || b?.event_type || "").toLowerCase();
  const p = b?.data || b?.payload || b?.message || b;
  const channel = String(p?.channel || "").toLowerCase();
  const direction = String(p?.direction || "").toLowerCase();
  const msgId = firstString(p?.id, p?.messageId, p?.message_id);
  const from = firstString(p?.from, p?.fromNumber, p?.from_number, p?.sender);
  const to = firstString(p?.to, p?.toNumber, p?.to_number, p?.recipients, p?.recipient);
  const text = firstString(p?.body, p?.text);

  try {
    const isInbound = eventType.includes("received") ||
      (!eventType && (direction === "inbound" || direction === "in"));

    if (isInbound) {
      // telnyx-inbound owns SMS; only WhatsApp comes in through Clerk.
      if (channel && channel !== "whatsapp") return ok({ received: true, ignored: `channel ${channel}` });
      if (!from || !text) return ok({ received: true, ignored: "no from/text" });

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
        direction: "in", entity_id: entityId, to_number: to || null, from_number: from,
        body: text, telnyx_message_id: msgId ? `clerk:${msgId}` : null,
        status: "received", channel: "whatsapp",
      });
      if (insErr) return ok({ received: true, dedup: true });

      if (entityId) {
        const { data: openCase } = await service.from("triage_cases")
          .select("id").eq("entity_id", entityId).eq("status", "open").limit(1).maybeSingle();
        if (openCase) {
          await service.from("triage_case_notes").insert({
            case_id: openCase.id,
            body: `WhatsApp received from ${from}: "${text.slice(0, 300)}${text.length > 300 ? "…" : ""}"`,
          });
        }
      }

      const { data: staff } = await service.from("staff_profiles")
        .select("id, is_active, is_portal_admin, can_manage_portal").eq("is_active", true);
      const recipients = (staff || []).filter((s) => s.is_portal_admin || s.can_manage_portal);
      for (const s of recipients) {
        await service.from("notifications").insert({
          recipient_id: s.id, kind: "sms_received",
          title: `WhatsApp from ${entityName || from}: ${text.slice(0, 80)}`,
          link_path: "/comms/whatsapp",
        });
      }
      return ok({ received: true, matched: !!entityId });
    }

    if (eventType.includes("delivered") || eventType.includes("failed")) {
      if (!msgId) return ok();
      const failed = eventType.includes("failed");
      await service.from("sms_messages").update({
        status: failed ? "failed" : "delivered",
        error: failed ? firstString(p?.error, p?.reason, p?.status) || "delivery failed" : null,
        delivered_at: failed ? null : new Date().toISOString(),
      }).eq("telnyx_message_id", `clerk:${msgId}`);
      return ok();
    }

    return ok({ received: true, ignored: eventType || "unknown" });
  } catch (_e) {
    return ok({ received: true, error: "handled" });
  }
});
