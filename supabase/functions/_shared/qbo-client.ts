import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { failureUpdate, refreshWithRetry } from "./oauth-refresh.ts";

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

type SupaClient = ReturnType<typeof createClient>;

// A token-bearing row + which table it came from (so we refresh/write back
// to the right place). Billing tokens live in `qbo_connections` (keyed by id,
// one active row); per-client dashboard/report tokens live in
// `qbo_report_tokens` (keyed by realm_id).
type TokenSource = {
  table: "qbo_connections" | "qbo_report_tokens";
  keyCol: "id" | "realm_id";
  conn: Record<string, unknown> & {
    realm_id: string;
    access_token: string;
    refresh_token: string;
    token_expires_at: string;
    refresh_token_expires_at?: string | null;
    id?: string;
  };
};

// Resolve where a realm's tokens live.
//  - No realmId  → the single active billing connection (existing behaviour).
//  - With realmId → prefer qbo_report_tokens; fall back to a billing connection
//    on the same realm (lets AVA's own books work before any reconnect).
async function resolveTokenSource(sb: SupaClient, realmId?: string): Promise<TokenSource> {
  if (!realmId) {
    const { data, error } = await sb
      .from("qbo_connections")
      .select("*")
      .eq("status", "active")
      .single();
    if (error || !data) {
      throw new Error("No active QBO connection found. Please connect to QuickBooks first.");
    }
    return { table: "qbo_connections", keyCol: "id", conn: data as TokenSource["conn"] };
  }

  const { data: rt } = await sb
    .from("qbo_report_tokens")
    .select("*")
    .eq("realm_id", realmId)
    .maybeSingle();
  if (rt && (rt as Record<string, unknown>).refresh_token) {
    return { table: "qbo_report_tokens", keyCol: "realm_id", conn: rt as TokenSource["conn"] };
  }

  const { data: bc } = await sb
    .from("qbo_connections")
    .select("*")
    .eq("realm_id", realmId)
    .eq("status", "active")
    .maybeSingle();
  if (bc) {
    return { table: "qbo_connections", keyCol: "id", conn: bc as TokenSource["conn"] };
  }

  throw new Error(
    `No stored QBO tokens for realm ${realmId}. The client needs to reconnect QuickBooks.`,
  );
}

// Get a valid access token, refreshing if within 5 min of expiry.
// Pass a realmId to target a specific client; omit for the billing connection.
export async function getValidToken(realmId?: string): Promise<{ accessToken: string; realmId: string }> {
  const sb = getServiceClient();
  const src = await resolveTokenSource(sb, realmId);

  const expiresAt = new Date(src.conn.token_expires_at);
  const now = new Date();
  const fiveMinutes = 5 * 60 * 1000;

  if (expiresAt.getTime() - now.getTime() < fiveMinutes) {
    const refreshed = await refreshToken(sb, src);
    return { accessToken: refreshed.access_token, realmId: src.conn.realm_id };
  }

  return { accessToken: src.conn.access_token, realmId: src.conn.realm_id };
}

// As getValidToken, but hands back the refresh token too — for the one caller
// that has to mirror the live pair somewhere else (the Apps Script report
// runner keeps its own copy in a spreadsheet). Intuit rotates the refresh
// token on every refresh, so any mirror has to be re-pushed each time or it
// silently rots. Pass a wider marginMs when the token has to stay usable for
// the length of a long job, not just the length of one API call.
export async function getValidTokenPair(
  realmId: string,
  marginMs = 5 * 60 * 1000,
): Promise<{ accessToken: string; refreshToken: string; realmId: string; expiresAt: string }> {
  const sb = getServiceClient();
  const src = await resolveTokenSource(sb, realmId);

  const expiresAt = new Date(src.conn.token_expires_at);
  if (expiresAt.getTime() - Date.now() < marginMs) {
    const tokens = await refreshToken(sb, src);
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      realmId: src.conn.realm_id,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    };
  }

  return {
    accessToken: src.conn.access_token,
    refreshToken: src.conn.refresh_token,
    realmId: src.conn.realm_id,
    expiresAt: src.conn.token_expires_at,
  };
}

