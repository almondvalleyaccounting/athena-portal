// ch-code-chase — Athena Portal
// Chaser for Companies House personal-code verification (directors/PSCs):
//   1. SEED — one open ch_code_requests row per person who is a director or
//      PSC (entity_people.role='director' or source='ch_psc') and has no
//      people.ch_personal_code yet. Anchor entity = their is_primary_contact
//      link if present, else the first link on record.
//   2. OFFER — email explaining the choice (AVA obtains it for £20+VAT with
//      ID+POA, or the client self-serves via GOV.UK One Login) → awaiting_decision.
//   3. CHASE ladder — nudges for awaiting_decision / awaiting_id_poa /
//      awaiting_code, same shape as onboarding-chase: first_chase_after_days,
//      then chase_every_days, capped at max_chases → escalation_status
//      'call_needed' (Sophie calls). No further movement after
//      stalled_after_days → 'escalated_tracy'.
//   4. INTERNAL DIGEST — offers sent, chasers sent, call-needed list,
//      escalated-to-Tracy list, no-email-on-file list.
//
// Response capture (decision / ID+POA / code) is manual for now — staff log
// it in the Athena ch-codes UI from a phone call or email reply, exactly how
// onboarding chasers work today. This function only drives outbound chasing.
//
// SAFETY: dry_run defaults to TRUE. Real sends additionally require
// ch_code_chase_config.sending_enabled = true (test_recipient bypasses the
// gate and routes every email to one address).
//
// Auth: active-staff JWT (can_manage_portal or can_view_ch_codes), OR
// x-cron-secret matching CH_CODE_CHASE_CRON_SECRET env / config.cron_secret.
//
// Body: { dry_run?: boolean, test_recipient?: string }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CH_CODE_CHASE_CRON_SECRET") || "";
const PORTAL_PUBLIC_URL = Deno.env.get("PORTAL_PUBLIC_URL") || "https://portal.almondvalleyaccounting.co.uk";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RESEND_FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") || "info@almondvalleyaccounting.co.uk";
const RESEND_FROM_NAME = Deno.env.get("RESEND_FROM_NAME") || "Almond Valley Accounting";

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
    body: JSON.stringify({ from: `${RESEND_FROM_NAME} <${RESEND_FROM_EMAIL}>`, to: [opts.to], subject: opts.subject, html: opts.html, text: opts.text }),
  });
  const j = await resp.json().catch(() => ({}));
  return { ok: resp.ok, id: (j?.id as string) || null, error: resp.ok ? undefined : (j?.message || j) };
}
function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function daysSince(dateStr: string | null): number | null {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr + "T00:00:00Z").getTime()) / 86400000);
}
function firstEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = String(raw).split(/[;,]/)[0].trim();
  return e.includes("@") ? e : null;
}

type Row = Record<string, unknown>;

function offerEmailHtml(personName: string, entityName: string): { html: string; text: string; subject: string } {
  const subject = "Action needed — your Companies House ID verification";
  const lead = `Companies House now requires every director and person with significant control to verify their identity and get a personal code before we can file ${esc(entityName)}'s Confirmation Statement. You have two options:`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#fafafa;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1e293b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;padding:32px 16px;"><tr><td align="center">
      <table role="presentation" width="580" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;">
        <tr><td style="font-size:15px;font-weight:600;color:#0f172a;padding-bottom:6px;">Hi ${esc(personName)},</td></tr>
        <tr><td style="font-size:14px;line-height:1.6;color:#1e293b;">${lead}</td></tr>
        <tr><td style="padding-top:16px;">
          <div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin-bottom:10px;">
            <div style="font-weight:700;color:#0f172a;font-size:13.5px;margin-bottom:4px;">Option 1 — We do it for you (£20 + VAT)</div>
            <div style="font-size:13px;color:#475569;line-height:1.5;">Send us a form of photo ID and a recent proof of address — we'll verify your identity as an authorised agent. Just reply to this email to choose this option.</div>
          </div>
          <div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;">
            <div style="font-weight:700;color:#0f172a;font-size:13.5px;margin-bottom:4px;">Option 2 — You verify yourself (free)</div>
            <div style="font-size:13px;color:#475569;line-height:1.5;">Verify your identity at <strong>gov.uk</strong> using GOV.UK One Login, then forward us the personal code. Reply to this email to let us know you're taking this route.</div>
          </div>
        </td></tr>
        <tr><td style="font-size:13px;line-height:1.6;color:#64748b;padding-top:16px;">
          One important note either way: Companies House emails the code straight to <strong>your own inbox</strong>, never to us — so whichever option you pick, we'll still need you to forward us the code once you have it.
        </td></tr>
        <tr><td style="padding-top:24px;border-top:1px solid #f1f5f9;font-size:11px;color:#94a3b8;text-align:center;">Almond Valley Accounting · ${esc(entityName)}</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
  const text = `Hi ${personName},\n\n${lead}\n\nOption 1 — We do it for you (£20 + VAT): send us photo ID + proof of address, reply to this email to choose this.\nOption 2 — You verify yourself (free): verify at gov.uk via GOV.UK One Login, reply to let us know.\n\nEither way, Companies House emails the code to your own inbox, not to us — please forward it to us once you have it.\n\nAlmond Valley Accounting`;
  return { html, text, subject };
}

