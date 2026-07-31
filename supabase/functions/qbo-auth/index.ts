import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Self-contained (inlines getServiceClient/jsonResponse/corsHeaders) so it
// deploys as a single file — no _shared bundling. verify_jwt is FALSE: this is
// an OAuth redirect endpoint hit by the browser and Intuit without a JWT.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const QBO_CLIENT_ID = Deno.env.get("QBO_CLIENT_ID")!;
const QBO_CLIENT_SECRET = Deno.env.get("QBO_CLIENT_SECRET")!;
const QBO_REDIRECT_URI = Deno.env.get("QBO_REDIRECT_URI")!;
const PORTAL_URL = Deno.env.get("PORTAL_URL") || "https://portal.almondvalleyaccounting.co.uk";
const QBO_AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const APPS_SCRIPT_URL = Deno.env.get("APPS_SCRIPT_REPORT_URL") || "";
const PORTAL_SYNC_SECRET = Deno.env.get("PORTAL_SYNC_SECRET") || "";

function getServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}
function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// Only allow same-app relative return paths (defends against open redirect).
function safeReturnTo(rt: string | null | undefined): string | null {
  if (rt && rt.startsWith("/") && !rt.startsWith("//")) return rt;
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  try {
    if (action === "authorize") return handleAuthorize(url);
    if (action === "callback") return await handleCallback(url);
    if (action === "disconnect") return await handleDisconnect(req);
    return jsonResponse({ success: false, error: "Invalid action. Use: authorize, callback, or disconnect" }, 400);
  } catch (err) {
    console.error("qbo-auth error:", err);
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});

function handleAuthorize(url: URL) {
  const userId = url.searchParams.get("user_id") || "";
  const purpose = url.searchParams.get("purpose") || "billing";
  const returnTo = url.searchParams.get("return_to") || "";

  // Carry user ID, purpose and return path through the OAuth round-trip.
  const state = btoa(JSON.stringify({ user_id: userId, purpose, return_to: returnTo, ts: Date.now() }));

  const params = new URLSearchParams({
    client_id: QBO_CLIENT_ID,
    response_type: "code",
    scope: "com.intuit.quickbooks.accounting",
    redirect_uri: QBO_REDIRECT_URI,
    state,
  });

  return new Response(null, { status: 302, headers: { Location: `${QBO_AUTH_URL}?${params.toString()}` } });
}

