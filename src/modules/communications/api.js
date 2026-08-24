// Communications module — data layer.
//
// Email rides the comms-gmail edge function (tokens never reach the
// browser); mailbox metadata comes from the v_gmail_connections view
// (token columns excluded). SMS/WhatsApp read sms_messages directly
// (staff RLS) and send through the sms-send edge function.
import { supabase } from '../../lib/supabase';
import { fetchAllRows } from '../../lib/fetchAllRows';


// ── Mailboxes ─────────────────────────────────────────────────────────

// All mailboxes the caller may use: their own personal inbox + every
// shared one. Admins also see other people's personal mailboxes so they
// can spot broken connections (the edge function still owner-gates reads).
export async function listMailboxes(profile) {
  const { data, error } = await supabase
    .from('v_gmail_connections')
    .select('*')
    .order('kind', { ascending: false }) // shared first
    .order('account_email');
  if (error) throw error;
  return (data || []).filter((m) =>
    m.kind === 'shared' || m.owner_staff_id === profile?.id || profile?.is_portal_admin,
  );
}

/**
 * Start a mailbox connect flow and navigate to Google's consent screen.
 *
 * This replaces connectMailboxUrl(), which built the gmail-auth-init URL client-side
 * with staff_id in the query string. That endpoint 302'd anyone who asked and signed
 * nothing, so a stranger could consent with their own Google account and have the
 * callback install it as the practice-default mailbox — the one the reminder and chaser
 * senders use. gmail-auth-init now requires an active staff session and signs the staff
 * id into a single-use OAuth state, so the URL has to be fetched rather than built.
 *
 * Throws if the caller is not staff or the function is unreachable — callers should
 * surface the message rather than silently doing nothing.
 */
export async function startMailboxConnect({ kind, displayName, returnTo } = {}) {
  const { data, error } = await supabase.functions.invoke('gmail-auth-init', {
    body: {
      ...(kind ? { kind } : {}),
      ...(displayName ? { display_name: displayName } : {}),
      return_to: returnTo || '/comms/email',
      // Adding a mailbox from Communications must never silently take over the
      // practice default; only the legacy reconnect panel does that.
      set_default: false,
    },
  });
  if (error) throw error;
  if (!data?.url) throw new Error(data?.error || 'Could not start the mailbox connection');
  window.location.href = data.url;
}

export function mailboxNeedsReconnect(mailbox) {
  if (!mailbox) return false;
  if (mailbox.status !== 'active') return true;
  const scope = mailbox.scope || '';
  // Full current permission set = modify (archive/labels) + contacts.
  return !scope.includes('gmail.modify') || !scope.includes('contacts.readonly');
}

// ── Gmail proxy ───────────────────────────────────────────────────────

async function callGmail(action, payload = {}) {
  const { data, error } = await supabase.functions.invoke('comms-gmail', {
    body: { action, ...payload },
  });
  if (error) {
    // FunctionsHttpError carries the response — surface the real message.
    let detail = error.message;
    let code = null;
    try {
      const body = await error.context?.json();
      if (body?.error) detail = body.error;
      if (body?.code) code = body.code;
    } catch { /* keep generic message */ }
    const err = new Error(detail);
    err.code = code;
    throw err;
  }
  if (data && data.success === false) {
    const err = new Error(data.error || 'Unknown error');
    err.code = data.code || null;
    throw err;
  }
  return data;
}

