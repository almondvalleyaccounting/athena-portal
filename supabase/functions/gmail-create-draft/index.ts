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
//     attachments  : [{ filename, mime_type, content_base64 }]  optional
//                    — PDFs only (the single-client fee-review letter),
//                    at most 3, 5 MB decoded in total
//   }
//
// Returns { success, draft_id, account_email }.
import {
  getServiceClient, getValidGmailToken, base64UrlEncode, jsonResponse, corsHeaders, formatSender,
} from "../_shared/gmail-client.ts";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";

type Attachment = { filename: string; mime_type: string; content_base64: string };

const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

// A header value must be one line: a CR or LF in `to`, the subject or a
// filename would let the caller write headers of their own.
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

// Build the MIME message. The body is multipart/alternative — text first
// (fallback) then HTML, Gmail picks the best part per recipient client.
// With attachments it is wrapped in multipart/mixed alongside them.
function buildMime(
  to: string, subject: string, text: string, html: string,
  fromEmail: string, fromName: string | null | undefined, attachments: Attachment[],
): string {
  const boundary = `=_athena_${crypto.randomUUID()}`;
  const mixed = `=_athena_mixed_${crypto.randomUUID()}`;
  const hasFiles = attachments.length > 0;
  const headers = [
    `From: ${formatSender(fromName, fromEmail)}`,
    `To: ${oneLine(to)}`,
    `Subject: ${encodeSubject(oneLine(subject))}`,
    `MIME-Version: 1.0`,
    hasFiles
      ? `Content-Type: multipart/mixed; boundary="${mixed}"`
      : `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join("\r\n");
  const alternative = [
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
  ];
  if (!hasFiles) return `${headers}\r\n${["", ...alternative, ""].join("\r\n")}`;

  const parts = [
    "",
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    ...alternative,
  ];
  for (const a of attachments) {
    const name = oneLine(a.filename).replace(/["\\]/g, "");
    // RFC 2045 caps a base64 line at 76 characters.
    const wrapped = a.content_base64.replace(/\s+/g, "").match(/.{1,76}/g)?.join("\r\n") ?? "";
    parts.push(
      `--${mixed}`,
      `Content-Type: ${a.mime_type}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      `Content-Transfer-Encoding: base64`,
      "",
      wrapped,
    );
  }
  parts.push(`--${mixed}--`, "");
  return `${headers}\r\n${parts.join("\r\n")}`;
}

// Validate caller-supplied attachments. Returns an error string or null.
function checkAttachments(list: unknown): string | null {
  if (list == null) return null;
  if (!Array.isArray(list)) return "attachments must be an array";
  if (list.length > MAX_ATTACHMENTS) return `at most ${MAX_ATTACHMENTS} attachments`;
  let total = 0;
  for (const a of list as Attachment[]) {
    if (!a || typeof a.filename !== "string" || !a.filename.trim()) return "attachment filename required";
    if (a.mime_type !== "application/pdf") return "only PDF attachments are accepted";
    if (typeof a.content_base64 !== "string" || !/^[A-Za-z0-9+/=\s]+$/.test(a.content_base64)) {
      return "attachment content must be base64";
    }
    total += Math.floor(a.content_base64.replace(/\s+/g, "").length * 3 / 4);
  }
  if (total > MAX_ATTACHMENT_BYTES) return "attachments exceed 5 MB";
  return null;
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

  let body: { billing_id?: string; to?: string; subject?: string; body_text?: string; body_html?: string; initiated_by?: string; attachments?: Attachment[] };
  try { body = await req.json(); } catch { return jsonResponse({ success: false, error: "Invalid JSON" }, 400); }

  if (!body.billing_id || !body.to || !body.subject || !body.body_text || !body.body_html) {
    return jsonResponse({ success: false, error: "billing_id, to, subject, body_text, body_html required" }, 400);
  }
  const attachmentError = checkAttachments(body.attachments);
  if (attachmentError) return jsonResponse({ success: false, error: attachmentError }, 400);
  const attachments = body.attachments ?? [];

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

  const mime = buildMime(body.to, body.subject, body.body_text, body.body_html, accountEmail, senderName, attachments);
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
    detail: {
      to: body.to, subject: body.subject, draft_id: draftId, client: row.entity?.name || null, account_email: accountEmail,
      attachments: attachments.map((a) => a.filename),
    },
  });

  return jsonResponse({ success: true, draft_id: draftId, account_email: accountEmail });
});
