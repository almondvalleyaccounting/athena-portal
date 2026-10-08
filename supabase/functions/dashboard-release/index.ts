// dashboard-release — set which dates of a client's figures their dashboard shows.
//
// The release window (sql/355) is how unchecked numbers stay off a client's
// screen: QuickBooks is live, so without it a client sees October the moment
// anything is posted to October. This function is the only way the window
// changes. Nothing moves it on a timer, on purpose — releasing a month is a
// person saying "we have checked this".
//
// Optionally it then emails everybody with live dashboard access at the client
// to say new figures are available. No token in the email (same reasoning as
// portal-send-link): it points at the portal and nothing more.
//
// Auth: staff holding can_manage_portal — the permission that decides what a
// client may see in the first place.
//
// Body: { entity_id, mode: 'window'|'all', release_from?, release_to?, notify?: boolean }
// Returns { success, window, notified_to[], warning? }.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";
import { sendEmail } from "../_shared/resend.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_PORTAL_URL =
  Deno.env.get("CLIENT_PORTAL_URL") || "https://clients.almondvalleyaccounting.co.uk";
// Resend leaves no Sent item in Gmail; the info@ copy is the record.
const BCC_EMAIL = Deno.env.get("PORTAL_LINK_BCC_EMAIL") ?? "info@almondvalleyaccounting.co.uk";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (v: unknown): v is string =>
  typeof v === "string" && ISO.test(v) && !isNaN(new Date(`${v}T00:00:00Z`).getTime());

const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });

function releaseEmail(opts: { entityName: string; mode: string; to: string }) {
  const subject = `Your ${opts.entityName} figures have been updated`;
  const what = opts.mode === "all"
    ? `Your latest figures for ${opts.entityName} are now available on your dashboard.`
    : `Your figures for ${opts.entityName} up to ${longDate(opts.to)} have been checked and are now available on your dashboard.`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f8f9;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1e293b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8f9;padding:32px 16px;"><tr><td align="center">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:32px;">
        <tr><td style="font-size:20px;font-weight:700;color:#1E4560;padding-bottom:10px;">New figures are ready</td></tr>
        <tr><td style="font-size:14.5px;line-height:1.7;color:#1e293b;">${esc(what)}</td></tr>
        <tr><td style="padding:22px 0 6px;">
          <a href="${esc(CLIENT_PORTAL_URL)}" style="display:inline-block;background:#1E4560;color:#fff;text-decoration:none;padding:13px 24px;border-radius:11px;font-weight:600;font-size:15px;">Open your dashboard</a>
        </td></tr>
        <tr><td style="font-size:13.5px;line-height:1.7;color:#475569;padding-top:14px;">
          Sign in with this email address and we will send you a six-digit code. Any questions about the numbers? Just reply to this email.
        </td></tr>
        <tr><td style="padding-top:22px;border-top:1px solid #f1f5f9;font-size:11px;color:#94a3b8;text-align:center;">Almond Valley Accounting</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;

  const text = `New figures are ready

${what}

Open your dashboard: ${CLIENT_PORTAL_URL}

Sign in with this email address and we will send you a six-digit code. Any questions about the numbers? Just reply to this email.

Almond Valley Accounting`;

  return { subject, html, text };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  let caller;
  try {
    caller = await requireStaffOrService(req, "can_manage_portal");
  } catch (e) {
    return authErrorResponse(e, cors);
  }

  const body = await req.json().catch(() => ({}));
  const entityId = String(body.entity_id || "").trim();
  const mode = body.mode === "all" ? "all" : body.mode === "window" ? "window" : null;
  const notify = body.notify === true;

  if (!entityId) return json({ success: false, error: "entity_id is required" }, 400);
  if (!mode) return json({ success: false, error: "mode must be 'window' or 'all'" }, 400);

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const [{ data: entity }, { data: current }] = await Promise.all([
    service.from("entities").select("id, name").eq("id", entityId).maybeSingle(),
    service.from("dashboard_release_window").select("*").eq("entity_id", entityId).maybeSingle(),
  ]);
  if (!entity) return json({ success: false, error: "Unknown client" }, 404);

  // 'all' keeps the stored dates, so switching back to a window restores the
  // last one rather than resetting it.
  let from = body.release_from, to = body.release_to;
  if (mode === "all") {
    from = validDate(from) ? from : current?.release_from;
    to = validDate(to) ? to : current?.release_to;
  }
  if (!validDate(from) || !validDate(to)) {
    // Neither supplied nor stored: fall back to the standard defaults.
    const { data: d } = await service.rpc("dashboard_release_defaults").single();
    from = validDate(from) ? from : (d as any)?.release_from;
    to = validDate(to) ? to : (d as any)?.release_to;
  }
  if (!validDate(from) || !validDate(to)) {
    return json({ success: false, error: "release_from and release_to must be dates (yyyy-mm-dd)" }, 400);
  }
  if (from > to) return json({ success: false, error: "The 'from' date is after the 'to' date" }, 400);

  const now = new Date().toISOString();
  const { data: saved, error: upErr } = await service
    .from("dashboard_release_window")
    .upsert({
      entity_id: entityId, mode, release_from: from, release_to: to,
      updated_by: caller.userId, updated_at: now,
    }, { onConflict: "entity_id" })
    .select("*")
    .single();
  if (upErr) return json({ success: false, error: `Could not save: ${upErr.message}` }, 500);

  // Tell them, if asked — everybody with live access at this client.
  const notified: string[] = [];
  const failed: string[] = [];
  if (notify) {
    const { data: grants } = await service
      .from("client_dashboard_access")
      .select("email")
      .eq("entity_id", entityId)
      .is("revoked_at", null);
    const emails = [...new Set((grants || [])
      .map((g: any) => String(g.email || "").trim().toLowerCase())
      .filter((e) => e.includes("@")))];
    for (const email of emails) {
      const { subject, html, text } = releaseEmail({ entityName: entity.name, mode, to });
      const sent = await sendEmail({
        to: email, subject, html, text,
        ...(BCC_EMAIL ? { bcc: [BCC_EMAIL] } : {}),
        replyTo: "info@almondvalleyaccounting.co.uk",
      });
      (sent.ok ? notified : failed).push(email);
    }
    if (notified.length) {
      await service.from("dashboard_release_window")
        .update({ last_notified_at: new Date().toISOString() })
        .eq("entity_id", entityId);
    }
  }

  await service.from("dashboard_release_log").insert({
    entity_id: entityId, mode, release_from: from, release_to: to,
    notified_to: notified, changed_by: caller.userId,
  });

  return json({
    success: true,
    window: saved,
    notified_to: notified,
    warning: failed.length ? `Saved, but the email to ${failed.join(", ")} did not send.` : undefined,
  });
});
