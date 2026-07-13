// ch-code-weekly — Athena Portal
// Monday-morning team email for the Companies House personal-code chaser
// (cron: run_ch_code_weekly, Mon 09:00 UTC):
//   1. "What moved last week" — offers sent, chasers sent, decisions logged,
//      codes received, entered on BM — from ch_code_activity.
//   2. "What's coming" — people about to hit max_chases (next chase escalates
//      to a call), and Confirmation Statement deadlines approaching for
//      people still outstanding. Always sends (quiet weeks say so).
//
// Auth: x-cron-secret matching ch_code_chase_config.cron_secret, OR an
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
function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr + "T00:00:00Z").getTime() - Date.now()) / 86400000);
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

const ACTIVITY_LABELS: Array<[RegExp, string]> = [
  [/^offer emailed/i, "✉️ Offer sent"],
  [/^chase #\d+ emailed/i, "🔔 Reminder sent"],
  // Queue-sent emails (ch-code-queue-send bodies) — specific before generic.
  [/id\/poa reminder emailed/i, "🪪 ID/POA reminder sent"],
  [/code reminder emailed/i, "🔑 Code reminder sent"],
  [/self-verify reminder emailed/i, "🔔 Self-verify reminder sent"],
  [/reminder emailed/i, "🔔 Reminder sent"],
  [/^decision: we verify/i, "💳 Decision: we verify"],
  [/^decision: client is self/i, "🙋 Decision: client self-verifies"],
  [/id\/poa received/i, "🪪 ID/proof of address received"],
  [/^code received/i, "🔑 Personal code received"],
  [/submitted via inform direct/i, "✅ Submitted via Inform Direct"],
  [/call logged/i, "📞 Call logged"],
  [/^escalated/i, "🚨 Escalated"],
  [/moved to stage/i, "➡️ Stage moved"],
];
function activityLabel(body: string): string {
  for (const [re, label] of ACTIVITY_LABELS) if (re.test(body)) return label;
  return `📌 ${body}`;
}

const shell = (inner: string) =>
  `<!doctype html><html><body style="margin:0;padding:0;background:#f6f8f9;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1e293b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8f9;padding:32px 16px;"><tr><td align="center">
      <table role="presentation" width="620" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:28px;">
        ${inner}
        <tr><td style="padding:20px 0 4px;">
          <a href="${esc(ATHENA_URL)}/onboarding/ch-codes" style="display:inline-block;background:#1E4560;color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px;font-weight:600;font-size:14px;">Open in Athena</a>
        </td></tr>
        <tr><td style="padding-top:22px;border-top:1px solid #f1f5f9;font-size:11px;color:#94a3b8;text-align:center;">Almond Valley Accounting · CH personal code weekly</td></tr>
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

  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const [{ data: activity }, { data: staff }, { data: openReqs }] = await Promise.all([
    service.from("ch_code_activity")
      .select("body, created_at, kind, request:ch_code_requests(person:people(name), entity:entities!ch_code_requests_entity_id_fkey(name))")
      .in("kind", ["email_out", "system", "status_change"]).gte("created_at", since).order("created_at"),
    service.from("staff_profiles").select("id, email").eq("is_active", true),
    service.from("ch_code_requests")
      .select("chase_count, status, stage, escalation_status, person:people(name), entity:entities!ch_code_requests_entity_id_fkey(name, id)")
      .not("stage", "in", "(s6_submitted,s7_rejected)"),
  ]);

  // Recipients: the configured people (Bobby + Tracy) resolved to emails from
  // staff_profiles; fall back to all active staff if none are configured.
  const wantIds = (cfg?.weekly_recipient_ids as string[]) || [];
  const emailOf = (list: Row[]) => list.map((s) => (s.email as string)?.trim()).filter((e: string) => e?.includes("@"));
  const recipients = testRecipient
    ? [testRecipient]
    : wantIds.length
      ? emailOf((staff || []).filter((s: Row) => wantIds.includes(s.id as string)))
      : emailOf((staff || []) as Row[]);

  // ── What moved last week ──
  const byPerson = new Map<string, Row[]>();
  for (const a of (activity || []) as Row[]) {
    const req = a.request as Row;
    const person = (req?.person as Row)?.name as string;
    const entity = (req?.entity as Row)?.name as string;
    const key = `${person || "Unknown"} — ${entity || "Unknown"}`;
    if (!byPerson.has(key)) byPerson.set(key, []);
    byPerson.get(key)!.push(a);
  }
  const movedBlocks = [...byPerson.entries()].map(([who, items]) => `
    <tr><td style="padding-top:14px;">
      <div style="font-size:13px;font-weight:700;color:#0f172a;padding-bottom:4px;">${esc(who)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:13px;">
        ${items.map((a) => `<tr><td style="padding:7px 12px;border-top:1px solid #f1f5f9;color:#334155;">${esc(activityLabel(a.body as string))}</td>
          <td style="padding:7px 12px;border-top:1px solid #f1f5f9;color:#94a3b8;text-align:right;white-space:nowrap;">${new Date(a.created_at as string).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</td></tr>`).join("")}
      </table>
    </td></tr>`).join("");

  // ── What's coming: near-cap chases + CS deadlines approaching ──
  const nearCap: Row[] = [];
  const csComing: Row[] = [];
  for (const r of (openReqs || []) as Row[]) {
    const count = (r.chase_count as number) || 0;
    if (r.escalation_status === "none" && count === (cfg?.max_chases as number) - 1) nearCap.push(r);
  }
  const entityIds = [...new Set(((openReqs || []) as Row[]).map((r) => (r.entity as Row)?.id).filter(Boolean))];
  if (entityIds.length) {
    const { data: deadlines } = await service.from("deadlines")
      .select("entity_id, due_date").eq("tag", "Confirmation Statement").neq("status", "complete").in("entity_id", entityIds as string[]);
    const dueByEntity = new Map((deadlines || []).map((d: Row) => [d.entity_id as string, d.due_date as string]));
    for (const r of (openReqs || []) as Row[]) {
      const eid = (r.entity as Row)?.id as string;
      const due = dueByEntity.get(eid);
      if (!due) continue;
      const days = daysUntil(due);
      if (days != null && days >= 0 && days <= 30) csComing.push({ ...r, due_date: due, days_left: days });
    }
  }

  const comingHtml = (nearCap.length || csComing.length) ? `
    ${nearCap.length ? `<tr><td style="padding-top:16px;"><div style="font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.5px;padding-bottom:6px;">One more chase before a call is needed</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:13px;">
        ${nearCap.map((r) => `<tr><td style="padding:7px 12px;border-top:1px solid #f1f5f9;color:#0f172a;">${esc((r.person as Row)?.name)} — ${esc((r.entity as Row)?.name)}</td></tr>`).join("")}
      </table></td></tr>` : ""}
    ${csComing.length ? `<tr><td style="padding-top:16px;"><div style="font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.5px;padding-bottom:6px;">Confirmation Statement due within 30 days — code still outstanding</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:13px;">
        ${csComing.map((r) => `<tr><td style="padding:7px 12px;border-top:1px solid #f1f5f9;color:#0f172a;">${esc((r.person as Row)?.name)} — ${esc((r.entity as Row)?.name)}</td>
          <td style="padding:7px 12px;border-top:1px solid #f1f5f9;color:#dc2626;text-align:right;white-space:nowrap;">${r.days_left}d left</td></tr>`).join("")}
      </table></td></tr>` : ""}` : "";

  const html = shell(`
    <tr><td style="font-size:18px;font-weight:700;color:#1E4560;padding-bottom:4px;">Companies House codes — weekly round-up</td></tr>
    <tr><td style="font-size:13px;color:#64748b;">What moved last week, and what's coming up.</td></tr>
    ${movedBlocks || `<tr><td style="font-size:13.5px;color:#64748b;padding-top:14px;">A quiet week — nothing moved. The pipeline is in Athena if you want the detail.</td></tr>`}
    ${comingHtml}`);
  const text = `Companies House codes — weekly round-up\n\n` +
    ([...byPerson.entries()].map(([who, items]) => `${who}\n${items.map((a) => `  - ${activityLabel(a.body as string)} (${new Date(a.created_at as string).toLocaleDateString("en-GB")})`).join("\n")}`).join("\n\n") || "A quiet week — nothing moved.") +
    (nearCap.length ? `\n\nOne more chase before a call is needed:\n${nearCap.map((r) => `- ${(r.person as Row)?.name} (${(r.entity as Row)?.name})`).join("\n")}` : "") +
    (csComing.length ? `\n\nCS due within 30 days, code outstanding:\n${csComing.map((r) => `- ${(r.person as Row)?.name} (${(r.entity as Row)?.name}) — ${r.days_left}d left`).join("\n")}` : "");

  if (dryRun) {
    return json({ success: true, dry_run: true, recipients: recipients.length, moved: (activity || []).length, near_cap: nearCap.length, cs_coming: csComing.length });
  }
  if (!recipients.length) return json({ success: false, error: "no recipients" }, 400);

  const r = await sendEmail(recipients, "CH codes weekly — what moved & what's coming", html, text);
  await service.from("audit_log").insert({
    action: "ch_code_weekly_sent", entity_type: "ch_code_request", entity_id: null,
    detail: { recipients: recipients.length, moved: (activity || []).length, near_cap: nearCap.length, cs_coming: csComing.length, test: Boolean(testRecipient), ok: r.ok, resend_id: r.id, error: r.error },
  });

  return json({ success: r.ok, moved: (activity || []).length, near_cap: nearCap.length, cs_coming: csComing.length, recipients: recipients.length });
});
