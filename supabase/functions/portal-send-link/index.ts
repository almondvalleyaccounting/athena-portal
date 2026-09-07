// portal-send-link — Athena Portal
//
// Emails a client the one thing they need in order to use anything we have given
// them: the portal address, the email address to type into it, and what happens
// next. Nothing more.
//
// Why this exists. Granting portal or dashboard access is deliberately silent —
// grant_dashboard_access writes the grant and the invite and sends nothing, so
// setting somebody up is not the same act as announcing it to them. The cost of
// that was invisible: a client could hold a full dashboard grant for weeks and
// never know, and the screen showed "invited — not signed in yet", which reads
// like they are ignoring us when nobody had told them. The only email in the
// system that carried the portal link was the onboarding welcome, which needs an
// onboarding record, which existing clients do not have.
//
// What it deliberately does NOT do: send a sign-in link or a code. There is no
// token in this email, so it grants nothing and is safe to forward, wrong-address,
// or sit in an inbox for a year. The client asks for the six-digit code themselves
// at the portal, from portal-send-code, which checks the invite at that moment.
// A link that authenticates is a link that can be stolen; this one cannot be.
//
// Auth: staff holding can_manage_portal — the same permission that grants access
// in the first place, because "who may tell a client they have access" and "who
// may give them access" are the same question. verify_jwt=true at the gateway is
// NOT the control (the anon key is a valid JWT); requireStaffOrService is.
//
// Body: { entity_id: uuid, email: string }
// Returns { success, sent_at, send_count, to }.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";
import { sendEmail } from "../_shared/resend.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_PORTAL_URL =
  Deno.env.get("CLIENT_PORTAL_URL") || "https://clients.almondvalleyaccounting.co.uk";
// Blind copy so the send exists somewhere a human can find it: Resend leaves no
// Sent item in Gmail, and comms-ingest files the info@ copy against the client.
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

