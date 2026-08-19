// gmail-create-draft — Athena Portal
// Creates a Gmail draft for a fee-raise email and stamps the
// resulting draft id back onto the live_billing row.
//
// Body:
//   {
//     billing_id   : string (uuid)   required
//     to           : string (email)  required
//     subject      : string          required
//     body_text    : string          required  — plain text alternative
//     body_html    : string          required  — HTML body shown in Gmail
//     initiated_by : string (uuid)   optional
//   }
//
// Returns { success, draft_id, account_email }.
import {
  getServiceClient, getValidGmailToken, base64UrlEncode, jsonResponse, corsHeaders, formatSender,
} from "../_shared/gmail-client.ts";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";

// Build a multipart/alternative MIME message: text first (fallback)
// then HTML. Gmail picks the best part per recipient client.
function buildMime(to: string, subject: string, text: string, html: string, fromEmail: string, fromName?: string | null): string {
  const boundary = `=_athena_${crypto.randomUUID()}`;
  const headers = [
    `From: ${formatSender(fromName, fromEmail)}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join("\r\n");
  const body = [
    "",
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    "",
    text,
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    "",
    html,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return `${headers}\r\n${body}`;
}

// RFC 2047 encoding for non-ASCII subjects. £, em-dashes etc.
function encodeSubject(s: string): string {
  // Only encode if it has non-ASCII; keeps the common case clean.
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const b64 = base64UrlEncode(s).replace(/-/g, "+").replace(/_/g, "/");
  // Re-pad for RFC 2047 (base64 with =).
  const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
  return `=?UTF-8?B?${padded}?=`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ success: false, error: "POST required" }, 405);

  // Creates a draft on the practice-default mailbox from caller-supplied recipient and HTML.
  try { await requireStaffOrService(req); }
  catch (err) { return authErrorResponse(err, corsHeaders); }

  let body: { billing_id?: string; to?: string; subject?: string; body_text?: string; body_html?: string; initiated_by?: string };
  try { body = await req.json(); } catch { return jsonResponse({ success: false, error: "Invalid JSON" }, 400); }

  if (!body.billing_id || !body.to || !body.subject || !body.body_text || !body.body_html) {
    return jsonResponse({ success: false, error: "billing_id, to, subject, body_text, body_html required" }, 400);
  }

  let accessToken: string;
  let accountEmail: string;
  let senderName: string | null = null;
  try {
    const tok = await getValidGmailToken();
    accessToken = tok.accessToken;
    accountEmail = tok.accountEmail;
    senderName = tok.displayName;
  } catch (e) {
    return jsonResponse({ success: false, error: (e as Error).message, code: "no_gmail_connection" }, 400);
  }

  const sb = getServiceClient();

  // Sanity-check the billing row exists.
  const { data: row, error: rowErr } = await sb
    .from("live_billing")
    .select("id, entity:entities(id, name)")
    .eq("id", body.billing_id)
    .single();
  if (rowErr || !row) return jsonResponse({ success: false, error: "billing_id not found" }, 404);

  const mime = buildMime(body.to, body.subject, body.body_text, body.body_html, accountEmail, senderName);
  const raw = base64UrlEncode(mime);

  // POST to Gmail API. Drafts live at users.drafts.create.
  const apiResp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: { raw } }),
  });
  if (!apiResp.ok) {
    const txt = await apiResp.text();
    return jsonResponse({ success: false, error: `Gmail API ${apiResp.status}: ${txt}` }, 500);
  }
  const created = await apiResp.json();
  const draftId = created.id as string;

  // Stamp the draft id onto live_billing. Keep uplift_email_sent_at
  // untouched — a draft is not a send.
  await sb.from("live_billing").update({
    uplift_gmail_draft_id: draftId,
    uplift_gmail_draft_created_at: new Date().toISOString(),
    uplift_gmail_draft_created_by: body.initiated_by || null,
    uplift_email_to: body.to,
  }).eq("id", body.billing_id);

  await sb.from("audit_log").insert({
    user_id: body.initiated_by || null,
    action: "uplift_gmail_draft_created",
    entity_type: "live_billing",
    entity_id: body.billing_id,
    detail: { to: body.to, subject: body.subject, draft_id: draftId, client: row.entity?.name || null, account_email: accountEmail },
  });

  return jsonResponse({ success: true, draft_id: draftId, account_email: accountEmail });
});