export const gmail = {
  listLabels: (mailbox) => callGmail('list_labels', { mailbox }),
  createLabel: (mailbox, name) => callGmail('create_label', { mailbox, name }),
  listThreads: (mailbox, { labelIds, q, pageToken, maxResults } = {}) =>
    callGmail('list_threads', { mailbox, labelIds, q, pageToken, maxResults }),
  getThread: (mailbox, threadId) => callGmail('get_thread', { mailbox, threadId }),
  send: (mailbox, opts) => callGmail('send', { mailbox, ...opts }),
  modifyThread: (mailbox, threadId, { addLabelIds, removeLabelIds }) =>
    callGmail('modify_thread', { mailbox, threadId, addLabelIds, removeLabelIds }),
  trashThread: (mailbox, threadId) => callGmail('trash_thread', { mailbox, threadId }),
  untrashThread: (mailbox, threadId) => callGmail('untrash_thread', { mailbox, threadId }),
  getAttachment: (mailbox, messageId, attachmentId) =>
    callGmail('get_attachment', { mailbox, messageId, attachmentId }),
  learnLabels: (mailbox) => callGmail('learn_labels', { mailbox }),
};

// ── Auto-suggested tags ───────────────────────────────────────────────
// comms_tag_rules holds learned sender→label stats per mailbox: seeded by
// comms-gmail's learn_labels scan, reinforced every time a tag is applied
// here. The inbox suggests a tag per thread for one-click tag+archive.

export async function loadTagRules(mailbox) {
  const { data, error } = await supabase
    .from('comms_tag_rules')
    .select('sender_email, sender_domain, label_id, label_name, times_used, last_used_at')
    .eq('mailbox_email', mailbox)
    .limit(20000);
  if (error) throw error;
  return data || [];
}

// Fire-and-forget: suggestions are advisory, a lost write only costs a
// little learning.
export function recordTagRule(mailbox, senderEmail, label) {
  if (!mailbox || !senderEmail || !label?.id) return;
  // Never learn a colleague→client rule. Internal mail is *about* a client and
  // which one is in the wording, so the address predicts nothing — tagging
  // Raymond's email to a client by hand must not teach the inbox to suggest
  // that client for everything else he sends.
  const ownDomain = String(mailbox).split('@')[1];
  if (ownDomain && String(senderEmail).toLowerCase().endsWith(`@${ownDomain}`)) return;
  supabase.rpc('record_comms_tag', {
    p_mailbox: mailbox,
    p_sender: senderEmail,
    p_label_id: label.id,
    p_label_name: label.name,
  }).then(() => {}, () => {});
}

// Shared consumer domains carry no signal about who the sender is —
// never suggest at domain level for these.
const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.co.uk', 'outlook.com',
  'live.com', 'live.co.uk', 'yahoo.com', 'yahoo.co.uk', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'btinternet.com',
  'btopenworld.com', 'sky.com', 'talktalk.net', 'virginmedia.com', 'msn.com',
  'mail.com', 'protonmail.com', 'proton.me',
]);

// rules → suggest(senderEmail) → [{ label_id, label_name }, …] (empty if none).
//
// One person often belongs to several entities — Connor Steven is CS Abode
// Architects, CS Abode Developments *and* Connor Steven the individual — and
// which one a given email is about isn't something the sender address can tell
// us. So an exact sender match returns EVERY label that sender has been filed
// under (most-used first) and the caller tags them all; picking one would be
// wrong more often than tagging the set. Falling back to the company domain is
// a weaker signal, so that still only offers the one dominant label.
export function buildTagSuggester(rules) {
  const bySender = new Map();
  const domainAgg = new Map();
  for (const r of rules) {
    const list = bySender.get(r.sender_email) || [];
    list.push(r);
    bySender.set(r.sender_email, list);
    if (r.sender_domain && !FREEMAIL.has(r.sender_domain)) {
      let m = domainAgg.get(r.sender_domain);
      if (!m) { m = new Map(); domainAgg.set(r.sender_domain, m); }
      const d = m.get(r.label_id) || { label_id: r.label_id, label_name: r.label_name, count: 0 };
      d.count += r.times_used;
      m.set(r.label_id, d);
    }
  }
  const byDomain = new Map();
  for (const [domain, m] of domainAgg) {
    let best = null;
    let total = 0;
    for (const d of m.values()) {
      total += d.count;
      if (!best || d.count > best.count) best = d;
    }
    if (best && best.count >= 3 && best.count / total >= 0.6) byDomain.set(domain, best);
  }
  return (senderEmail) => {
    const email = String(senderEmail || '').toLowerCase();
    if (!email) return [];
    const exact = bySender.get(email);
    if (exact?.length) {
      const seen = new Set();
      return [...exact]
        .sort((a, b) => b.times_used - a.times_used
          || (b.last_used_at || '').localeCompare(a.last_used_at || ''))
        .filter((r) => !seen.has(r.label_id) && seen.add(r.label_id))
        .map((r) => ({ label_id: r.label_id, label_name: r.label_name }));
    }
    const dom = byDomain.get(email.split('@')[1] || '');
    if (dom) return [{ label_id: dom.label_id, label_name: dom.label_name }];
    return [];
  };
}

