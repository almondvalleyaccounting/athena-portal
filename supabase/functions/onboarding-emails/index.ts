// onboarding-emails — Athena Portal
// Staff-triggered client emails for onboarding:
//   kind: "welcome" — warm welcome to the practice + personal portal link +
//         what happens next + what we need from you (from their open steps)
//   kind: "pause"   — the graceful "we don't want to pester you" email after
//         the escalation ladder is exhausted; sets escalation_status='paused'
//         so the chaser engine stops emailing until the client re-engages.
//
// Auth: active staff JWT (these are explicit button clicks, not automation).
// Body: { onboarding_id: string, kind: "welcome" | "pause", to?: string }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RESEND_FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") || "accounts@almondvalleyaccounting.co.uk";
const RESEND_FROM_NAME = Deno.env.get("RESEND_FROM_NAME") || "Almond Valley Accounting";
const CLIENT_PORTAL_URL = Deno.env.get("CLIENT_PORTAL_URL") || "https://athena-client-portal.vercel.app";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendEmail(opts: { to: string; subject: string; html: string; text: string }) {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({
      from: `${RESEND_FROM_NAME} <${RESEND_FROM_EMAIL}>`,
      to: [opts.to], subject: opts.subject, html: opts.html, text: opts.text,
    }),
  });
  const j = await resp.json().catch(() => ({}));
  return { ok: resp.ok, id: (j?.id as string) || null, error: resp.ok ? undefined : (j?.message || j) };
}

const shell = (inner: string) =>
  `<!doctype html><html><body style="margin:0;padding:0;background:#f6f8f9;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1e293b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8f9;padding:32px 16px;"><tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:32px;">
        ${inner}
        <tr><td style="padding-top:26px;border-top:1px solid #f1f5f9;font-size:11px;color:#94a3b8;text-align:center;">Almond Valley Accounting</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;

function welcomeEmail(entityName: string, asks: string[]) {
  const subject = "Welcome to Almond Valley Accounting — let's get you set up";
  const askRows = asks.slice(0, 8).map((a) =>
    `<tr><td style="padding:7px 12px;border-top:1px solid #f1f5f9;font-size:14px;color:#0f172a;line-height:1.5;">${esc(a)}</td></tr>`).join("");
  const html = shell(`
    <tr><td style="font-size:22px;font-weight:700;color:#1E4560;padding-bottom:6px;">Welcome aboard 🎉</td></tr>
    <tr><td style="font-size:14.5px;line-height:1.7;color:#1e293b;">
      We're genuinely delighted to be looking after <strong>${esc(entityName)}</strong>. Getting set up with a new
      accountant usually means paperwork and chasing — we've built something better. You have your own
      client portal: it shows exactly where things are up to, what we're doing behind the scenes,
      and the handful of things we need from you — no forms, no passwords, no fuss.
    </td></tr>
    <tr><td style="padding:22px 0 6px;">
      <a href="${esc(CLIENT_PORTAL_URL)}" style="display:inline-block;background:#1E4560;color:#fff;text-decoration:none;padding:14px 26px;border-radius:12px;font-weight:600;font-size:15px;">Open your portal</a>
      <div style="font-size:12px;color:#94a3b8;padding-top:8px;">Sign in with just this email address — we'll send you a secure link, no password needed.</div>
    </td></tr>
    <tr><td style="font-size:14.5px;line-height:1.7;color:#1e293b;padding-top:14px;">
      <strong>What happens next?</strong> We handle the heavy lifting — HMRC registrations, agent authorisations,
      the boring bits. Your portal ticks along as we go, and we'll give you a friendly nudge when something needs you.
    </td></tr>
    ${asks.length ? `<tr><td style="padding-top:16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
        <tr style="background:#f8fafc;"><td style="padding:8px 12px;font-weight:600;color:#0f172a;font-size:13px;">To get us started, we'll need</td></tr>
        ${askRows}
      </table>
    </td></tr>` : ""}
    <tr><td style="font-size:14.5px;line-height:1.7;color:#1e293b;padding-top:18px;">
      Questions at any point — just reply to this email. A real person reads it (promise).
      <br/><br/>The Almond Valley team
    </td></tr>`);
  const text = `Welcome aboard!\n\nWe're delighted to be looking after ${entityName}. You have your own client portal showing exactly where things are up to and the few things we need from you.\n\nOpen your portal: ${CLIENT_PORTAL_URL}\n(Sign in with just this email address — we'll send you a secure link, no password needed.)\n\n` +
    (asks.length ? `To get us started, we'll need:\n${asks.slice(0, 8).map((a) => `- ${a}`).join("\n")}\n\n` : "") +
    `Questions at any point — just reply to this email.\n\nThe Almond Valley team`;
  return { subject, html, text };
}

