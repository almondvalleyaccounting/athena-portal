// comms-contacts-sync — Athena Portal
// Pulls Google Contacts (People API) for a connected mailbox into
// comms_contacts, for composer autocomplete and SMS/WhatsApp name
// matching. Syncs both saved contacts (people/me/connections) and
// Gmail's auto-collected "other contacts".
//
// Body: { mailbox: string }
// Auth: staff JWT; personal mailboxes owner-only (portal-admin override),
// same rules as comms-gmail. Requires the contacts scopes — mailboxes
// connected before the scope upgrade get code 'needs_reconnect'; a
// disabled People API in the Google Cloud project gets 'api_disabled'.
//
// Full-replace semantics per sync: rows upserted, then anything from a
// previous sync for this connection is deleted (contacts removed in
// Google disappear here too).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getValidGmailToken, jsonResponse, corsHeaders, getServiceClient } from "../_shared/gmail-client.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const PEOPLE = "https://people.googleapis.com/v1";

function digitsSuffix(raw: string, n = 9): string {
  const d = String(raw || "").replace(/\D/g, "");
  return d.slice(-n);
}

type ContactRow = {
  connection_id: string;
  resource_name: string;
  display_name: string | null;
  emails: string[];
  phones: string[];
  phone_suffixes: string[];
  organisation: string | null;
  synced_at: string;
};

function toRow(connectionId: string, syncedAt: string, p: any): ContactRow | null {
  const displayName = p.names?.[0]?.displayName || null;
  const emails = [...new Set((p.emailAddresses || []).map((e: any) => String(e.value || "").trim().toLowerCase()).filter(Boolean))] as string[];
  const phones = [...new Set((p.phoneNumbers || []).map((ph: any) => String(ph.value || "").trim()).filter(Boolean))] as string[];
  if (!displayName && !emails.length && !phones.length) return null;
  return {
    connection_id: connectionId,
    resource_name: p.resourceName,
    display_name: displayName,
    emails,
    phones,
    phone_suffixes: [...new Set(phones.map((ph) => digitsSuffix(ph)).filter((s) => s.length >= 7))],
    organisation: p.organizations?.[0]?.name || null,
    synced_at: syncedAt,
  };
}

async function fetchAll(accessToken: string, path: string, listKey: string, params: Record<string, string>) {
  const out: any[] = [];
  let pageToken = "";
  for (let page = 0; page < 30; page++) {
    const qs = new URLSearchParams({ ...params, pageSize: "1000", ...(pageToken ? { pageToken } : {}) });
    const resp = await fetch(`${PEOPLE}${path}?${qs}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) {
      const txt = await resp.text();
      const err = new Error(`People API ${resp.status}: ${txt.slice(0, 500)}`) as Error & { status?: number; body?: string };
      err.status = resp.status;
      err.body = txt;
      throw err;
    }
    const data = await resp.json();
    out.push(...(data[listKey] || []));
    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ success: false, error: "POST required" }, 405);

  // Staff auth (mirrors comms-gmail).
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ success: false, error: "Missing authorization" }, 401);
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: authErr } = await anon.auth.getUser();
  if (authErr || !user) return jsonResponse({ success: false, error: "Invalid token" }, 401);
  const service = getServiceClient();
  const { data: prof } = await service.from("staff_profiles")
    .select("id, is_active, is_portal_admin").eq("id", user.id).single();
  if (!prof?.is_active) return jsonResponse({ success: false, error: "Not authorised" }, 403);

  const body = await req.json().catch(() => ({}));
  const mailbox = String(body.mailbox || "").trim().toLowerCase();
  if (!mailbox) return jsonResponse({ success: false, error: "mailbox required" }, 400);

  let tok;
  try {
    tok = await getValidGmailToken(mailbox);
  } catch (e) {
    return jsonResponse({ success: false, error: (e as Error).message, code: "no_gmail_connection" }, 400);
  }
  if (tok.kind === "personal" && tok.ownerStaffId !== user.id && !prof.is_portal_admin) {
    return jsonResponse({ success: false, error: "This is a personal mailbox." }, 403);
  }
  if (!(tok.scope || "").includes("contacts.readonly")) {
    return jsonResponse({
      success: false, code: "needs_reconnect",
      error: "This mailbox was connected before contacts access was added — reconnect it once to grant it.",
    }, 400);
  }

  const syncedAt = new Date().toISOString();
  let people: any[] = [];
  let others: any[] = [];
  try {
    people = await fetchAll(tok.accessToken, "/people/me/connections", "connections", {
      personFields: "names,emailAddresses,phoneNumbers,organizations",
    });
    others = await fetchAll(tok.accessToken, "/otherContacts", "otherContacts", {
      readMask: "names,emailAddresses,phoneNumbers",
    });
  } catch (e) {
    const err = e as Error & { status?: number; body?: string };
    if (err.status === 403 && (err.body || "").includes("SERVICE_DISABLED")) {
      return jsonResponse({
        success: false, code: "api_disabled",
        error: "The People API isn't enabled in the Google Cloud project — enable it at console.cloud.google.com → APIs & Services, then retry.",
      }, 502);
    }
    if (err.status === 403) {
      return jsonResponse({
        success: false, code: "needs_reconnect",
        error: `Google refused contacts access (${err.message}). Reconnecting the mailbox usually fixes this.`,
      }, 502);
    }
    return jsonResponse({ success: false, error: err.message }, 502);
  }

  const rows = [...people, ...others]
    .map((p) => toRow(tok.connectionId, syncedAt, p))
    .filter(Boolean) as ContactRow[];

  // Upsert in chunks, then remove rows this sync didn't touch.
  for (let i = 0; i < rows.length; i += 500) {
    const { error: upErr } = await service.from("comms_contacts")
      .upsert(rows.slice(i, i + 500), { onConflict: "connection_id,resource_name" });
    if (upErr) return jsonResponse({ success: false, error: `Store failed: ${upErr.message}` }, 500);
  }
  await service.from("comms_contacts")
    .delete().eq("connection_id", tok.connectionId).lt("synced_at", syncedAt);

  return jsonResponse({
    success: true,
    contacts: people.length,
    other_contacts: others.length,
    stored: rows.length,
    mailbox: tok.accountEmail,
  });
});
