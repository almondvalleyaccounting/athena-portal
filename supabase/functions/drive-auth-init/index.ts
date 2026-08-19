// drive-auth-init — Athena Portal
//
// Returns the Google OAuth consent URL for the Drive connection. Active staff only.
// Uses the drive.file scope (app-created files and folders only — no access to the
// rest of the Drive) and its own gdrive_connections row.
//
// It used to be an unauthenticated GET that 302'd anyone who asked, taking `staff_id`
// from the query string into an unsigned `state`. The callback then revoked the live
// connection and installed the caller's, so a stranger could point client onboarding
// documents at their own Drive. State is now signed and single-use
// (../_shared/oauth-state.ts, sql/236) and the staff id comes from the verified JWT.
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";
import { createSignedState, safeReturnTo } from "../_shared/oauth-state.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/drive-auth-callback`;
const SCOPE = "https://www.googleapis.com/auth/drive.file openid email";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
  const returnTo = safeReturnTo(body.return_to) ?? "/onboarding";

  const state = await createSignedState({
    purpose: "drive",
    userId: caller.userId,
    returnTo,
  });

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent", // force refresh_token on re-auth
    include_granted_scopes: "true",
    state,
  });

  return json({
    success: true,
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  });
});
