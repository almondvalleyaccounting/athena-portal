// ch-code-queue-fill — Athena Portal
// Daily reminder-ladder for CH personal-code chases that QUEUES, never sends.
// Applies the comms policy (config.chase_every_days between emails, capped at
// 1 initial + max_chases per stage) to every open request sitting in a chasing
// stage, renders the right template exactly as the tile buttons do
// (ch_code_email_templates + the shared signature), and inserts a 'queued'
// row on ch_code_email_queue. Sophie reviews the queue and hits "Send All" —
// ch-code-queue-send remains the only path to a client's inbox.
//
// Deliberately conservative:
//   * REMINDERS ONLY — the first email of a stage stays a human decision
//     (emails_sent >= 1 required), so nothing is ever auto-initiated.
//   * Skips requests with a call/escalation flag, with anything already
//     queued, with no email on file, or with no reliable date anchor.
//   * Future-dated anchors (data-entry typos) are surfaced, not queued.
//
// Auth: active-staff JWT (is_portal_admin / can_manage_portal /
// can_view_ch_codes), OR x-cron-secret matching CH_CODE_CHASE_CRON_SECRET
// env / ch_code_chase_config.cron_secret. Cron runs additionally require
// ch_code_chase_config.auto_queue_enabled = true (checked by the SQL wrapper).
//
// Body: { dry_run?: boolean }  — dry_run defaults to TRUE.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CH_CODE_CHASE_CRON_SECRET") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });
}

type Row = Record<string, unknown>;

