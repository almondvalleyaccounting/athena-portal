// drive-auth-init — Athena Portal
// Builds the Google OAuth consent URL for the Drive connection and
// 302-redirects the caller. Mirrors gmail-auth-init but with the
// drive.file scope (app-created files/folders only — no access to the
// rest of the Drive) and its own gdrive_connections row.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/drive-auth-callback`;
const SCOPE = "https://www.googleapis.com/auth/drive.file openid email";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const url = new URL(req.url);
  const staffId = url.searchParams.get("staff_id") || "";
  const returnTo = url.searchParams.get("return_to") || "/onboarding";

  const state = base64UrlEncode(JSON.stringify({ staff_id: staffId, return_to: returnTo, t: Date.now() }));

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

  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, 302);
});
