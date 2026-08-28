// comms-ingest — Athena Portal
// Scans EVERY connected Gmail mailbox (shared + personal), matches each
// message's From/To/Cc against known client email addresses, and stores the
// matched messages in client_communications so they surface on the client
// page's Communications tab (merged with SMS/WhatsApp).
//
// Only matched mail is stored — unmatched traffic is discarded, never stored
// (same privacy stance as chase-reply-scan). We store the body of the
// individual message only, not the whole thread. One row per matched entity
// (an address can belong to several entities). Cross-mailbox duplicates share
// an rfc_message_id and are de-duped at read time in the UI.
//
// This function makes NO mailbox mutations — read-only (no label/archive/trash).
//
// Auth: x-cron-secret matching onboarding_chase_config.cron_secret, OR a
// portal-admin JWT (mirrors chase-reply-scan).
//
// Body: { mode?: 'incremental' | 'backfill', mailbox?: string }
//   incremental (default) — per mailbox: if its 12-month backfill isn't done
//                           yet (new/just-connected mailbox), run a backfill
//                           pass; otherwise scan mail newer than last_scanned_at.
//                           So a newly connected team member is auto-seeded with
//                           12 months of history on its first cron runs.
//   backfill              — force a backfill pass for every mailbox; walk back to
//                           the 12-month floor in bounded runs (manual driver).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { failureUpdate, refreshWithRetry } from "../_shared/oauth-refresh.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// Inlined from _shared/gmail-client.ts (token refresh itself is shared —
// _shared/oauth-refresh.ts — so the retry rule cannot drift between copies):
// resolve a mailbox's active connection and refresh the access token if it's
// within 5 minutes of expiry, surfacing errors back onto the gmail_connections
// row exactly as the shared helper does.
async function getValidGmailToken(mailbox: string): Promise<{ accessToken: string; accountEmail: string }> {
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: conn, error } = await sb.from("gmail_connections").select("*")
    .eq("status", "active").ilike("account_email", mailbox.replace(/[%_]/g, "")).maybeSingle();
  if (error) throw new Error(`gmail_connections lookup failed: ${error.message}`);
  if (!conn) throw new Error(`No active Gmail connection for ${mailbox}`);

  const expiresAt = new Date(conn.token_expires_at).getTime();
  if (expiresAt - Date.now() > 5 * 60 * 1000) {
    return { accessToken: conn.access_token as string, accountEmail: conn.account_email as string };
  }
  // A transient failure leaves the mailbox active so the next 15-minute run
  // retries it; only a dead grant disables it. See _shared/oauth-refresh.ts.
  const outcome = await refreshWithRetry(GOOGLE_TOKEN_URL, new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: conn.refresh_token as string,
  }));
  if (!outcome.ok) {
    await sb.from("gmail_connections").update(failureUpdate(outcome)).eq("id", conn.id);
    throw new Error(
      `Gmail token refresh failed after ${outcome.attempts} attempt(s): ${outcome.status} ${outcome.body}` +
      (outcome.permanent ? " — reconnect required" : " — transient, will retry"),
    );
  }
  const tokens = outcome.tokens as Record<string, any>;
  await sb.from("gmail_connections").update({
    access_token: tokens.access_token,
    token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    last_refreshed_at: new Date().toISOString(),
    status: "active", error_message: null, updated_at: new Date().toISOString(),
  }).eq("id", conn.id);
  return { accessToken: tokens.access_token as string, accountEmail: conn.account_email as string };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });
}

type Row = Record<string, unknown>;

// Tuning — bounded per run so a single invocation stays well under the edge
// wall-clock limit. Backfill is resumable (see backfilled_through), so hitting
// the cap just means "re-invoke to continue".
const BACKFILL_MONTHS = 12;
const MAX_MESSAGES_PER_RUN = 250;   // metadata fetches per mailbox per run
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;

function lc(s: string | null | undefined): string { return String(s || "").trim().toLowerCase(); }

// All email addresses in a header value (handles "Name <a@b>, c@d" etc.).
function emailsIn(headerValue: string): string[] {
  const m = String(headerValue || "").match(EMAIL_RE);
  return m ? m.map((e) => e.toLowerCase()) : [];
}

