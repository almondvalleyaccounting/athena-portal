// resend-webhook — Athena Portal
// Receives Resend email-event webhooks and records matching rows in
// quote_events. Public endpoint; auth is via Svix signature verification
// against the RESEND_WEBHOOK_SECRET env var.
//
// Deploy with --no-verify-jwt (Resend can't send a Supabase user JWT).
//
// Resend event types we care about (from https://resend.com/docs/webhooks):
//   email.sent       — accepted by Resend. We don't record this (redundant
//                      with the audit_log row written by send-quote-email).
//   email.delivered  -> quote_events 'delivered'
//   email.opened     -> quote_events 'opened'
//   email.bounced    -> quote_events 'bounced'
//   email.complained -> quote_events 'complained'
//
// Mapping resend_id -> quote_id:
//   send-quote-email writes the Resend `id` into audit_log.detail.resend_id
//   at send time. This function looks it up via a JSONB filter. No new
//   mapping table required.
//
// Configuration (manual, in Resend dashboard):
//   1. Add a webhook endpoint pointing to this function's URL:
//        https://neksyvneljgxvpchwgch.supabase.co/functions/v1/resend-webhook
//   2. Select events: delivered, bounced, complained, opened.
//   3. Copy the signing secret (starts with "whsec_") into the Supabase
//      secret RESEND_WEBHOOK_SECRET.
//   4. To enable opens, turn on Open Tracking in the Resend project
//      settings (adds a 1x1 pixel to sent emails).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_WEBHOOK_SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET") || "";

const FIVE_MINUTES_S = 5 * 60;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "svix-id, svix-timestamp, svix-signature, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function textResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain", ...corsHeaders },
  });
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

// ---- Svix signature verification ----------------------------------------

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

/**
 * Verify a Svix-format webhook signature. Resend uses Svix.
 * https://docs.svix.com/receiving/verifying-payloads/how-manual
 */
async function verifySvixSignature(
  payload: string,
  svixId: string,
  svixTimestamp: string,
  svixSignature: string,
  secret: string,
): Promise<boolean> {
  if (!svixId || !svixTimestamp || !svixSignature || !secret) return false;

  // Reject old timestamps (replay protection)
  const ts = Number(svixTimestamp);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > FIVE_MINUTES_S) return false;

  // Secret format: "whsec_<base64>"
  const rawSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const keyBytes = base64ToBytes(rawSecret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const toSign = `${svixId}.${svixTimestamp}.${payload}`;
  const sigBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(toSign),
  );
  const expected = bytesToBase64(sigBytes);

  // svix-signature is space-separated: "v1,sig1 v1,sig2 ..."
  // We only accept v1; any signature matching counts as valid.
  const candidates = svixSignature
    .split(" ")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("v1,"))
    .map((s) => s.slice(3));
  return candidates.some((c) => c === expected);
}

// ---- Resend event -> quote_events mapping -------------------------------

type ResendEventType =
  | "email.sent"
  | "email.delivered"
  | "email.delivery_delayed"
  | "email.opened"
  | "email.clicked"
  | "email.bounced"
  | "email.complained";

function mapEventType(resendType: string): string | null {
  switch (resendType as ResendEventType) {
    case "email.delivered":
      return "delivered";
    case "email.opened":
      return "opened";
    case "email.bounced":
      return "bounced";
    case "email.complained":
      return "complained";
    default:
      return null;
  }
}

// ---- Entry point --------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return textResponse("Method not allowed", 405);
  }

  const rawBody = await req.text();

  // Signature verification
  const svixId = req.headers.get("svix-id") ?? "";
  const svixTimestamp = req.headers.get("svix-timestamp") ?? "";
  const svixSignature = req.headers.get("svix-signature") ?? "";

  const ok = await verifySvixSignature(
    rawBody,
    svixId,
    svixTimestamp,
    svixSignature,
    RESEND_WEBHOOK_SECRET,
  );
  if (!ok) {
    console.error("[resend-webhook] signature verification failed", {
      svixId,
      svixTimestamp,
      hasSecret: Boolean(RESEND_WEBHOOK_SECRET),
    });
    return textResponse("Invalid signature", 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return textResponse("Invalid JSON", 400);
  }

  const resendType = String(payload.type ?? "");
  const mappedType = mapEventType(resendType);
  if (!mappedType) {
    // Unknown or intentionally-ignored event type (e.g. email.sent). ACK
    // with 200 so Resend doesn't retry.
    return jsonResponse({ ok: true, ignored: resendType });
  }

  const data = (payload.data ?? {}) as Record<string, unknown>;
  const resendId = (data.email_id as string) || (data.id as string) || null;
  if (!resendId) {
    console.error("[resend-webhook] event has no email_id", payload);
    return jsonResponse({ ok: false, error: "missing_email_id" }, 400);
  }

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Look up which quote this email_id belongs to. send-quote-email writes
  // the Resend id into audit_log.detail.resend_id at send time.
  const { data: auditRow, error: auditErr } = await service
    .from("audit_log")
    .select("entity_id, detail")
    .eq("entity_type", "quote")
    .eq("action", "sent_to_client")
    .filter("detail->>resend_id", "eq", resendId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (auditErr) {
    console.error("[resend-webhook] audit lookup error", auditErr);
    return jsonResponse({ ok: false, error: "lookup_failed" }, 500);
  }
  if (!auditRow?.entity_id) {
    // Unknown email_id — likely a test send, a system email, or a race
    // where the webhook arrived before audit_log was committed. ACK so
    // Resend doesn't retry indefinitely; we log for visibility.
    console.warn("[resend-webhook] no audit_log row for email_id", resendId);
    return jsonResponse({ ok: true, unknown_email_id: resendId });
  }

  // Client email: try to echo what was recorded at send time so all rows
  // for one quote share a consistent value. Falls back to webhook payload.
  const auditedRecipient =
    (auditRow.detail as Record<string, unknown> | null)?.recipient as
      | string
      | undefined;
  const toFromPayload = Array.isArray(data.to) ? (data.to[0] as string) : "";
  const clientEmail = auditedRecipient || toFromPayload || null;

  const { error: insertErr } = await service.from("quote_events").insert({
    quote_id: auditRow.entity_id,
    event_type: mappedType,
    client_email: clientEmail,
    resend_id: resendId,
    metadata: {
      resend_type: resendType,
      resend_created_at: payload.created_at ?? null,
    },
  });

  if (insertErr) {
    console.error("[resend-webhook] insert error", insertErr);
    return jsonResponse({ ok: false, error: insertErr.message }, 500);
  }

  return jsonResponse({
    ok: true,
    quote_id: auditRow.entity_id,
    event_type: mappedType,
  });
});
