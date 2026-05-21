// gmail-auth-init — Athena Portal
// Builds the Google OAuth consent URL and 302-redirects the caller.
// State carries the calling staff id so gmail-auth-callback can stamp
// gmail_connections.connected_by.
import {
  GOOGLE_AUTH_URL, GOOGLE_CLIENT_ID, GMAIL_REDIRECT_URI, GMAIL_SCOPE,
  base64UrlEncode, corsHeaders,
} from "../_shared/gmail-client.ts";

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const url = new URL(req.url);
  const staffId = url.searchParams.get("staff_id") || "";
  const returnTo = url.searchParams.get("return_to") || "/manage/billing/uplifts";

  const state = base64UrlEncode(JSON.stringify({ staff_id: staffId, return_to: returnTo, t: Date.now() }));

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GMAIL_REDIRECT_URI,
    response_type: "code",
    scope: GMAIL_SCOPE,
    // Forces a fresh consent so we always get a refresh_token back,
    // even on re-auth — without this Google omits the refresh_token
    // if the user has previously granted the scope.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });

  const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;
  return Response.redirect(authUrl, 302);
});