function pauseEmail(entityName: string) {
  const subject = "We'll leave it with you for now";
  const html = shell(`
    <tr><td style="font-size:20px;font-weight:700;color:#1E4560;padding-bottom:6px;">No pressure from us</td></tr>
    <tr><td style="font-size:14.5px;line-height:1.7;color:#1e293b;">
      We've reached out a few times about getting <strong>${esc(entityName)}</strong> set up and haven't managed
      to catch you — and we know how it goes; life and business get busy. The last thing we want is to pester you,
      so we've paused our reminders for now.
    </td></tr>
    <tr><td style="font-size:14.5px;line-height:1.7;color:#1e293b;padding-top:14px;">
      Whenever you're ready, just reply to this email or pop back into your portal and we'll pick up
      exactly where we left off — everything's saved.
    </td></tr>
    <tr><td style="padding:22px 0 6px;">
      <a href="${esc(CLIENT_PORTAL_URL)}" style="display:inline-block;background:#0d9488;color:#fff;text-decoration:none;padding:12px 22px;border-radius:12px;font-weight:600;font-size:14px;">Pick up where we left off</a>
    </td></tr>
    <tr><td style="font-size:14.5px;line-height:1.7;color:#1e293b;padding-top:14px;">Speak soon,<br/>The Almond Valley team</td></tr>`);
  const text = `No pressure from us.\n\nWe've reached out a few times about getting ${entityName} set up and haven't managed to catch you — and we know how it goes. The last thing we want is to pester you, so we've paused our reminders for now.\n\nWhenever you're ready, just reply to this email or pop back into your portal (${CLIENT_PORTAL_URL}) and we'll pick up exactly where we left off.\n\nSpeak soon,\nThe Almond Valley team`;
  return { subject, html, text };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ success: false, error: "Missing authorization" }, 401);
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: authErr } = await anon.auth.getUser();
  if (authErr || !user) return json({ success: false, error: "Invalid token" }, 401);
  const { data: prof } = await service.from("staff_profiles").select("is_active").eq("id", user.id).single();
  if (!prof?.is_active) return json({ success: false, error: "Not authorised" }, 403);

  const body = await req.json().catch(() => ({}));
  const onboardingId: string | null = body.onboarding_id || null;
  const kind: string = body.kind || "";
  if (!onboardingId || !["welcome", "pause"].includes(kind)) {
    return json({ success: false, error: "onboarding_id and kind (welcome|pause) required" }, 400);
  }

  const { data: ob, error: obErr } = await service
    .from("onboardings")
    .select("id, entity_id, entity:entities!onboardings_entity_id_fkey(id, name, billing_email, prospect_email), steps:onboarding_steps(name, client_label, owner_type, status, group_sort, sort)")
    .eq("id", onboardingId)
    .single();
  if (obErr || !ob) return json({ success: false, error: obErr?.message || "Onboarding not found" }, 404);

  const ent = ob.entity as Record<string, unknown>;
  const to: string | null = body.to
    || (ent?.billing_email as string)?.split(/[;,]/)[0]?.trim()
    || (ent?.prospect_email as string)?.split(/[;,]/)[0]?.trim()
    || null;
  if (!to || !to.includes("@")) return json({ success: false, error: "No email address — pass `to` or set one on the client." }, 400);

  const entityName = (ent?.name as string) || "your business";
  const asks = ((ob.steps as Array<Record<string, unknown>>) || [])
    .filter((s) => s.owner_type === "client" && !["complete", "na"].includes(s.status as string))
    .sort((a, b) => (a.group_sort as number) - (b.group_sort as number) || (a.sort as number) - (b.sort as number))
    .map((s) => (s.client_label || s.name) as string);

  const email = kind === "welcome" ? welcomeEmail(entityName, asks) : pauseEmail(entityName);
  const r = await sendEmail({ to, ...email });
  if (!r.ok) return json({ success: false, error: `Send failed: ${JSON.stringify(r.error)}` }, 502);

  if (kind === "pause") {
    await service.from("onboardings").update({
      escalation_status: "paused", paused_at: new Date().toISOString().slice(0, 10),
    }).eq("id", onboardingId);
  }
  await service.from("onboarding_activity").insert({
    onboarding_id: onboardingId, kind: "email_out",
    body: kind === "welcome"
      ? `Welcome email sent to ${to} (portal introduction + what we need)`
      : `Pause email sent to ${to} — chasing paused until the client re-engages`,
    created_by: user.id,
  });
  await service.from("audit_log").insert({
    user_id: user.id, action: `onboarding_${kind}_email_sent`, entity_type: "onboarding",
    entity_id: onboardingId, detail: { to, resend_id: r.id },
  });

  return json({ success: true, to, kind });
});
