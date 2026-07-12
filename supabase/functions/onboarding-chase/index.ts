// onboarding-chase — Athena Portal
// Daily chaser for onboarding:
//   1. CLIENT chasers — one friendly email per client listing every
//      waiting-on-client step that is due a nudge (first after the step's
//      chase_after_days, then every chase_every_days, capped at max_chases).
//   2. INTERNAL digest — one email per onboarding owner covering: chasers
//      that went out, waiting-on-HMRC/3rd-party steps past their expected
//      turnaround, non-responsive clients (max chases reached), and clients
//      we could not chase because no email is on file.
//
// SAFETY: dry_run defaults to TRUE. Real sends additionally require
// onboarding_chase_config.sending_enabled = true (test_recipient bypasses
// the gate and routes every email to one address).
//
// Auth: portal-admin JWT, OR x-cron-secret matching
// ONBOARDING_CHASE_CRON_SECRET env / onboarding_chase_config.cron_secret.
//
// Body: { dry_run?: boolean, test_recipient?: string }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("ONBOARDING_CHASE_CRON_SECRET") || "";
const PORTAL_PUBLIC_URL =
  Deno.env.get("PORTAL_PUBLIC_URL") || "https://portal.almondvalleyaccounting.co.uk";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RESEND_FROM_EMAIL =
  Deno.env.get("RESEND_FROM_EMAIL") || "info@almondvalleyaccounting.co.uk";
const RESEND_FROM_NAME =
  Deno.env.get("RESEND_FROM_NAME") || "Almond Valley Accounting";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });
}

async function sendEmail(opts: { to: string; subject: string; html: string; text?: string }) {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({
      from: `${RESEND_FROM_NAME} <${RESEND_FROM_EMAIL}>`,
      to: [opts.to],
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    }),
  });
  const j = await resp.json().catch(() => ({}));
  return { ok: resp.ok, id: (j?.id as string) || null, status: resp.status, error: resp.ok ? undefined : (j?.message || j) };
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function daysSince(dateStr: string | null): number | null {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr + "T00:00:00Z").getTime()) / 86400000);
}
// First email address out of a possibly comma/semicolon separated list
function firstEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = String(raw).split(/[;,]/)[0].trim();
  return e.includes("@") ? e : null;
}

type Step = Record<string, unknown>;
type Ob = Record<string, unknown>;

function clientEmailHtml(entityName: string, steps: Step[], anyReminder: boolean): { html: string; text: string; subject: string } {
  const items = steps.map((s) => `
    <tr><td style="padding:8px 12px;border-top:1px solid #f1f5f9;color:#0f172a;font-size:14px;line-height:1.5;">
      ${esc(s.client_label || s.name)}
    </td></tr>`).join("");
  const lead = anyReminder
    ? "Just a gentle reminder — we're still waiting on a few things to finish getting you set up:"
    : "We're partway through getting you set up, and to keep everything moving we just need a few things from you:";
  const subject = anyReminder
    ? "Reminder: a few things we still need — Almond Valley Accounting"
    : "Getting you set up — a few things we need from you";

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#fafafa;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1e293b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;padding:32px 16px;"><tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;">
        <tr><td style="font-size:15px;font-weight:600;color:#0f172a;padding-bottom:6px;">Hi there,</td></tr>
        <tr><td style="font-size:14px;line-height:1.6;color:#1e293b;">${lead}</td></tr>
        <tr><td style="padding-top:16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
            <tr style="background:#f8fafc;"><td style="padding:8px 12px;font-weight:600;color:#0f172a;font-size:13px;">Still needed (${steps.length})</td></tr>
            ${items}
          </table>
        </td></tr>
        <tr><td style="font-size:14px;line-height:1.6;color:#1e293b;padding-top:18px;">
          The easiest way is to simply <strong>reply to this email</strong> with anything on the list — or let us know if something is stuck and we'll help.
        </td></tr>
        <tr><td style="padding-top:24px;border-top:1px solid #f1f5f9;font-size:11px;color:#94a3b8;text-align:center;">
          Almond Valley Accounting · ${esc(entityName)}
        </td></tr>
      </table>
    </td></tr></table>
  </body></html>`;

  const text = `Hi there,\n\n${lead}\n\n` +
    steps.map((s) => `- ${s.client_label || s.name}`).join("\n") +
    `\n\nThe easiest way is to reply to this email with anything on the list — or let us know if something is stuck and we'll help.\n\nAlmond Valley Accounting`;
  return { html, text, subject };
}

