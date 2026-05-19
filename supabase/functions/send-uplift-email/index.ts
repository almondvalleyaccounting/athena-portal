// send-uplift-email — Athena Portal
// Sends a fee-raise email for a single live_billing row via Resend
// (same sender / API key already used by send-quote-email).
//
// Body:
//   {
//     billing_id   : string (uuid)   required
//     to           : string (email)  required
//     subject      : string          required
//     body_text    : string          required  — plain text version
//     initiated_by : string (uuid)   optional
//   }
//
// On success: updates live_billing.uplift_email_sent_at / _by / _to.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RESEND_FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") || "accounts@almondvalleyaccounting.co.uk";
const RESEND_FROM_NAME  = Deno.env.get("RESEND_FROM_NAME")  || "Almond Valley Accounting";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });
}

// Convert plain text to a minimal HTML body so mail clients render
// paragraph breaks correctly. Each line is wrapped in a <div>; runs of
// 28+ dashes (our section dividers) become an <hr>.
function textToHtml(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (/^—{6,}$/.test(line.trim())) return "<hr style='border:none;border-top:1px solid #e5e7eb;margin:12px 0' />";
      if (line.trim() === "") return "<div style='height:8px'></div>";
      const esc = line
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return `<div>${esc}</div>`;
    })
    .join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST")     return json({ success: false, error: "POST required" }, 405);

  let body: { billing_id?: string; to?: string; subject?: string; body_text?: string; body_html?: string; initiated_by?: string };
  try { body = await req.json(); } catch { return json({ success: false, error: "Invalid JSON" }, 400); }

  if (!body.billing_id || !body.to || !body.subject || !body.body_text) {
    return json({ success: false, error: "billing_id, to, subject, body_text required" }, 400);
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Resolve client/entity name for the From label.
  const { data: row } = await sb
    .from("live_billing")
    .select("id, entity:entities(id, name)")
    .eq("id", body.billing_id)
    .single();
  if (!row) return json({ success: false, error: "billing_id not found" }, 404);

  // Prefer a caller-supplied HTML body (the fee-raise composer produces
  // one with proper tables and section copy). Fall back to converting
  // the plain text version for older clients of this function.
  const html = body.body_html && body.body_html.trim().length > 0
    ? body.body_html
    : `<!DOCTYPE html><html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; color: #0f172a; line-height: 1.5; padding: 8px 0;">${textToHtml(body.body_text)}</body></html>`;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${RESEND_FROM_NAME} <${RESEND_FROM_EMAIL}>`,
      to: [body.to],
      subject: body.subject,
      text: body.body_text,
      html,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    return json({ success: false, error: `Resend ${resp.status}: ${errText}` }, 500);
  }
  const sent = await resp.json();

  await sb.from("live_billing").update({
    uplift_email_sent_at: new Date().toISOString(),
    uplift_email_sent_by: body.initiated_by || null,
    uplift_email_to: body.to,
  }).eq("id", body.billing_id);

  // Audit log row alongside the existing entity audit history.
  await sb.from("audit_log").insert({
    user_id: body.initiated_by || null,
    action: "uplift_email_sent",
    entity_type: "live_billing",
    entity_id: body.billing_id,
    detail: { to: body.to, subject: body.subject, resend_id: sent?.id || null, client: row.entity?.name || null },
  });

  return json({ success: true, resend_id: sent?.id });
});
