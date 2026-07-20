// chase-reply-scan — Athena Portal
// Polls the connected Gmail inbox (info@) every 15 minutes and matches
// senders against open chases, so nobody is ever chased after they replied.
//
// On a match it does exactly three things — and never sends anything:
//   * CH-code chase:  stamps ch_code_requests.client_replied_at + logs an
//     email_in activity ("chase paused — process and advance the stage").
//   * Onboarding:     stamps onboardings.client_replied_at + logs a
//     client_reply activity; a call_needed escalation resets to none
//     (mirroring how portal replies reset the ladder). 'paused' is left
//     for a human — the pause email said we'd stop, so resuming is a
//     deliberate decision.
//   * Both chase engines HOLD reminders while the reply is newer than the
//     last outbound email (see ch-code-queue-fill / onboarding-chase).
//
// Matched messages are recorded in chase_inbound_log (unique gmail id =
// dedupe); unmatched inbox traffic is re-checked within the lookback window
// but never stored. Fails soft when no Gmail connection exists.
//
// Auth: x-cron-secret matching onboarding_chase_config.cron_secret (the
// general onboarding automation secret), OR a portal-admin JWT.
// Body: {} — no options; the lookback window is fixed at 3 days.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getValidGmailToken } from "../_shared/gmail-client.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });
}

type Row = Record<string, unknown>;

function firstEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = String(raw).split(/[;,]/)[0].trim().toLowerCase();
  return e.includes("@") ? e : null;
}
// "Name <a@b.com>" → "a@b.com"
function addressOf(fromHeader: string): string | null {
  const m = fromHeader.match(/<([^>]+)>/);
  const raw = (m ? m[1] : fromHeader).trim().toLowerCase();
  return raw.includes("@") ? raw : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── Auth: cron secret (onboarding automation secret) OR portal-admin JWT ──
  const cronHeader = req.headers.get("x-cron-secret") || "";
  const { data: cfg } = await service.from("onboarding_chase_config").select("cron_secret").eq("id", true).maybeSingle();
  const expectedSecret = (cfg?.cron_secret as string) || "";
  if (!(expectedSecret && cronHeader && cronHeader === expectedSecret)) {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ success: false, error: "Missing authorization" }, 401);
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authErr } = await anon.auth.getUser();
    if (authErr || !user) return json({ success: false, error: "Invalid token" }, 401);
    const { data: prof } = await service.from("staff_profiles").select("is_portal_admin, can_manage_portal").eq("id", user.id).single();
    if (!prof || !(prof.is_portal_admin || prof.can_manage_portal)) return json({ success: false, error: "Not authorised" }, 403);
  }

  // ── Gmail connection — fail soft until info@ is connected ──
  let token: { accessToken: string; accountEmail: string };
  try {
    token = await getValidGmailToken();
  } catch (e) {
    return json({ success: true, skipped: true, reason: `No usable Gmail connection: ${(e as Error).message}` });
  }

  // ── Recent inbox messages (3-day lookback; dedupe via chase_inbound_log) ──
  const listResp = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?" +
      new URLSearchParams({ q: "in:inbox newer_than:3d", maxResults: "100" }),
    { headers: { Authorization: `Bearer ${token.accessToken}` } },
  );
  if (!listResp.ok) return json({ success: false, error: `Gmail list failed: ${listResp.status} ${await listResp.text()}` }, 500);
  const listJson = await listResp.json();
  const messageIds: string[] = ((listJson.messages || []) as Row[]).map((m) => m.id as string);
  if (!messageIds.length) return json({ success: true, scanned: 0, matched: 0 });

  const { data: seenRows } = await service.from("chase_inbound_log").select("gmail_message_id").in("gmail_message_id", messageIds);
  const seen = new Set((seenRows || []).map((r: Row) => r.gmail_message_id as string));
  const fresh = messageIds.filter((id) => !seen.has(id));
  if (!fresh.length) return json({ success: true, scanned: 0, matched: 0 });

  // ── Build the match universe ──
  const [{ data: chReqs }, { data: obs }] = await Promise.all([
    service.from("ch_code_requests")
      .select("id, stage, client_replied_at, owner_id, person:people(id, name, email), entity:entities!ch_code_requests_entity_id_fkey(id, name)")
      .in("stage", ["s1_offer", "s2_decision", "s3a_client", "s3b_us", "s4_code", "s5_entered"]),
    service.from("onboardings")
      .select("id, status, escalation_status, client_replied_at, owner_id, entity:entities!onboardings_entity_id_fkey(id, name, billing_email, prospect_email)")
      .eq("status", "active"),
  ]);

  const chByEmail = new Map<string, Row[]>();
  for (const r of (chReqs || []) as Row[]) {
    const e = firstEmail((r.person as Row)?.email as string);
    if (!e) continue;
    if (!chByEmail.has(e)) chByEmail.set(e, []);
    chByEmail.get(e)!.push(r);
  }

  const obIds = ((obs || []) as Row[]).map((o) => o.entity as Row).filter(Boolean).map((e) => e.id as string);
  const [{ data: qboRows }, { data: bmRows }] = await Promise.all([
    obIds.length ? service.from("qbo_customer_mappings").select("entity_id, qbo_email").in("entity_id", obIds).not("qbo_email", "is", null) : Promise.resolve({ data: [] }),
    obIds.length ? service.from("entity_people").select("entity_id, person:people(email)").in("entity_id", obIds).eq("is_primary_contact", true) : Promise.resolve({ data: [] }),
  ]);
  const extraEmails = new Map<string, string[]>();
  for (const r of (qboRows || []) as Row[]) {
    const e = firstEmail(r.qbo_email as string);
    if (e) extraEmails.set(r.entity_id as string, [...(extraEmails.get(r.entity_id as string) || []), e]);
  }
  for (const r of (bmRows || []) as Row[]) {
    const e = firstEmail((r.person as Row)?.email as string);
    if (e) extraEmails.set(r.entity_id as string, [...(extraEmails.get(r.entity_id as string) || []), e]);
  }
  const obByEmail = new Map<string, Row[]>();
  for (const o of (obs || []) as Row[]) {
    const ent = o.entity as Row;
    const candidates = new Set<string>([
      firstEmail(ent?.billing_email as string) || "",
      firstEmail(ent?.prospect_email as string) || "",
      ...(extraEmails.get(ent?.id as string) || []),
    ].filter(Boolean) as string[]);
    for (const e of candidates) {
      if (!obByEmail.has(e)) obByEmail.set(e, []);
      obByEmail.get(e)!.push(o);
    }
  }

  // ── Process fresh messages ──
  let matchedCount = 0;
  const details: Row[] = [];
  for (const id of fresh) {
    const msgResp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?` +
        new URLSearchParams({ format: "metadata", metadataHeaders: "From" }) + "&metadataHeaders=Subject&metadataHeaders=Date",
      { headers: { Authorization: `Bearer ${token.accessToken}` } },
    );
    if (!msgResp.ok) continue;
    const msg = await msgResp.json();
    const headers: Row[] = msg?.payload?.headers || [];
    const h = (name: string) => (headers.find((x) => String(x.name).toLowerCase() === name)?.value as string) || "";
    const from = addressOf(h("from"));
    if (!from || from === token.accountEmail.toLowerCase()) continue;
    const subject = h("subject");
    const receivedAt = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString();

    const chMatches = chByEmail.get(from) || [];
    const obMatches = obByEmail.get(from) || [];
    if (!chMatches.length && !obMatches.length) continue;

    // Insert-first dedupe: a unique violation means another run got here.
    const { error: logErr } = await service.from("chase_inbound_log").insert({
      gmail_message_id: id, from_email: from, subject, received_at: receivedAt,
      matched_ch_request_ids: chMatches.map((r) => r.id as string),
      matched_onboarding_ids: obMatches.map((o) => o.id as string),
    });
    if (logErr) continue;
    matchedCount++;

    for (const r of chMatches) {
      await service.from("ch_code_requests").update({ client_replied_at: receivedAt, updated_at: new Date().toISOString() }).eq("id", r.id as string);
      await service.from("ch_code_activity").insert({
        request_id: r.id as string, kind: "email_in",
        body: `Reply received from ${from}${subject ? ` — “${subject}”` : ""}. Reminders held — process it and advance the stage.`,
      });
      if (r.owner_id) {
        await service.from("notifications").insert({
          recipient_id: r.owner_id as string, kind: "chase_reply",
          title: `${(r.person as Row)?.name || from} replied on their CH code chase`,
          link_path: `/onboarding/ch-codes/${r.id}`,
        });
      }
    }
    for (const o of obMatches) {
      await service.from("onboardings").update({ client_replied_at: receivedAt }).eq("id", o.id as string);
      await service.from("onboarding_activity").insert({
        onboarding_id: o.id as string, kind: "client_reply",
        body: `Email reply received from ${from}${subject ? ` — “${subject}”` : ""}. Chasing held until it's processed.`,
      });
      if ((o.escalation_status as string) === "call_needed") {
        await service.from("onboardings").update({ escalation_status: "none", escalated_at: null }).eq("id", o.id as string);
      }
      if (o.owner_id) {
        await service.from("notifications").insert({
          recipient_id: o.owner_id as string, kind: "chase_reply",
          title: `${(o.entity as Row)?.name || from} replied on their onboarding`,
          link_path: `/onboarding/${o.id}`,
        });
      }
    }
    details.push({ from, subject, ch: chMatches.length, onboarding: obMatches.length });
  }

  return json({ success: true, scanned: fresh.length, matched: matchedCount, details });
});
