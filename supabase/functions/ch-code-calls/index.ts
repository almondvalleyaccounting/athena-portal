// ch-code-calls — Athena Portal
// Wednesday-morning "calls required" email for the Companies House
// personal-code chaser (cron: run_ch_code_calls, Wed 09:00 UTC).
//
// Lists everyone who has had the offer + 2 reminders (3 emails in total) with
// no call logged and no escalation yet — i.e. commsOf(r) === 'three_emails' in
// the UI (the "call due" column of the chase-ladder summary). The next action
// for these is a phone call.
//
// Recipient: the configured call assignee (ch_code_chase_config.call_assignee_id
// — Sophie), resolved to an email from staff_profiles (no hardcoded address).
//
// Auth: x-cron-secret matching ch_code_chase_config.cron_secret, OR an active
// staff JWT (manual test runs).
// Body: { dry_run?: boolean, test_recipient?: string }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RESEND_FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") || "info@almondvalleyaccounting.co.uk";
const RESEND_FROM_NAME = Deno.env.get("RESEND_FROM_NAME") || "Almond Valley Accounting";
const ATHENA_URL = Deno.env.get("PORTAL_PUBLIC_URL") || "https://portal.almondvalleyaccounting.co.uk";

// Chasing stages where the offer→reminder→call ladder applies. Kept in sync
// with CH_STAGES (chasing: true) in src/modules/ch-codes/api.js.
const CHASING_STAGES = ["s1_offer", "s3a_client", "s3b_us", "s4_code"];
// Human labels for the stage each caller is sitting in.
const STAGE_LABEL: Record<string, string> = {
  s1_offer: "Offer — awaiting decision",
  s3a_client: "Client self-verifying",
  s3b_us: "We verify — ID & POA",
  s4_code: "Awaiting code",
};

type Row = Record<string, unknown>;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
async function sendEmail(to: string[], subject: string, html: string, text: string) {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({ from: `${RESEND_FROM_NAME} <${RESEND_FROM_EMAIL}>`, to, subject, html, text }),
  });
  const j = await resp.json().catch(() => ({}));
  return { ok: resp.ok, id: (j?.id as string) || null, error: resp.ok ? undefined : (j?.message || j) };
}

const shell = (inner: string) =>
  `<!doctype html><html><body style="margin:0;padding:0;background:#f6f8f9;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1e293b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8f9;padding:32px 16px;"><tr><td align="center">
      <table role="presentation" width="620" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:28px;">
        ${inner}
        <tr><td style="padding:20px 0 4px;">
          <a href="${esc(ATHENA_URL)}/onboarding/ch-codes" style="display:inline-block;background:#1E4560;color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px;font-weight:600;font-size:14px;">Open in Athena</a>
        </td></tr>
        <tr><td style="padding-top:22px;border-top:1px solid #f1f5f9;font-size:11px;color:#94a3b8;text-align:center;">Almond Valley Accounting · CH personal code — calls required</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);
  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: cfg } = await service.from("ch_code_chase_config").select("*").eq("id", true).maybeSingle();
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
  const dryRun = body.dry_run === true;
  const testRecipient: string | null = body.test_recipient || null;

  // Calls required = offer + 2 reminders (3 emails) with no call yet and no
  // escalation — the UI's "call due" (three_emails) state, across chasing stages.
  const { data: callsRaw } = await service.from("ch_code_requests")
    .select("id, stage, emails_sent, last_chased_at, person:people(name), entity:entities!ch_code_requests_entity_id_fkey(name, entity_status)")
    .in("stage", CHASING_STAGES)
    .eq("escalation_status", "none")
    .gte("emails_sent", 3)
    .order("stage");

  // Former clients (nlac/archived) never appear — we do no work for them.
  const FORMER = new Set(["nlac", "archived"]);
  const calls = (callsRaw || []).filter((r: Row) =>
    !FORMER.has(((r.entity as Row)?.entity_status as string) ?? "active"));

  // Recipient: the configured call assignee (Sophie), resolved to an email.
  let recipients: string[] = [];
  if (testRecipient) {
    recipients = [testRecipient];
  } else if (cfg?.call_assignee_id) {
    const { data: assignee } = await service.from("staff_profiles")
      .select("email, is_active").eq("id", cfg.call_assignee_id as string).maybeSingle();
    const email = (assignee?.email as string)?.trim();
    if (assignee?.is_active && email?.includes("@")) recipients = [email];
  }

  const rows = (calls || []) as Row[];
  const listHtml = rows.map((r) => {
    const person = (r.person as Row)?.name as string;
    const entity = (r.entity as Row)?.name as string;
    return `<tr>
      <td style="padding:8px 12px;border-top:1px solid #f1f5f9;color:#0f172a;font-weight:600;">${esc(person || "Unknown")}</td>
      <td style="padding:8px 12px;border-top:1px solid #f1f5f9;color:#334155;">${esc(entity || "—")}</td>
      <td style="padding:8px 12px;border-top:1px solid #f1f5f9;color:#64748b;">${esc(STAGE_LABEL[r.stage as string] || r.stage)}</td>
      <td style="padding:8px 12px;border-top:1px solid #f1f5f9;color:#dc2626;text-align:right;white-space:nowrap;">${r.emails_sent} emails</td>
    </tr>`;
  }).join("");

  const html = shell(`
    <tr><td style="font-size:18px;font-weight:700;color:#1E4560;padding-bottom:4px;">Companies House codes — calls required</td></tr>
    <tr><td style="font-size:13px;color:#64748b;padding-bottom:6px;">These directors have had the offer and two reminders (3 emails) with no reply — the next step is a call.</td></tr>
    ${rows.length ? `<tr><td style="padding-top:12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:13px;">
        <tr style="background:#f8fafc;">
          <td style="padding:8px 12px;font-weight:700;color:#0f172a;">Director</td>
          <td style="padding:8px 12px;font-weight:700;color:#0f172a;">Company</td>
          <td style="padding:8px 12px;font-weight:700;color:#0f172a;">Stage</td>
          <td style="padding:8px 12px;font-weight:700;color:#0f172a;text-align:right;">Chased</td>
        </tr>
        ${listHtml}
      </table>
    </td></tr>` : `<tr><td style="font-size:13.5px;color:#64748b;padding-top:14px;">No calls required this week — nobody has hit 3 emails without a reply. 🎉</td></tr>`}`);
  const text = `Companies House codes — calls required\n\n` +
    (rows.length
      ? `These directors have had the offer + 2 reminders (3 emails) with no reply — the next step is a call:\n\n` +
        rows.map((r) => `- ${(r.person as Row)?.name || "Unknown"} (${(r.entity as Row)?.name || "—"}) — ${STAGE_LABEL[r.stage as string] || r.stage}, ${r.emails_sent} emails`).join("\n")
      : "No calls required this week — nobody has hit 3 emails without a reply.");

  if (dryRun) {
    return json({ success: true, dry_run: true, calls: rows.length, recipients: recipients.length });
  }
  if (!recipients.length) return json({ success: false, error: "no recipient (set call_assignee_id or pass test_recipient)" }, 400);

  const r = await sendEmail(recipients, `CH codes — ${rows.length} call${rows.length === 1 ? "" : "s"} required`, html, text);
  await service.from("audit_log").insert({
    action: "ch_code_calls_sent", entity_type: "ch_code_request", entity_id: null,
    detail: { calls: rows.length, recipients: recipients.length, test: Boolean(testRecipient), ok: r.ok, resend_id: r.id, error: r.error },
  });

  return json({ success: r.ok, calls: rows.length, recipients: recipients.length });
});
