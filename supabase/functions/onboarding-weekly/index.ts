// onboarding-weekly — Athena Portal
// Monday-morning team emails (cron: run_onboarding_weekly, Mon 09:00 UTC):
//   1. "What moved last week" — high-level onboarding milestones from
//      v_onboarding_updates (codes/numbers received, quotes accepted,
//      QuickBooks/payroll set up, service requests, starts/completions).
//      Sent to onboarding_chase_config.weekly_recipient_ids (Bobby, Tracy,
//      Stephanie; empty list = all active staff). Always sends (quiet weeks
//      say so).
//   2. "Needs attention" — issues only when there are any: codes /
//      registrations overdue with HMRC & co, and unresponsive clients
//      (escalated or chase-capped).
//
// Auth: x-cron-secret matching onboarding_chase_config.cron_secret, OR an
// active staff JWT (manual test runs).
// Body: { dry_run?: boolean, test_recipient?: string }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RESEND_FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") || "info@almondvalleyaccounting.co.uk";
const RESEND_FROM_NAME = Deno.env.get("RESEND_FROM_NAME") || "Almond Valley Accounting";
const ATHENA_URL = Deno.env.get("PORTAL_PUBLIC_URL") || "https://portal.almondvalleyaccounting.co.uk";

type Row = Record<string, unknown>;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function daysSince(dateStr: string | null): number | null {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr + "T00:00:00Z").getTime()) / 86400000);
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

// Keep in sync with UpdatesView.jsx updateDisplay()
const MILESTONE_LABELS: Array<[RegExp, string]> = [
  [/letter of engagement/i, "📝 Letter of Engagement signed"],
  [/2 forms of id/i, "🪪 ID documents received"],
  [/authentication code/i, "🔑 Companies House auth code received"],
  [/accepted quote/i, "✅ Quote accepted"],
  [/personal utr/i, "🏛️ Personal UTR received"],
  [/company utr/i, "🏛️ Company UTR received"],
  [/vat number/i, "🧾 VAT number received"],
  [/paye ref/i, "💷 PAYE reference received"],
  [/ct agent code/i, "🔗 CT agent code received"],
  [/agent code/i, "🔗 HMRC agent code received"],
  [/cis code/i, "🏗️ CIS code received"],
  [/qb licence/i, "💻 QuickBooks set up"],
  [/brightpay/i, "💷 Payroll set up on Brightpay"],
  [/live billing/i, "💳 Billing live in QuickBooks"],
  [/billing tracker/i, "💳 Added to billing"],
];
function updateLabel(u: Row): string {
  if (u.kind === "milestone") {
    for (const [re, label] of MILESTONE_LABELS) if (re.test(u.title as string)) return label;
    return `✔️ ${u.title}`;
  }
  if (u.kind === "service_request") return `🛎️ ${u.title}`;
  if (u.kind === "started") return "🚀 Onboarding started";
  if (u.kind === "completed") return "🎉 Onboarding complete";
  return String(u.title || "");
}

