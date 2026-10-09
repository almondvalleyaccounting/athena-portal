// Shared Gmail sending + the send controls, used by comms-gmail (the screen)
// and comms-outbox-run (the every-minute sender for undo send / send later),
// so an email goes out — and is checked — the same way from either.
//
// Send controls (sql/364), after a team member emailed the whole client base:
//   1. one email to more than one client → warning;
//   2. a client's email replied/forwarded to someone else → warning;
//   3. more than N recipients outside the firm → blocked
//      (N = app_settings.email_max_external_recipients, an Athena admin setting).
// Warnings need the sender's explicit go-ahead; the cap can't be overridden.
// Bulk mail belongs in Client Tax Reminders.

import { base64UrlEncode, formatSender } from "./gmail-client.ts";

export const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailApiError extends Error {
  status: number;
  constructor(status: number, body: string) {
    super(`Gmail API ${status}: ${body.slice(0, 500)}`);
    this.status = status;
  }
}

export async function gmailFetch(accessToken: string, path: string, init?: RequestInit) {
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

export function header(headers: Array<{ name: string; value: string }> | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

// "Almond Valley <info@av.co.uk>" → "info@av.co.uk" (lowercased, "" if unparseable).
export function extractEmail(raw: string): string {
  const m = String(raw || "").match(/<([^>]+)>/);
  const e = (m ? m[1] : String(raw || "")).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : "";
}

// Every address in a To/Cc/Bcc string ("A <a@x>, b@y; "Smith, J" <j@z>").
// Pulled out by pattern rather than split on commas — display names can hold
// commas.
export function addressesIn(...fields: Array<string | undefined | null>): string[] {
  const out = new Set<string>();
  for (const f of fields) {
    for (const m of String(f || "").matchAll(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
      out.add(m[0].toLowerCase());
    }
  }
  return [...out];
}

function encodeSubject(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const b64 = base64UrlEncode(s).replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
  return `=?UTF-8?B?${padded}?=`;
}

export function buildMime(opts: {
  from: string; to: string; cc?: string; bcc?: string; subject: string;
  text: string; html?: string; inReplyTo?: string; references?: string;
  reaction?: string;
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
  // Gmail emoji reaction: an extra alternative part Gmail renders as a
  // reaction under the original; other clients fall back to the plain/HTML
  // parts (just the emoji). Needs In-Reply-To pointing at the email reacted to.
  const reactionPart = opts.reaction
    ? [
      `--${boundary}`,
      `Content-Type: text/vnd.google.email-reaction+json; charset="UTF-8"`,
      `Content-Transfer-Encoding: 8bit`,
      "",
      JSON.stringify({ emoji: opts.reaction, version: 1 }),
    ]
    : [];
  const body = [
    "",
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 8bit`,
    "",
    opts.text,
    ...reactionPart,
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

export interface SendPayload {
  to: string; cc?: string; bcc?: string; subject: string;
  bodyText: string; bodyHtml?: string;
  threadId?: string; inReplyTo?: string; references?: string;
  reaction?: string;
}

export interface SendToken {
  accessToken: string; accountEmail: string; displayName: string | null;
}

// Send one email and write the audit row. Returns Gmail's ids.
// deno-lint-ignore no-explicit-any
export async function sendEmail(tok: SendToken, service: any, staffId: string, p: SendPayload, via = "athena") {
  const mime = buildMime({
    from: formatSender(tok.displayName, tok.accountEmail), to: p.to, cc: p.cc, bcc: p.bcc, subject: p.subject,
    text: p.bodyText, html: p.bodyHtml, inReplyTo: p.inReplyTo, references: p.references, reaction: p.reaction,
  });
  const sent = await gmailFetch(tok.accessToken, "/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw: base64UrlEncode(mime), ...(p.threadId ? { threadId: p.threadId } : {}) }),
  });
  await service.from("audit_log").insert({
    user_id: staffId,
    action: "comms_email_sent",
    entity_type: "gmail_connections",
    detail: {
      mailbox: tok.accountEmail, to: p.to, cc: p.cc || null, subject: String(p.subject).slice(0, 200),
      thread_id: sent.threadId, reply: !!p.threadId, via,
    },
  });
  return { id: sent.id as string, threadId: sent.threadId as string };
}

// ── The checks ───────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
export async function recipientCap(service: any): Promise<number> {
  const { data } = await service.from("app_settings").select("setting_value")
    .eq("setting_key", "email_max_external_recipients").maybeSingle();
  const n = Number(data?.setting_value);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

export interface SendCheck {
  blocked: string | null;      // a reason, or null
  warnings: string[];          // need the sender's go-ahead
  external: string[];          // recipients outside the firm
}

// mode: 'new' | 'reply' | 'replyAll' | 'forward'. context: the From/To/Cc of
// the email being replied to or forwarded (null for a new email).
export async function checkSend(
  // deno-lint-ignore no-explicit-any
  service: any,
  opts: {
    mailbox: string; to?: string; cc?: string; bcc?: string; mode?: string;
    context?: { from?: string; to?: string; cc?: string } | null;
  },
): Promise<SendCheck> {
  const firm = (opts.mailbox.split("@")[1] || "").toLowerCase();
  const isExternal = (e: string) => !!e && !(firm && e.endsWith(`@${firm}`));
  const recipients = addressesIn(opts.to, opts.cc, opts.bcc);
  const external = recipients.filter(isExternal);

  const cap = await recipientCap(service);
  if (external.length > cap) {
    return {
      blocked: `This email has ${external.length} recipients outside the firm. Athena sends to at most ${cap} per email — ` +
        `for a mailing to clients, use Client Tax Reminders.`,
      warnings: [], external,
    };
  }

  const ctx = opts.context
    ? addressesIn(opts.context.from, opts.context.to, opts.context.cc).filter(isExternal)
    : [];
  const lookup = [...new Set([...external, ...ctx])];
  const byEmail = new Map<string, Map<string, string>>(); // email → entity_id → name
  if (lookup.length) {
    const { data, error } = await service.rpc("comms_recipient_entities", { p_emails: lookup });
    if (error) throw new Error(`Recipient check failed: ${error.message}`);
    for (const r of data || []) {
      const m = byEmail.get(r.email) || new Map<string, string>();
      m.set(r.entity_id, r.entity_name);
      byEmail.set(r.email, m);
    }
  }

  // Group addresses into clients: two addresses are the same client when
  // their records overlap (a director's own record and their company's share
  // the person). Each group is named by its most-shared record.
  const groupsOf = (emails: string[]) => {
    const groups: Array<{ emails: string[]; ids: Set<string>; names: Map<string, string> }> = [];
    for (const e of emails) {
      const ents = byEmail.get(e);
      if (!ents) continue;
      const hits = groups.filter((g) => [...ents.keys()].some((id) => g.ids.has(id)));
      const merged = { emails: [e], ids: new Set(ents.keys()), names: new Map(ents) };
      for (const g of hits) {
        merged.emails.push(...g.emails);
        g.ids.forEach((id) => merged.ids.add(id));
        g.names.forEach((n, id) => merged.names.set(id, n));
        groups.splice(groups.indexOf(g), 1);
      }
      groups.push(merged);
    }
    return groups.map((g) => {
      const count = new Map<string, number>();
      for (const e of g.emails) for (const id of byEmail.get(e)!.keys()) count.set(id, (count.get(id) || 0) + 1);
      const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return { ...g, name: g.names.get(top)! };
    });
  };

  const warnings: string[] = [];
  const sendGroups = groupsOf(external);
  if (sendGroups.length > 1) {
    warnings.push(`This email goes to ${sendGroups.length} different clients: ${sendGroups.map((g) => g.name).join(", ")}.`);
  }

  if (ctx.length) {
    const ctxGroups = groupsOf(ctx);
    const ctxIds = new Set(ctxGroups.flatMap((g) => [...g.ids]));
    if (ctxGroups.length) {
      const ctxName = ctxGroups.map((g) => g.name).join(" and ");
      if (ctxGroups.length > 1 && (opts.mode === "forward" || opts.mode === "replyAll")) {
        warnings.push(`The email you're ${opts.mode === "forward" ? "forwarding" : "replying to"} already involves ${ctxGroups.length} clients: ${ctxName}.`);
      }
      for (const g of sendGroups) {
        if (![...g.ids].some((id) => ctxIds.has(id))) {
          warnings.push(`This email is with ${ctxName}, but you're sending it to ${g.name}.`);
        }
      }
      if (opts.mode === "forward") {
        const strangers = external.filter((e) => !byEmail.has(e));
        if (strangers.length) {
          warnings.push(`You're forwarding ${ctxName}'s email to ${strangers.length === 1 ? "someone" : "people"} not on their record: ${strangers.join(", ")}.`);
        }
      }
    }
  }
  return { blocked: null, warnings, external };
}
