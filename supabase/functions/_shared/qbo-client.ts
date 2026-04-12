import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const QBO_CLIENT_ID = Deno.env.get("QBO_CLIENT_ID")!;
const QBO_CLIENT_SECRET = Deno.env.get("QBO_CLIENT_SECRET")!;
const QBO_API_BASE = Deno.env.get("QBO_API_BASE") || "https://quickbooks.api.intuit.com";
const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

// Service-role Supabase client for secure DB access
export function getServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

// Get a valid access token, refreshing if needed
export async function getValidToken(): Promise<{ accessToken: string; realmId: string }> {
  const sb = getServiceClient();

  const { data: conn, error } = await sb
    .from("qbo_connections")
    .select("*")
    .eq("status", "active")
    .single();

  if (error || !conn) {
    throw new Error("No active QBO connection found. Please connect to QuickBooks first.");
  }

  const expiresAt = new Date(conn.token_expires_at);
  const now = new Date();
  const fiveMinutes = 5 * 60 * 1000;

  // Refresh if within 5 minutes of expiry
  if (expiresAt.getTime() - now.getTime() < fiveMinutes) {
    const refreshed = await refreshToken(sb, conn);
    return { accessToken: refreshed.access_token, realmId: conn.realm_id };
  }

  return { accessToken: conn.access_token, realmId: conn.realm_id };
}

// Refresh the OAuth token
async function refreshToken(sb: ReturnType<typeof createClient>, conn: Record<string, unknown>) {
  const basicAuth = btoa(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`);

  const resp = await fetch(QBO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: conn.refresh_token as string,
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    // Mark connection as error
    await sb.from("qbo_connections").update({
      status: "error",
      error_message: `Token refresh failed: ${resp.status} ${errBody}`,
      updated_at: new Date().toISOString(),
    }).eq("id", conn.id);
    throw new Error(`QBO token refresh failed: ${resp.status}`);
  }

  const tokens = await resp.json();
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  const refreshExpiresAt = tokens.x_refresh_token_expires_in
    ? new Date(Date.now() + tokens.x_refresh_token_expires_in * 1000)
    : null;

  await sb.from("qbo_connections").update({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_expires_at: expiresAt.toISOString(),
    refresh_token_expires_at: refreshExpiresAt?.toISOString() || conn.refresh_token_expires_at,
    last_refreshed_at: new Date().toISOString(),
    status: "active",
    error_message: null,
    updated_at: new Date().toISOString(),
  }).eq("id", conn.id);

  return tokens;
}

// Make a QBO API call with automatic auth
export async function qboFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const { accessToken, realmId } = await getValidToken();
  const url = `${QBO_API_BASE}/v3/company/${realmId}/${path}`;

  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set("Accept", "application/json");
  if (options.body) {
    headers.set("Content-Type", "application/json");
  }

  const resp = await fetch(url, { ...options, headers });

  // If 401, try one token refresh and retry
  if (resp.status === 401) {
    const sb = getServiceClient();
    const { data: conn } = await sb.from("qbo_connections").select("*").eq("status", "active").single();
    if (conn) {
      await refreshToken(sb, conn);
      const { accessToken: newToken } = await getValidToken();
      headers.set("Authorization", `Bearer ${newToken}`);
      return fetch(url, { ...options, headers });
    }
  }

  return resp;
}

// QBO query helper
export async function qboQuery(query: string): Promise<unknown> {
  const resp = await qboFetch(`query?query=${encodeURIComponent(query)}`);
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`QBO query failed: ${resp.status} ${err}`);
  }
  return resp.json();
}

// Log a sync operation
export async function logSync(entry: {
  direction: "push" | "pull";
  entity_id?: string;
  entity_name?: string;
  qbo_entity_type?: string;
  qbo_entity_id?: string;
  status: "pending" | "success" | "error" | "skipped";
  detail?: Record<string, unknown>;
  error_message?: string;
  initiated_by?: string;
}) {
  const sb = getServiceClient();
  await sb.from("qbo_sync_log").insert(entry);
}

// Standard JSON response helper
export function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  });
}

// CORS preflight handler
export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}
