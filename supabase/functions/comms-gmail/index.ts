// comms-gmail — Athena Portal
// The Communications module's Gmail proxy. One POST endpoint, action-based:
//
//   { action, mailbox, ... }   mailbox = connected account email
//
//   list_labels    → user's labels (system + custom)
//   list_threads   { labelIds?, q?, pageToken?, maxResults?, excludeOwn? }
//   get_thread     { threadId }        full messages, parsed bodies + attachments
//   list_messages  { labelIds?, q?, pageToken?, maxResults?, excludeOwn? }
//                    one row per EMAIL rather than per conversation
//   get_message    { messageId }       one email, parsed body + attachments
//   rename_label   { labelId, name }   rename / move a label (and its children)
//   sent_index     { max? }   my recent sent mail → the Message-ID each answered
//   gmail_signature           this mailbox's Gmail signature(s), to import
//   sig_save / sig_delete / sig_use   my signatures and where each is used (sql/365)
//   get_vacation / set_vacation       Out of office (Gmail vacation responder)
//   list_filters / create_filter / delete_filter   Rules (Gmail filters)
//                    — need gmail.settings.basic (reconnect once)
//   queue_send     { …send fields, sendAt?, mode?, contextMessageId?, acknowledged? }
//                    every composer email: checked (sql/364), then held in
//                    comms_outbox — 20s for undo, or until a Send later time
//   send_queued    { id }   send one of my queued emails now
//   cancel_queued  { id }   take it back (returns it, to reopen as a draft)
//
//   send and queue_send run the send controls: too many outside recipients is
//   refused; a cross-client warning comes back as code needs_confirmation with
//   the warnings, and is sent only when re-sent with acknowledged: true.
//   modify_message / trash_message / untrash_message  { messageId, … }
//                    the per-email versions of the thread actions
//   send           { to, cc?, bcc?, subject, bodyText, bodyHtml?, threadId?,
//                    inReplyTo?, references? }   new mail / reply / forward
//   modify_thread  { threadId, addLabelIds?, removeLabelIds? }
//                    archive = remove INBOX; mark read = remove UNREAD
//   trash_thread   { threadId }        Gmail bin (recoverable ~30 days)
//   untrash_thread { threadId }        undo for the above
//   get_attachment { messageId, attachmentId }
//   learn_labels   { maxThreads? }     scan recent archived threads and
//                    record sender→label stats into comms_tag_rules (feeds
//                    the inbox's auto-suggested tags)
//   reject_tag     { sender, labelId, labelName }   mark a sender→label
//                    suggestion wrong so the inbox stops offering it
//
// Deployed with verify_jwt ON; additionally checks the caller is active staff
// and may use the mailbox: personal mailboxes are owner-only (portal admins
// excepted), shared mailboxes are open to all active staff. Tokens never
// leave the server — the browser only ever sees parsed message data.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getValidGmailToken, jsonResponse, corsHeaders, getServiceClient,
} from "../_shared/gmail-client.ts";
import {
  gmailFetch, GmailApiError, header, extractEmail, sendEmail, checkSend, type SendPayload,
} from "../_shared/gmail-send.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

