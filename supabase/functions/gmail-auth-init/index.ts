// gmail-auth-init — Athena Portal
// Builds the Google OAuth consent URL and 302-redirects the caller.
// State carries the calling staff id so gmail-auth-callback can stamp
// gmail_connections.connected_by, plus the mailbox intent:
//   kind=personal|shared  — Communications-module mailbox connect
//   display_name          — label shown in the mailbox switcher
//   set_default=1         — this mailbox becomes the practice default the
//                           automation senders use (legacy panel behaviour;
//                           also the default when kind is omitted)
import {
  GOOGLE_AUTH_URL, GOOGLE_CLIENT_ID, GMAIL_REDIRECT_URI, GMAIL_SCOPE,
  base64UrlEncode, corsHeaders,
} from "../_shared/gmail-client.ts";

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const url = new URL(req.url);
  const staffId = url.searchParams.get("staff_id") || "";
  const returnTo = url.searchParams.get("return_to") || "/manage/billing/uplifts";
  const kindRaw = url.searchParams.get("kind") || "";
  const kind = kindRaw === "personal" || kindRaw === "shared" ? kindRaw : null;
  const displayName = url.searchParams.get("display_name") || "";
  // Legacy callers (GmailConnectionPanel) pass no kind: they're (re)connecting
  // the practice-default mailbox. Comms connects only set it when asked.
  const setDefault = kind ? url.searchParams.get("set_default") === "1" : true;

  const state = base64UrlEncode(JSON.stringify({
    staff_id: staffId, return_to: returnTo, t: Date.now(),
    ...(kind ? { kind } : {}),
    ...(displayName ? { display_name: displayName.slice(0, 80) } : {}),
    set_default: setDefault,
  }));

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
