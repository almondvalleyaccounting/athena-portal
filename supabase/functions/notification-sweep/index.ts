// notification-sweep — Athena Portal
// Nightly (weekday 06:30) generator of stuck-state nudges + the daily
// internal digest email. Staff-only — no client email is ever involved.
//
// Nudges (idempotent via notifications.source_key; pre-checked then inserted
// because PostgREST can't target the partial unique index):
//   1. Accepted quote uncommitted 14+ days → everyone with can_approve_quotes
//      (source_key quote_uncommitted:<quote_id> — fires once per quote).
//   2. Suggested billing lines older than 7 days → can_view_client_fees staff
//      (source_key billing_suggested:<iso-week> — at most one nudge a week
//      while any remain).
//   3. Mandatory training missing / due (≤60d) / overdue → that staff member
//      (source_key mandatory:<training_id>:<iso-week> — weekly while open).
//
// Digest: one email per staff member with UNREAD notifications created in the
// last 25 hours (so nothing nags forever, and yesterday's read items don't
// re-send). Sent via Resend from the internal sender.
//
// Auth: x-cron-secret matching notification_config.cron_secret, OR a
// portal-admin JWT. Body: { dry_run?: boolean } — dry_run defaults FALSE
// (the whole function is internal and idempotent).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PORTAL_PUBLIC_URL = Deno.env.get("PORTAL_PUBLIC_URL") || "https://portal.almondvalleyaccounting.co.uk";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RESEND_FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") || "info@almondvalleyaccounting.co.uk";
const RESEND_FROM_NAME = Deno.env.get("RESEND_FROM_NAME") || "Athena";

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
function firstEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = String(raw).split(/[;,]/)[0].trim();
  return e.includes("@") ? e : null;
}
function isoWeek(d = new Date()): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((t.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
async function sendEmail(opts: { to: string; subject: string; html: string; text?: string }) {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({ from: `${RESEND_FROM_NAME} <${RESEND_FROM_EMAIL}>`, to: [opts.to], subject: opts.subject, html: opts.html, text: opts.text }),
  });
  const j = await resp.json().catch(() => ({}));
  return { ok: resp.ok, id: (j?.id as string) || null, error: resp.ok ? undefined : (j?.message || j) };
}