// Refresh the OAuth token, writing new tokens back to whichever table they came from.
async function refreshToken(sb: SupaClient, src: TokenSource) {
  const { table, keyCol, conn } = src;
  const basicAuth = btoa(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`);

  // Same rule as Gmail: a 5xx or a dropped connection is retried and leaves the
  // realm connected, so the next run picks it up. Only a dead grant sets
  // status='error', because only that needs a human. See _shared/oauth-refresh.ts.
  const outcome = await refreshWithRetry(
    QBO_TOKEN_URL,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: conn.refresh_token,
    }),
    { "Authorization": `Basic ${basicAuth}`, "Accept": "application/json" },
  );

  const keyVal = conn[keyCol] as string;

  if (!outcome.ok) {
    await sb.from(table).update(failureUpdate(outcome)).eq(keyCol, keyVal);
    throw new Error(
      `QBO token refresh failed after ${outcome.attempts} attempt(s): ${outcome.status}` +
      (outcome.permanent ? " — reconnect required" : " — transient, will retry"),
    );
  }

  const tokens = outcome.tokens as Record<string, any>;
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  const refreshExpiresAt = tokens.x_refresh_token_expires_in
    ? new Date(Date.now() + tokens.x_refresh_token_expires_in * 1000)
    : null;

  await sb.from(table).update({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_expires_at: expiresAt.toISOString(),
    refresh_token_expires_at: refreshExpiresAt?.toISOString() || conn.refresh_token_expires_at,
    last_refreshed_at: new Date().toISOString(),
    status: "active",
    error_message: null,
    updated_at: new Date().toISOString(),
  }).eq(keyCol, keyVal);

  return tokens;
}

// How long to wait on a QuickBooks READ before giving up.
//
// Intuit's gateway sits on a slow query for roughly two minutes and then
// answers 504 "stream timeout" — which is exactly what it did across billing
// and qbo-pull on 2026-09-01. Two minutes of spinner tells the reader nothing
// that thirty seconds wouldn't, and the browser has usually given up long
// before the function does, so bound the read here and turn it into a sentence.
//
// READS ONLY, and that restriction is the whole point. A write is never
// aborted: QBO may have created the invoice before the connection dropped, so
// a caller told "failed" retries and books it twice. A slow write is only
// slow; waiting is the cheaper mistake.
const QBO_READ_TIMEOUT_MS = 30_000;

/** Turn an aborted fetch into a sentence; pass anything else through. */
function qboNetworkError(e: unknown): Error {
  const name = (e as Error)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return new Error(
      `QuickBooks did not respond within ${Math.round(QBO_READ_TIMEOUT_MS / 1000)} seconds. ` +
        `It is usually busy rather than broken, and nothing was changed — try again in a minute.`,
    );
  }
  return e instanceof Error ? e : new Error(String(e));
}

// Make a QBO API call with automatic auth. Pass realmId to target a client.
export async function qboFetch(
  path: string,
  options: RequestInit = {},
  realmId?: string,
): Promise<Response> {
  const { accessToken, realmId: resolvedRealm } = await getValidToken(realmId);
  const url = `${QBO_API_BASE}/v3/company/${resolvedRealm}/${path}`;

  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set("Accept", "application/json");
  if (options.body) {
    headers.set("Content-Type", "application/json");
  }

  // A caller that brought its own signal keeps it. Otherwise reads get the
  // timeout above and writes get none — see QBO_READ_TIMEOUT_MS.
  const isWrite = !!options.body;
  const readSignal = () =>
    options.signal ?? (isWrite ? undefined : AbortSignal.timeout(QBO_READ_TIMEOUT_MS));

  let resp: Response;
  try {
    resp = await fetch(url, { ...options, headers, signal: readSignal() });
  } catch (e) {
    throw qboNetworkError(e);
  }

  // If 401, try one token refresh and retry
  if (resp.status === 401) {
    const sb = getServiceClient();
    try {
      const src = await resolveTokenSource(sb, realmId);
      await refreshToken(sb, src);
      const { accessToken: newToken } = await getValidToken(realmId);
      headers.set("Authorization", `Bearer ${newToken}`);
      // A fresh signal: the first one may already have burned part of its budget.
      return await fetch(url, { ...options, headers, signal: readSignal() });
    } catch (e) {
      // A timeout on the retry is worth reporting; a failed refresh is not —
      // returning the original 401 is what lets the caller say "reconnect".
      if ((e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError") {
        throw qboNetworkError(e);
      }
      return resp;
    }
  }

  return resp;
}

// QBO query helper. Pass realmId to target a client.
export async function qboQuery(query: string, realmId?: string): Promise<unknown> {
  const resp = await qboFetch(`query?query=${encodeURIComponent(query)}&minorversion=75`, {}, realmId);
  if (!resp.ok) {
    const err = await resp.text();
    // 502/503/504 is Intuit's own gateway giving up, not anything wrong with
    // the query or the connection. Say that, because "QBO query failed: 504
    // stream timeout" reads like an Athena bug and sends people to look in
    // entirely the wrong place.
    if (resp.status >= 502 && resp.status <= 504) {
      throw new Error(
        `QuickBooks is not responding right now (Intuit returned ${resp.status}). ` +
          `Nothing was changed — try again in a minute.`,
      );
    }
    throw new Error(`QBO query failed: ${resp.status} ${err}`);
  }
  return resp.json();
}

// Unwrap the transaction out of a RecurringTransaction response body.
//
// The two QBO endpoints do NOT agree on the envelope, and the difference is
// silent rather than an error:
//
//   query  SELECT * FROM RecurringTransaction
//          → QueryResponse.RecurringTransaction[] = [ { Invoice: {...} }, … ]
//   read   GET recurringtransaction/{id}
//          → { RecurringTransaction: { Invoice: {...} } }
//
// Reading `body.Invoice` off the second one yields undefined. Three call sites
// assumed the query shape for the read, and each failed quietly in its own way:
// qbo-fetch-template-meta wrote qbo_next_run_date = null for every template and
// returned success (0 of 146 rows carried a next run date), and
// qbo-push-recurring threw "missing Invoice/SalesReceipt" on every staged
// uplift. Accept either shape here so nobody has to remember which is which.
export function recurringInner(
  body: Record<string, unknown> | null | undefined,
): { key: "Invoice" | "SalesReceipt"; txn: Record<string, unknown> } | null {
  if (!body) return null;
  const wrapper = (body.RecurringTransaction as Record<string, unknown> | undefined) ?? body;
  for (const key of ["Invoice", "SalesReceipt"] as const) {
    const txn = wrapper[key] as Record<string, unknown> | undefined;
    if (txn) return { key, txn };
  }
  return null;
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
