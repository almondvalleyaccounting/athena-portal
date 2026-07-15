// portal-send-code — Athena Portal (client portal sign-in)
//
// Robust, branded sign-in for the client portal. The old flow relied on
// Supabase's built-in Magic Link email, which (a) had no code in it (the
// template lacked {{ .Token }}) and (b) landed in junk (sent via Supabase's
// mailer, not our warmed-up Resend domain).
//
// This function instead:
//   1. Confirms the email has been invited (client_portal_invites) — only
//      clients we've granted access to can request a code.
//   2. Throttles requests (portal_login_attempts) to stop email bombing.
//   3. Uses the admin API to mint a genuine Supabase email OTP
//      (generateLink → properties.email_otp) so verifying it still yields a
//      real Supabase session (RLS + portal RPCs keep working).
//   4. Emails the 6-digit code via Resend from info@almondvalleyaccounting.co.uk
//      (SPF/DKIM already set up → inbox, not junk).
//
// The portal then calls supabase.auth.verifyOtp({ email, token, type: 'email' })
// with the code the user types — that step lives in the client portal repo.
//
// Auth: public (CORS) — this is the unauthenticated sign-in entry point. It is
// safe because it only ever emails a code to an already-invited address.
// Body: { email: string }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RESEND_FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") || "info@almondvalleyaccounting.co.uk";
const RESEND_FROM_NAME = Deno.env.get("RESEND_FROM_NAME") || "Almond Valley Accounting";
const CLIENT_PORTAL_URL = Deno.env.get("CLIENT_PORTAL_URL") || "https://clients.almondvalleyaccounting.co.uk";

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

// Minimum seconds between code requests for the same email.
const RESEND_COOLDOWN_SECONDS = 30;

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

function codeEmail(code: string) {
  const subject = `${code} is your Almond Valley sign-in code`;
  const html =
    `<!doctype html><html><body style="margin:0;padding:0;background:#f6f8f9;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1e293b;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8f9;padding:32px 16px;"><tr><td align="center">
        <table role="presentation" width="460" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:32px;">
          <tr><td style="font-size:20px;font-weight:700;color:#1E4560;padding-bottom:8px;">Sign in to your portal</td></tr>
          <tr><td style="font-size:14.5px;line-height:1.7;color:#1e293b;">Enter this code to sign in — it's valid for one hour:</td></tr>
          <tr><td style="padding:20px 0;">
            <div style="font-size:34px;font-weight:800;letter-spacing:8px;color:#0f172a;background:#f1f5f9;border-radius:12px;padding:16px 0;text-align:center;">${esc(code)}</div>
          </td></tr>
          <tr><td style="font-size:13px;line-height:1.6;color:#64748b;">If you didn't try to sign in, you can safely ignore this email — no one can access your account without this code.</td></tr>
          <tr><td style="padding-top:18px;"><a href="${esc(CLIENT_PORTAL_URL)}" style="color:#1E4560;font-size:13px;">${esc(CLIENT_PORTAL_URL)}</a></td></tr>
          <tr><td style="padding-top:22px;border-top:1px solid #f1f5f9;font-size:11px;color:#94a3b8;text-align:center;">Almond Valley Accounting</td></tr>
        </table>
      </td></tr></table>
    </body></html>`;
  const text = `Sign in to your portal\n\nEnter this code to sign in (valid for one hour):\n\n${code}\n\nIf you didn't try to sign in, you can safely ignore this email.\n\n${CLIENT_PORTAL_URL}\n\nAlmond Valley Accounting`;
  return { subject, html, text };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const body = await req.json().catch(() => ({}));
  const email = String(body.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return json({ success: false, error: "A valid email address is required." }, 400);

  // 1. Only invited clients can request a code.
  const { data: invite } = await service.from("client_portal_invites")
    .select("id").eq("email", email).limit(1).maybeSingle();
  if (!invite) {
    return json({
      success: false,
      error: "This email doesn't have portal access yet. Please ask your accountant to send you an invite.",
    }, 403);
  }

  // 2. Throttle repeat requests.
  const nowIso = new Date().toISOString();
  const { data: attempt } = await service.from("portal_login_attempts")
    .select("last_sent_at, send_count").eq("email", email).maybeSingle();
  if (attempt?.last_sent_at) {
    const elapsed = (Date.now() - new Date(attempt.last_sent_at as string).getTime()) / 1000;
    if (elapsed < RESEND_COOLDOWN_SECONDS) {
      return json({ success: false, error: `Please wait a few seconds before requesting another code.`, retry_after: Math.ceil(RESEND_COOLDOWN_SECONDS - elapsed) }, 429);
    }
  }

  // 3. Ensure the auth user exists (idempotent), then mint an email OTP.
  //    createUser errors harmlessly if they're already registered.
  await service.auth.admin.createUser({ email, email_confirm: true }).catch(() => {});
  const { data: link, error: linkErr } = await service.auth.admin.generateLink({ type: "magiclink", email });
  const code = (link?.properties as Record<string, unknown> | undefined)?.email_otp as string | undefined;
  if (linkErr || !code) {
    return json({ success: false, error: `Could not generate a sign-in code: ${linkErr?.message || "no code returned"}` }, 502);
  }

  // 4. Email the code via Resend.
  const { subject, html, text } = codeEmail(code);
  const r = await sendEmail({ to: email, subject, html, text });
  if (!r.ok) return json({ success: false, error: `Could not send the code email: ${JSON.stringify(r.error)}` }, 502);

  // Record the send for throttling.
  await service.from("portal_login_attempts").upsert({
    email, last_sent_at: nowIso, send_count: ((attempt?.send_count as number) || 0) + 1,
  }, { onConflict: "email" });

  return json({ success: true });
});
