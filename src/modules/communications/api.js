// Communications module — data layer.
//
// Email rides the comms-gmail edge function (tokens never reach the
// browser); mailbox metadata comes from the v_gmail_connections view
// (token columns excluded). SMS/WhatsApp read sms_messages directly
// (staff RLS) and send through the sms-send edge function.
import { supabase } from '../../lib/supabase';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://neksyvneljgxvpchwgch.supabase.co';

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

export function connectMailboxUrl({ staffId, kind, displayName, returnTo }) {
  const params = new URLSearchParams({
    staff_id: staffId || '',
    kind,
    return_to: returnTo || '/comms/email',
  });
  if (displayName) params.set('display_name', displayName);
  return `${SUPABASE_URL}/functions/v1/gmail-auth-init?${params.toString()}`;
}

export function mailboxNeedsReconnect(mailbox) {
  if (!mailbox) return false;
  if (mailbox.status !== 'active') return true;
  return !(mailbox.scope || '').includes('gmail.modify');
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
  listThreads: (mailbox, { labelIds, q, pageToken } = {}) =>
    callGmail('list_threads', { mailbox, labelIds, q, pageToken }),
  getThread: (mailbox, threadId) => callGmail('get_thread', { mailbox, threadId }),
  send: (mailbox, opts) => callGmail('send', { mailbox, ...opts }),
  modifyThread: (mailbox, threadId, { addLabelIds, removeLabelIds }) =>
    callGmail('modify_thread', { mailbox, threadId, addLabelIds, removeLabelIds }),
  getAttachment: (mailbox, messageId, attachmentId) =>
    callGmail('get_attachment', { mailbox, messageId, attachmentId }),
};

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