// First usable email from a stored contact field (may be "a; b").
function firstEmail(raw: string | null | undefined): string | null {
  const e = lc(String(raw || "").split(/[;,]/)[0]);
  return e.includes("@") ? e : null;
}

// "Jim <a@b.com>" → { name: 'Jim', email: 'a@b.com' }
function parseFrom(fromHeader: string): { name: string | null; email: string | null } {
  const s = String(fromHeader || "").trim();
  const m = s.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: lc(m[2]) || null };
  const bare = emailsIn(s)[0] || null;
  return { name: null, email: bare };
}

function base64UrlDecode(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

// Best text/html + text/plain body for THIS message only (ignores attachments).
function parseBody(payload: any, out: { html: string; text: string }) {
  if (!payload) return;
  const mime = payload.mimeType || "";
  const filename = payload.filename || "";
  if (!filename && payload.body?.data) {
    if (mime === "text/html" && !out.html) out.html = base64UrlDecode(payload.body.data);
    if (mime === "text/plain" && !out.text) out.text = base64UrlDecode(payload.body.data);
  }
  for (const part of payload.parts || []) parseBody(part, out);
}

function headerOf(headers: Row[], name: string): string {
  return (headers.find((h) => String(h.name).toLowerCase() === name.toLowerCase())?.value as string) || "";
}

// ── Client email → entity ids ─────────────────────────────────────────────
// One address can map to several entities (an individual and their company
// often share a contact email), so the map value is a Set of entity ids.
async function buildEmailMap(service: ReturnType<typeof createClient>): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  const add = (email: string | null, entityId: string | null | undefined) => {
    if (!email || !entityId) return;
    if (!map.has(email)) map.set(email, new Set());
    map.get(email)!.add(entityId as string);
  };

  const [people, ents, qbo, recon] = await Promise.all([
    service.from("entity_people").select("entity_id, person:people(email)").limit(20000),
    service.from("entities").select("id, billing_email, prospect_email").limit(20000),
    service.from("qbo_customer_mappings").select("entity_id, qbo_email").not("qbo_email", "is", null).limit(20000),
    service.from("v_email_reconciliation").select("entity_id, bm_contact_email").limit(20000),
  ]);

  for (const r of (people.data || []) as Row[]) add(firstEmail((r.person as Row)?.email as string), r.entity_id as string);
  for (const r of (ents.data || []) as Row[]) {
    add(firstEmail(r.billing_email as string), r.id as string);
    add(firstEmail(r.prospect_email as string), r.id as string);
  }
  for (const r of (qbo.data || []) as Row[]) add(firstEmail(r.qbo_email as string), r.entity_id as string);
  for (const r of (recon.data || []) as Row[]) add(firstEmail(r.bm_contact_email as string), r.entity_id as string);

  return map;
}

// Our own addresses, not just the mailbox being scanned. Quote and CH-code
// emails go out through Resend as info@ and are blind-copied to another of our
// mailboxes, so the copy that lands in accounts@ was still sent BY us — keying
// direction off the scanned mailbox alone would file it as inbound. For the
// same reason a firm address never identifies a client.
const FIRM_EMAIL_DOMAIN =
  Deno.env.get("FIRM_EMAIL_DOMAIN") || "almondvalleyaccounting.co.uk";
const isFirmAddress = (addr: string) =>
  addr.toLowerCase().endsWith(`@${FIRM_EMAIL_DOMAIN.toLowerCase()}`);