// ── Google Contacts (synced into comms_contacts) ─────────────────────

export async function syncContacts(mailbox) {
  const { data, error } = await supabase.functions.invoke('comms-contacts-sync', {
    body: { mailbox },
  });
  if (error) {
    let detail = error.message;
    let code = null;
    try {
      const b = await error.context?.json();
      if (b?.error) detail = b.error;
      if (b?.code) code = b.code;
    } catch { /* keep generic message */ }
    const err = new Error(detail);
    err.code = code;
    throw err;
  }
  if (data && data.success === false) {
    const err = new Error(data.error || 'Sync failed');
    err.code = data.code || null;
    throw err;
  }
  return data;
}

export async function loadContacts() {
  // 918 rows today, and it feeds the suffix→name matching below — a truncated
  // contact book silently turns known senders into unknown numbers. The old
  // .limit(8000) never raised the API's 1000-row cap.
  return fetchAllRows(() => supabase
    .from('comms_contacts')
    .select('id, display_name, emails, phones, phone_suffixes, organisation')
    .order('id'));
}

// Client contacts from BrightManager, as a fallback source of names for
// inbound numbers. The Google contact book above carries 918 contacts but a
// phone number on only 10 of them, so on its own it leaves almost every
// client texting in as a bare number. BM has a mobile for 304 of the 348
// people it knows about (see sql/262_people_phone.sql).
//
// Deliberately a FALLBACK, not a merge into the vote above: Google duplicates
// vote by weight, and a single BM row would either lose to a wrongly-merged
// contact or win against a correct one for the wrong reason. Filling gaps is
// the whole benefit and it carries none of that risk.
export async function loadPeoplePhones() {
  return fetchAllRows(() => supabase
    .from('people')
    .select('id, name, phone_suffix')
    .not('phone_suffix', 'is', null)
    .order('id'));
}

// suffix → name. Where two people share a suffix (a shared family mobile),
// nobody wins: returning the wrong client's name is worse than showing the
// number, which at least reads as unknown.
export function peopleByPhoneSuffix(people) {
  const seen = new Map();
  const dupes = new Set();
  for (const p of people || []) {
    if (!p.phone_suffix) continue;
    if (seen.has(p.phone_suffix)) { dupes.add(p.phone_suffix); continue; }
    seen.set(p.phone_suffix, p);
  }
  for (const s of dupes) seen.delete(s);
  return seen;
}

// suffix (last 9 digits) → contact, for SMS/WhatsApp name matching.
// Google contact books are messy: the same number often sits on several
// duplicate contacts, and occasionally on a wrongly-merged one belonging
// to somebody else. Majority vote by (token-sorted) display name decides —
// six "Bobby Gallacher" copies outvote one bad merge. Ties keep the first
// seen, so the result is deterministic.
export function contactsByPhoneSuffix(contacts) {
  const nameKey = (c) => (c.display_name || '')
    .toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ') || c.id;
  const votes = new Map(); // suffix → Map(nameKey → { contact, n })
  for (const c of contacts) {
    for (const s of c.phone_suffixes || []) {
      let m = votes.get(s);
      if (!m) { m = new Map(); votes.set(s, m); }
      const key = nameKey(c);
      const cur = m.get(key) || { contact: c, n: 0 };
      cur.n++;
      m.set(key, cur);
    }
  }
  const map = new Map();
  for (const [s, m] of votes) {
    let best = null;
    for (const v of m.values()) if (!best || v.n > best.n) best = v;
    if (best) map.set(s, best.contact);
  }
  return map;
}