const shell = (inner: string) =>
  `<!doctype html><html><body style="margin:0;padding:0;background:#f6f8f9;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1e293b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8f9;padding:32px 16px;"><tr><td align="center">
      <table role="presentation" width="620" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:28px;">
        ${inner}
        <tr><td style="padding:20px 0 4px;">
          <a href="${esc(ATHENA_URL)}/onboarding/updates" style="display:inline-block;background:#1E4560;color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px;font-weight:600;font-size:14px;">Open in Athena</a>
        </td></tr>
        <tr><td style="padding-top:22px;border-top:1px solid #f1f5f9;font-size:11px;color:#94a3b8;text-align:center;">Almond Valley Accounting · Athena onboarding weekly</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);
  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: cfg } = await service.from("onboarding_chase_config").select("*").eq("id", true).maybeSingle();
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

  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const [{ data: updates }, { data: staff }, { data: obs }, { data: wcfg }] = await Promise.all([
    service.from("v_onboarding_updates").select("*").gte("happened_at", since).order("happened_at"),
    service.from("staff_profiles").select("id, email").eq("is_active", true),
    service.from("onboardings")
      .select("id, status, escalation_status, entity:entities!onboardings_entity_id_fkey(name), steps:onboarding_steps(name, client_label, status, owner_type, requested_at, expected_days, chase_count)")
      .eq("status", "active"),
    service.from("onboarding_chase_config").select("weekly_recipient_ids").eq("id", true).maybeSingle(),
  ]);

  // Both weekly emails go to the configured recipients
  // (onboarding_chase_config.weekly_recipient_ids — same pattern as the CH
  // weekly); an empty list falls back to all active staff.
  const wantedIds: string[] = Array.isArray(wcfg?.weekly_recipient_ids) ? (wcfg.weekly_recipient_ids as string[]) : [];
  const pool = wantedIds.length
    ? (staff || []).filter((s: Row) => wantedIds.includes(s.id as string))
    : (staff || []);
  const recipients = testRecipient
    ? [testRecipient]
    : pool.map((s: Row) => (s.email as string)?.trim()).filter((e: string) => e?.includes("@"));

  // ── Email 1: what moved last week ──
  const byEntity = new Map<string, Row[]>();
  for (const u of (updates || []) as Row[]) {
    // 'started' events for onboardings created before the window shouldn't
    // appear, and the view already filters by happened_at.
    const k = u.entity_name as string;
    if (!byEntity.has(k)) byEntity.set(k, []);
    byEntity.get(k)!.push(u);
  }
  const updateBlocks = [...byEntity.entries()].map(([entity, items]) => `
    <tr><td style="padding-top:14px;">
      <div style="font-size:13px;font-weight:700;color:#0f172a;padding-bottom:4px;">${esc(entity)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:13px;">
        ${items.map((u) => `<tr><td style="padding:7px 12px;border-top:1px solid #f1f5f9;color:#334155;">${esc(updateLabel(u))}</td>
          <td style="padding:7px 12px;border-top:1px solid #f1f5f9;color:#94a3b8;text-align:right;white-space:nowrap;">${new Date(u.happened_at as string).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</td></tr>`).join("")}
      </table>
    </td></tr>`).join("");

  const updatesHtml = shell(`
    <tr><td style="font-size:18px;font-weight:700;color:#1E4560;padding-bottom:4px;">Onboarding — what moved last week</td></tr>
    <tr><td style="font-size:13px;color:#64748b;">High-level milestones across all onboardings, Monday round-up.</td></tr>
    ${updateBlocks || `<tr><td style="font-size:13.5px;color:#64748b;padding-top:14px;">A quiet week — no major onboarding milestones. The pipeline is in Athena if you want the detail.</td></tr>`}`);
  const updatesText = `Onboarding — what moved last week\n\n` +
    ([...byEntity.entries()].map(([entity, items]) =>
      `${entity}\n${items.map((u) => `  - ${updateLabel(u)} (${new Date(u.happened_at as string).toLocaleDateString("en-GB")})`).join("\n")}`).join("\n\n") || "A quiet week — no major onboarding milestones.");

  // ── Email 2: issues (only when there are any) ──
  const overdue: Array<{ entity: string; step: string; waited: number; expect: number }> = [];
  const unresponsive: Array<{ entity: string; why: string }> = [];
  const maxChases = (cfg?.max_chases as number) ?? 3;
  for (const o of (obs || []) as Row[]) {
    const entity = ((o.entity as Row)?.name as string) || "Unknown client";
    const esc_ = (o.escalation_status as string) || "none";
    const capped = ((o.steps as Row[]) || []).filter((s) => ((s.chase_count as number) || 0) >= maxChases && s.status === "waiting_client");
    if (esc_ !== "none") {
      unresponsive.push({ entity, why: `escalation: ${esc_.replace(/_/g, " ")}` });
    } else if (capped.length) {
      unresponsive.push({ entity, why: `${capped.length} request${capped.length === 1 ? "" : "s"} chased ${maxChases}× with no response` });
    }
    for (const s of ((o.steps as Row[]) || [])) {
      if (s.status !== "waiting_external" || s.expected_days == null) continue;
      const waited = daysSince(s.requested_at as string);
      if (waited != null && waited > (s.expected_days as number)) {
        overdue.push({ entity, step: s.name as string, waited, expect: s.expected_days as number });
      }
    }
  }

  const issuesCount = overdue.length + unresponsive.length;
  const issuesHtml = shell(`
    <tr><td style="font-size:18px;font-weight:700;color:#b91c1c;padding-bottom:4px;">Onboarding — needs attention</td></tr>
    <tr><td style="font-size:13px;color:#64748b;">Codes not arriving and clients not responding — the weekly stuck-list.</td></tr>
    ${overdue.length ? `<tr><td style="padding-top:16px;">
      <div style="font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.5px;padding-bottom:6px;">Codes / registrations overdue</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:13px;">
        ${overdue.map((r) => `<tr><td style="padding:7px 12px;border-top:1px solid #f1f5f9;color:#0f172a;">${esc(r.entity)} — ${esc(r.step)}</td>
          <td style="padding:7px 12px;border-top:1px solid #f1f5f9;color:#dc2626;text-align:right;white-space:nowrap;">${r.waited}d waited (expect ~${r.expect}d)</td></tr>`).join("")}
      </table></td></tr>` : ""}
    ${unresponsive.length ? `<tr><td style="padding-top:16px;">
      <div style="font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.5px;padding-bottom:6px;">Unresponsive clients</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:13px;">
        ${unresponsive.map((r) => `<tr><td style="padding:7px 12px;border-top:1px solid #f1f5f9;color:#0f172a;">${esc(r.entity)}</td>
          <td style="padding:7px 12px;border-top:1px solid #f1f5f9;color:#d97706;text-align:right;white-space:nowrap;">${esc(r.why)}</td></tr>`).join("")}
      </table></td></tr>` : ""}`);
  const issuesText = `Onboarding — needs attention\n\n` +
    (overdue.length ? `Codes/registrations overdue:\n${overdue.map((r) => `- ${r.entity}: ${r.step} (${r.waited}d, expect ~${r.expect}d)`).join("\n")}\n\n` : "") +
    (unresponsive.length ? `Unresponsive clients:\n${unresponsive.map((r) => `- ${r.entity} (${r.why})`).join("\n")}\n` : "");

  if (dryRun) {
    return json({
      success: true, dry_run: true, recipients: recipients.length,
      updates: (updates || []).length, issues: issuesCount,
    });
  }
  if (!recipients.length) return json({ success: false, error: "no recipients" }, 400);

  const results: Row[] = [];
  const r1 = await sendEmail(recipients, "Onboarding weekly — what moved last week", updatesHtml, updatesText);
  results.push({ kind: "weekly_updates", ok: r1.ok, resend_id: r1.id, error: r1.error });
  if (issuesCount > 0) {
    const r2 = await sendEmail(recipients, `Onboarding weekly — ${issuesCount} ${issuesCount === 1 ? "item needs" : "items need"} attention`, issuesHtml, issuesText);
    results.push({ kind: "weekly_issues", ok: r2.ok, resend_id: r2.id, error: r2.error });
  }

  await service.from("audit_log").insert({
    action: "onboarding_weekly_sent", entity_type: "onboarding", entity_id: null,
    detail: { recipients: recipients.length, updates: (updates || []).length, issues: issuesCount, test: Boolean(testRecipient), results },
  });

  return json({ success: true, sent: results.filter((r) => r.ok).length, updates: (updates || []).length, issues: issuesCount, recipients: recipients.length });
});