async function gmailList(token: string, q: string, pageToken?: string) {
  const params = new URLSearchParams({ q, maxResults: "100" });
  if (pageToken) params.set("pageToken", pageToken);
  const resp = await fetch(`${GMAIL}/messages?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`Gmail list ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  return resp.json();
}

// Process one mailbox for one run. Returns per-mailbox stats + whether the
// backfill for this mailbox is complete.
async function processMailbox(
  service: ReturnType<typeof createClient>,
  emailMap: Map<string, Set<string>>,
  accountEmail: string,
  mode: "incremental" | "backfill",
): Promise<Row> {
  let token: { accessToken: string; accountEmail: string };
  try {
    token = await getValidGmailToken(accountEmail);
  } catch (e) {
    return { mailbox: accountEmail, skipped: true, reason: (e as Error).message };
  }
  const mailboxLc = token.accountEmail.toLowerCase();
  const runStart = new Date();

  // Window bounds.
  const { data: stateRow } = await service.from("comms_ingest_state").select("*").eq("mailbox", token.accountEmail).maybeSingle();
  const floorMs = Date.now() - BACKFILL_MONTHS * 30 * 24 * 3600 * 1000;
  const backfilledThroughMs = stateRow?.backfilled_through ? new Date(stateRow.backfilled_through as string).getTime() : null;
  const backfillComplete = backfilledThroughMs !== null && backfilledThroughMs <= floorMs;

  // A mailbox that hasn't finished its 12-month backfill gets backfill passes
  // FIRST — even under the regular incremental cron — then settles into
  // incremental. So a newly connected team member is seeded with 12 months of
  // history automatically on its first runs; no special connect-flow wiring.
  // (An explicit mode:'backfill' request always backfills, for manual drivers.)
  const effectiveMode: "incremental" | "backfill" =
    mode === "backfill" ? "backfill" : (backfillComplete ? "incremental" : "backfill");

  let q: string;
  if (effectiveMode === "backfill") {
    const upperMs = backfilledThroughMs ?? Date.now();
    if (upperMs <= floorMs) return { mailbox: token.accountEmail, done: true, scanned: 0, stored: 0 };
    q = `after:${Math.floor(floorMs / 1000)} before:${Math.floor(upperMs / 1000)} -in:chats -in:drafts`;
  } else {
    const sinceMs = stateRow?.last_scanned_at
      ? new Date(stateRow.last_scanned_at as string).getTime() - 10 * 60 * 1000 // 10-min overlap, dedupe absorbs it
      : Date.now() - 2 * 24 * 3600 * 1000;
    q = `after:${Math.floor(sinceMs / 1000)} -in:chats -in:drafts`;
  }

  // Collect message ids (newest-first) up to the per-run cap.
  const ids: string[] = [];
  let pageToken: string | undefined;
  while (ids.length < MAX_MESSAGES_PER_RUN) {
    const listJson = await gmailList(token.accessToken, q, pageToken);
    for (const m of (listJson.messages || []) as Row[]) {
      ids.push(m.id as string);
      if (ids.length >= MAX_MESSAGES_PER_RUN) break;
    }
    pageToken = listJson.nextPageToken;
    if (!pageToken) break;
  }
  const cappedOut = ids.length >= MAX_MESSAGES_PER_RUN && !!pageToken;

  // Skip messages already stored for this mailbox (dedupe across runs).
  let fresh = ids;
  if (ids.length) {
    const { data: seenRows } = await service.from("client_communications")
      .select("gmail_message_id").eq("mailbox", token.accountEmail).in("gmail_message_id", ids);
    const seen = new Set((seenRows || []).map((r: Row) => r.gmail_message_id as string));
    fresh = ids.filter((id) => !seen.has(id));
  }

  let stored = 0;
  let oldestMs = Infinity;
  for (const id of ids) {
    // Metadata first — cheap match test.
    const metaResp = await fetch(
      `${GMAIL}/messages/${id}?format=metadata` +
        "&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID",
      { headers: { Authorization: `Bearer ${token.accessToken}` } },
    );
    if (!metaResp.ok) continue;
    const meta = await metaResp.json();
    const internalMs = Number(meta.internalDate || 0);
    if (internalMs && internalMs < oldestMs) oldestMs = internalMs;

    if (!fresh.includes(id)) continue; // already stored — but still counted toward oldestMs above

    const headers: Row[] = meta?.payload?.headers || [];
    const fromRaw = headerOf(headers, "From");
    const toRaw = headerOf(headers, "To");
    const ccRaw = headerOf(headers, "Cc");
    const from = parseFrom(fromRaw);

    // Match any participant address to one or more entities.
    const participants = [...emailsIn(fromRaw), ...emailsIn(toRaw), ...emailsIn(ccRaw)];
    const entityIds = new Set<string>();
    let matchedEmail: string | null = null;
    for (const addr of participants) {
      if (addr === mailboxLc || isFirmAddress(addr)) continue; // one of ours never identifies a client
      const hit = emailMap.get(addr);
      if (hit) { for (const eid of hit) entityIds.add(eid); if (!matchedEmail) matchedEmail = addr; }
    }
    if (!entityIds.size) continue;

    // Full fetch for the body of this message only.
    const fullResp = await fetch(`${GMAIL}/messages/${id}?format=full`, { headers: { Authorization: `Bearer ${token.accessToken}` } });
    if (!fullResp.ok) continue;
    const full = await fullResp.json();
    const body = { html: "", text: "" };
    parseBody(full.payload, body);

    const occurredAt = internalMs ? new Date(internalMs).toISOString() : runStart.toISOString();
    const direction = isFirmAddress(from.email) ? "out" : "in";
    const rfcId = headerOf(headers, "Message-ID") || null;
    const subject = headerOf(headers, "Subject") || null;

    const rows = [...entityIds].map((entityId) => ({
      entity_id: entityId,
      mailbox: token.accountEmail,
      gmail_message_id: id,
      gmail_thread_id: (full.threadId as string) || (meta.threadId as string) || null,
      rfc_message_id: rfcId,
      direction,
      from_email: from.email,
      from_name: from.name,
      to_emails: emailsIn(toRaw),
      cc_emails: emailsIn(ccRaw),
      subject,
      snippet: (full.snippet as string) || (meta.snippet as string) || null,
      body_html: body.html || null,
      body_text: body.text || null,
      matched_email: matchedEmail,
      occurred_at: occurredAt,
    }));
    const { error: insErr } = await service.from("client_communications")
      .upsert(rows, { onConflict: "entity_id,mailbox,gmail_message_id", ignoreDuplicates: true });
    if (!insErr) stored += rows.length;
  }

  // Advance progress markers.
  const state: Row = { mailbox: token.accountEmail, updated_at: runStart.toISOString() };
  let done = false;
  if (effectiveMode === "backfill") {
    if (cappedOut && oldestMs !== Infinity) {
      // More to do below the oldest we saw — resume before it next run.
      state.backfilled_through = new Date(oldestMs).toISOString();
    } else {
      // Drained this window down to the floor.
      state.backfilled_through = new Date(floorMs).toISOString();
      done = true;
    }
  } else {
    state.last_scanned_at = runStart.toISOString();
  }
  await service.from("comms_ingest_state").upsert(state, { onConflict: "mailbox" });

  return { mailbox: token.accountEmail, mode: effectiveMode, scanned: ids.length, stored, done, cappedOut };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── Auth: cron secret OR portal-admin JWT ──
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

  const bodyIn = await req.json().catch(() => ({}));
  const mode: "incremental" | "backfill" = bodyIn?.mode === "backfill" ? "backfill" : "incremental";
  const onlyMailbox: string | null = bodyIn?.mailbox ? String(bodyIn.mailbox) : null;

  // Which mailboxes to scan — all active connections, or just one.
  let connQuery = service.from("gmail_connections").select("account_email").eq("status", "active");
  if (onlyMailbox) connQuery = connQuery.ilike("account_email", onlyMailbox.replace(/[%_]/g, ""));
  const { data: conns } = await connQuery;
  const mailboxes = [...new Set((conns || []).map((c: Row) => c.account_email as string))];
  if (!mailboxes.length) return json({ success: true, skipped: true, reason: "No active Gmail connections" });

  const emailMap = await buildEmailMap(service);

  const results: Row[] = [];
  for (const mb of mailboxes) {
    try {
      results.push(await processMailbox(service, emailMap, mb, mode));
    } catch (e) {
      results.push({ mailbox: mb, error: (e as Error).message });
    }
  }

  const allDone = mode === "backfill" && results.every((r) => r.done || r.skipped);
  return json({
    success: true,
    mode,
    mappedAddresses: emailMap.size,
    stored: results.reduce((s, r) => s + (Number(r.stored) || 0), 0),
    done: allDone,
    results,
  });
});
