// drive-auth-callback — Athena Portal
// Google redirects here after consent for the Drive connection.
// Exchanges the code for tokens and upserts the single active
// gdrive_connections row. Mirrors gmail-auth-callback.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { consumeSignedState, safeReturnTo } from "../_shared/oauth-state.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/drive-auth-callback`;
const SCOPE = "https://www.googleapis.com/auth/drive.file openid email";
const PORTAL_BASE = Deno.env.get("PORTAL_BASE_URL") || "https://portal.almondvalleyaccounting.co.uk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function errPage(message: string, status = 400) {
  return new Response(
    `<!DOCTYPE html><html><body style="font-family:system-ui;padding:32px;color:#0f172a"><h1 style="font-weight:500">Google Drive connection failed</h1><p>${message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p><p><a href="${PORTAL_BASE}/onboarding">Back to Onboarding</a></p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders } },
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) return errPage(`Google returned: ${error}`);
  if (!code) return errPage("Missing authorisation code on callback.");

  // Verify before doing anything: below this point the live gdrive_connections row is
  // revoked and replaced with whatever account just consented. Previously the state was
  // decoded best-effort and a malformed one was tolerated, so any stranger who reached
  // this endpoint could redirect client onboarding documents to their own Drive.
  let staffId: string;
  let returnTo: string;
  try {
    const verified = await consumeSignedState(stateRaw, "drive");
    staffId = verified.userId;
    returnTo = safeReturnTo(verified.returnTo) ?? "/onboarding";
  } catch (err) {
    console.error("drive-auth-callback rejected:", (err as Error).message);
    return errPage("This connection request could not be verified. Please start again from Athena.", 403);
  }

  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!tokenResp.ok) return errPage(`Google token exchange failed: ${tokenResp.status} ${await tokenResp.text()}`);
  const tokens = await tokenResp.json();
  if (!tokens.refresh_token) {
    return errPage("Google did not return a refresh token. Try disconnecting at https://myaccount.google.com/permissions and re-authorising.");
  }

  const userinfoResp = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userinfoResp.ok) return errPage(`userinfo failed: ${userinfoResp.status} ${await userinfoResp.text()}`);
  const userinfo = await userinfoResp.json();
  const accountEmail = userinfo.email as string;
  if (!accountEmail) return errPage("userinfo returned no email.");

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  await sb.from("gdrive_connections")
    .update({ status: "revoked", updated_at: new Date().toISOString() })
    .eq("status", "active");

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  const { error: insertErr } = await sb.from("gdrive_connections").insert({
    account_email: accountEmail,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_expires_at: expiresAt.toISOString(),
    scope: tokens.scope || SCOPE,
    connected_by: staffId,
    connected_at: new Date().toISOString(),
    last_refreshed_at: new Date().toISOString(),
    status: "active",
  });
  if (insertErr) return errPage(`Could not store connection: ${insertErr.message}`);

  await sb.from("audit_log").insert({
    user_id: staffId,
    action: "gdrive_connection_established",
    entity_type: "gdrive_connections",
    detail: { account_email: accountEmail, scope: tokens.scope },
  });

  const dest = returnTo.startsWith("/") ? `${PORTAL_BASE}${returnTo}` : `${PORTAL_BASE}/onboarding`;
  return Response.redirect(`${dest}?drive_connected=1`, 302);
});