async function handleCallback(url: URL) {
  const code = url.searchParams.get("code");
  const realmId = url.searchParams.get("realmId");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // Parse state FIRST — the redirect base depends on it (avoids a TDZ error on
  // the early denial/missing-code paths).
  let userId: string | null = null;
  let purpose = "billing";
  let returnTo = "";
  if (state) {
    try {
      const parsed = JSON.parse(atob(state));
      userId = parsed.user_id || null;
      purpose = parsed.purpose || "billing";
      returnTo = parsed.return_to || "";
    } catch { /* ignore */ }
  }

  const isReports = purpose === "reports";
  // A dashboard-initiated connect passes return_to=/client-dashboard so we land
  // back where we started; otherwise fall back to the purpose default.
  const base = safeReturnTo(returnTo) || (isReports ? "/reports" : "/manage/billing");

  if (error) {
    return redirect(`${PORTAL_URL}${base}?qbo=error&message=${encodeURIComponent(error)}`);
  }
  if (!code || !realmId) {
    return redirect(`${PORTAL_URL}${base}?qbo=error&message=Missing+code+or+realmId`);
  }

  // Exchange authorization code for tokens
  const basicAuth = btoa(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`);
  const tokenResp = await fetch(QBO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: QBO_REDIRECT_URI }),
  });

  if (!tokenResp.ok) {
    const errBody = await tokenResp.text();
    console.error("Token exchange failed:", errBody);
    return redirect(`${PORTAL_URL}${base}?qbo=error&message=Token+exchange+failed`);
  }

  const tokens = await tokenResp.json();
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  const refreshExpiresAt = tokens.x_refresh_token_expires_in
    ? new Date(Date.now() + tokens.x_refresh_token_expires_in * 1000)
    : null;

  // Company name
  let companyName = null;
  try {
    const apiBase = Deno.env.get("QBO_API_BASE") || "https://quickbooks.api.intuit.com";
    const companyResp = await fetch(`${apiBase}/v3/company/${realmId}/companyinfo/${realmId}`, {
      headers: { "Authorization": `Bearer ${tokens.access_token}`, "Accept": "application/json" },
    });
    if (companyResp.ok) {
      const companyData = await companyResp.json();
      companyName = companyData?.CompanyInfo?.CompanyName || null;
    }
  } catch { /* non-critical */ }

  const sb = getServiceClient();

  if (isReports) {
    // ── Reports/Dashboard mode ──
    // Metadata row (staff-readable list shared by Reports + Client Dashboard).
    const { error: upsertErr } = await sb.from("qbo_report_connections").upsert(
      {
        realm_id: realmId,
        company_name: companyName || `QBO Company ${realmId}`,
        connected_by: userId || null,
        connected_at: new Date().toISOString(),
        status: "active",
      },
      { onConflict: "realm_id" },
    );
    if (upsertErr) {
      console.error("Failed to store report connection:", upsertErr);
      return redirect(`${PORTAL_URL}${base}?qbo=error&message=Failed+to+store+connection`);
    }

    // Tokens go in a SEPARATE, service-role-only table (qbo_report_tokens) —
    // NEVER qbo_report_connections, which is staff-readable. This is what lets
    // dashboard-qbo-pull read live data for this client (no Apps Script bridge).
    const { error: tokenErr } = await sb.from("qbo_report_tokens").upsert(
      {
        realm_id: realmId,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: expiresAt.toISOString(),
        refresh_token_expires_at: refreshExpiresAt?.toISOString() || null,
        scope: tokens.scope || "com.intuit.quickbooks.accounting",
        status: "active",
        error_message: null,
        connected_by: userId || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "realm_id" },
    );
    if (tokenErr) console.error("Failed to store report tokens:", tokenErr);

    // Sync tokens to the Apps Script Clients tab (legacy Reports pull path).
    if (APPS_SCRIPT_URL && PORTAL_SYNC_SECRET) {
      try {
        const syncResp = await fetch(APPS_SCRIPT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "sync_tokens",
            auth: `Bearer ${PORTAL_SYNC_SECRET}`,
            realmId,
            clientName: companyName || `QBO Company ${realmId}`,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
          }),
          redirect: "follow",
        });
        console.log("Token sync to Apps Script:", syncResp.status, await syncResp.text());
      } catch (syncErr) {
        console.error("Token sync to Apps Script failed:", syncErr);
      }
    }

    return redirect(`${PORTAL_URL}${base}?qbo=connected`);
  }

  // ── Billing mode: full token storage (existing behaviour) ──
  // Reconnecting supersedes the old row rather than updating it, so the
  // per-realm billing settings have to be carried across by hand. They are
  // not re-enterable anywhere in the UI, and losing the tax code silently
  // breaks every push (QBO rejects the invoice with "error while calculating
  // tax" once the code falls back to a guess). Read before superseding.
  const { data: prior } = await sb
    .from("qbo_connections")
    .select("default_tax_code_id, default_tax_code_name, default_due_date_offset_days")
    .eq("realm_id", realmId)
    .not("default_tax_code_id", "is", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  await sb.from("qbo_connections").update({
    status: "disconnected",
    updated_at: new Date().toISOString(),
  }).eq("status", "active");

  const { error: insertErr } = await sb.from("qbo_connections").insert({
    realm_id: realmId,
    company_name: companyName,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_expires_at: expiresAt.toISOString(),
    refresh_token_expires_at: refreshExpiresAt?.toISOString() || null,
    scope: tokens.scope || "com.intuit.quickbooks.accounting",
    connected_by: userId || null,
    status: "active",
    default_tax_code_id: prior?.default_tax_code_id ?? null,
    default_tax_code_name: prior?.default_tax_code_name ?? null,
    default_due_date_offset_days: prior?.default_due_date_offset_days ?? 14,
  });
  if (insertErr) {
    console.error("Failed to store QBO connection:", insertErr);
    return redirect(`${PORTAL_URL}${base}?qbo=error&message=Failed+to+store+connection`);
  }

  // audit_log's actor column is user_id — "performed_by" silently failed the
  // insert, which is why the 2026-07-21 reconnect left no audit trail.
  await sb.from("audit_log").insert({
    action: "qbo_connected",
    entity_type: "qbo_connection",
    detail: { realm_id: realmId, company_name: companyName },
    user_id: userId || null,
  });

  return redirect(`${PORTAL_URL}${base}?qbo=connected`);
}

function redirect(location: string) {
  return new Response(null, { status: 302, headers: { Location: location } });
}

async function handleDisconnect(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

  const sb = getServiceClient();
  const { error } = await sb.from("qbo_connections").update({
    status: "disconnected",
    updated_at: new Date().toISOString(),
  }).eq("status", "active");

  if (error) return jsonResponse({ success: false, error: "Failed to disconnect" }, 500);
  return jsonResponse({ success: true, message: "Disconnected from QuickBooks" });
}
