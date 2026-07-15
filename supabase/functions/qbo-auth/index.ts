import { getServiceClient, jsonResponse, corsHeaders } from "../_shared/qbo-client.ts";

const QBO_CLIENT_ID = Deno.env.get("QBO_CLIENT_ID")!;
const QBO_CLIENT_SECRET = Deno.env.get("QBO_CLIENT_SECRET")!;
const QBO_REDIRECT_URI = Deno.env.get("QBO_REDIRECT_URI")!;
const PORTAL_URL = Deno.env.get("PORTAL_URL") || "https://portal.almondvalleyaccounting.co.uk";
const QBO_AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const APPS_SCRIPT_URL = Deno.env.get("APPS_SCRIPT_REPORT_URL") || "";
const PORTAL_SYNC_SECRET = Deno.env.get("PORTAL_SYNC_SECRET") || "";

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  try {
    if (action === "authorize") {
      return handleAuthorize(url);
    }

    if (action === "callback") {
      return await handleCallback(url);
    }

    if (action === "disconnect") {
      return await handleDisconnect(req);
    }

    return jsonResponse({ success: false, error: "Invalid action. Use: authorize, callback, or disconnect" }, 400);
  } catch (err) {
    console.error("qbo-auth error:", err);
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});

function handleAuthorize(url: URL) {
  const userId = url.searchParams.get("user_id") || "";
  const purpose = url.searchParams.get("purpose") || "billing";

  // Build state with user ID and purpose for tracking through OAuth round-trip
  const state = btoa(JSON.stringify({ user_id: userId, purpose, ts: Date.now() }));

  const params = new URLSearchParams({
    client_id: QBO_CLIENT_ID,
    response_type: "code",
    scope: "com.intuit.quickbooks.accounting",
    redirect_uri: QBO_REDIRECT_URI,
    state,
  });

  const authUrl = `${QBO_AUTH_URL}?${params.toString()}`;

  return new Response(null, {
    status: 302,
    headers: { Location: authUrl },
  });
}

async function handleCallback(url: URL) {
  const code = url.searchParams.get("code");
  const realmId = url.searchParams.get("realmId");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // Parse state first — errorRedirectBase depends on purpose, and the
  // early error paths below need a valid base URL. Previously this was
  // read before declaration (TDZ ReferenceError on OAuth denial).
  let userId: string | null = null;
  let purpose = "billing";
  if (state) {
    try {
      const parsed = JSON.parse(atob(state));
      userId = parsed.user_id || null;
      purpose = parsed.purpose || "billing";
    } catch { /* ignore */ }
  }

  const isReports = purpose === "reports";
  const errorRedirectBase = isReports ? "/reports" : "/manage/billing";

  // Handle user denial
  if (error) {
    const redirectUrl = `${PORTAL_URL}${errorRedirectBase}?qbo=error&message=${encodeURIComponent(error)}`;
    return new Response(null, { status: 302, headers: { Location: redirectUrl } });
  }

  if (!code || !realmId) {
    const redirectUrl = `${PORTAL_URL}${errorRedirectBase}?qbo=error&message=Missing+code+or+realmId`;
    return new Response(null, { status: 302, headers: { Location: redirectUrl } });
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
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: QBO_REDIRECT_URI,
    }),
  });

  if (!tokenResp.ok) {
    const errBody = await tokenResp.text();
    console.error("Token exchange failed:", errBody);
    const redirectUrl = `${PORTAL_URL}${errorRedirectBase}?qbo=error&message=Token+exchange+failed`;
    return new Response(null, { status: 302, headers: { Location: redirectUrl } });
  }

  const tokens = await tokenResp.json();
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  const refreshExpiresAt = tokens.x_refresh_token_expires_in
    ? new Date(Date.now() + tokens.x_refresh_token_expires_in * 1000)
    : null;

  // Fetch company info from QBO
  let companyName = null;
  try {
    const apiBase = Deno.env.get("QBO_API_BASE") || "https://quickbooks.api.intuit.com";
    const companyResp = await fetch(
      `${apiBase}/v3/company/${realmId}/companyinfo/${realmId}`,
      {
        headers: {
          "Authorization": `Bearer ${tokens.access_token}`,
          "Accept": "application/json",
        },
      }
    );
    if (companyResp.ok) {
      const companyData = await companyResp.json();
      companyName = companyData?.CompanyInfo?.CompanyName || null;
    }
  } catch { /* non-critical */ }

  const sb = getServiceClient();

  if (isReports) {
    // ── Reports mode: store only realm_id + company_name (no tokens) ──
    // Upsert — if realm_id already exists, update the name and reactivate
    const { error: upsertErr } = await sb.from("qbo_report_connections").upsert(
      {
        realm_id: realmId,
        company_name: companyName || `QBO Company ${realmId}`,
        connected_by: userId || null,
        connected_at: new Date().toISOString(),
        status: "active",
      },
      { onConflict: "realm_id" }
    );

    if (upsertErr) {
      console.error("Failed to store report connection:", upsertErr);
      const redirectUrl = `${PORTAL_URL}/reports?qbo=error&message=Failed+to+store+connection`;
      return new Response(null, { status: 302, headers: { Location: redirectUrl } });
    }

    // Persist tokens for the in-app Client Dashboard. These go in a SEPARATE,
    // service-role-only table (qbo_report_tokens) — never qbo_report_connections,
    // which is staff-readable. This lets dashboard-qbo-pull read live data for
    // this client directly (no Apps Script bridge). Existing report connections
    // predate this, so they must reconnect once to capture tokens.
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

    // Sync tokens to Apps Script Clients tab so it can run reports for this client
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
        const syncResult = await syncResp.text();
        console.log("Token sync to Apps Script:", syncResp.status, syncResult);
      } catch (syncErr) {
        console.error("Token sync to Apps Script failed:", syncErr);
      }
    }

    const redirectUrl = `${PORTAL_URL}/reports?qbo=connected`;
    return new Response(null, { status: 302, headers: { Location: redirectUrl } });

  } else {
    // ── Billing mode: full token storage (existing behaviour) ──

    // Deactivate any existing connections
    await sb.from("qbo_connections").update({
      status: "disconnected",
      updated_at: new Date().toISOString(),
    }).eq("status", "active");

    // Insert new connection
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
    });

    if (insertErr) {
      console.error("Failed to store QBO connection:", insertErr);
      const redirectUrl = `${PORTAL_URL}/manage/billing?qbo=error&message=Failed+to+store+connection`;
      return new Response(null, { status: 302, headers: { Location: redirectUrl } });
    }

    // Log the connection
    await sb.from("audit_log").insert({
      action: "qbo_connected",
      entity_type: "qbo_connection",
      detail: { realm_id: realmId, company_name: companyName },
      performed_by: userId || null,
    });

    const redirectUrl = `${PORTAL_URL}/manage/billing?qbo=connected`;
    return new Response(null, { status: 302, headers: { Location: redirectUrl } });
  }
}

async function handleDisconnect(req: Request) {
  // Verify the request has a valid auth header
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return jsonResponse({ success: false, error: "Unauthorized" }, 401);
  }

  const sb = getServiceClient();

  // Mark all active connections as disconnected
  const { error } = await sb.from("qbo_connections").update({
    status: "disconnected",
    updated_at: new Date().toISOString(),
  }).eq("status", "active");

  if (error) {
    return jsonResponse({ success: false, error: "Failed to disconnect" }, 500);
  }

  return jsonResponse({ success: true, message: "Disconnected from QuickBooks" });
}