function chaseEmailHtml(personName: string, entityName: string, status: string): { html: string; text: string; subject: string } {
  const ask = status === "awaiting_decision"
    ? "let us know which option you'd like for your Companies House ID verification (we do it for £20+VAT with your ID+POA, or you self-verify at gov.uk)"
    : status === "awaiting_id_poa"
      ? "send over a form of photo ID and a recent proof of address so we can verify your identity"
      : "forward us your Companies House personal code once you have it (Companies House will have emailed it to you directly)";
  const subject = "Reminder — your Companies House ID verification";
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#fafafa;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1e293b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;padding:32px 16px;"><tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;">
        <tr><td style="font-size:15px;font-weight:600;color:#0f172a;padding-bottom:6px;">Hi ${esc(personName)},</td></tr>
        <tr><td style="font-size:14px;line-height:1.6;color:#1e293b;">Just a gentle reminder — we still need you to ${esc(ask)}, so we can keep ${esc(entityName)}'s Confirmation Statement on track.</td></tr>
        <tr><td style="font-size:14px;line-height:1.6;color:#1e293b;padding-top:14px;">The easiest way is to simply <strong>reply to this email</strong>.</td></tr>
        <tr><td style="padding-top:24px;border-top:1px solid #f1f5f9;font-size:11px;color:#94a3b8;text-align:center;">Almond Valley Accounting · ${esc(entityName)}</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
  const text = `Hi ${personName},\n\nJust a gentle reminder — we still need you to ${ask}, so we can keep ${entityName}'s Confirmation Statement on track.\n\nReply to this email.\n\nAlmond Valley Accounting`;
  return { html, text, subject };
}

