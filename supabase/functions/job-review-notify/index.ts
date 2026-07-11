// job-review-notify — Athena Portal
// Sends ONE nudge email per assignee for an open job-review cycle, pointing
// them at the Athena review page. Used for the initial monthly nudge and for
// chase reminders (only_unanswered=true).
//
// SAFETY: dry_run defaults to TRUE. A real send requires dry_run:false.
// test_recipient routes every email to one address (validation, no team spam).
//
// Auth: a portal admin's JWT, OR the x-cron-secret header matching
// JOB_REVIEW_CRON_SECRET (for pg_cron / scheduled invocation).
//
// Body:
//   {
//     dry_run?: boolean          // default true
//     test_recipient?: string    // route all emails here instead of assignees
//     cycle_id?: string          // default: latest open cycle
//     only_unanswered?: boolean  // default false (nudge all); true = chase
//     reminder?: boolean         // labels the audit action + subject
//   }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendEmail } from "../_shared/resend.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("JOB_REVIEW_CRON_SECRET") || "";
const PORTAL_PUBLIC_URL =
  Deno.env.get("PORTAL_PUBLIC_URL") || "https://portal.almondvalleyaccounting.co.uk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00Z" : ""));
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function monthLabel(iso: string): string {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

function renderEmail(name: string, monthLbl: string, items: Array<Record<string, unknown>>, reminder: boolean): { html: string; text: string } {
  const url = `${PORTAL_PUBLIC_URL}/review`;
  const rows = items.slice(0, 20).map((i) => `
    <tr>
      <td style="padding:6px 10px;border-top:1px solid #f1f5f9;color:#0f172a;">${esc(i.client_name)}</td>
      <td style="padding:6px 10px;border-top:1px solid #f1f5f9;color:#64748b;">${esc(i.service === "Self Assessment" ? "SA" : "Accounts")}</td>
      <td style="padding:6px 10px;border-top:1px solid #f1f5f9;color:#64748b;">YE ${fmtDate(i.period_end as string)}</td>
      <td style="padding:6px 10px;border-top:1px solid #f1f5f9;color:${(i.days_past as number) > 365 ? "#dc2626" : "#64748b"};text-align:right;">${esc(i.days_past)}d</td>
    </tr>`).join("");
  const more = items.length > 20 ? `<div style="font-size:12px;color:#94a3b8;margin-top:8px;">…and ${items.length - 20} more.</div>` : "";
  const lead = reminder
    ? `This is a reminder — you still have <strong>${items.length}</strong> job${items.length === 1 ? "" : "s"} to review for the ${esc(monthLbl)} workflow meeting.`
    : `You have <strong>${items.length}</strong> job${items.length === 1 ? "" : "s"} that could have progressed but haven’t, to review before the ${esc(monthLbl)} workflow meeting.`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#fafafa;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1e293b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;padding:32px 16px;"><tr><td align="center">
      <table role="presentation" width="620" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;">
        <tr><td style="font-size:15px;font-weight:600;color:#0f172a;padding-bottom:6px;">Hi ${esc(name || "there")},</td></tr>
        <tr><td style="font-size:14px;line-height:1.6;color:#1e293b;">${lead} It only takes a moment per job — tell us when you’ll have it done, what’s blocking it, and how confident you are.</td></tr>
        <tr><td style="padding:20px 0 4px;">
          <a href="${esc(url)}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;font-size:14px;">Open my review in Athena</a>
        </td></tr>
        <tr><td style="padding-top:20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:13px;">
            <tr style="background:#f8fafc;"><td colspan="4" style="padding:8px 10px;font-weight:600;color:#0f172a;">Your jobs</td></tr>
            ${rows}
          </table>
          ${more}
        </td></tr>
        <tr><td style="padding-top:24px;border-top:1px solid #f1f5f9;margin-top:20px;font-size:11px;color:#94a3b8;text-align:center;">
          Almond Valley Accounting · BrightManager remains the record for job status.
        </td></tr>
      </table>
    </td></tr></table>
  </body></html>`;

  const text = `Hi ${name || "there"},\n\n${lead.replace(/<[^>]+>/g, "")}\n\nOpen your review: ${url}\n\n` +
    items.slice(0, 20).map((i) => `- ${i.client_name} (${i.service}) YE ${fmtDate(i.period_end as string)} — ${i.days_past}d past`).join("\n");
  return { html, text };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── Auth: cron secret OR portal-admin JWT ──
  // Expected cron secret comes from the env var if set, else from
  // job_review_config.cron_secret (service-role readable).
  const cronHeader = req.headers.get("x-cron-secret") || "";
  let expectedSecret = CRON_SECRET;
  if (!expectedSecret) {
    const { data: cfg } = await service.from("job_review_config").select("cron_secret").eq("id", true).maybeSingle();
    expectedSecret = (cfg?.cron_secret as string) || "";
  }
  let callerId: string | null = null;
  if (!(expectedSecret && cronHeader && cronHeader === expectedSecret)) {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ success: false, error: "Missing authorization" }, 401);
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authErr } = await anon.auth.getUser();
    if (authErr || !user) return json({ success: false, error: "Invalid token" }, 401);
    const { data: prof } = await service.from("staff_profiles").select("is_portal_admin, can_manage_portal").eq("id", user.id).single();
    if (!prof || !(prof.is_portal_admin || prof.can_manage_portal)) {
      return json({ success: false, error: "Not authorised" }, 403);
    }
    callerId = user.id;
  }

  const body = await req.json().catch(() => ({}));
  const dryRun = body.dry_run !== false; // default TRUE
  const testRecipient: string | null = body.test_recipient || null;
  const onlyUnanswered = body.only_unanswered === true;
  const reminder = body.reminder === true;

  // Resolve cycle
  const { data: cycle } = body.cycle_id
    ? await service.from("job_review_cycle").select("*").eq("id", body.cycle_id).single()
    : await service.from("job_review_cycle").select("*").eq("status", "open").order("period_month", { ascending: false }).limit(1).maybeSingle();
  if (!cycle) return json({ success: false, error: "No open cycle" }, 404);

  // Items (optionally only unanswered), with assignee email
  let q = service.from("job_review_item")
    .select("client_name, service, period_end, days_past, responded_at, assignee:assignee_id(id, name, email, is_active)")
    .eq("cycle_id", cycle.id);
  if (onlyUnanswered) q = q.is("responded_at", null);
  const { data: items, error: itemsErr } = await q;
  if (itemsErr) return json({ success: false, error: itemsErr.message }, 500);

  // Group by assignee (skip inactive / no email)
  const groups = new Map<string, { name: string; email: string; items: Array<Record<string, unknown>> }>();
  for (const it of (items || []) as Array<Record<string, unknown>>) {
    const a = it.assignee as Record<string, unknown> | null;
    if (!a || !a.email || a.is_active === false) continue;
    const key = a.id as string;
    if (!groups.has(key)) groups.set(key, { name: a.name as string, email: a.email as string, items: [] });
    groups.get(key)!.items.push(it);
  }

  const monthLbl = monthLabel(cycle.period_month);
  const plan = Array.from(groups.values()).map((g) => ({
    name: g.name, email: testRecipient || g.email, jobs: g.items.length,
  }));

  if (dryRun) {
    return json({ success: true, dry_run: true, cycle_month: cycle.period_month, recipients: plan.length, plan });
  }

  // Safety gate: real team-wide sends require sending_enabled. Test sends
  // (test_recipient → one address) are always allowed for end-to-end testing.
  if (!testRecipient) {
    const { data: cfg2 } = await service.from("job_review_config").select("sending_enabled").eq("id", true).maybeSingle();
    if (!cfg2?.sending_enabled) {
      return json({ success: false, error: "Team sending is disabled (job_review_config.sending_enabled = false). Use test_recipient, or enable sending once you've tested." }, 409);
    }
  }

  // Real send
  const results: Array<Record<string, unknown>> = [];
  for (const g of groups.values()) {
    const to = testRecipient || g.email;
    const { html, text } = renderEmail(g.name, monthLbl, g.items, reminder);
    const subject = reminder
      ? `Reminder: ${g.items.length} job${g.items.length === 1 ? "" : "s"} to review — ${monthLbl}`
      : `${g.items.length} job${g.items.length === 1 ? "" : "s"} to review before the workflow meeting — ${monthLbl}`;
    const r = await sendEmail({ to, subject, html, text });
    results.push({ email: to, jobs: g.items.length, ok: r.ok, resend_id: r.id, error: r.error });
    await service.from("audit_log").insert({
      user_id: callerId,
      action: reminder ? "job_review_reminder_sent" : "job_review_nudge_sent",
      entity_type: "job_review_cycle",
      entity_id: cycle.id,
      detail: { to, jobs: g.items.length, resend_id: r.id, ok: r.ok, test: Boolean(testRecipient) },
    });
  }
  return json({ success: true, dry_run: false, cycle_month: cycle.period_month, sent: results.filter((r) => r.ok).length, results });
});
