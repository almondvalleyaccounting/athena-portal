// comm-optin — Athena Portal
// Public landing endpoint for the opt-in/opt-out buttons in client
// communication emails (Client Reminders module). Deployed with
// verify_jwt OFF — anyone with a link can hit it, so the token IS the
// auth: an unguessable random hex stored on reminder_emails. No token,
// no effect.
//
// GET ?token=<hex>&choice=in|out
//   * looks up reminder_emails by token (service role)
//   * stamps clicked_choice / clicked_at on that email row
//   * upserts client_comm_preferences for (entity, comm_type)
//   * writes an audit_log row
//   * 302-redirects to the app's public /opt-in confirmation page
//
// Why redirect instead of returning HTML: Supabase serves edge-function
// responses on the *.supabase.co domain as text/plain (anti-phishing),
// so an HTML page here shows as raw source. The human-facing page lives
// on the app domain; we just do the DB work and bounce the browser there.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL = "https://portal.almondvalleyaccounting.co.uk";

function redirectTo(path: string): Response {
  return new Response(null, {
    status: 302,
    headers: { "Location": `${APP_URL}${path}`, "Cache-Control": "no-store" },
  });
}
const INVALID = () => redirectTo("/opt-in?status=invalid");

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") return INVALID();

  const url = new URL(req.url);
  const token = (url.searchParams.get("token") || "").trim();
  const choice = (url.searchParams.get("choice") || "").trim().toLowerCase();

  if (!token || (choice !== "in" && choice !== "out")) return INVALID();

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: email, error } = await service
    .from("reminder_emails")
    .select("id, entity_id, comm_type, clicked_choice")
    .eq("token", token)
    .maybeSingle();
  if (error || !email) return INVALID();

  const now = new Date().toISOString();

  // Record the click on the email row (last click wins — people change
  // their minds, and the preference upsert below follows the same rule).
  await service.from("reminder_emails")
    .update({ clicked_choice: choice, clicked_at: now })
    .eq("id", email.id);

  const commType = (email.comm_type as string) || "tax_reminders";
  if (email.entity_id) {
    await service.from("client_comm_preferences").upsert(
      {
        entity_id: email.entity_id,
        comm_type: commType,
        status: choice === "in" ? "opted_in" : "opted_out",
        decided_at: now,
        decided_via: "email_link",
        decided_by: null,
        note: null,
        updated_at: now,
      },
      { onConflict: "entity_id,comm_type" },
    );

    await service.from("audit_log").insert({
      action: "comm_optin",
      entity_type: "entity",
      entity_id: email.entity_id,
      detail: { choice, comm_type: commType, reminder_email_id: email.id },
    });
  }

  return redirectTo(`/opt-in?choice=${choice}`);
});
