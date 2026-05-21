// gmail-auth-callback — Athena Portal
// Google redirects here with ?code=…&state=… after the user grants
// consent. We exchange the code for tokens, fetch the user's email
// via the OpenID userinfo endpoint, and upsert the single
// gmail_connections row. Then 302 the user back to the portal.
import {
  GOOGLE_TOKEN_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GMAIL_REDIRECT_URI, GMAIL_SCOPE,
  getServiceClient, corsHeaders,
} from "../_shared/gmail-client.ts";

const PORTAL_BASE = Deno.env.get("PORTAL_BASE_URL") || "https://portal.almondvalleyaccounting.co.uk";

function htmlResponse(body: string, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders } });
}

function errPage(message: string, status = 400) {
  return htmlResponse(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:32px;color:#0f172a"><h1 style="font-weight:500">Gmail connection failed</h1><p>${message.replace(/</g, "&lt;")}</p><p><a href="${PORTAL_BASE}/manage/billing/uplifts">Back to Push uplifts</a></p></body></html>`, status);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) return errPage(`Google returned: ${error}`);
  if (!code) return errPage("Missing authorisation code on callback.");

  // Decode state (best-effort — failures don't block the connection).
  let staffId: string | null = null;
  let returnTo = "/manage/billing/uplifts";
  if (stateRaw) {
    try {
      // base64url → base64
      const padded = stateRaw.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((stateRaw.length + 3) % 4);
      const decoded = JSON.parse(atob(padded));
      if (decoded.staff_id) staffId = decoded.staff_id;
      if (decoded.return_to) returnTo = decoded.return_to;
    } catch { /* tolerate malformed state */ }
  }

  // Exchange code for tokens.
  const tokenResp = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: GMAIL_REDIRECT_URI,
    }),
  });
  if (!tokenResp.ok) {
    const txt = await tokenResp.text();
    return errPage(`Google token exchange failed: ${tokenResp.status} ${txt}`);
  }
  const tokens = await tokenResp.json();
  // tokens: { access_token, refresh_token, expires_in, scope, id_token, token_type }
  if (!tokens.refresh_token) {
    return errPage("Google did not return a refresh token. Try disconnecting at https://myaccount.google.com/permissions and re-authorising.");
  }

  // Fetch the authorising user's email via userinfo.
  const userinfoResp = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { "Authorization": `Bearer ${tokens.access_token}` },
  });
  if (!userinfoResp.ok) {
    const txt = await userinfoResp.text();
    return errPage(`userinfo failed: ${userinfoResp.status} ${txt}`);
  }
  const userinfo = await userinfoResp.json();
  const accountEmail = userinfo.email as string;
  if (!accountEmail) return errPage("userinfo returned no email.");

  const sb = getServiceClient();

  // Mark any existing active connection as revoked, then insert the new one.
  // Partial-unique index gmail_connections_one_active_idx enforces single-active.
  await sb.from("gmail_connections")
    .update({ status: "revoked", updated_at: new Date().toISOString() })
    .eq("status", "active");

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  const { error: insertErr } = await sb.from("gmail_connections").insert({
    account_email: accountEmail,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_expires_at: expiresAt.toISOString(),
    scope: tokens.scope || GMAIL_SCOPE,
    connected_by: staffId,
    connected_at: new Date().toISOString(),
    last_refreshed_at: new Date().toISOString(),
    status: "active",
  });
  if (insertErr) return errPage(`Could not store connection: ${insertErr.message}`);

  // Audit trail.
  await sb.from("audit_log").insert({
    user_id: staffId,
    action: "gmail_connection_established",
    entity_type: "gmail_connections",
    detail: { account_email: accountEmail, scope: tokens.scope },
  });

  // Redirect back to the portal.
  const dest = returnTo.startsWith("/") ? `${PORTAL_BASE}${returnTo}` : `${PORTAL_BASE}/manage/billing/uplifts`;
  return Response.redirect(`${dest}?gmail_connected=1`, 302);
});