type Row = Record<string, unknown>;
type Pending = { recipient_id: string; kind: string; title: string; body?: string | null; link_path?: string | null; source_key: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const cronHeader = req.headers.get("x-cron-secret") || "";
  const { data: cfg } = await service.from("notification_config").select("*").eq("id", true).maybeSingle();
  const expectedSecret = (cfg?.cron_secret as string) || "";
  if (!(expectedSecret && cronHeader && cronHeader === expectedSecret)) {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ success: false, error: "Missing authorization" }, 401);
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authErr } = await anon.auth.getUser();
    if (authErr || !user) return json({ success: false, error: "Invalid token" }, 401);
    const { data: prof } = await service.from("staff_profiles").select("is_portal_admin, can_manage_portal").eq("id", user.id).single();
    if (!prof || !(prof.is_portal_admin || prof.can_manage_portal)) return json({ success: false, error: "Not authorised" }, 403);
  }
  if (!cfg) return json({ success: false, error: "notification_config row missing" }, 500);

  const { data: staff } = await service.from("staff_profiles")
    .select("id, name, email, is_active, can_approve_quotes, can_view_client_fees")
    .eq("is_active", true);
  const activeStaff = (staff || []) as Row[];
  const week = isoWeek();
  const pending: Pending[] = [];

  if (cfg.sweep_enabled) {
    // 1. Accepted quotes uncommitted 14+ days
    const cutoff14 = new Date(Date.now() - 14 * 86400000).toISOString();
    const { data: staleQuotes } = await service.from("quotes")
      .select("id, quote_ref, relationship_group, accepted_at")
      .eq("status", "accepted").is("committed_at", null).lt("accepted_at", cutoff14);
    const approvers = activeStaff.filter((s) => s.can_approve_quotes);
    for (const q of (staleQuotes || []) as Row[]) {
      const days = Math.floor((Date.now() - new Date(q.accepted_at as string).getTime()) / 86400000);
      for (const s of approvers) {
        pending.push({
          recipient_id: s.id as string, kind: "quote_uncommitted",
          title: `Accepted quote sitting uncommitted ${days} days: ${q.relationship_group || q.quote_ref}`,
          link_path: `/manage/quotes/${q.id}`, source_key: `quote_uncommitted:${q.id}`,
        });
      }
    }

    // 2. Suggested billing lines older than 7 days (one weekly aggregate)
    const cutoff7 = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data: lbRows } = await service.from("live_billing")
      .select("id, services, created_at").eq("status", "active").lt("created_at", cutoff7);
    let suggested = 0;
    for (const r of (lbRows || []) as Row[]) {
      const services = Array.isArray(r.services) ? (r.services as Row[]) : [];
      suggested += services.filter((s) => (s.approval_status || "suggested") === "suggested" && s.recurring_status !== "ending").length;
    }
    if (suggested > 0) {
      for (const s of activeStaff.filter((x) => x.can_view_client_fees)) {
        pending.push({
          recipient_id: s.id as string, kind: "billing_suggested",
          title: `${suggested} billing line${suggested === 1 ? "" : "s"} waiting in the approval queue for 7+ days`,
          link_path: "/manage/billing/review", source_key: `billing_suggested:${week}`,
        });
      }
    }

    // 3. Mandatory training missing / due / overdue → the person, weekly
    const [{ data: trainings }, { data: completions }] = await Promise.all([
      service.from("pd_mandatory_training").select("id, name, renewal_months").eq("active", true),
      service.from("pd_mandatory_completion").select("staff_id, training_id, completed_on, expires_on").order("completed_on", { ascending: false }),
    ]);
    const latest = new Map<string, Row>();
    for (const c of (completions || []) as Row[]) {
      const key = `${c.staff_id}::${c.training_id}`;
      if (!latest.has(key)) latest.set(key, c);
    }
    const soon = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    for (const t of (trainings || []) as Row[]) {
      for (const s of activeStaff) {
        const c = latest.get(`${s.id}::${t.id}`);
        let status: string | null = null;
        if (!c) status = "missing";
        else if (c.expires_on && String(c.expires_on) <= today) status = "overdue";
        else if (c.expires_on && String(c.expires_on) <= soon) status = "due soon";
        if (!status) continue;
        pending.push({
          recipient_id: s.id as string, kind: "mandatory_training",
          title: `Mandatory training ${status}: ${t.name}`,
          link_path: "/team/pd/mandatory", source_key: `mandatory:${t.id}:${week}`,
        });
      }
    }
  }

  // Insert with manual dedupe (PostgREST can't target the partial unique index).
  let created = 0;
  if (pending.length) {
    const keys = [...new Set(pending.map((p) => p.source_key))];
    const { data: existing } = await service.from("notifications")
      .select("recipient_id, source_key").in("source_key", keys);
    const seen = new Set((existing || []).map((r: Row) => `${r.recipient_id}::${r.source_key}`));
    const fresh = pending.filter((p) => !seen.has(`${p.recipient_id}::${p.source_key}`));
    if (fresh.length) {
      const { error: insErr } = await service.from("notifications").insert(fresh);
      if (!insErr) created = fresh.length;
    }
  }

  // ── Daily internal digest: unread from the last 25h, one email per person ──
  const digests: Row[] = [];
  if (cfg.digest_enabled) {
    const since = new Date(Date.now() - 25 * 3600000).toISOString();
    const { data: unread } = await service.from("notifications")
      .select("recipient_id, title, link_path, created_at")
      .is("read_at", null).gte("created_at", since)
      .order("created_at", { ascending: false });
    const byRecipient = new Map<string, Row[]>();
    for (const n of (unread || []) as Row[]) {
      const rid = n.recipient_id as string;
      if (!byRecipient.has(rid)) byRecipient.set(rid, []);
      byRecipient.get(rid)!.push(n);
    }
    for (const [rid, items] of byRecipient) {
      const person = activeStaff.find((s) => s.id === rid);
      const to = firstEmail(person?.email as string);
      if (!to) continue;
      const rows = items.slice(0, 12).map((n) =>
        `<tr><td style="padding:7px 12px;border-top:1px solid #f1f5f9;font-size:13px;color:#0f172a;">
           <a href="${esc(PORTAL_PUBLIC_URL + (n.link_path || "/home"))}" style="color:#0f172a;text-decoration:none;">${esc(n.title)}</a>
         </td></tr>`).join("");
      const subject = `Athena — ${items.length} thing${items.length === 1 ? "" : "s"} for you`;
      const html = `<!doctype html><html><body style="margin:0;padding:0;background:#fafafa;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1e293b;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;padding:32px 16px;"><tr><td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;">
            <tr><td style="font-size:15px;font-weight:600;color:#0f172a;padding-bottom:6px;">Hi ${esc(String(person?.name || "there").split(" ")[0])},</td></tr>
            <tr><td style="font-size:14px;line-height:1.6;color:#1e293b;">New in Athena since yesterday:</td></tr>
            <tr><td style="padding-top:12px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">${rows}</table></td></tr>
            ${items.length > 12 ? `<tr><td style="font-size:12px;color:#94a3b8;padding-top:8px;">…and ${items.length - 12} more in the bell.</td></tr>` : ""}
            <tr><td style="padding:20px 0 4px;"><a href="${esc(PORTAL_PUBLIC_URL + "/home")}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;font-size:14px;">Open Athena</a></td></tr>
          </table>
        </td></tr></table>
      </body></html>`;
      const text = `Hi ${String(person?.name || "there").split(" ")[0]},\n\nNew in Athena since yesterday:\n` +
        items.slice(0, 12).map((n) => `- ${n.title} (${PORTAL_PUBLIC_URL}${n.link_path || "/home"})`).join("\n") +
        (items.length > 12 ? `\n…and ${items.length - 12} more in the bell.` : "");
      const r = await sendEmail({ to, subject, html, text });
      digests.push({ to, count: items.length, ok: r.ok, error: r.error });
    }
  }

  return json({ success: true, nudges_created: created, digests });
});
