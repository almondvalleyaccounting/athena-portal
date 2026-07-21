// comms-gmail — Athena Portal
// The Communications module's Gmail proxy. One POST endpoint, action-based:
//
//   { action, mailbox, ... }   mailbox = connected account email
//
//   list_labels    → user's labels (system + custom)
//   list_threads   { labelIds?, q?, pageToken?, maxResults? }
//   get_thread     { threadId }        full messages, parsed bodies + attachments
//   send           { to, cc?, bcc?, subject, bodyText, bodyHtml?, threadId?,
//                    inReplyTo?, references? }   new mail / reply / forward
//   modify_thread  { threadId, addLabelIds?, removeLabelIds? }
//                    archive = remove INBOX; mark read = remove UNREAD
//   trash_thread   { threadId }        Gmail bin (recoverable ~30 days)
//   untrash_thread { threadId }        undo for the above
//   get_attachment { messageId, attachmentId }
//
// Deployed with verify_jwt ON; additionally checks the caller is active staff
// and may use the mailbox: personal mailboxes are owner-only (portal admins
// excepted), shared mailboxes are open to all active staff. Tokens never
// leave the server — the browser only ever sees parsed message data.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getValidGmailToken, base64UrlEncode, jsonResponse, corsHeaders, getServiceClient,
} from "../_shared/gmail-client.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

async function gmailFetch(accessToken: string, path: string, init?: RequestInit) {
  const resp = await fetch(`${GMAIL}${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new GmailApiError(resp.status, txt);
  }
  return resp.json();
}

class GmailApiError extends Error {
  status: number;
  constructor(status: number, body: string) {
    super(`Gmail API ${status}: ${body.slice(0, 500)}`);
    this.status = status;
  }
}

function base64UrlDecode(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

function header(headers: Array<{ name: string; value: string }> | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

// Walks a message payload tree collecting the best text/html and text/plain
// bodies plus any attachment parts (anything with a filename).
function parsePayload(payload: any, out: { html: string; text: string; attachments: any[] }) {
  if (!payload) return;
  const mime = payload.mimeType || "";
  const filename = payload.filename || "";
  if (filename && payload.body?.attachmentId) {
    out.attachments.push({
      attachmentId: payload.body.attachmentId,
      filename,
      mimeType: mime,
      size: payload.body.size || 0,
    });
  } else if (payload.body?.data) {
    if (mime === "text/html" && !out.html) out.html = base64UrlDecode(payload.body.data);
    if (mime === "text/plain" && !out.text) out.text = base64UrlDecode(payload.body.data);
  }
  for (const part of payload.parts || []) parsePayload(part, out);
}

function parseMessage(msg: any) {
  const h = msg.payload?.headers;
  const out = { html: "", text: "", attachments: [] as any[] };
  parsePayload(msg.payload, out);
  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds || [],
    internalDate: Number(msg.internalDate || 0),
    snippet: msg.snippet || "",
    from: header(h, "From"),
    to: header(h, "To"),
    cc: header(h, "Cc"),
    subject: header(h, "Subject"),
    date: header(h, "Date"),
    messageIdHeader: header(h, "Message-ID"),
    references: header(h, "References"),
    bodyHtml: out.html,
    bodyText: out.text,
    attachments: out.attachments.map((a) => ({ ...a, messageId: msg.id })),
  };
}

function encodeSubject(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const b64 = base64UrlEncode(s).replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
  return `=?UTF-8?B?${padded}?=`;
}

function buildMime(opts: {
  from: string; to: string; cc?: string; bcc?: string; subject: string;
  text: string; html?: string; inReplyTo?: string; references?: string;
}): string {
  const boundary = `=_athena_${crypto.randomUUID()}`;
  const headers = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    ...(opts.cc ? [`Cc: ${opts.cc}`] : []),
    ...(opts.bcc ? [`Bcc: ${opts.bcc}`] : []),
    `Subject: ${encodeSubject(opts.subject)}`,
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`] : []),
    ...(opts.references ? [`References: ${opts.references}`] : []),
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join("\r\n");
  const html = opts.html || opts.text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\r?\n/g, "<br>\r\n");
  const body = [
    "",
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 8bit`,
    "",
    opts.text,
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: 8bit`,
    "",
    html,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return `${headers}\r\n${body}`;
}

