// Shared helpers for the three Gmail edge functions.
// OAuth pattern mirrors qbo-client.ts — refresh access tokens when
// they're within 5 minutes of expiry, surface errors back to the
// gmail_connections row so the UI can show an "auth broken" banner.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
export const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
export const GMAIL_REDIRECT_URI = `${SUPABASE_URL}/functions/v1/gmail-auth-callback`;

// Compose (draft creation) + read-only (the chase-reply-scan poller matches
// inbound replies against open chases — it never modifies mailbox state).
// We never send on the user's behalf. Adding readonly means reconnecting the
// account re-consents with both scopes.
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.readonly openid email";

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

// Pulls the single active gmail_connections row and refreshes the
// access token if it's about to expire. Throws if no connection
// exists or the refresh fails — callers should catch and surface.
export async function getValidGmailToken(): Promise<{ accessToken: string; accountEmail: string; connectionId: string }> {
  const sb = getServiceClient();
  const { data: conn, error } = await sb
    .from("gmail_connections")
    .select("*")
    .eq("status", "active")
    .maybeSingle();
  if (error) throw new Error(`gmail_connections lookup failed: ${error.message}`);
  if (!conn) throw new Error("No active Gmail connection. Sign in via the connection panel first.");

  const expiresAt = new Date(conn.token_expires_at);
  const now = new Date();
  const fiveMinutes = 5 * 60 * 1000;
  if (expiresAt.getTime() - now.getTime() > fiveMinutes) {
    return { accessToken: conn.access_token, accountEmail: conn.account_email, connectionId: conn.id };
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

  return { accessToken: tokens.access_token, accountEmail: conn.account_email, connectionId: conn.id };
}

// Base64url, used for both the MIME body and the OAuth state.
export function base64UrlEncode(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
