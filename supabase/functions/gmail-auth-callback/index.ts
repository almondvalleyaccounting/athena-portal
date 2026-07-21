// gmail-auth-callback — Athena Portal
// Google redirects here with ?code=…&state=… after the user grants
// consent. We exchange the code for tokens, fetch the user's email
// via the OpenID userinfo endpoint, and upsert the mailbox's
// gmail_connections row (one row per address — COMMS_INTEGRATIONS.md
// Option A). Then 302 the user back to the portal.
import {
  GOOGLE_TOKEN_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GMAIL_REDIRECT_URI, GMAIL_SCOPE,
  getServiceClient, corsHeaders,
} from "../_shared/gmail-client.ts";

const PORTAL_BASE = Deno.env.get("PORTAL_BASE_URL") || "https://portal.almondvalleyaccounting.co.uk";

function htmlResponse(body: string, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders } });
}

function errPage(message: string, status = 400) {
  return htmlResponse(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:32px;color:#0f172a"><h1 style="font-weight:500">Gmail connection failed</h1><p>${message.replace(/</g, "&lt;")}</p><p><a href="${PORTAL_BASE}/comms/email">Back to Communications</a></p></body></html>`, status);
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
  let kind: "personal" | "shared" | null = null;
  let displayName: string | null = null;
  let setDefault = true; // legacy states carry no flags → default-mailbox connect
  if (stateRaw) {
    try {
      // base64url → base64
      const padded = stateRaw.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((stateRaw.length + 3) % 4);
      const decoded = JSON.parse(atob(padded));
      if (decoded.staff_id) staffId = decoded.staff_id;
      if (decoded.return_to) returnTo = decoded.return_to;
      if (decoded.kind === "personal" || decoded.kind === "shared") kind = decoded.kind;
      if (decoded.display_name) displayName = String(decoded.display_name).slice(0, 80);
      if (typeof decoded.set_default === "boolean") setDefault = decoded.set_default;
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
  const accountEmail = (userinfo.email as string || "").toLowerCase();
  if (!accountEmail) return errPage("userinfo returned no email.");

  const sb = getServiceClient();

  // One row per mailbox address: reuse the address's existing row if there is
  // one (prefer an active row, else the most recent), otherwise insert.
  // Identity fields (kind/owner) are only set on insert — a re-consent must
  // never flip a shared mailbox to personal or vice versa.
  const { data: activeRow } = await sb.from("gmail_connections").select("id, kind, display_name, is_practice_default")
    .eq("status", "active").ilike("account_email", accountEmail).maybeSingle();
  let existing = activeRow;
  if (!existing) {
    const { data: oldRows } = await sb.from("gmail_connections").select("id, kind, display_name, is_practice_default")
      .ilike("account_email", accountEmail).order("connected_at", { ascending: false }).limit(1);
    existing = oldRows?.[0] || null;
  }

  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  const tokenFields = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_expires_at: expiresAt.toISOString(),
    scope: tokens.scope || GMAIL_SCOPE,
    connected_by: staffId,
    connected_at: nowIso,
    last_refreshed_at: nowIso,
    status: "active",
    error_message: null,
    updated_at: nowIso,
  };

  let connectionId: string;
  if (existing) {
    const { error: updErr } = await sb.from("gmail_connections").update({
      ...tokenFields,
      ...(displayName && !existing.display_name ? { display_name: displayName } : {}),
    }).eq("id", existing.id);
    if (updErr) return errPage(`Could not store connection: ${updErr.message}`);
    connectionId = existing.id;
  } else {
    const { data: inserted, error: insertErr } = await sb.from("gmail_connections").insert({
      account_email: accountEmail,
      ...tokenFields,
      kind: kind || "shared",
      owner_staff_id: kind === "personal" ? staffId : null,
      display_name: displayName || accountEmail.split("@")[0],
      is_practice_default: false, // flipped below so the old default is cleared first
    }).select("id").single();
    if (insertErr || !inserted) return errPage(`Could not store connection: ${insertErr?.message || "insert failed"}`);
    connectionId = inserted.id;
  }

  // Practice-default handover (legacy panel flow, or an explicit set_default).
  if (setDefault) {
    await sb.from("gmail_connections").update({ is_practice_default: false, updated_at: nowIso })
      .eq("is_practice_default", true).neq("id", connectionId);
    await sb.from("gmail_connections").update({ is_practice_default: true, updated_at: nowIso })
      .eq("id", connectionId);
  }

  // Audit trail.
  await sb.from("audit_log").insert({
    user_id: staffId,
    action: "gmail_connection_established",
    entity_type: "gmail_connections",
    detail: { account_email: accountEmail, scope: tokens.scope, kind: existing?.kind || kind || "shared", set_default: setDefault },
  });

  // Redirect back to the portal.
  const dest = returnTo.startsWith("/") ? `${PORTAL_BASE}${returnTo}` : `${PORTAL_BASE}/manage/billing/uplifts`;
  return Response.redirect(`${dest}?gmail_connected=1`, 302);
});