function base64UrlDecode(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
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

// Fetch thread summaries in small batches to stay inside Gmail's per-user
// rate quota (threads.get costs 10 units, 250 units/sec allowed), so a chunk
// of 10 is 100 units. Small pages go at full tilt; anything bigger paces
// itself, because a get lost to a 429 would silently drop a conversation from
// the list. One retry, then it's counted and reported as `missed`.
// Every address this mailbox sends as — the account plus its Send-mail-as
// aliases. A mailbox that still sends from an old address had its own sent
// mail treated as a stranger's: shown in the inbox under its own name.
async function selfAddresses(accessToken: string, accountEmail: string): Promise<Set<string>> {
  const self = new Set([accountEmail.toLowerCase()]);
  try {
    const data = await gmailFetch(accessToken, "/settings/sendAs");
    for (const a of data.sendAs || []) if (a.sendAsEmail) self.add(String(a.sendAsEmail).toLowerCase());
  } catch { /* the account address alone is still right, just incomplete */ }
  return self;
}

// focusLabel: the folder being listed. Gmail files a whole conversation under
// a label when ANY message carries it, so a row built from the thread's last
// message showed our own reply in the Inbox. The row describes the latest
// message that is actually in the folder instead; onlySelf marks threads
// whose in-folder messages are all our own.
async function fetchThreadSummaries(
  accessToken: string, ids: string[], self: Set<string> = new Set(), focusLabel = "",
) {
  const summaries: any[] = [];
  const CHUNK = 10;
  const pace = ids.length > CHUNK * 2 ? 300 : 0;
  let missed = 0;
  const meta = (id: string) =>
    gmailFetch(accessToken, `/threads/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`);
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const got = await Promise.all(chunk.map((id) =>
      meta(id).catch(() =>
        new Promise((r) => setTimeout(r, 500)).then(() => meta(id)).catch(() => null))
    ));
    if (pace && i + CHUNK < ids.length) await new Promise((r) => setTimeout(r, pace));
    for (const t of got as any[]) {
      if (!t) { missed++; continue; }
      const msgs = t.messages || [];
      const first = msgs[0];
      const inFolder = focusLabel ? msgs.filter((m: any) => (m.labelIds || []).includes(focusLabel)) : [];
      const last = inFolder.length ? inFolder[inFolder.length - 1] : msgs[msgs.length - 1];
      const isSelf = (m: any) => self.has(extractEmail(header(m?.payload?.headers, "From")));
      const labelIds = new Set<string>();
      for (const m of msgs) for (const l of m.labelIds || []) labelIds.add(l);
      // Most recent From that isn't the mailbox itself — the conversation
      // partner even when we replied last (drives tag suggestions).
      let counterpartFrom = "";
      for (let j = msgs.length - 1; j >= 0; j--) {
        const f = header(msgs[j]?.payload?.headers, "From");
        const e = extractEmail(f);
        if (e && !self.has(e)) { counterpartFrom = f; break; }
      }
      summaries.push({
        counterpartFrom,
        fromSelf: isSelf(last),
        onlySelf: inFolder.length > 0 && inFolder.every(isSelf),
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
  return { summaries, missed };
}

// One row per email (messages.list), for the inbox's email-level view. Gmail
// groups replies AND unrelated mail with a similar subject into one thread, so
// a thread row could open on a different email from the one clicked. Same
// paced batching as the thread summaries; messages.get costs 5 units, not 10.
async function fetchMessageSummaries(accessToken: string, ids: string[], self: Set<string>) {
  const summaries: any[] = [];
  const CHUNK = 20;
  const pace = ids.length > CHUNK * 2 ? 250 : 0;
  let missed = 0;
  const meta = (id: string) =>
    gmailFetch(accessToken, `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID`);
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const got = await Promise.all(chunk.map((id) =>
      meta(id).catch(() =>
        new Promise((r) => setTimeout(r, 500)).then(() => meta(id)).catch(() => null))
    ));
    if (pace && i + CHUNK < ids.length) await new Promise((r) => setTimeout(r, pace));
    for (const m of got as any[]) {
      if (!m) { missed++; continue; }
      const h = m.payload?.headers;
      const from = header(h, "From");
      const fromSelf = self.has(extractEmail(from));
      const labelIds: string[] = m.labelIds || [];
      summaries.push({
        id: m.id,
        threadId: m.threadId,
        messageCount: 1,
        // The other party for tag suggestions; blank when we sent it.
        counterpartFrom: fromSelf ? "" : from,
        fromSelf,
        onlySelf: fromSelf,
        snippet: m.snippet || "",
        subject: header(h, "Subject") || "(no subject)",
        from,
        to: header(h, "To"),
        // Matched against the In-Reply-To of my sent mail (sent_index) to show
        // "you replied / forwarded".
        messageIdHeader: header(h, "Message-ID"),
        internalDate: Number(m.internalDate || 0),
        unread: labelIds.includes("UNREAD"),
        labelIds,
      });
    }
  }
  summaries.sort((a, b) => b.internalDate - a.internalDate);
  return { summaries, missed };
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

  // The send controls for a send/queue_send body. Returns a response to send
  // back instead (blocked, or warnings not yet acknowledged), or null to go on.
  // deno-lint-ignore no-explicit-any
  const gateSend = async (t: any, b: any): Promise<Response | null> => {
    let context = null;
    if (b.contextMessageId) {
      try {
        const m = await gmailFetch(t.accessToken,
          `/messages/${b.contextMessageId}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc`);
        const h = m.payload?.headers;
        context = { from: header(h, "From"), to: header(h, "To"), cc: header(h, "Cc") };
      } catch { /* original gone: check the recipients alone */ }
    }
    const check = await checkSend(service, {
      mailbox: t.accountEmail, to: b.to, cc: b.cc, bcc: b.bcc, mode: b.mode, context,
    });
    if (check.blocked) {
      return jsonResponse({ success: false, error: check.blocked, code: "too_many_recipients" }, 400);
    }
    if (check.warnings.length && !b.acknowledged) {
      return jsonResponse({ success: false, code: "needs_confirmation", error: check.warnings.join(" "), warnings: check.warnings });
    }
    return null;
  };

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

      // Rename or move a label. Gmail nests by name ("Parent/Child"), and a
      // child's name holds the full path, so moving a label renames every
      // label beneath it too. Returns the labels changed.
      case "rename_label": {
        const id = String(body.labelId || "");
        const newName = String(body.name || "").split("/").map((p) => p.trim()).filter(Boolean).join("/");
        if (!id || !newName) return jsonResponse({ success: false, error: "labelId and name required" }, 400);
        const all = (await gmailFetch(tok.accessToken, "/labels")).labels || [];
        const target = all.find((l: any) => l.id === id);
        if (!target || target.type !== "user") return jsonResponse({ success: false, error: "Label not found" }, 404);
        const oldName: string = target.name;
        if (newName === oldName) return jsonResponse({ success: true, renamed: [] });
        if (newName.startsWith(`${oldName}/`)) {
          return jsonResponse({ success: false, error: "A label can't go inside itself." }, 400);
        }
        // Parent first, then children, so each child's new parent exists.
        const moves = all
          .filter((l: any) => l.type === "user" && (l.id === id || l.name.startsWith(`${oldName}/`)))
          .sort((a: any, b: any) => a.name.length - b.name.length)
          .map((l: any) => ({ id: l.id, from: l.name, to: newName + l.name.slice(oldName.length) }));
        const renamed = [];
        for (const m of moves) {
          const res = await gmailFetch(tok.accessToken, `/labels/${m.id}`, {
            method: "PATCH", body: JSON.stringify({ name: m.to }),
          });
          renamed.push({ id: res.id, name: res.name });
        }
        // Learned tag rules show the name; keep it current.
        for (const r of renamed) {
          await service.from("comms_tag_rules").update({ label_name: r.name })
            .eq("mailbox_email", tok.accountEmail.toLowerCase()).eq("label_id", r.id);
        }
        return jsonResponse({ success: true, renamed });
      }

      case "list_threads": {
        const params = new URLSearchParams();
        for (const l of body.labelIds || []) params.append("labelIds", String(l));
        if (body.q) params.set("q", String(body.q));
        if (body.pageToken) params.set("pageToken", String(body.pageToken));
        params.set("maxResults", String(Math.min(Number(body.maxResults) || 25, 100)));
        const list = await gmailFetch(tok.accessToken, `/threads?${params.toString()}`);
        const ids = (list.threads || []).map((t: any) => t.id);
        const labels = (body.labelIds || []).map(String);
        const focus = labels.length === 1 ? labels[0] : "";
        const self = await selfAddresses(tok.accessToken, tok.accountEmail);
        const { summaries, missed } = await fetchThreadSummaries(tok.accessToken, ids, self, focus);
        // -from:me in q only knows the account address, not its aliases.
        const threads = body.excludeOwn ? summaries.filter((t) => !t.onlySelf) : summaries;
        return jsonResponse({
          success: true, threads, missed, scanned: ids.length,
          nextPageToken: list.nextPageToken || null,
          resultSizeEstimate: list.resultSizeEstimate || 0,
        });
      }

      case "list_messages": {
        const params = new URLSearchParams();
        for (const l of body.labelIds || []) params.append("labelIds", String(l));
        if (body.q) params.set("q", String(body.q));
        if (body.pageToken) params.set("pageToken", String(body.pageToken));
        params.set("maxResults", String(Math.min(Number(body.maxResults) || 25, 100)));
        const list = await gmailFetch(tok.accessToken, `/messages?${params.toString()}`);
        const ids = (list.messages || []).map((m: any) => m.id);
        const self = await selfAddresses(tok.accessToken, tok.accountEmail);
        const { summaries, missed } = await fetchMessageSummaries(tok.accessToken, ids, self);
        const messages = body.excludeOwn ? summaries.filter((m) => !m.fromSelf) : summaries;
        return jsonResponse({
          success: true, messages, missed, scanned: ids.length,
          nextPageToken: list.nextPageToken || null,
        });
      }

      // What I've answered: my recent sent mail, each with the Message-ID it
      // replied to or forwarded (In-Reply-To — Gmail and Athena both set it,
      // forwards included). The screen matches these against the emails it
      // lists. Newest first, up to `max` (≤500), paced like the list.
      case "sent_index": {
        const max = Math.min(Math.max(Number(body.max) || 300, 10), 500);
        const ids: string[] = [];
        let pageToken: string | undefined;
        while (ids.length < max) {
          const params = new URLSearchParams({ maxResults: String(Math.min(100, max - ids.length)) });
          params.append("labelIds", "SENT");
          if (pageToken) params.set("pageToken", pageToken);
          const list = await gmailFetch(tok.accessToken, `/messages?${params.toString()}`);
          const batch = (list.messages || []).map((m: { id: string }) => m.id);
          ids.push(...batch);
          pageToken = list.nextPageToken;
          if (!pageToken || !batch.length) break;
        }
        const out: Array<Record<string, unknown>> = [];
        const CHUNK = 20;
        for (let i = 0; i < ids.length; i += CHUNK) {
          const got = await Promise.all(ids.slice(i, i + CHUNK).map((id) =>
            gmailFetch(tok.accessToken,
              `/messages/${id}?format=metadata&metadataHeaders=In-Reply-To&metadataHeaders=Subject&metadataHeaders=To`)
              .catch(() => null)));
          for (const m of got) {
            if (!m) continue;
            const h = m.payload?.headers;
            const inReplyTo = header(h, "In-Reply-To").trim();
            if (!inReplyTo) continue; // a new email answers nothing
            out.push({
              id: m.id,
              inReplyTo,
              forward: /^\s*(fwd?|fw)\s*:/i.test(header(h, "Subject")),
              to: header(h, "To"),
              date: Number(m.internalDate || 0),
            });
          }
          if (i + CHUNK < ids.length) await new Promise((r) => setTimeout(r, 200));
        }
        return jsonResponse({ success: true, sent: out });
      }

      // ── Signatures (sql/365) ──────────────────────────────────────────
      // The Gmail signature(s) set on this mailbox, as HTML, to import.
      case "gmail_signature": {
        const data = await gmailFetch(tok.accessToken, "/settings/sendAs");
        const list = (data.sendAs || [])
          .filter((a: { signature?: string }) => (a.signature || "").trim())
          .map((a: { sendAsEmail: string; displayName?: string; signature: string; isDefault?: boolean }) => ({
            email: a.sendAsEmail, name: a.displayName || "", html: a.signature, isDefault: !!a.isDefault,
          }));
        return jsonResponse({ success: true, signatures: list });
      }

      // Save (create or update) one of MY signatures. Scripts and inline
      // event handlers are stripped — a signature is formatting, not code.
      case "sig_save": {
        const name = String(body.name || "").trim().slice(0, 80);
        if (!name) return jsonResponse({ success: false, error: "Give the signature a name." }, 400);
        const html = String(body.bodyHtml || "")
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
          .replace(/javascript:/gi, "");
        if (html.length > 100_000) return jsonResponse({ success: false, error: "That signature is too large." }, 400);
        const now = new Date().toISOString();
        const q = body.id
          ? service.from("comms_signature_templates").update({ name, body_html: html, updated_at: now })
            .eq("id", body.id).eq("staff_id", user.id).select("id").maybeSingle()
          : service.from("comms_signature_templates").insert({ staff_id: user.id, name, body_html: html })
            .select("id").single();
        const { data: row, error: e } = await q;
        if (e) throw new Error(e.message);
        if (!row) return jsonResponse({ success: false, error: "Signature not found." }, 404);
        return jsonResponse({ success: true, id: row.id });
      }

      case "sig_delete": {
        if (!body.id) return jsonResponse({ success: false, error: "id required" }, 400);
        const { error: e } = await service.from("comms_signature_templates").delete()
          .eq("id", body.id).eq("staff_id", user.id);
        if (e) throw new Error(e.message);
        return jsonResponse({ success: true });
      }

      // Which signature I use for an action, on this mailbox or all of mine
      // (scope '*'). signatureId null = none; clear: true = back to the
      // all-mailboxes choice.
      case "sig_use": {
        const action = String(body.useAction || "");
        if (!["new", "reply", "forward"].includes(action)) {
          return jsonResponse({ success: false, error: "useAction must be new, reply or forward" }, 400);
        }
        const scope = body.scope === "*" ? "*" : tok.accountEmail.toLowerCase();
        if (body.clear) {
          await service.from("comms_signature_use").delete()
            .eq("staff_id", user.id).eq("mailbox_email", scope).eq("action", action);
          return jsonResponse({ success: true });
        }
        const sigId = body.signatureId || null;
        if (sigId) {
          const { data: mine } = await service.from("comms_signature_templates").select("id")
            .eq("id", sigId).eq("staff_id", user.id).maybeSingle();
          if (!mine) return jsonResponse({ success: false, error: "Signature not found." }, 404);
        }
        const { error: e } = await service.from("comms_signature_use").upsert({
          staff_id: user.id, mailbox_email: scope, action, signature_id: sigId, updated_at: new Date().toISOString(),
        });
        if (e) throw new Error(e.message);
        return jsonResponse({ success: true });
      }

      // ── Out of office + Rules (gmail.settings.basic) ──────────────────
      // A mailbox connected before that permission was added gets code
      // needs_settings_permission — the screen says "reconnect".
      case "get_vacation":
      case "set_vacation":
      case "list_filters":
      case "create_filter":
      case "delete_filter": {
        if (!(tok.scope || "").includes("gmail.settings.basic")) {
          return jsonResponse({
            success: false, code: "needs_settings_permission",
            error: "This mailbox needs reconnecting once to manage out of office and rules.",
          });
        }
        if (action === "get_vacation") {
          const v = await gmailFetch(tok.accessToken, "/settings/vacation");
          return jsonResponse({ success: true, vacation: v });
        }
        if (action === "set_vacation") {
          const v = body.vacation || {};
          const html = String(v.responseBodyHtml || "").slice(0, 100_000)
            .replace(/<script[\s\S]*?<\/script>/gi, "");
          const payload: Record<string, unknown> = {
            enableAutoReply: !!v.enableAutoReply,
            responseSubject: String(v.responseSubject || "").slice(0, 300),
            responseBodyHtml: html,
            responseBodyPlainText: String(v.responseBodyPlainText || "").slice(0, 100_000),
            restrictToContacts: !!v.restrictToContacts,
            restrictToDomain: !!v.restrictToDomain,
          };
          if (v.startTime) payload.startTime = String(Number(v.startTime));
          if (v.endTime) payload.endTime = String(Number(v.endTime));
          const saved = await gmailFetch(tok.accessToken, "/settings/vacation", {
            method: "PUT", body: JSON.stringify(payload),
          });
          return jsonResponse({ success: true, vacation: saved });
        }
        if (action === "list_filters") {
          const f = await gmailFetch(tok.accessToken, "/settings/filters");
          return jsonResponse({ success: true, filters: f.filter || [] });
        }
        if (action === "delete_filter") {
          if (!body.filterId) return jsonResponse({ success: false, error: "filterId required" }, 400);
          const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/settings/filters/${encodeURIComponent(String(body.filterId))}`, {
            method: "DELETE", headers: { Authorization: `Bearer ${tok.accessToken}` },
          });
          if (!r.ok && r.status !== 404) throw new GmailApiError(r.status, await r.text());
          return jsonResponse({ success: true });
        }
        // create_filter: criteria { from, to, subject, query, negatedQuery, hasAttachment }
        // and action { addLabelIds, removeLabelIds } — Gmail's own filter
        // shape. Forwarding isn't offered (needs a further permission).
        const c = body.criteria || {};
        const criteria: Record<string, unknown> = {};
        for (const k of ["from", "to", "subject", "query", "negatedQuery"]) {
          const val = String(c[k] || "").trim().slice(0, 500);
          if (val) criteria[k] = val;
        }
        if (c.hasAttachment) criteria.hasAttachment = true;
        if (!Object.keys(criteria).length) {
          return jsonResponse({ success: false, error: "Say which emails the rule is for." }, 400);
        }
        const allowedSystem = new Set(["INBOX", "UNREAD", "STARRED", "IMPORTANT", "TRASH", "SPAM"]);
        const clean = (ids: unknown) => (Array.isArray(ids) ? ids : []).map(String)
          .filter((id) => allowedSystem.has(id) || /^Label_\w+$/.test(id));
        const act = { addLabelIds: clean(body.ruleAction?.addLabelIds), removeLabelIds: clean(body.ruleAction?.removeLabelIds) };
        if (!act.addLabelIds.length && !act.removeLabelIds.length) {
          return jsonResponse({ success: false, error: "Say what the rule should do." }, 400);
        }
        const created = await gmailFetch(tok.accessToken, "/settings/filters", {
          method: "POST", body: JSON.stringify({ criteria, action: act }),
        });
        // Optionally do the same to matching mail already there (Gmail's
        // filters only act on new mail). Capped so one rule can't sweep a
        // whole mailbox by accident.
        let applied = 0;
        if (body.applyToExisting) {
          const q = [
            criteria.from ? `from:(${criteria.from})` : "",
            criteria.to ? `to:(${criteria.to})` : "",
            criteria.subject ? `subject:(${criteria.subject})` : "",
            criteria.query ? String(criteria.query) : "",
            criteria.negatedQuery ? `-{${criteria.negatedQuery}}` : "",
            criteria.hasAttachment ? "has:attachment" : "",
          ].filter(Boolean).join(" ");
          const ids: string[] = [];
          let pageToken: string | undefined;
          while (ids.length < 500) {
            const params = new URLSearchParams({ q, maxResults: "100" });
            if (pageToken) params.set("pageToken", pageToken);
            const list = await gmailFetch(tok.accessToken, `/messages?${params.toString()}`);
            ids.push(...(list.messages || []).map((m: { id: string }) => m.id));
            pageToken = list.nextPageToken;
            if (!pageToken) break;
          }
          if (ids.length) {
            await gmailFetch(tok.accessToken, "/messages/batchModify", {
              method: "POST", body: JSON.stringify({ ids: ids.slice(0, 500), ...act }),
            });
            applied = Math.min(ids.length, 500);
          }
        }
        return jsonResponse({ success: true, filter: created, applied });
      }

      case "get_message": {
        if (!body.messageId) return jsonResponse({ success: false, error: "messageId required" }, 400);
        const m = await gmailFetch(tok.accessToken, `/messages/${body.messageId}?format=full`);
        return jsonResponse({ success: true, message: parseMessage(m) });
      }

      case "modify_message": {
        if (!body.messageId) return jsonResponse({ success: false, error: "messageId required" }, 400);
        const add = (body.addLabelIds || []).map(String);
        const remove = (body.removeLabelIds || []).map(String);
        if (!add.length && !remove.length) {
          return jsonResponse({ success: false, error: "addLabelIds or removeLabelIds required" }, 400);
        }
        await gmailFetch(tok.accessToken, `/messages/${body.messageId}/modify`, {
          method: "POST",
          body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
        });
        return jsonResponse({ success: true });
      }

      // Bin, never permanent deletion — same as the thread versions below.
      case "trash_message":
      case "untrash_message": {
        if (!body.messageId) return jsonResponse({ success: false, error: "messageId required" }, 400);
        await gmailFetch(tok.accessToken,
          `/messages/${body.messageId}/${action === "trash_message" ? "trash" : "untrash"}`,
          { method: "POST", body: "{}" });
        return jsonResponse({ success: true });
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
        // One emoji, and only as a reply to a specific email.
        const reaction = typeof body.reaction === "string" && body.reaction.length <= 16 && inReplyTo
          ? body.reaction : undefined;
        if (!to || !subject || !bodyText) {
          return jsonResponse({ success: false, error: "to, subject, bodyText required" }, 400);
        }
        const gate = await gateSend(tok, body);
        if (gate) return gate;
        const sent = await sendEmail(tok, service, user.id,
          { to, cc, bcc, subject, bodyText, bodyHtml, threadId, inReplyTo, references, reaction });
        return jsonResponse({ success: true, id: sent.id, threadId: sent.threadId });
      }

      case "queue_send": {
        const p: SendPayload = {
          to: String(body.to || "").trim(), cc: body.cc || undefined, bcc: body.bcc || undefined,
          subject: String(body.subject || "").trim(), bodyText: String(body.bodyText || ""),
          bodyHtml: body.bodyHtml || undefined, threadId: body.threadId || undefined,
          inReplyTo: body.inReplyTo || undefined, references: body.references || undefined,
        };
        if (!p.to || !p.subject || !p.bodyText) {
          return jsonResponse({ success: false, error: "to, subject, bodyText required" }, 400);
        }
        let sendAt = new Date(Date.now() + 20_000);
        let kind = "undo";
        if (body.sendAt) {
          const t = new Date(String(body.sendAt));
          if (isNaN(t.getTime())) return jsonResponse({ success: false, error: "sendAt is not a date" }, 400);
          if (t.getTime() > Date.now() + 366 * 86400_000) {
            return jsonResponse({ success: false, error: "Send later is limited to a year ahead." }, 400);
          }
          if (t.getTime() > Date.now() + 30_000) { sendAt = t; kind = "later"; }
        }
        const gate = await gateSend(tok, body);
        if (gate) return gate;
        // The composer as written (text without the quote, the quote apart), so
        // cancelling reopens a clean draft. Not used for sending.
        const draft = body.draft && JSON.stringify(body.draft).length < 400_000 ? body.draft : null;
        const { data: row, error: insErr } = await service.from("comms_outbox").insert({
          staff_id: user.id,
          mailbox: tok.accountEmail.toLowerCase(),
          payload: { ...p, draft },
          subject: p.subject.slice(0, 300),
          to_summary: [p.to, p.cc].filter(Boolean).join(", ").slice(0, 300),
          send_at: sendAt.toISOString(),
          kind,
          warnings: body.acknowledged && Array.isArray(body.acknowledgedWarnings) ? body.acknowledgedWarnings : [],
        }).select("id, send_at, kind").single();
        if (insErr) throw new Error(insErr.message);
        return jsonResponse({ success: true, id: row.id, sendAt: row.send_at, kind: row.kind });
      }

      case "send_queued": {
        if (!body.id) return jsonResponse({ success: false, error: "id required" }, 400);
        // Claim it: only a queued email of mine, from this mailbox, and only once.
        const { data: row } = await service.from("comms_outbox")
          .update({ status: "sending", claimed_at: new Date().toISOString() })
          .eq("id", body.id).eq("staff_id", user.id).eq("status", "queued")
          .eq("mailbox", tok.accountEmail.toLowerCase())
          .select("id, payload").maybeSingle();
        if (!row) return jsonResponse({ success: true, already: true }); // sent by the cron, or cancelled
        try {
          const sent = await sendEmail(tok, service, user.id, row.payload as SendPayload);
          await service.from("comms_outbox").update({
            status: "sent", sent_at: new Date().toISOString(),
            gmail_message_id: sent.id, gmail_thread_id: sent.threadId,
          }).eq("id", row.id);
          return jsonResponse({ success: true, id: sent.id, threadId: sent.threadId });
        } catch (e) {
          await service.from("comms_outbox").update({ status: "failed", error: (e as Error).message.slice(0, 500) })
            .eq("id", row.id);
          throw e;
        }
      }

      case "cancel_queued": {
        if (!body.id) return jsonResponse({ success: false, error: "id required" }, 400);
        const { data: row } = await service.from("comms_outbox")
          .update({ status: "cancelled" })
          .eq("id", body.id).eq("staff_id", user.id).eq("status", "queued")
          .select("id, payload, mailbox").maybeSingle();
        if (!row) {
          return jsonResponse({ success: false, error: "Too late — it has already been sent.", code: "already_sent" }, 409);
        }
        return jsonResponse({ success: true, payload: row.payload, mailbox: row.mailbox });
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

      // One pass over recent ARCHIVED mail (processed = usually labelled):
      // each threads.get already carries every message's labelIds + From, so
      // a single call credits the sender to all user labels on the thread.
      // Results merge into comms_tag_rules — the inbox uses those stats to
      // suggest a tag per email. Re-running is safe (merge_comms_tag_rules
      // uses greatest(), so counts refresh without double-counting).
      //
      // Quota: Gmail caps "Queries per minute per user" at 15,000 units and
      // threads.get/list cost 10 each. Chunks of 5 + 350ms pauses ≈ 5k/min.
      // Anything that still fails is skipped and reported as partial.
      case "learn_labels": {
        const maxThreads = Math.min(Math.max(Number(body.maxThreads) || 400, 50), 800);
        const self = tok.accountEmail.toLowerCase();
        // Colleagues are skipped, not just ourselves: a message from a
        // teammate is *about* a client, and which client lives in the wording
        // rather than the address. Learning "raymond@ → this client" would
        // teach the inbox to suggest whichever client he last wrote about.
        const selfDomain = self.split("@")[1] || "";
        const internal = (e: string) => !!selfDomain && e.endsWith(`@${selfDomain}`);
        const labelData = await gmailFetch(tok.accessToken, "/labels");
        const userLabelById = new Map<string, string>();
        for (const l of labelData.labels || []) {
          if (l.type === "user") userLabelById.set(l.id, l.name);
        }

        const ids: string[] = [];
        let partial = false;
        try {
          let pageToken: string | undefined;
          while (ids.length < maxThreads) {
            const params = new URLSearchParams({
              q: "-in:inbox -in:spam -in:trash",
              maxResults: String(Math.min(100, maxThreads - ids.length)),
            });
            if (pageToken) params.set("pageToken", pageToken);
            const list = await gmailFetch(tok.accessToken, `/threads?${params.toString()}`);
            const batch = (list.threads || []).map((t: any) => t.id);
            ids.push(...batch);
            pageToken = list.nextPageToken;
            if (!pageToken || !batch.length) break;
            await new Promise((r) => setTimeout(r, 200));
          }
        } catch {
          partial = true; // learn from whatever we managed to list
        }

        const counts = new Map<string, { sender: string; label_id: string; label_name: string; count: number }>();
        const labelsSeen = new Set<string>();
        let scanned = 0;
        for (let i = 0; i < ids.length; i += 5) {
          const chunk = ids.slice(i, i + 5);
          const got = await Promise.all(chunk.map((id) =>
            gmailFetch(tok.accessToken, `/threads/${id}?format=metadata&metadataHeaders=From`)
              .catch(() => null)
          ));
          for (const t of got) {
            if (!t) { partial = true; continue; }
            scanned++;
            const senders = new Set<string>();
            const labelsOn = new Set<string>();
            for (const m of t.messages || []) {
              const e = extractEmail(header(m.payload?.headers, "From"));
              if (e && e !== self && !internal(e)) senders.add(e);
              for (const lid of m.labelIds || []) {
                if (userLabelById.has(lid)) labelsOn.add(lid);
              }
            }
            for (const lid of labelsOn) {
              labelsSeen.add(lid);
              for (const s of senders) {
                const key = `${s}|${lid}`;
                const cur = counts.get(key) ||
                  { sender: s, label_id: lid, label_name: userLabelById.get(lid)!, count: 0 };
                cur.count++;
                counts.set(key, cur);
              }
            }
          }
          await new Promise((r) => setTimeout(r, 350));
        }

        const rules = [...counts.values()];
        if (rules.length) {
          const { error: mergeErr } = await service.rpc("merge_comms_tag_rules", {
            p_mailbox: self,
            p_rules: rules,
          });
          if (mergeErr) return jsonResponse({ success: false, error: `Could not store rules: ${mergeErr.message}` }, 500);
        }
        return jsonResponse({
          success: true,
          threadsScanned: scanned,
          labelsScanned: labelsSeen.size,
          rules: rules.length,
          partial,
        });
      }

      // A wrong suggestion, corrected from the inbox. Kept as a rejected row
      // rather than deleted so a history re-learn can't reinstate it (sql/363).
      case "reject_tag": {
        const sender = extractEmail(String(body.sender || ""));
        const labelId = String(body.labelId || "").trim();
        if (!sender || !labelId) {
          return jsonResponse({ success: false, error: "sender and labelId required" }, 400);
        }
        const mb = tok.accountEmail.toLowerCase();
        const { data: existing, error: selErr } = await service.from("comms_tag_rules")
          .select("id").eq("mailbox_email", mb).eq("sender_email", sender).eq("label_id", labelId)
          .maybeSingle();
        if (selErr) throw new Error(selErr.message);
        const { error: writeErr } = existing
          ? await service.from("comms_tag_rules").update({ rejected: true }).eq("id", existing.id)
          : await service.from("comms_tag_rules").insert({
            mailbox_email: mb,
            sender_email: sender,
            sender_domain: sender.split("@")[1] || "",
            label_id: labelId,
            label_name: String(body.labelName || labelId).slice(0, 200),
            times_used: 0,
            source: "manual",
            rejected: true,
          });
        if (writeErr) throw new Error(writeErr.message);
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