const host = CLIENT_PORTAL_URL.replace(/^https?:\/\//, "");

function linkEmail(opts: { entityName: string; email: string; repeat: boolean }) {
  const subject = opts.repeat
    ? `Your ${opts.entityName} portal — signing in`
    : `Your ${opts.entityName} client portal is ready`;

  const intro = opts.repeat
    ? `A quick resend of how to get into your portal for ${opts.entityName} — everything is already set up and waiting for you.`
    : `We have set up your own portal for ${opts.entityName}. Your figures, your reports, whenever you want them — no waiting for us to send anything over.`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f8f9;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1e293b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8f9;padding:32px 16px;"><tr><td align="center">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:32px;">
        <tr><td style="font-size:20px;font-weight:700;color:#1E4560;padding-bottom:10px;">Your client portal</td></tr>
        <tr><td style="font-size:14.5px;line-height:1.7;color:#1e293b;">${esc(intro)}</td></tr>
        <tr><td style="padding:22px 0 6px;">
          <a href="${esc(CLIENT_PORTAL_URL)}" style="display:inline-block;background:#1E4560;color:#fff;text-decoration:none;padding:13px 24px;border-radius:11px;font-weight:600;font-size:15px;">Open your portal</a>
        </td></tr>
        <tr><td style="font-size:13px;color:#64748b;padding-bottom:18px;"><a href="${esc(CLIENT_PORTAL_URL)}" style="color:#1E4560;">${esc(host)}</a></td></tr>
        <tr><td style="font-size:14px;line-height:1.7;color:#1e293b;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;">
          <strong style="color:#1E4560;">Signing in</strong><br>
          There is no password. Enter <strong>${esc(opts.email)}</strong> — it has to be this address, that is what your access is registered against — and we will email you a six-digit code. Type the code in and you are through. The code lasts an hour; ask for a new one any time.
        </td></tr>
        <tr><td style="font-size:13.5px;line-height:1.7;color:#475569;padding-top:16px;">
          The code arrives from <strong>info@almondvalleyaccounting.co.uk</strong> — worth a look in your junk folder the first time, and marking it as safe.
        </td></tr>
        <tr><td style="font-size:13.5px;line-height:1.7;color:#475569;padding-top:14px;">
          Anything not looking right, or something you would like to see in there that isn't? Just reply to this email.
        </td></tr>
        <tr><td style="padding-top:22px;border-top:1px solid #f1f5f9;font-size:11px;color:#94a3b8;text-align:center;">Almond Valley Accounting</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;

  const text = `Your client portal

${intro}

Open your portal: ${CLIENT_PORTAL_URL}

Signing in
There is no password. Enter ${opts.email} — it has to be this address, that is what your access is registered against — and we will email you a six-digit code. Type the code in and you are through. The code lasts an hour; ask for a new one any time.

The code arrives from info@almondvalleyaccounting.co.uk — worth a look in your junk folder the first time, and marking it as safe.

Anything not looking right, or something you would like to see in there that isn't? Just reply to this email.

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
  const email = String(body.email || "").trim().toLowerCase();

  if (!entityId) return json({ success: false, error: "entity_id is required" }, 400);
  if (!email.includes("@")) return json({ success: false, error: "A valid email is required" }, 400);

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: entity } = await service
    .from("entities").select("id, name").eq("id", entityId).maybeSingle();
  if (!entity) return json({ success: false, error: "Unknown client" }, 404);

  // Only ever to somebody who actually has access. Emailing "your portal is
  // ready" to an address that would be turned away at the door is worse than
  // sending nothing: they try, they are refused, and they ring us about it.
  //
  // Matched in JS on a lowercased comparison rather than with .ilike(): an email
  // is user-supplied text and `_` is an ilike wildcard, so ilike("a_b@x.com")
  // would also match "axb@x.com" — a way to send one client's portal details to
  // a different address that happens to be on the same client. .eq() would be
  // safe but would miss any legacy row stored with capitals in it.
  const [{ data: invites }, { data: grants }] = await Promise.all([
    service.from("client_portal_invites")
      .select("id, email, link_sent_count").eq("entity_id", entityId),
    service.from("client_dashboard_access")
      .select("id, email").eq("entity_id", entityId).is("revoked_at", null),
  ]);
  const same = (v: string | null | undefined) => String(v ?? "").trim().toLowerCase() === email;
  const invite = (invites || []).find((r) => same(r.email)) || null;
  const grant = (grants || []).find((r) => same(r.email)) || null;

  if (!invite && !grant) {
    return json({
      success: false,
      error: "That email has no portal invite and no dashboard access for this client. Give them access first.",
    }, 409);
  }

  // A live dashboard grant with no invite row cannot sign in — portal-send-code
  // checks the invite, so the code request would be refused. Repairing that here
  // is the difference between a button that works and one that sends somebody
  // instructions for a door that is locked.
  let inviteId = invite?.id ?? null;
  let previousSends = invite?.link_sent_count ?? 0;
  if (!inviteId) {
    const { data: created, error: insErr } = await service
      .from("client_portal_invites")
      .insert({ entity_id: entityId, email, invited_by: caller.userId })
      .select("id, link_sent_count")
      .single();
    if (insErr) return json({ success: false, error: `Could not create the portal invite: ${insErr.message}` }, 500);
    inviteId = created.id;
    previousSends = created.link_sent_count ?? 0;
  }

  const { subject, html, text } = linkEmail({
    entityName: entity.name,
    email,
    repeat: previousSends > 0,
  });

  const sent = await sendEmail({
    to: email,
    subject,
    html,
    text,
    ...(BCC_EMAIL ? { bcc: [BCC_EMAIL] } : {}),
    replyTo: "info@almondvalleyaccounting.co.uk",
  });
  if (!sent.ok) {
    return json({ success: false, error: `Could not send the email: ${JSON.stringify(sent.error)}` }, 502);
  }

  // Recorded only after Resend accepted it. A timestamp written ahead of the send
  // would say we told them when we had not, and this column is read as proof.
  const sentAt = new Date().toISOString();
  const { error: updErr } = await service
    .from("client_portal_invites")
    .update({
      link_sent_at: sentAt,
      link_sent_count: previousSends + 1,
      link_sent_by: caller.userId,
    })
    .eq("id", inviteId);

  return json({
    success: true,
    sent_at: sentAt,
    send_count: previousSends + 1,
    to: email,
    // The email went; only the bookkeeping of it failed. Say so rather than
    // reporting a failure that would have somebody send it a second time.
    warning: updErr ? `Sent, but the send was not recorded: ${updErr.message}` : undefined,
  });
});