export function phoneSuffix(raw, n = 9) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.slice(-n);
}

// ── Signatures ────────────────────────────────────────────────────────

// Effective signature for a mailbox: exact match wins, '*' (all my
// mailboxes) is the fallback.
export async function loadSignatures(staffId) {
  const { data, error } = await supabase
    .from('comms_signatures')
    .select('mailbox_email, body')
    .eq('staff_id', staffId);
  if (error) throw error;
  return data || [];
}

export function effectiveSignature(signatures, mailbox) {
  const exact = signatures.find((s) => s.mailbox_email === mailbox);
  if (exact) return exact.body;
  return signatures.find((s) => s.mailbox_email === '*')?.body || '';
}

export async function saveSignature(staffId, mailboxEmail, body) {
  const { error } = await supabase.from('comms_signatures').upsert({
    staff_id: staffId,
    mailbox_email: mailboxEmail, // '*' = all my mailboxes
    body,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

// Trigger a browser download from a Gmail attachment (base64url payload).
export function downloadAttachment({ data, filename, mimeType }) {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: mimeType || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'attachment';
  a.click();
  URL.revokeObjectURL(url);
}

// "Almond Valley <info@av.co.uk>" → { name: 'Almond Valley', email: 'info@av.co.uk' }
export function parseAddress(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || m[2].trim(), email: m[2].trim() };
  return { name: s, email: s };
}

// ── Client-page timeline ──────────────────────────────────────────────
// The client-detail Communications tab merges stored emails (fed by the
// comms-ingest edge function) with the client's SMS/WhatsApp history.

export async function loadClientEmails(entityId) {
  const { data, error } = await supabase
    .from('client_communications')
    .select('id, mailbox, gmail_thread_id, rfc_message_id, direction, from_email, from_name, to_emails, cc_emails, subject, snippet, body_html, body_text, matched_email, occurred_at')
    .eq('entity_id', entityId)
    .order('occurred_at', { ascending: false })
    .limit(2000);
  if (error) throw error;
  return data || [];
}

export async function listEntitySms(entityId) {
  const { data, error } = await supabase
    .from('sms_messages')
    .select('id, direction, to_number, from_number, body, status, error, channel, created_at, delivered_at')
    .eq('entity_id', entityId)
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw error;
  return data || [];
}

// ── SMS / WhatsApp ────────────────────────────────────────────────────

export async function listMessages(channel) {
  const { data, error } = await supabase
    .from('sms_messages')
    .select('id, direction, entity_id, to_number, from_number, body, status, error, channel, created_at, delivered_at')
    .eq('channel', channel)
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw error;
  return data || [];
}

export async function resolveEntityNames(entityIds) {
  const ids = [...new Set(entityIds.filter(Boolean))];
  if (!ids.length) return {};
  const { data } = await supabase.from('entities').select('id, name').in('id', ids);
  return Object.fromEntries((data || []).map((e) => [e.id, e.name]));
}

export async function sendMessage({ to, body, channel, entityId }) {
  const { data, error } = await supabase.functions.invoke('sms-send', {
    body: { to, body, channel, entity_id: entityId || undefined },
  });
  if (error) {
    let detail = error.message;
    try {
      const b = await error.context?.json();
      if (b?.error) detail = b.error;
    } catch { /* keep generic message */ }
    throw new Error(detail);
  }
  if (data && data.success === false) throw new Error(data.error || 'Send failed');
  return data;
}

// The conversation partner's number for a message row.
export function counterpartNumber(msg) {
  return msg.direction === 'out' ? msg.to_number : msg.from_number;
}

export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}