// ── Rendering: a faithful port of src/modules/ch-codes/emailRender.js so a
// queued reminder is byte-identical to one queued from a tile. Keep in sync. ──
function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function firstNameOf(name: unknown): string {
  const n = String(name ?? "").trim();
  if (!n) return "there";
  return n.split(/\s+/)[0];
}
function fillVars(str: unknown, vars: { first_name: string; person: string; entity: string }): string {
  return String(str ?? "")
    .replace(/\{\{\s*first_name\s*\}\}/g, esc(vars.first_name))
    .replace(/\{\{\s*person\s*\}\}/g, esc(vars.person))
    .replace(/\{\{\s*entity\s*\}\}/g, esc(vars.entity));
}
function wrapShell(innerHtml: string, signatureHtml: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff;">
    <div style="max-width:640px;margin:0;padding:14px 6px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;">
      ${innerHtml}
      ${signatureHtml || ""}
    </div>
  </body></html>`;
}
function htmlToText(html: string): string {
  return String(html ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<li[^>]*>/gi, "\n • ")
    .replace(/<br\s*\/?>(?=)/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|ul|ol)>/gi, "\n")
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function renderTemplate(
  template: { subject: unknown; body_html: unknown },
  vars: { person: string; entity: string },
  signatureHtml: string,
): { subject: string; html: string; text: string } {
  const v = { ...vars, first_name: firstNameOf(vars.person) };
  const subject = fillVars(template.subject, v);
  const body = fillVars(template.body_html, v);
  const html = wrapShell(body, signatureHtml);
  const text = htmlToText(signatureHtml ? `${body}\n${signatureHtml}` : body);
  return { subject, html, text };
}

function firstEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = String(raw).split(/[;,]/)[0].trim();
  return e.includes("@") ? e : null;
}
function daysSince(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(String(dateStr).slice(0, 10) + "T00:00:00Z").getTime();
  if (Number.isNaN(d)) return null;
  return Math.floor((Date.now() - d) / 86400000);
}

// Reminder template per chasing stage — mirrors the tile buttons' kinds.
const KIND_BY_STAGE: Record<string, string> = {
  s1_offer: "reminder",
  s3a_client: "self_verify",
  s3b_us: "id_poa",
  s4_code: "code",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const cronHeader = req.headers.get("x-cron-secret") || "";
  const { data: cfg } = await service.from("ch_code_chase_config").select("*").eq("id", true).maybeSingle();
  const expectedSecret = CRON_SECRET || (cfg?.cron_secret as string) || "";
  if (!(expectedSecret && cronHeader && cronHeader === expectedSecret)) {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ success: false, error: "Missing authorization" }, 401);
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authErr } = await anon.auth.getUser();
    if (authErr || !user) return json({ success: false, error: "Invalid token" }, 401);
    const { data: prof } = await service.from("staff_profiles").select("is_portal_admin, can_manage_portal, can_view_ch_codes").eq("id", user.id).single();
    if (!prof || !(prof.is_portal_admin || prof.can_manage_portal || prof.can_view_ch_codes)) {
      return json({ success: false, error: "Not authorised" }, 403);
    }
  }
  if (!cfg) return json({ success: false, error: "ch_code_chase_config row missing" }, 500);

  const body = await req.json().catch(() => ({}));
  const dryRun = body.dry_run !== false; // default TRUE

  const gapDays = (cfg.chase_every_days as number) ?? 3;
  // Total emails per stage = 1 human-sent initial + max_chases auto reminders.
  const maxEmails = 1 + ((cfg.max_chases as number) ?? 2);

  const [{ data: reqs, error: reqErr }, { data: queueRows }, { data: tpls }] = await Promise.all([
    service.from("ch_code_requests")
      .select("id, stage, status, emails_sent, escalation_status, requested_at, person:people(id, name, email), entity:entities!ch_code_requests_entity_id_fkey(id, name)")
      .in("stage", Object.keys(KIND_BY_STAGE)),
    service.from("ch_code_email_queue").select("request_id, status, sent_at"),
    service.from("ch_code_email_templates").select("*"),
  ]);
  if (reqErr) return json({ success: false, error: reqErr.message }, 500);

  const signatureHtml = (cfg.email_signature_html as string) || "";
  const tplByKind = new Map((tpls || []).map((t: Row) => [t.key as string, t]));

  const pendingByReq = new Set<string>();
  const lastSentByReq = new Map<string, string>();
  for (const q of (queueRows || []) as Row[]) {
    const rid = q.request_id as string;
    if (q.status === "queued") pendingByReq.add(rid);
    if (q.status === "sent" && q.sent_at) {
      const prev = lastSentByReq.get(rid);
      if (!prev || String(q.sent_at) > prev) lastSentByReq.set(rid, String(q.sent_at));
    }
  }

  const toQueue: Array<{ req: Row; kind: string; to: string; daysSince: number }> = [];
  const skipped = { first_email_is_human: 0, capped: 0, escalated: 0, no_email: 0, already_queued: 0, no_anchor: 0, future_anchor: 0, not_due_yet: 0, no_template: 0 };
  const anomalies: Array<Row> = [];

  for (const r of (reqs || []) as Row[]) {
    const sent = (r.emails_sent as number) || 0;
    if ((r.escalation_status as string) !== "none") { skipped.escalated++; continue; }
    if (sent === 0) { skipped.first_email_is_human++; continue; }
    if (sent >= maxEmails) { skipped.capped++; continue; }
    if (pendingByReq.has(r.id as string)) { skipped.already_queued++; continue; }

    const to = firstEmail((r.person as Row)?.email as string);
    if (!to) { skipped.no_email++; continue; }

    const anchor = lastSentByReq.get(r.id as string) || (r.requested_at as string) || null;
    const waited = daysSince(anchor);
    if (waited == null) {
      skipped.no_anchor++;
      anomalies.push({ person: (r.person as Row)?.name, entity: (r.entity as Row)?.name, issue: `${sent} email(s) counted but no date on record — set the emails-sent date or queue by hand` });
      continue;
    }
    if (waited < 0) {
      skipped.future_anchor++;
      anomalies.push({ person: (r.person as Row)?.name, entity: (r.entity as Row)?.name, issue: `last contact is dated in the future (${anchor}) — fix the date` });
      continue;
    }
    if (waited < gapDays) { skipped.not_due_yet++; continue; }

    const kind = KIND_BY_STAGE[r.stage as string];
    if (!tplByKind.has(kind)) { skipped.no_template++; continue; }
    toQueue.push({ req: r, kind, to, daysSince: waited });
  }

  const plan = toQueue.map((t) => ({
    person: (t.req.person as Row)?.name, entity: (t.req.entity as Row)?.name,
    stage: t.req.stage, kind: t.kind, to: t.to,
    email_number: ((t.req.emails_sent as number) || 0) + 1, days_since_last: t.daysSince,
  }));

  if (dryRun) {
    return json({ success: true, dry_run: true, would_queue: plan, skipped, anomalies });
  }

  let queued = 0;
  for (const t of toQueue) {
    const { subject, html, text } = renderTemplate(
      tplByKind.get(t.kind) as { subject: unknown; body_html: unknown },
      { person: ((t.req.person as Row)?.name as string) || "there", entity: ((t.req.entity as Row)?.name as string) || "your company" },
      signatureHtml,
    );
    const { error: insErr } = await service.from("ch_code_email_queue").insert({
      request_id: t.req.id as string, kind: t.kind, to_email: t.to,
      subject, html, text, status: "queued", created_by: null,
    });
    if (insErr) continue;
    queued++;
    await service.from("ch_code_activity").insert({
      request_id: t.req.id as string, kind: "note",
      body: `Auto-queued a ${t.kind.replace(/_/g, " ")} reminder to ${t.to} (${t.daysSince}d since the last email) — review it in the Queue before it sends.`,
    });
  }

  await service.from("audit_log").insert({
    action: "ch_code_queue_filled", entity_type: "ch_code_email_queue", entity_id: null,
    detail: { queued, plan, skipped, anomalies },
  });

  return json({ success: true, dry_run: false, queued, plan, skipped, anomalies });
});