function digestHtml(sections: {
  offered: Array<{ person: string; entity: string }>;
  chased: Array<{ person: string; entity: string; status: string }>;
  callNeeded: Array<{ person: string; entity: string }>;
  escalatedTracy: Array<{ person: string; entity: string }>;
  noEmail: Array<{ person: string; entity: string }>;
}): { html: string; text: string; subject: string } {
  const url = `${PORTAL_PUBLIC_URL}/ch-codes`;
  const count = sections.callNeeded.length + sections.escalatedTracy.length + sections.noEmail.length;
  const subject = `CH code chaser — ${count > 0 ? `${count} item${count === 1 ? "" : "s"} need attention` : "chasers sent"}`;
  const sec = (title: string, rows: string) => rows
    ? `<tr><td style="padding-top:18px;"><div style="font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.5px;padding-bottom:6px;">${title}</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:13px;">${rows}</table></td></tr>`
    : "";
  const row = (left: string, right: string, tone = "#64748b") =>
    `<tr><td style="padding:7px 12px;border-top:1px solid #f1f5f9;color:#0f172a;">${left}</td>
     <td style="padding:7px 12px;border-top:1px solid #f1f5f9;color:${tone};text-align:right;white-space:nowrap;">${right}</td></tr>`;
  const offeredRows = sections.offered.map((o) => row(`${esc(o.person)} — ${esc(o.entity)}`, "offer sent")).join("");
  const chasedRows = sections.chased.map((c) => row(`${esc(c.person)} — ${esc(c.entity)}`, esc(c.status.replace(/_/g, " ")))).join("");
  const callRows = sections.callNeeded.map((c) => row(`${esc(c.person)} — ${esc(c.entity)}`, "call needed", "#dc2626")).join("");
  const tracyRows = sections.escalatedTracy.map((c) => row(`${esc(c.person)} — ${esc(c.entity)}`, "escalated to Tracy", "#dc2626")).join("");
  const noEmailRows = sections.noEmail.map((c) => row(`${esc(c.person)} — ${esc(c.entity)}`, "no email on file", "#d97706")).join("");
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#fafafa;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1e293b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;padding:32px 16px;"><tr><td align="center">
      <table role="presentation" width="620" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;">
        <tr><td style="font-size:15px;font-weight:600;color:#0f172a;padding-bottom:6px;">Hi,</td></tr>
        <tr><td style="font-size:14px;line-height:1.6;color:#1e293b;">Today's Companies House personal-code round-up.</td></tr>
        ${sec("Offers sent today", offeredRows)}
        ${sec("Chasers sent today", chasedRows)}
        ${sec("Needs a call", callRows)}
        ${sec("Escalated to Tracy", tracyRows)}
        ${sec("Couldn't chase — no email on file", noEmailRows)}
        <tr><td style="padding:20px 0 4px;"><a href="${esc(url)}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;font-size:14px;">Open in Athena</a></td></tr>
        <tr><td style="padding-top:24px;border-top:1px solid #f1f5f9;font-size:11px;color:#94a3b8;text-align:center;">Almond Valley Accounting · CH code chaser</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
  const text = `Today's CH code round-up:\n` +
    (sections.offered.length ? `\nOffers sent:\n${sections.offered.map((o) => `- ${o.person} (${o.entity})`).join("\n")}\n` : "") +
    (sections.chased.length ? `\nChasers sent:\n${sections.chased.map((c) => `- ${c.person} (${c.entity}) — ${c.status}`).join("\n")}\n` : "") +
    (sections.callNeeded.length ? `\nNeeds a call:\n${sections.callNeeded.map((c) => `- ${c.person} (${c.entity})`).join("\n")}\n` : "") +
    (sections.escalatedTracy.length ? `\nEscalated to Tracy:\n${sections.escalatedTracy.map((c) => `- ${c.person} (${c.entity})`).join("\n")}\n` : "") +
    (sections.noEmail.length ? `\nNo email on file:\n${sections.noEmail.map((c) => `- ${c.person} (${c.entity})`).join("\n")}\n` : "") +
    `\nOpen in Athena: ${url}`;
  return { html, text, subject };
}

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
  const testRecipient: string | null = body.test_recipient || null;

  // Former clients (nlac/archived): we do no work for them, so we never seed a
  // code request against them and never chase one that already exists. A
  // director of BOTH a current and a former client is still chased (anchored to
  // the current one), because we drop the former-client links, not the person.
  const { data: formerRows } = await service
    .from("entities").select("id").in("entity_status", ["nlac", "archived"]);
  const formerEntities = new Set((formerRows || []).map((e: Row) => e.id as string));

  // ── 1. Seed: one open request per person who is a director or PSC and
  // has no personal code yet ──
  let seeded = 0;
  if (!testRecipient) {
    const { data: links } = await service
      .from("entity_people")
      .select("entity_id, person_id, role, source, is_primary_contact, person:people(id, ch_personal_code)")
      .in("role", ["director"]);
    const { data: pscLinks } = await service
      .from("entity_people")
      .select("entity_id, person_id, role, source, is_primary_contact, person:people(id, ch_personal_code)")
      .eq("source", "ch_psc");
    const allLinks = [...((links || []) as Row[]), ...((pscLinks || []) as Row[])]
      .filter((l) => !((l.person as Row)?.ch_personal_code))
      .filter((l) => !formerEntities.has(l.entity_id as string));

    const { data: openReqs } = await service.from("ch_code_requests").select("person_id")
      .not("status", "in", "(entered_on_bm,stalled)");
    const hasOpen = new Set((openReqs || []).map((r: Row) => r.person_id as string));

    const byPerson = new Map<string, Row[]>();
    for (const l of allLinks) {
      const pid = l.person_id as string;
      if (hasOpen.has(pid)) continue;
      if (!byPerson.has(pid)) byPerson.set(pid, []);
      byPerson.get(pid)!.push(l);
    }

    const { data: sophie } = await service.from("staff_profiles").select("id").eq("name", "Sophie Laidlaw").maybeSingle();
    for (const [personId, personLinks] of byPerson) {
      const anchor = personLinks.find((l) => l.is_primary_contact) || personLinks[0];
      const { error: insErr } = await service.from("ch_code_requests").insert({
        person_id: personId, entity_id: anchor.entity_id, status: "pending_offer",
        owner_id: sophie?.id || null,
      });
      if (!insErr) seeded++;
    }
  }

  // ── Load open requests with person + entity context ──
  const { data: reqs, error: reqErr } = await service
    .from("ch_code_requests")
    .select("*, person:people(id, name, email), entity:entities!ch_code_requests_entity_id_fkey(id, name)")
    .not("status", "in", "(entered_on_bm,stalled)");
  if (reqErr) return json({ success: false, error: reqErr.message }, 500);

  const today = new Date().toISOString().slice(0, 10);
  const offered: Array<{ req: Row; to: string }> = [];
  const chased: Array<{ req: Row; to: string; status: string }> = [];
  const callNeeded: Row[] = [];
  const escalatedTracy: Row[] = [];
  const noEmail: Row[] = [];

  for (const r of (reqs || []) as Row[]) {
    const person = r.person as Row;
    const entity = r.entity as Row;
    // Former client — never chase, never email, never surface in the digest.
    if (formerEntities.has(entity?.id as string)) continue;
    const to = testRecipient || firstEmail(person?.email as string);
    const personName = (person?.name as string) || "there";
    const entityName = (entity?.name as string) || "your company";

    if (r.status === "pending_offer") {
      if (!to) { noEmail.push(r); continue; }
      offered.push({ req: r, to });
      continue;
    }
    // Already escalated to Tracy — stays in the digest as a reminder, no more emails
    if (r.escalation_status === "escalated_tracy") { escalatedTracy.push(r); continue; }

    if (["awaiting_decision", "awaiting_id_poa", "awaiting_code"].includes(r.status as string)) {
      if (!to) { noEmail.push(r); continue; }
      const count = (r.chase_count as number) || 0;
      if (count >= (cfg.max_chases as number)) {
        // Already capped — check for stall escalation, else just surface in digest
        const sinceCall = daysSince((r.escalated_at as string) || (r.last_chased_at as string));
        if (r.escalation_status === "call_needed" && sinceCall != null && sinceCall >= (cfg.stalled_after_days as number)) {
          escalatedTracy.push(r);
          if (!testRecipient) {
            await service.from("ch_code_requests").update({ escalation_status: "escalated_tracy", escalated_at: today }).eq("id", r.id as string);
            await service.from("ch_code_activity").insert({ request_id: r.id as string, kind: "system", body: `No response after ${sinceCall} days since the call flag — escalated to Tracy.` });
          }
        } else {
          callNeeded.push(r);
        }
        continue;
      }
      const anchor = (r.last_chased_at as string) || (r.requested_at as string);
      const waited = daysSince(anchor);
      const threshold = count === 0 ? (cfg.first_chase_after_days as number) : (cfg.chase_every_days as number);
      if (waited != null && waited >= threshold) {
        chased.push({ req: r, to, status: r.status as string });
      }
    }
  }

  if (dryRun) {
    return json({
      success: true, dry_run: true, sending_enabled: cfg.sending_enabled, seeded,
      offers: offered.map((o) => ({ person: (o.req.person as Row)?.name, entity: (o.req.entity as Row)?.name, to: o.to })),
      chases: chased.map((c) => ({ person: (c.req.person as Row)?.name, entity: (c.req.entity as Row)?.name, to: c.to, status: c.status, chase_number: ((c.req.chase_count as number) || 0) + 1 })),
      call_needed: callNeeded.map((r) => ({ person: (r.person as Row)?.name, entity: (r.entity as Row)?.name })),
      escalated_tracy: escalatedTracy.map((r) => ({ person: (r.person as Row)?.name, entity: (r.entity as Row)?.name })),
      no_email: noEmail.map((r) => ({ person: (r.person as Row)?.name, entity: (r.entity as Row)?.name })),
    });
  }

  if (!testRecipient && !cfg.sending_enabled) {
    return json({ success: false, error: "Sending is disabled (ch_code_chase_config.sending_enabled = false). Use test_recipient, or enable sending once tested." }, 409);
  }

  const results: Row[] = [];

  for (const o of offered) {
    const person = o.req.person as Row;
    const entity = o.req.entity as Row;
    const { html, text, subject } = offerEmailHtml((person?.name as string) || "there", (entity?.name as string) || "your company");
    const r = await sendEmail({ to: o.to, subject, html, text });
    results.push({ kind: "offer", person: person?.name, entity: entity?.name, to: o.to, ok: r.ok, resend_id: r.id, error: r.error });
    if (r.ok && !testRecipient) {
      await service.from("ch_code_requests").update({ status: "awaiting_decision", requested_at: today, updated_at: new Date().toISOString() }).eq("id", o.req.id as string);
      await service.from("ch_code_activity").insert({ request_id: o.req.id as string, kind: "email_out", body: `Offer emailed to ${o.to}.` });
    }
    if (testRecipient) break;
  }

  for (const c of chased) {
    const person = c.req.person as Row;
    const entity = c.req.entity as Row;
    const { html, text, subject } = chaseEmailHtml((person?.name as string) || "there", (entity?.name as string) || "your company", c.status);
    const r = await sendEmail({ to: c.to, subject, html, text });
    results.push({ kind: "chase", person: person?.name, entity: entity?.name, to: c.to, ok: r.ok, resend_id: r.id, error: r.error });
    if (r.ok && !testRecipient) {
      const newCount = ((c.req.chase_count as number) || 0) + 1;
      const update: Row = { chase_count: newCount, last_chased_at: today, updated_at: new Date().toISOString() };
      if (newCount >= (cfg.max_chases as number)) update.escalation_status = "call_needed";
      await service.from("ch_code_requests").update(update).eq("id", c.req.id as string);
      await service.from("ch_code_activity").insert({ request_id: c.req.id as string, kind: "email_out", body: `Chase #${newCount} emailed to ${c.to}.` });
      if (newCount >= (cfg.max_chases as number)) {
        await service.from("ch_code_activity").insert({ request_id: c.req.id as string, kind: "system", body: `${newCount} chases sent with no response — escalated: Sophie to call.` });
        callNeeded.push(c.req);
      }
    }
    if (testRecipient) break;
  }

  if (cfg.internal_digest_enabled) {
    const { data: callAssignee } = cfg.call_assignee_id
      ? await service.from("staff_profiles").select("email").eq("id", cfg.call_assignee_id).maybeSingle()
      : { data: null };
    const { data: escalateTo } = cfg.escalate_to_id
      ? await service.from("staff_profiles").select("email").eq("id", cfg.escalate_to_id).maybeSingle()
      : { data: null };
    const sections = {
      offered: offered.map((o) => ({ person: (o.req.person as Row)?.name as string, entity: (o.req.entity as Row)?.name as string })),
      chased: chased.map((c) => ({ person: (c.req.person as Row)?.name as string, entity: (c.req.entity as Row)?.name as string, status: c.status })),
      callNeeded: callNeeded.map((r) => ({ person: (r.person as Row)?.name as string, entity: (r.entity as Row)?.name as string })),
      escalatedTracy: escalatedTracy.map((r) => ({ person: (r.person as Row)?.name as string, entity: (r.entity as Row)?.name as string })),
      noEmail: noEmail.map((r) => ({ person: (r.person as Row)?.name as string, entity: (r.entity as Row)?.name as string })),
    };
    const hasContent = sections.offered.length || sections.chased.length || sections.callNeeded.length || sections.escalatedTracy.length || sections.noEmail.length;
    if (hasContent || testRecipient) {
      const { html, text, subject } = digestHtml(sections);
      const recipients = testRecipient
        ? [testRecipient]
        : [firstEmail(callAssignee?.email as string), sections.escalatedTracy.length ? firstEmail(escalateTo?.email as string) : null].filter(Boolean) as string[];
      for (const to of [...new Set(recipients)]) {
        const r = await sendEmail({ to, subject, html, text });
        results.push({ kind: "digest", to, ok: r.ok, resend_id: r.id, error: r.error });
        if (testRecipient) break;
      }
    }
  }

  await service.from("audit_log").insert({
    action: "ch_code_chase_sent", entity_type: "ch_code_request", entity_id: null,
    detail: { seeded, offered: offered.length, chased: chased.length, test: Boolean(testRecipient), results },
  });

  return json({ success: true, dry_run: false, seeded, sent: results.filter((r) => r.ok).length, results });
});
