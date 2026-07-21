// Shared helpers for the Gmail edge functions.
// OAuth pattern mirrors qbo-client.ts — refresh access tokens when
// they're within 5 minutes of expiry, surface errors back to the
// gmail_connections row so the UI can show an "auth broken" banner.
//
// Multi-mailbox (COMMS_INTEGRATIONS.md Option A): gmail_connections holds one
// row per mailbox. getValidGmailToken(mailbox?) targets a specific address;
// with no argument it uses the practice-default row, so the existing senders
// (reminders-send, chase-reply-scan, gmail-create-draft) behave as before.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
export const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
export const GMAIL_REDIRECT_URI = `${SUPABASE_URL}/functions/v1/gmail-auth-callback`;

// gmail.modify: read the inbox (chase-reply-scan), create drafts (uplift
// emails), SEND (client reminders go out as genuine Gmail messages), and
// archive processed messages (remove the INBOX label) — everything except
// permanent deletion. contacts(.other).readonly: the Communications
// module syncs Google Contacts for composer autocomplete + SMS/WhatsApp
// name matching (comms-contacts-sync). Scope additions mean existing
// mailboxes must reconnect once to re-consent.
export const GMAIL_SCOPE = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "openid",
  "email",
].join(" ");

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function getServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

export function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

export interface GmailTokenInfo {
  accessToken: string;
  accountEmail: string;
  connectionId: string;
  kind: string;
  ownerStaffId: string | null;
  scope: string | null;
}

// Resolves a mailbox's active gmail_connections row and refreshes the
// access token if it's about to expire. mailbox = account email address;
// omitted → the practice-default row (legacy single-mailbox behaviour).
// Throws if no usable connection exists — callers should catch and surface.
export async function getValidGmailToken(mailbox?: string): Promise<GmailTokenInfo> {
  const sb = getServiceClient();

  let query = sb.from("gmail_connections").select("*").eq("status", "active");
  if (mailbox) {
    // ilike with no wildcards = case-insensitive equality.
    query = query.ilike("account_email", mailbox.replace(/[%_]/g, ""));
  } else {
    query = query.eq("is_practice_default", true);
  }
  let { data: conn, error } = await query.maybeSingle();
  if (error) throw new Error(`gmail_connections lookup failed: ${error.message}`);

  // Fallback for a default request when no row carries the flag yet.
  if (!conn && !mailbox) {
    const { data: rows } = await sb.from("gmail_connections").select("*")
      .eq("status", "active").order("connected_at", { ascending: true }).limit(1);
    conn = rows?.[0] || null;
  }
  if (!conn) {
    throw new Error(mailbox
      ? `No active Gmail connection for ${mailbox}. Connect it in Communications.`
      : "No active Gmail connection. Sign in via the connection panel first.");
  }

  const info = (c: Record<string, unknown>, accessToken: string): GmailTokenInfo => ({
    accessToken,
    accountEmail: c.account_email as string,
    connectionId: c.id as string,
    kind: (c.kind as string) || "shared",
    ownerStaffId: (c.owner_staff_id as string) || null,
    scope: (c.scope as string) || null,
  });

  const expiresAt = new Date(conn.token_expires_at);
  const now = new Date();
  const fiveMinutes = 5 * 60 * 1000;
  if (expiresAt.getTime() - now.getTime() > fiveMinutes) {
    return info(conn, conn.access_token);
  }

  // Refresh.
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: conn.refresh_token,
    }),
  });
  if (!resp.ok) {
    const errBody = await resp.text();
    await sb.from("gmail_connections").update({
      status: "error",
      error_message: `Token refresh failed: ${resp.status} ${errBody}`,
      updated_at: new Date().toISOString(),
    }).eq("id", conn.id);
    throw new Error(`Gmail token refresh failed: ${resp.status} ${errBody}`);
  }
  const tokens = await resp.json();
  const newExpiry = new Date(Date.now() + tokens.expires_in * 1000);
  await sb.from("gmail_connections").update({
    access_token: tokens.access_token,
    token_expires_at: newExpiry.toISOString(),
    last_refreshed_at: new Date().toISOString(),
    status: "active",
    error_message: null,
    updated_at: new Date().toISOString(),
  }).eq("id", conn.id);

  return info(conn, tokens.access_token);
}

// Base64url, used for both the MIME body and the OAuth state.
export function base64UrlEncode(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
