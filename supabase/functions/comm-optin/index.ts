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
//   * upserts client_comm_preferences for (entity, comm_type) —
//     clicking the other button later flips the preference (people
//     change their minds)
//   * writes an audit_log row
//   * responds with a small plain HTML confirmation page
//
// Invalid or missing tokens get a polite "reply to the email instead"
// page rather than an error — clients see this, not staff.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function htmlPage(heading: string, message: string, status = 200): Response {
  const body = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Almond Valley Accounting</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;">
  <div style="max-width:520px;margin:48px auto;padding:32px 28px;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;font-family:Arial,Helvetica,sans-serif;color:#222222;">
    <h1 style="font-size:18px;margin:0 0 6px;">Almond Valley Accounting</h1>
    <h2 style="font-size:15px;margin:0 0 16px;color:#555555;font-weight:normal;">${heading}</h2>
    <p style="font-size:14px;line-height:1.6;margin:0;">${message}</p>
  </div>
</body>
</html>`;
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const INVALID_PAGE = () =>
  htmlPage(
    "This link isn't valid",
    "This link isn't valid &mdash; please reply to the email instead and we'll set your preference for you.",
    404,
  );

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return htmlPage("Something went wrong", "This page only handles links from our emails. Please reply to the email instead.", 405);
  }

  const url = new URL(req.url);
  const token = (url.searchParams.get("token") || "").trim();
  const choice = (url.searchParams.get("choice") || "").trim().toLowerCase();

  if (!token || (choice !== "in" && choice !== "out")) return INVALID_PAGE();

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: email, error } = await service
    .from("reminder_emails")
    .select("id, entity_id, comm_type, clicked_choice")
    .eq("token", token)
    .maybeSingle();
  if (error || !email) return INVALID_PAGE();

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

  if (choice === "in") {
    return htmlPage(
      "You're opted in",
      "You're opted in &mdash; we'll send you tax payment reminders.",
    );
  }
  return htmlPage(
    "No problem",
    "No problem &mdash; we won't email you tax payment reminders. You can change your mind any time by replying to our email.",
  );
});