function digestHtml(ownerName: string, sections: {
  chased: Array<{ entity: string; steps: Step[]; to: string | null }>;
  overdueExternal: Array<{ entity: string; step: Step; waited: number }>;
  nonResponsive: Array<{ entity: string; step: Step }>;
  noEmail: Array<{ entity: string; steps: Step[] }>;
  offboard: Array<{ entity: string; pausedDays: number }>;
  handovers: Array<{ entity: string; toName: string; due: string }>;
}, callAssigneeName: string): { html: string; text: string; subject: string } {
  const url = `${PORTAL_PUBLIC_URL}/onboarding`;
  const count = sections.overdueExternal.length + sections.nonResponsive.length + sections.noEmail.length + sections.offboard.length + sections.handovers.length;
  const subject = `Onboarding digest — ${count > 0 ? `${count} item${count === 1 ? "" : "s"} need attention` : "chasers sent"}`;

  const sec = (title: string, rows: string) => rows
    ? `<tr><td style="padding-top:18px;">
        <div style="font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.5px;padding-bottom:6px;">${title}</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:13px;">${rows}</table>
      </td></tr>`
    : "";

  const row = (left: string, right: string, tone = "#64748b") =>
    `<tr><td style="padding:7px 12px;border-top:1px solid #f1f5f9;color:#0f172a;">${left}</td>
     <td style="padding:7px 12px;border-top:1px solid #f1f5f9;color:${tone};text-align:right;white-space:nowrap;">${right}</td></tr>`;

  const chasedRows = sections.chased.map((c) =>
    row(`${esc(c.entity)} — ${c.steps.length} item${c.steps.length === 1 ? "" : "s"}`, esc(c.to || ""))).join("");
  const overdueRows = sections.overdueExternal.map((o) =>
    row(`${esc(o.entity)} — ${esc(o.step.name)}`, `${o.waited}d waited (expect ~${o.step.expected_days}d)`, "#dc2626")).join("");
  const nonRespRows = sections.nonResponsive.map((n) =>
    row(`${esc(n.entity)} — ${esc(n.step.client_label || n.step.name)}`, `${n.step.chase_count} chases, no response`, "#dc2626")).join("");
  const noEmailRows = sections.noEmail.map((n) =>
    row(`${esc(n.entity)} — ${n.steps.length} item${n.steps.length === 1 ? "" : "s"} due a chase`, "no email on file", "#d97706")).join("");
  const offboardRows = sections.offboard.map((n) =>
    row(esc(n.entity), `paused ${n.pausedDays}d — review & offboard?`, "#dc2626")).join("");
  const handoverRows = sections.handovers.map((h) =>
    row(esc(h.entity), `hand over to ${esc(h.toName)} (due ${esc(h.due)})`, "#d97706")).join("");

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#fafafa;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1e293b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;padding:32px 16px;"><tr><td align="center">
      <table role="presentation" width="620" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;">
        <tr><td style="font-size:15px;font-weight:600;color:#0f172a;padding-bottom:6px;">Hi ${esc(ownerName || "there")},</td></tr>
        <tr><td style="font-size:14px;line-height:1.6;color:#1e293b;">Today's onboarding round-up for the clients you own.</td></tr>
        ${sec("Client chasers sent today", chasedRows)}
        ${sec("Waiting on HMRC / 3rd party — overdue", overdueRows)}
        ${sec(`Non-responsive — needs a call (${esc(callAssigneeName)})`, nonRespRows)}
        ${sec("Paused clients — offboard due", offboardRows)}
        ${sec("Handovers due", handoverRows)}
        ${sec("Couldn't chase — no email on file", noEmailRows)}
        <tr><td style="padding:20px 0 4px;">
          <a href="${esc(url)}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;font-size:14px;">Open onboarding in Athena</a>
        </td></tr>
        <tr><td style="padding-top:24px;border-top:1px solid #f1f5f9;font-size:11px;color:#94a3b8;text-align:center;">Almond Valley Accounting · Athena onboarding chaser</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;

  const text = `Hi ${ownerName || "there"},\n\nToday's onboarding round-up:\n` +
    (sections.chased.length ? `\nChasers sent:\n${sections.chased.map((c) => `- ${c.entity}: ${c.steps.length} item(s) → ${c.to}`).join("\n")}\n` : "") +
    (sections.overdueExternal.length ? `\nOverdue with HMRC/3rd party:\n${sections.overdueExternal.map((o) => `- ${o.entity}: ${o.step.name} (${o.waited}d, expect ~${o.step.expected_days}d)`).join("\n")}\n` : "") +
    (sections.nonResponsive.length ? `\nNon-responsive (call: ${callAssigneeName}):\n${sections.nonResponsive.map((n) => `- ${n.entity}: ${n.step.client_label || n.step.name} (${n.step.chase_count} chases)`).join("\n")}\n` : "") +
    (sections.offboard.length ? `\nPaused — offboard due:\n${sections.offboard.map((n) => `- ${n.entity} (paused ${n.pausedDays}d)`).join("\n")}\n` : "") +
    (sections.handovers.length ? `\nHandovers due:\n${sections.handovers.map((h) => `- ${h.entity} → ${h.toName} (due ${h.due})`).join("\n")}\n` : "") +
    (sections.noEmail.length ? `\nNo email on file:\n${sections.noEmail.map((n) => `- ${n.entity} (${n.steps.length} item(s) due)`).join("\n")}\n` : "") +
    `\nOpen onboarding: ${url}`;
  return { html, text, subject };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── Auth: cron secret OR portal-admin JWT ──
  const cronHeader = req.headers.get("x-cron-secret") || "";
  const { data: cfg } = await service.from("onboarding_chase_config").select("*").eq("id", true).maybeSingle();
  const expectedSecret = CRON_SECRET || (cfg?.cron_secret as string) || "";
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
  if (!cfg) return json({ success: false, error: "onboarding_chase_config row missing" }, 500);

  const body = await req.json().catch(() => ({}));
  const dryRun = body.dry_run !== false; // default TRUE
  const testRecipient: string | null = body.test_recipient || null;

  // ── Load active onboardings with steps + contact candidates ──
  const { data: obs, error: obsErr } = await service
    .from("onboardings")
    .select(`
      id, status, entity_id, owner_id, escalation_status, escalated_at, paused_at,
      handover_due, handover_done_at,
      handover:staff_profiles!onboardings_handover_to_fkey(name),
      entity:entities!onboardings_entity_id_fkey(id, name, billing_email, prospect_email, ch_auth_code, vat_number, utr, paye_ref),
      owner:staff_profiles!onboardings_owner_id_fkey(id, name, email, is_active),
      steps:onboarding_steps(*)
    `)
    .eq("status", "active");
  if (obsErr) return json({ success: false, error: obsErr.message }, 500);

  // ── BM cross-reference sweep: complete steps the BrightManager record
  // already proves are done (auth code / VAT number / UTR / PAYE ref on the
  // entity). Idempotent verification, so it runs on dry runs too.
  const BM_FIELD_BY_CHECK: Record<string, string> = {
    bm_ch_auth_code: "ch_auth_code", bm_vat_number: "vat_number", bm_utr: "utr", bm_paye_ref: "paye_ref",
  };
  let autoVerified = 0;
  if (!testRecipient) {
    for (const o of (obs || []) as Ob[]) {
      const ent = o.entity as Ob;
      for (const s of (o.steps as Step[]) || []) {
        const field = BM_FIELD_BY_CHECK[s.auto_check as string];
        if (!field || ["complete", "na"].includes(s.status as string)) continue;
        const val = ent?.[field];
        if (val) {
          await service.from("onboarding_steps").update({
            status: "complete", completed_at: new Date().toISOString(),
            note: `Auto-verified: ${field.replace(/_/g, " ")} is on the BrightManager record`,
          }).eq("id", s.id);
          await service.from("onboarding_activity").insert({
            onboarding_id: o.id, step_id: s.id, kind: "system",
            body: `Auto-verified from BM data: "${s.name}" — ${field.replace(/_/g, " ")} is now on record.`,
          });
          s.status = "complete";
          autoVerified++;
        }
      }
    }
  }

  // Call assignee for the escalation ladder (configurable; Sophie by default)
  let callAssigneeName = "the onboarding owner";
  if (cfg.call_assignee_id) {
    const { data: ca } = await service.from("staff_profiles").select("name").eq("id", cfg.call_assignee_id).maybeSingle();
    if (ca?.name) callAssigneeName = ca.name as string;
  }

  const entityIds = (obs || []).map((o: Ob) => o.entity_id);
  const [{ data: qboRows }, { data: bmRows }] = await Promise.all([
    entityIds.length
      ? service.from("qbo_customer_mappings").select("entity_id, qbo_email").in("entity_id", entityIds).not("qbo_email", "is", null)
      : Promise.resolve({ data: [] }),
    entityIds.length
      ? service.from("entity_people").select("entity_id, is_primary_contact, person:people(email)").in("entity_id", entityIds).eq("is_primary_contact", true)
      : Promise.resolve({ data: [] }),
  ]);
  const qboEmail = new Map<string, string>();
  for (const r of (qboRows || []) as Ob[]) {
    if (!qboEmail.has(r.entity_id as string)) {
      const e = firstEmail(r.qbo_email as string);
      if (e) qboEmail.set(r.entity_id as string, e);
    }
  }
  const bmEmail = new Map<string, string>();
  for (const r of (bmRows || []) as Ob[]) {
    const e = firstEmail((r.person as Ob | null)?.email as string);
    if (e && !bmEmail.has(r.entity_id as string)) bmEmail.set(r.entity_id as string, e);
  }
  const resolveEmail = (o: Ob): string | null => {
    const ent = o.entity as Ob;
    return firstEmail(ent?.billing_email as string)
      || firstEmail(ent?.prospect_email as string)
      || qboEmail.get(o.entity_id as string)
      || bmEmail.get(o.entity_id as string)
      || null;
  };

  // ── Classify steps ──
  const today = new Date().toISOString().slice(0, 10);
  const chases: Array<{ ob: Ob; entity: string; to: string | null; steps: Step[] }> = [];
  const offboardDue: Ob[] = [];
  const perOwner = new Map<string, {
    name: string; email: string | null;
    chased: Array<{ entity: string; steps: Step[]; to: string | null }>;
    overdueExternal: Array<{ entity: string; step: Step; waited: number }>;
    nonResponsive: Array<{ entity: string; step: Step }>;
    noEmail: Array<{ entity: string; steps: Step[] }>;
    offboard: Array<{ entity: string; pausedDays: number }>;
    handovers: Array<{ entity: string; toName: string; due: string }>;
  }>();

  const ownerBucket = (o: Ob) => {
    const owner = o.owner as Ob | null;
    const key = (owner?.id as string) || "unowned";
    if (!perOwner.has(key)) {
      perOwner.set(key, {
        name: (owner?.name as string) || "team",
        email: owner && owner.is_active !== false ? firstEmail(owner.email as string) : null,
        chased: [], overdueExternal: [], nonResponsive: [], noEmail: [], offboard: [], handovers: [],
      });
    }
    return perOwner.get(key)!;
  };

  for (const o of (obs || []) as Ob[]) {
    const entityName = ((o.entity as Ob)?.name as string) || "Unknown client";
    const bucket = ownerBucket(o);
    const escalation = (o.escalation_status as string) || "none";

    // Handover past due → remind the buddy in the digest
    if (o.handover_due && !o.handover_done_at && daysSince(o.handover_due as string) !== null && (daysSince(o.handover_due as string) as number) >= 0) {
      bucket.handovers.push({
        entity: entityName,
        toName: ((o.handover as Ob | null)?.name as string) || "their permanent team member",
        due: o.handover_due as string,
      });
    }

    // Paused past the offboard window → flag for a human decision
    if (["paused", "offboard_due"].includes(escalation)) {
      const pausedDays = daysSince(o.paused_at as string);
      if (pausedDays != null && pausedDays >= (cfg.offboard_after_days as number)) {
        bucket.offboard.push({ entity: entityName, pausedDays });
        if (escalation === "paused") offboardDue.push(o);
      }
    }

    const due: Step[] = [];
    for (const s of (o.steps as Step[]) || []) {
      if (s.status === "waiting_external") {
        const waited = daysSince(s.requested_at as string);
        if (waited != null && s.expected_days != null && waited > (s.expected_days as number)) {
          bucket.overdueExternal.push({ entity: entityName, step: s, waited });
        }
        continue;
      }
      if (s.owner_type !== "client" || s.status !== "waiting_client" || !s.requested_at) continue;
      // The pause email means what it says — no more client emails
      if (["paused", "offboard_due"].includes(escalation)) continue;
      const count = (s.chase_count as number) || 0;
      if (count >= (cfg.max_chases as number)) {
        bucket.nonResponsive.push({ entity: entityName, step: s });
        continue;
      }
      const anchor = (s.last_chased_at as string) || (s.requested_at as string);
      const waited = daysSince(anchor);
      const threshold = count === 0
        ? ((s.chase_after_days as number) ?? (cfg.first_chase_after_days as number))
        : (cfg.chase_every_days as number);
      if (waited != null && waited >= threshold) due.push(s);
    }
    if (due.length) {
      const to = resolveEmail(o);
      if (to) {
        chases.push({ ob: o, entity: entityName, to, steps: due });
        bucket.chased.push({ entity: entityName, steps: due, to });
      } else {
        bucket.noEmail.push({ entity: entityName, steps: due });
      }
    }
  }

  const digests = Array.from(perOwner.values()).filter((b) =>
    b.chased.length || b.overdueExternal.length || b.nonResponsive.length || b.noEmail.length || b.offboard.length || b.handovers.length);

  if (dryRun) {
    return json({
      success: true, dry_run: true, sending_enabled: cfg.sending_enabled, auto_verified: autoVerified,
      client_chases: chases.map((c) => ({
        entity: c.entity, to: testRecipient || c.to,
        steps: c.steps.map((s) => ({ name: s.name, ask: s.client_label || s.name, chase_number: ((s.chase_count as number) || 0) + 1 })),
      })),
      digests: digests.map((b) => ({
        owner: b.name, to: testRecipient || b.email,
        chasers: b.chased.length, overdue_external: b.overdueExternal.length,
        non_responsive: b.nonResponsive.length, no_email: b.noEmail.length,
        offboard_due: b.offboard.length, handovers_due: b.handovers.length,
      })),
    });
  }

  // Safety gate: real sends require sending_enabled (test sends exempt)
  if (!testRecipient && !cfg.sending_enabled) {
    return json({ success: false, error: "Sending is disabled (onboarding_chase_config.sending_enabled = false). Use test_recipient, or enable sending once tested." }, 409);
  }

  const results: Array<Record<string, unknown>> = [];

  // ── Send client chasers ──
  for (const c of chases) {
    const to = testRecipient || c.to!;
    const anyReminder = c.steps.some((s) => ((s.chase_count as number) || 0) > 0);
    const { html, text, subject } = clientEmailHtml(c.entity, c.steps, anyReminder);
    const r = await sendEmail({ to, subject, html, text });
    results.push({ kind: "client_chase", entity: c.entity, to, ok: r.ok, resend_id: r.id, error: r.error });

    if (r.ok && !testRecipient) {
      for (const s of c.steps) {
        const newCount = ((s.chase_count as number) || 0) + 1;
        await service.from("onboarding_steps").update({ last_chased_at: today, chase_count: newCount }).eq("id", s.id);
        await service.from("onboarding_activity").insert({
          onboarding_id: (c.ob as Ob).id, step_id: s.id, kind: "email_out",
          body: `Chase #${newCount} emailed to ${to}: ${s.client_label || s.name}`,
        });
        if (newCount >= (cfg.max_chases as number)) {
          await service.from("onboarding_activity").insert({
            onboarding_id: (c.ob as Ob).id, step_id: s.id, kind: "system",
            body: `Client non-responsive: ${newCount} chases sent for "${s.client_label || s.name}" with no response — escalated: ${callAssigneeName} to call.`,
          });
          // Escalation ladder: emails exhausted → a human calls
          if ((((c.ob as Ob).escalation_status as string) || "none") === "none") {
            await service.from("onboardings").update({
              escalation_status: "call_needed", escalated_at: today,
            }).eq("id", (c.ob as Ob).id);
            (c.ob as Ob).escalation_status = "call_needed";
          }
        }
      }
    }
    await service.from("audit_log").insert({
      user_id: callerId, action: "onboarding_chase_sent", entity_type: "onboarding",
      entity_id: (c.ob as Ob).id, detail: { to, steps: c.steps.length, resend_id: r.id, ok: r.ok, test: Boolean(testRecipient) },
    });
    if (testRecipient) break; // one sample client email on test sends
  }

  // ── Persist offboard-due flags (paused past the configurable window) ──
  if (!testRecipient) {
    for (const o of offboardDue) {
      await service.from("onboardings").update({ escalation_status: "offboard_due" }).eq("id", o.id);
      await service.from("onboarding_activity").insert({
        onboarding_id: o.id, kind: "system",
        body: `Paused for ${cfg.offboard_after_days}+ days with no response — flagged for offboarding. Review and archive if appropriate.`,
      });
    }
  }

  // ── Send internal digests ──
  if (cfg.internal_digest_enabled) {
    for (const b of digests) {
      const to = testRecipient || b.email;
      if (!to) { results.push({ kind: "digest", owner: b.name, ok: false, error: "owner has no email" }); continue; }
      const { html, text, subject } = digestHtml(b.name, b, callAssigneeName);
      const r = await sendEmail({ to, subject, html, text });
      results.push({ kind: "digest", owner: b.name, to, ok: r.ok, resend_id: r.id, error: r.error });
      if (testRecipient) break; // one sample digest on test sends
    }
  }

  return json({ success: true, dry_run: false, auto_verified: autoVerified, sent: results.filter((r) => r.ok).length, results });
});
