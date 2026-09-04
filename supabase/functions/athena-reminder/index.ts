// athena-reminder — Athena Portal
// A nudge to Bobby to keep Athena current (import the latest BrightManager
// export so the deadline tracker, Ready Now and Sophie's task list stay live).
// Fires three times a week via pg_cron: Friday 15:00, Sunday 19:00 and
// Monday 08:00 UK. The Monday one is the last call before the whole-team
// deadline digest goes out at 12:00.
//
// Auth: x-cron-secret matching deadline_digest_config.cron_secret (reused —
// same internal-digest trust boundary), OR an active staff JWT for manual tests.
// Body: { dry_run?: boolean (default true), test_recipient?: string, moment?: string }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendEmail } from "../_shared/resend.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PORTAL_URL = Deno.env.get("PORTAL_PUBLIC_URL") || "https://portal.almondvalleyaccounting.co.uk";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);
  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: cfg } = await service.from("deadline_digest_config").select("cron_secret").eq("id", true).maybeSingle();
  const expected = (cfg?.cron_secret as string) || "";
  const got = req.headers.get("x-cron-secret") || "";
  if (!(expected && got === expected)) {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ success: false, error: "Missing authorization" }, 401);
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authErr } = await anon.auth.getUser();
    if (authErr || !user) return json({ success: false, error: "Invalid token" }, 401);
    const { data: prof } = await service.from("staff_profiles").select("is_active").eq("id", user.id).single();
    if (!prof?.is_active) return json({ success: false, error: "Not authorised" }, 403);
  }

  const body = await req.json().catch(() => ({}));
  const dryRun = body.dry_run !== false; // default TRUE
  const testRecipient: string | null = body.test_recipient || null;
  const moment: string = ["sunday", "friday", "monday"].includes(body.moment) ? body.moment : "";

  // Recipient = Bobby (resolved from staff_profiles, not hardcoded).
  const { data: me } = await service.from("staff_profiles").select("email, name")
    .eq("name", "Bobby Gallacher").eq("is_active", true).maybeSingle();
  const to = testRecipient || (me?.email as string) || "";
  if (!to) return json({ success: false, error: "no recipient (Bobby not found / no email)" }, 400);

  const lead = moment === "sunday"
    ? "Before Monday kicks off — a quick reminder to update Athena."
    : moment === "friday"
      ? "Heading into the weekend — a quick reminder to update Athena."
      : moment === "monday"
        ? "Last call — the team's deadline digest goes out at midday, so update Athena first."
        : "A quick reminder to update Athena.";
  const subject = moment === "sunday"
    ? "Sunday reminder: update Athena for Monday"
    : moment === "monday"
      ? "Monday morning: update Athena before the midday digest"
      : "Reminder: update Athena";

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f8f9;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1e293b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8f9;padding:32px 16px;"><tr><td align="center">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:28px;">
        <tr><td style="font-size:18px;font-weight:700;color:#1E4560;padding-bottom:6px;">Update Athena</td></tr>
        <tr><td style="font-size:14px;line-height:1.6;color:#1e293b;">${lead} Import the latest BrightManager export so the deadline tracker, Ready Now and Sophie's task list all reflect where jobs really are.</td></tr>
        <tr><td style="font-size:13px;line-height:1.6;color:#64748b;padding-top:10px;">${moment === "monday"
          ? "Two minutes now and the digest the team reads at midday is accurate."
          : "Two minutes now keeps Monday's deadline digest and the team's task lists accurate."}</td></tr>
        <tr><td style="padding:20px 0 4px;">
          <a href="${PORTAL_URL}/import" style="display:inline-block;background:#1E4560;color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px;font-weight:600;font-size:14px;">Open the importer</a>
        </td></tr>
        <tr><td style="padding-top:22px;border-top:1px solid #f1f5f9;font-size:11px;color:#94a3b8;text-align:center;">Almond Valley Accounting · Athena update reminder</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
  const text = `${lead}\n\nImport the latest BrightManager export so the deadline tracker, Ready Now and Sophie's task list stay accurate.\n\nOpen the importer: ${PORTAL_URL}/import`;

  if (dryRun) return json({ success: true, dry_run: true, to, moment });

  const r = await sendEmail({ to, subject, html, text });
  await service.from("audit_log").insert({
    action: "athena_reminder_sent", entity_type: "reminder", entity_id: null,
    detail: { to, moment, test: Boolean(testRecipient), ok: r.ok, resend_id: r.id, error: r.error },
  });
  return json({ success: r.ok, to, moment, resend_id: r.id, error: r.error });
});
