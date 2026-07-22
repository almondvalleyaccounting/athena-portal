// recruitment-email — Athena Portal
// Sends an email to a job applicant via Resend and logs it to
// recruitment_messages so it shows on the applicant's timeline.
//
// Deployed with verify_jwt OFF; verifies a staff JWT itself and requires the
// caller to be cleared for applicant PII (can_view_recruitment_applicants /
// can_manage_recruitment / is_portal_admin) — the same tier that can read the
// recruitment_messages row it writes.
//
// Body: { application_id: uuid, to: string, subject: string,
//         body: string (plain text; converted to simple HTML),
//         reply_to?: string }
//
// No public surface: this is staff-only. Applicant replies go to reply_to
// (default the practice jobs/info mailbox), never back into Athena directly.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendEmail } from "../_shared/resend.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REPLY_TO_DEFAULT =
  Deno.env.get("RECRUITMENT_REPLY_TO") || "info@almondvalleyaccounting.co.uk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
// Plain text → simple, safe HTML (paragraphs + line breaks).
function textToHtml(text: string): string {
  const paras = String(text).trim().split(/\n{2,}/).map((p) =>
    `<p style="margin:0 0 14px;">${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`
  ).join("");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;line-height:1.55;">${paras}</div>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Staff auth + PII clearance.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ success: false, error: "Missing authorization" }, 401);
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: authErr } = await anon.auth.getUser();
  if (authErr || !user) return json({ success: false, error: "Invalid token" }, 401);
  const { data: prof } = await service.from("staff_profiles")
    .select("is_active, name, can_view_recruitment_applicants, can_manage_recruitment, is_portal_admin")
    .eq("id", user.id).single();
  if (!prof?.is_active) return json({ success: false, error: "Not authorised" }, 403);
  if (!(prof.can_view_recruitment_applicants || prof.can_manage_recruitment || prof.is_portal_admin)) {
    return json({ success: false, error: "Not cleared for applicant communications" }, 403);
  }

  const body = await req.json().catch(() => ({}));
  const applicationId = String(body.application_id || "");
  const to = String(body.to || "").trim();
  const subject = String(body.subject || "").trim();
  const text = String(body.body || "").trim();
  const replyTo = String(body.reply_to || "").trim() || REPLY_TO_DEFAULT;
  if (!applicationId) return json({ success: false, error: "application_id required" }, 400);
  if (!to || !/.+@.+\..+/.test(to)) return json({ success: false, error: "A valid recipient email is required" }, 400);
  if (!subject) return json({ success: false, error: "subject required" }, 400);
  if (!text) return json({ success: false, error: "body required" }, 400);

  // Confirm the application exists and grab candidate_id for the log.
  const { data: app } = await service.from("recruitment_applications")
    .select("id, candidate_id").eq("id", applicationId).maybeSingle();
  if (!app) return json({ success: false, error: "Application not found" }, 404);

  const result = await sendEmail({ to, subject, html: textToHtml(text), text, replyTo });

  const { data: row } = await service.from("recruitment_messages").insert({
    application_id: applicationId,
    candidate_id: app.candidate_id,
    channel: "email",
    direction: "out",
    subject,
    body: text,
    to_addr: to,
    status: result.ok ? "sent" : "failed",
    provider_id: result.id,
    error: result.ok ? null : String(result.error || "send failed").slice(0, 500),
    created_by: user.id,
  }).select("id").single();

  if (!result.ok) {
    return json({ success: false, error: `Email failed: ${String(result.error || result.status)}`, id: row?.id }, 502);
  }
  return json({ success: true, id: row?.id, provider_id: result.id });
});