// Fetch thread summaries in small batches to stay inside Gmail's per-user
// rate quota (threads.get costs 10 units, 250 units/sec allowed).
async function fetchThreadSummaries(accessToken: string, ids: string[]) {
  const summaries: any[] = [];
  const CHUNK = 10;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const got = await Promise.all(chunk.map((id) =>
      gmailFetch(accessToken, `/threads/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`)
        .catch(() => null)
    ));
    for (const t of got) {
      if (!t) continue;
      const msgs = t.messages || [];
      const first = msgs[0];
      const last = msgs[msgs.length - 1];
      const labelIds = new Set<string>();
      for (const m of msgs) for (const l of m.labelIds || []) labelIds.add(l);
      summaries.push({
        id: t.id,
        messageCount: msgs.length,
        snippet: last?.snippet || "",
        subject: header(first?.payload?.headers, "Subject") || "(no subject)",
        from: header(last?.payload?.headers, "From"),
        to: header(last?.payload?.headers, "To"),
        internalDate: Number(last?.internalDate || 0),
        unread: labelIds.has("UNREAD"),
        labelIds: [...labelIds],
      });
    }
  }
  summaries.sort((a, b) => b.internalDate - a.internalDate);
  return summaries;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ success: false, error: "POST required" }, 405);

  // Staff auth.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ success: false, error: "Missing authorization" }, 401);
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: authErr } = await anon.auth.getUser();
  if (authErr || !user) return jsonResponse({ success: false, error: "Invalid token" }, 401);
  const service = getServiceClient();
  const { data: prof } = await service.from("staff_profiles")
    .select("id, is_active, is_portal_admin").eq("id", user.id).single();
  if (!prof?.is_active) return jsonResponse({ success: false, error: "Not authorised" }, 403);

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");
  const mailbox = String(body.mailbox || "").trim().toLowerCase();
  if (!action) return jsonResponse({ success: false, error: "action required" }, 400);
  if (!mailbox) return jsonResponse({ success: false, error: "mailbox required" }, 400);

  // Resolve the mailbox connection + access check.
  let tok;
  try {
    tok = await getValidGmailToken(mailbox);
  } catch (e) {
    return jsonResponse({ success: false, error: (e as Error).message, code: "no_gmail_connection" }, 400);
  }
  if (tok.kind === "personal" && tok.ownerStaffId !== user.id && !prof.is_portal_admin) {
    return jsonResponse({ success: false, error: "This is a personal mailbox." }, 403);
  }

  try {
    switch (action) {
      case "list_labels": {
        const data = await gmailFetch(tok.accessToken, "/labels");
        return jsonResponse({ success: true, labels: data.labels || [] });
      }

      case "create_label": {
        const name = String(body.name || "").trim();
        if (!name) return jsonResponse({ success: false, error: "name required" }, 400);
        const label = await gmailFetch(tok.accessToken, "/labels", {
          method: "POST",
          body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }),
        });
        return jsonResponse({ success: true, label });
      }

      case "list_threads": {
        const params = new URLSearchParams();
        for (const l of body.labelIds || []) params.append("labelIds", String(l));
        if (body.q) params.set("q", String(body.q));
        if (body.pageToken) params.set("pageToken", String(body.pageToken));
        params.set("maxResults", String(Math.min(Number(body.maxResults) || 25, 50)));
        const list = await gmailFetch(tok.accessToken, `/threads?${params.toString()}`);
        const ids = (list.threads || []).map((t: any) => t.id);
        const threads = await fetchThreadSummaries(tok.accessToken, ids);
        return jsonResponse({
          success: true, threads,
          nextPageToken: list.nextPageToken || null,
          resultSizeEstimate: list.resultSizeEstimate || 0,
        });
      }

      case "get_thread": {
        if (!body.threadId) return jsonResponse({ success: false, error: "threadId required" }, 400);
        const t = await gmailFetch(tok.accessToken, `/threads/${body.threadId}?format=full`);
        return jsonResponse({
          success: true,
          thread: { id: t.id, messages: (t.messages || []).map(parseMessage) },
        });
      }

      case "send": {
        const { to, cc, bcc, subject, bodyText, bodyHtml, threadId, inReplyTo, references } = body;
        if (!to || !subject || !bodyText) {
          return jsonResponse({ success: false, error: "to, subject, bodyText required" }, 400);
        }
        const mime = buildMime({
          from: tok.accountEmail, to, cc, bcc, subject,
          text: bodyText, html: bodyHtml, inReplyTo, references,
        });
        const sent = await gmailFetch(tok.accessToken, "/messages/send", {
          method: "POST",
          body: JSON.stringify({ raw: base64UrlEncode(mime), ...(threadId ? { threadId } : {}) }),
        });
        await service.from("audit_log").insert({
          user_id: user.id,
          action: "comms_email_sent",
          entity_type: "gmail_connections",
          detail: { mailbox: tok.accountEmail, to, subject: String(subject).slice(0, 200), thread_id: sent.threadId, reply: !!threadId },
        });
        return jsonResponse({ success: true, id: sent.id, threadId: sent.threadId });
      }

      case "modify_thread": {
        if (!body.threadId) return jsonResponse({ success: false, error: "threadId required" }, 400);
        const add = (body.addLabelIds || []).map(String);
        const remove = (body.removeLabelIds || []).map(String);
        if (!add.length && !remove.length) {
          return jsonResponse({ success: false, error: "addLabelIds or removeLabelIds required" }, 400);
        }
        await gmailFetch(tok.accessToken, `/threads/${body.threadId}/modify`, {
          method: "POST",
          body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
        });
        return jsonResponse({ success: true });
      }

      // Gmail bin, never permanent deletion (gmail.modify can't hard-delete
      // anyway — that needs the full mail scope, deliberately not requested).
      case "trash_thread":
      case "untrash_thread": {
        if (!body.threadId) return jsonResponse({ success: false, error: "threadId required" }, 400);
        await gmailFetch(tok.accessToken,
          `/threads/${body.threadId}/${action === "trash_thread" ? "trash" : "untrash"}`,
          { method: "POST", body: "{}" });
        return jsonResponse({ success: true });
      }

      case "get_attachment": {
        if (!body.messageId || !body.attachmentId) {
          return jsonResponse({ success: false, error: "messageId and attachmentId required" }, 400);
        }
        const att = await gmailFetch(tok.accessToken,
          `/messages/${body.messageId}/attachments/${encodeURIComponent(body.attachmentId)}`);
        return jsonResponse({ success: true, size: att.size, data: att.data });
      }

      default:
        return jsonResponse({ success: false, error: `Unknown action: ${action}` }, 400);
    }
  } catch (e) {
    if (e instanceof GmailApiError) {
      // 403 with the old compose+readonly consent → tell the UI a reconnect fixes it.
      const needsReconnect = e.status === 403 && !(tok.scope || "").includes("gmail.modify");
      return jsonResponse({
        success: false, error: e.message,
        ...(needsReconnect ? { code: "needs_reconnect" } : {}),
      }, 502);
    }
    return jsonResponse({ success: false, error: (e as Error).message }, 500);
  }
});
