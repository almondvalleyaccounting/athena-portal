// comm-click — Athena Portal
// Public click-tracking redirect for links in payment-reminder emails
// (Client Tax Reminders module). Deployed with verify_jwt OFF — the token
// IS the auth: an unguessable random hex stored on reminder_emails.
//
// GET ?token=<hex>&to=pay|pta
//   * looks up reminder_emails by token (service role)
//   * stamps clicked_at + clicked_link on that email row (last click wins)
//   * 302-redirects the browser to the real gov.uk destination
//
// The destination is resolved from a server-side allowlist keyed by `to`,
// never taken from the query string — so this can't be used as an open
// redirect. An unknown/absent token still redirects (so a stale link isn't
// a dead end); it just isn't logged.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Allowlisted destinations. `to` maps here; nothing else is redirectable.
const DEST: Record<string, string> = {
  pay: "https://www.gov.uk/pay-self-assessment-tax-bill",
  pta: "https://www.gov.uk/personal-tax-account",
};
const FALLBACK = "https://www.gov.uk";

function redirect(dest: string): Response {
  return new Response(null, {
    status: 302,
    headers: { "Location": dest, "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") return redirect(FALLBACK);

  const url = new URL(req.url);
  const token = (url.searchParams.get("token") || "").trim();
  const to = (url.searchParams.get("to") || "").trim().toLowerCase();
  const dest = DEST[to] || FALLBACK;

  // Log the click (best-effort) before bouncing. Never let a logging
  // failure block the redirect — the client must always reach gov.uk.
  if (token && (to === "pay" || to === "pta")) {
    try {
      const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { data: email } = await service
        .from("reminder_emails")
        .select("id")
        .eq("token", token)
        .maybeSingle();
      if (email) {
        const now = new Date().toISOString();
        await service.from("reminder_emails")
          .update({ clicked_at: now, clicked_link: to })
          .eq("id", email.id);
      }
    } catch (_e) { /* swallow — redirect regardless */ }
  }

  return redirect(dest);
});
