// Shared Resend sender for Athena edge functions. Keeps the API key, sender
// identity, and error shape in one place. Mirrors the inline calls in
// send-quote-email so behaviour is consistent.
//
// (send-uplift-email was listed here too. Deleted 2026-08-19: it had no caller in
// src or the built bundle, and an unreferenced endpoint that can send mail as the
// practice is worth removing rather than guarding. Source is in git if ever needed.)

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RESEND_FROM_EMAIL =
  Deno.env.get("RESEND_FROM_EMAIL") || "info@almondvalleyaccounting.co.uk";
const RESEND_FROM_NAME =
  Deno.env.get("RESEND_FROM_NAME") || "Almond Valley Accounting";

export interface SendResult {
  ok: boolean;
  id: string | null;
  status: number;
  error?: unknown;
}

export async function sendEmail(opts: {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  cc?: string[];
  replyTo?: string;
}): Promise<SendResult> {
  const payload: Record<string, unknown> = {
    from: `${RESEND_FROM_NAME} <${RESEND_FROM_EMAIL}>`,
    to: Array.isArray(opts.to) ? opts.to : [opts.to],
    subject: opts.subject,
    html: opts.html,
  };
  if (opts.text) payload.text = opts.text;
  if (opts.cc && opts.cc.length) payload.cc = opts.cc;
  if (opts.replyTo) payload.reply_to = opts.replyTo;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });
  const json = await resp.json().catch(() => ({}));
  return {
    ok: resp.ok,
    id: (json?.id as string) || null,
    status: resp.status,
    error: resp.ok ? undefined : (json?.message || json),
  };
}
