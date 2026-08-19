// gmail-auth-init — Athena Portal
//
// Returns the Google OAuth consent URL for the app to navigate to. Active staff only.
//
// It used to be an unauthenticated GET that 302'd anyone who asked, taking `staff_id`
// straight from the query string and putting it, unsigned, into `state`. Combined with
// a callback that decoded that state best-effort, anyone could consent with their own
// Google account and have gmail-auth-callback install their mailbox as ours — and with
// set_default defaulting to true, as the PRACTICE DEFAULT, which is the mailbox
// reminders-send and chase-reply-scan send client mail from.
//
// So the state is now signed and single-use (../_shared/oauth-state.ts, sql/236), and
// the staff id comes from the caller's verified JWT rather than from the request.
//
// Body (all optional):
//   kind=personal|shared  — Communications-module mailbox connect
//   display_name          — label shown in the mailbox switcher
//   set_default=true      — this mailbox becomes the practice default the automation
//                           senders use. Defaults to true only when `kind` is absent,
//                           which is the legacy GmailConnectionPanel "reconnect the
//                           practice mailbox" case.
//   return_to             — relative in-app path to land on afterwards
import {
  GOOGLE_AUTH_URL, GOOGLE_CLIENT_ID, GMAIL_REDIRECT_URI, GMAIL_SCOPE, corsHeaders,
} from "../_shared/gmail-client.ts";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";
import { createSignedState, safeReturnTo } from "../_shared/oauth-state.ts";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  let caller;
  try {
    caller = await requireStaffOrService(req, { allowService: false });
  } catch (err) {
    return authErrorResponse(err, corsHeaders);
  }
  if (caller.kind !== "staff" || !caller.userId) {
    return json({ success: false, error: "Not authorised" }, 403);
  }

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const kindRaw = typeof body.kind === "string" ? body.kind : "";
  const kind = kindRaw === "personal" || kindRaw === "shared" ? kindRaw : null;
  const displayName = typeof body.display_name === "string" ? body.display_name.slice(0, 80) : "";
  // Explicit intent wins. Falling back to "true when no kind was given" preserves the
  // legacy GmailConnectionPanel behaviour (reconnecting the practice mailbox) without
  // making every Communications connect a silent takeover of the default.
  const setDefault = typeof body.set_default === "boolean" ? body.set_default : !kind;
  const returnTo = safeReturnTo(body.return_to) ?? "/manage/billing/uplifts";

  const state = await createSignedState({
    purpose: "gmail",
    userId: caller.userId,
    returnTo,
    extra: {
      set_default: setDefault,
      ...(kind ? { kind } : {}),
      ...(displayName ? { display_name: displayName } : {}),
    },
  });

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GMAIL_REDIRECT_URI,
    response_type: "code",
    scope: GMAIL_SCOPE,
    // Forces a fresh consent so we always get a refresh_token back, even on re-auth —
    // without this Google omits the refresh_token if the scope was granted before.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });

  return json({ success: true, url: `${GOOGLE_AUTH_URL}?${params.toString()}` });
});
