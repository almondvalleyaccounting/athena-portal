import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, ArchiveRestore, ChevronLeft, CornerUpLeft, CornerUpRight, Forward as ForwardIcon,
  Inbox as InboxIcon, Mail, Paperclip, PenSquare, RefreshCw, Search, Send, Tag, X,
} from 'lucide-react';
import { useAuth } from '../../../shell/AppShell';
import { chipStyle, tones } from '../../../lib/tokens';
import {
  connectMailboxUrl, downloadAttachment, gmail, listMailboxes,
  mailboxNeedsReconnect, parseAddress,
} from '../api';

const font = "'Outfit', sans-serif";

// System labels worth showing, in order. User labels are appended after.
const SYSTEM_LABELS = [
  { id: 'INBOX', label: 'Inbox' },
  { id: 'STARRED', label: 'Starred' },
  { id: 'SENT', label: 'Sent' },
  { id: 'DRAFT', label: 'Drafts' },
];

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: '2-digit' }) });
}

// Sandboxed HTML email body — allow-same-origin (no scripts) so we can
// measure the content height, but nothing inside can run code or reach
// the portal session.
function HtmlBody({ html }) {
  const ref = useRef(null);
  const [height, setHeight] = useState(120);
  const onLoad = () => {
    try {
      const doc = ref.current?.contentDocument;
      if (doc) setHeight(Math.min(Math.max(doc.body.scrollHeight + 24, 60), 1600));
    } catch { /* leave default */ }
  };
  const srcDoc = `<!doctype html><html><head><base target="_blank"><style>body{font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;margin:8px;word-break:break-word}</style></head><body>${html}</body></html>`;
  return (
    <iframe
      ref={ref}
      title="email body"
      sandbox="allow-same-origin"
      srcDoc={srcDoc}
      onLoad={onLoad}
      style={{ width: '100%', height, border: 'none', background: '#fff' }}
    />
  );
}

function MessageCard({ msg, mailbox, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const from = parseAddress(msg.from);
  return (
    <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff', overflow: 'hidden' }}>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '10px 14px', cursor: 'pointer', background: open ? '#fff' : '#f8fafc' }}
      >
        <span style={{ fontWeight: 600, fontSize: 13, color: '#0f172a', whiteSpace: 'nowrap' }}>{from.name}</span>
        {open && <span style={{ fontSize: 11, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>to {msg.to}{msg.cc ? `, cc ${msg.cc}` : ''}</span>}
        {!open && <span style={{ fontSize: 12, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{msg.snippet}</span>}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#94a3b8', whiteSpace: 'nowrap' }}>{fmtDate(msg.internalDate)}</span>
      </div>
      {open && (
        <div style={{ borderTop: '1px solid #f1f5f9' }}>
          {msg.bodyHtml
            ? <HtmlBody html={msg.bodyHtml} />
            : <div style={{ padding: 14, fontSize: 13, color: '#1e293b', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.bodyText || msg.snippet}</div>}
          {msg.attachments.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '10px 14px', borderTop: '1px solid #f1f5f9' }}>
              {msg.attachments.map((a) => (
                <button
                  key={a.attachmentId}
                  onClick={async () => {
                    try {
                      const res = await gmail.getAttachment(mailbox, a.messageId, a.attachmentId);
                      downloadAttachment({ data: res.data, filename: a.filename, mimeType: a.mimeType });
                    } catch (e) { alert(`Download failed: ${e.message}`); }
                  }}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '5px 10px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#f8fafc', cursor: 'pointer', fontFamily: font, color: '#334155' }}
                >
                  <Paperclip size={12} /> {a.filename} <span style={{ color: '#94a3b8' }}>({Math.max(1, Math.round(a.size / 1024))} KB)</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Quote the original message for reply/forward bodies (plain text).
function quoteBody(msg) {
  const text = msg.bodyText || msg.snippet || '';
  const from = parseAddress(msg.from);
  const when = msg.internalDate ? new Date(msg.internalDate).toLocaleString('en-GB') : msg.date;
  return `\n\nOn ${when}, ${from.name} <${from.email}> wrote:\n${text.split('\n').map((l) => `> ${l}`).join('\n')}`;
}

function forwardBody(msg) {
  const text = msg.bodyText || msg.snippet || '';
  return `\n\n---------- Forwarded message ----------\nFrom: ${msg.from}\nDate: ${msg.date}\nSubject: ${msg.subject}\nTo: ${msg.to}\n\n${text}`;
}

export default function EmailView() {
  const { profile } = useAuth();
  const isAdmin = profile?.is_portal_admin || profile?.can_manage_portal;

  const [mailboxes, setMailboxes] = useState(null); // null = loading
  const [mailbox, setMailbox] = useState(() => localStorage.getItem('comms_mailbox') || '');
  const [labels, setLabels] = useState([]);
  const [labelId, setLabelId] = useState('INBOX');
  const [threads, setThreads] = useState([]);
  const [nextPage, setNextPage] = useState(null);
  const [listLoading, setListLoading] = useState(false);
  const [q, setQ] = useState('');
  const [qDraft, setQDraft] = useState('');
  const [thread, setThread] = useState(null); // { id, messages }
  const [threadLoading, setThreadLoading] = useState(false);
  const [composer, setComposer] = useState(null); // { mode, to, cc, subject, body, threadId, inReplyTo, references }
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const selected = useMemo(
    () => (mailboxes || []).find((m) => m.account_email === mailbox) || null,
    [mailboxes, mailbox],
  );
  const labelById = useMemo(() => Object.fromEntries(labels.map((l) => [l.id, l])), [labels]);

  // ── Mailboxes ──
  const loadMailboxes = useCallback(async () => {
    try {
      const rows = await listMailboxes(profile);
      setMailboxes(rows);
      const stored = localStorage.getItem('comms_mailbox');
      const preferred =
        rows.find((m) => m.account_email === stored) ||
        rows.find((m) => m.kind === 'personal' && m.owner_staff_id === profile?.id) ||
        rows[0];
      if (preferred) setMailbox(preferred.account_email);
    } catch (e) {
      setError(`Could not load mailboxes: ${e.message}`);
      setMailboxes([]);
    }
  }, [profile]);

  useEffect(() => { if (profile) loadMailboxes(); }, [profile, loadMailboxes]);
  useEffect(() => { if (mailbox) localStorage.setItem('comms_mailbox', mailbox); }, [mailbox]);

  // ── Labels + threads ──
  const loadLabels = useCallback(async () => {
    if (!mailbox) return;
    try {
      const res = await gmail.listLabels(mailbox);
      setLabels(res.labels || []);
    } catch (e) {
      setLabels([]);
      setError(e.code === 'no_gmail_connection' ? null : `Labels: ${e.message}`);
    }
  }, [mailbox]);

  const loadThreads = useCallback(async ({ append, pageToken } = {}) => {
    if (!mailbox) return;
    setListLoading(true);
    setError(null);
    try {
      const res = await gmail.listThreads(mailbox, {
        labelIds: q ? undefined : [labelId],
        q: q || undefined,
        pageToken,
      });
      setThreads((prev) => (append ? [...prev, ...res.threads] : res.threads));
      setNextPage(res.nextPageToken);
    } catch (e) {
      if (e.code !== 'no_gmail_connection') setError(e.message);
      if (!append) { setThreads([]); setNextPage(null); }
    } finally {
      setListLoading(false);
    }
  }, [mailbox, labelId, q]);

  useEffect(() => { setThread(null); setComposer(null); loadLabels(); }, [mailbox, loadLabels]);
  useEffect(() => { setThread(null); loadThreads(); }, [loadThreads]);

  // ── Thread ──
  const openThread = useCallback(async (summary) => {
    setThreadLoading(true);
    setComposer(null);
    setError(null);
    try {
      const res = await gmail.getThread(mailbox, summary.id);
      setThread(res.thread);
      if (summary.unread) {
        gmail.modifyThread(mailbox, summary.id, { removeLabelIds: ['UNREAD'] })
          .then(() => setThreads((prev) => prev.map((t) => (t.id === summary.id ? { ...t, unread: false } : t))))
          .catch(() => { /* read-state is cosmetic */ });
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setThreadLoading(false);
    }
  }, [mailbox]);

  const archiveThread = useCallback(async (threadId, restore = false) => {
    try {
      await gmail.modifyThread(mailbox, threadId, restore
        ? { addLabelIds: ['INBOX'] }
        : { removeLabelIds: ['INBOX'] });
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      setThread(null);
      setNotice(restore ? 'Moved back to inbox.' : 'Archived.');
      setTimeout(() => setNotice(null), 2500);
    } catch (e) {
      setError(e.code === 'needs_reconnect'
        ? 'Archiving needs the upgraded Gmail permission — reconnect this mailbox (banner above).'
        : e.message);
    }
  }, [mailbox]);

  // ── Composer ──
  const lastMsg = thread?.messages?.[thread.messages.length - 1] || null;

  const startComposer = useCallback((mode) => {
    setError(null);
    if (mode === 'new') {
      setComposer({ mode, to: '', cc: '', subject: '', body: '' });
      return;
    }
    if (!lastMsg) return;
    const from = parseAddress(lastMsg.from);
    const subject = lastMsg.subject || '';
    const reSubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
    const references = [lastMsg.references, lastMsg.messageIdHeader].filter(Boolean).join(' ');
    if (mode === 'reply' || mode === 'replyAll') {
      let to = from.email;
      let cc = '';
      if (mode === 'replyAll') {
        const others = [lastMsg.to, lastMsg.cc].filter(Boolean).join(', ')
          .split(',').map((s) => parseAddress(s).email).filter((e) => e && e.toLowerCase() !== mailbox);
        cc = [...new Set(others)].join(', ');
      }
      setComposer({ mode, to, cc, subject: reSubject, body: quoteBody(lastMsg), threadId: thread.id, inReplyTo: lastMsg.messageIdHeader, references });
    } else if (mode === 'forward') {
      const fwdSubject = /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`;
      setComposer({ mode, to: '', cc: '', subject: fwdSubject, body: forwardBody(lastMsg) });
    }
  }, [lastMsg, thread, mailbox]);

  const sendComposer = useCallback(async () => {
    if (!composer?.to?.trim() || !composer?.subject?.trim()) { setError('To and subject are required.'); return; }
    setSending(true);
    setError(null);
    try {
      await gmail.send(mailbox, {
        to: composer.to.trim(),
        cc: composer.cc?.trim() || undefined,
        subject: composer.subject.trim(),
        bodyText: composer.body || '',
        threadId: composer.threadId || undefined,
        inReplyTo: composer.inReplyTo || undefined,
        references: composer.references || undefined,
      });
      setComposer(null);
      setNotice('Sent.');
      setTimeout(() => setNotice(null), 2500);
      if (composer.threadId && thread) openThread({ id: thread.id, unread: false });
    } catch (e) {
      setError(`Send failed: ${e.message}`);
    } finally {
      setSending(false);
    }
  }, [composer, mailbox, thread, openThread]);

  // ── Connect CTAs ──
  const myPersonal = (mailboxes || []).find((m) => m.kind === 'personal' && m.owner_staff_id === profile?.id);
  const connectPersonalUrl = connectMailboxUrl({
    staffId: profile?.id, kind: 'personal',
    displayName: profile?.name ? profile.name.split(' ')[0] : undefined,
  });
  const connectSharedUrl = connectMailboxUrl({ staffId: profile?.id, kind: 'shared' });

  if (mailboxes === null) {
    return <div style={{ padding: 30, color: '#64748b', fontSize: 13 }}>Loading mailboxes…</div>;
  }

  // First-run: nothing connected that this user can see.
  if (!mailboxes.length) {
    return (
      <div style={{ maxWidth: 560, margin: '40px auto', textAlign: 'center', fontFamily: font }}>
        <Mail size={34} color="#94a3b8" style={{ marginBottom: 10 }} />
        <div style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', marginBottom: 6 }}>No mailboxes connected yet</div>
        <div style={{ fontSize: 13, color: '#64748b', marginBottom: 18 }}>
          Connect your own inbox to read, reply, forward and archive from Athena.
          {isAdmin ? ' As an admin you can also connect shared mailboxes like info@ or payroll@ — sign into that Google account when prompted.' : ''}
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <a href={connectPersonalUrl} style={{ padding: '9px 18px', fontSize: 13, fontWeight: 600, background: '#0f172a', color: '#fff', borderRadius: 8, textDecoration: 'none' }}>Connect my inbox</a>
          {isAdmin && <a href={connectSharedUrl} style={{ padding: '9px 18px', fontSize: 13, fontWeight: 600, background: '#fff', color: '#0f172a', border: '1px solid #cbd5e1', borderRadius: 8, textDecoration: 'none' }}>Add a shared mailbox</a>}
        </div>
      </div>
    );
  }

  const userLabels = labels.filter((l) => l.type === 'user' && l.labelListVisibility !== 'labelHide');
  const needsReconnect = mailboxNeedsReconnect(selected);
  const reconnectUrl = selected ? connectMailboxUrl({
    staffId: profile?.id, kind: selected.kind, displayName: selected.display_name,
  }) : '#';

  return (
    <div style={{ display: 'flex', gap: 14, height: '100%', minHeight: 0, fontFamily: font }}>
      {/* ── Left: mailbox + labels ── */}
      <div style={{ width: 210, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <select
          value={mailbox}
          onChange={(e) => setMailbox(e.target.value)}
          style={{ padding: '8px 10px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8, background: '#fff', fontWeight: 600, color: '#0f172a' }}
        >
          {mailboxes.map((m) => (
            <option key={m.account_email} value={m.account_email}>
              {m.display_name || m.account_email}{m.kind === 'shared' ? ' (shared)' : ''}
            </option>
          ))}
        </select>
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: -4, paddingLeft: 2 }}>{selected?.account_email}</div>

        <button
          onClick={() => startComposer('new')}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', fontSize: 13, fontWeight: 600, background: '#0f172a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: font }}
        >
          <PenSquare size={14} /> New email
        </button>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {SYSTEM_LABELS.filter((s) => labelById[s.id] || s.id === 'INBOX').map((s) => (
            <button
              key={s.id}
              onClick={() => { setQ(''); setQDraft(''); setLabelId(s.id); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', fontSize: 13,
                fontWeight: labelId === s.id && !q ? 700 : 500,
                background: labelId === s.id && !q ? tones.info.bg : 'transparent',
                color: labelId === s.id && !q ? tones.info.fg : '#334155',
                border: 'none', borderRadius: 8, cursor: 'pointer', textAlign: 'left', fontFamily: font,
              }}
            >
              {s.id === 'INBOX' ? <InboxIcon size={14} /> : <Tag size={13} />} {s.label}
            </button>
          ))}
          {userLabels.length > 0 && <div style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5, padding: '8px 10px 2px' }}>Labels</div>}
          {userLabels.map((l) => (
            <button
              key={l.id}
              onClick={() => { setQ(''); setQDraft(''); setLabelId(l.id); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', fontSize: 12.5,
                fontWeight: labelId === l.id && !q ? 700 : 500,
                background: labelId === l.id && !q ? tones.info.bg : 'transparent',
                color: labelId === l.id && !q ? tones.info.fg : '#475569',
                border: 'none', borderRadius: 8, cursor: 'pointer', textAlign: 'left', fontFamily: font,
              }}
            >
              <Tag size={12} /> <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>
            </button>
          ))}
        </div>

        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 10 }}>
          {!myPersonal && (
            <a href={connectPersonalUrl} style={{ fontSize: 12, color: '#0e7fe0', textDecoration: 'none', fontWeight: 600 }}>+ Connect my inbox</a>
          )}
          {isAdmin && (
            <a
              href={connectSharedUrl}
              onClick={(e) => { if (!window.confirm('You’ll be sent to Google — sign in as the SHARED mailbox you want to add (e.g. info@ or payroll@), not your own account. Continue?')) e.preventDefault(); }}
              style={{ fontSize: 12, color: '#0e7fe0', textDecoration: 'none', fontWeight: 600 }}
            >+ Add shared mailbox</a>
          )}
        </div>
      </div>

      {/* ── Middle/right ── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {needsReconnect && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 12, color: '#92400e' }}>
            {selected?.status !== 'active'
              ? <span>This mailbox&apos;s connection is broken ({selected?.error_message || selected?.status}).</span>
              : <span>This mailbox was connected with the old read-only permission — archiving needs a quick reconnect.</span>}
            <a href={reconnectUrl} style={{ marginLeft: 'auto', fontWeight: 700, color: '#92400e' }}>Reconnect</a>
          </div>
        )}
        {error && (
          <div style={{ display: 'flex', gap: 10, padding: '8px 12px', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 8, fontSize: 12, color: '#b91c1c' }}>
            <span style={{ flex: 1 }}>{error}</span>
            <button onClick={() => setError(null)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#b91c1c' }}><X size={13} /></button>
          </div>
        )}
        {notice && (
          <div style={{ padding: '8px 12px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, fontSize: 12, color: '#166534' }}>{notice}</div>
        )}

        {/* Composer (also used standalone for New email) */}
        {composer && (
          <div style={{ border: '1px solid #cbd5e1', borderRadius: 10, background: '#fff', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#0f172a' }}>
                {composer.mode === 'new' ? 'New email' : composer.mode === 'forward' ? 'Forward' : 'Reply'} — from {selected?.display_name || mailbox}
              </span>
              <button onClick={() => setComposer(null)} style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: '#64748b' }}><X size={14} /></button>
            </div>
            <input value={composer.to} onChange={(e) => setComposer((c) => ({ ...c, to: e.target.value }))} placeholder="To"
              style={{ padding: '7px 10px', fontSize: 13, fontFamily: font, border: '1px solid #e2e8f0', borderRadius: 7 }} />
            <input value={composer.cc} onChange={(e) => setComposer((c) => ({ ...c, cc: e.target.value }))} placeholder="Cc (optional)"
              style={{ padding: '7px 10px', fontSize: 13, fontFamily: font, border: '1px solid #e2e8f0', borderRadius: 7 }} />
            <input value={composer.subject} onChange={(e) => setComposer((c) => ({ ...c, subject: e.target.value }))} placeholder="Subject"
              style={{ padding: '7px 10px', fontSize: 13, fontFamily: font, border: '1px solid #e2e8f0', borderRadius: 7, fontWeight: 600 }} />
            <textarea value={composer.body} onChange={(e) => setComposer((c) => ({ ...c, body: e.target.value }))} rows={9}
              style={{ padding: '8px 10px', fontSize: 13, fontFamily: font, border: '1px solid #e2e8f0', borderRadius: 7, resize: 'vertical', lineHeight: 1.5 }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button onClick={sendComposer} disabled={sending}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', fontSize: 13, fontWeight: 600, background: sending ? '#94a3b8' : '#0e7fe0', color: '#fff', border: 'none', borderRadius: 8, cursor: sending ? 'default' : 'pointer', fontFamily: font }}>
                <Send size={13} /> {sending ? 'Sending…' : 'Send'}
              </button>
              {composer.mode === 'forward' && <span style={{ fontSize: 11, color: '#94a3b8' }}>Attachments aren&apos;t carried over on forwards yet.</span>}
            </div>
          </div>
        )}

        {/* Thread open */}
        {thread && !composer ? (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button onClick={() => setThread(null)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px', fontSize: 12, border: '1px solid #cbd5e1', background: '#fff', borderRadius: 8, cursor: 'pointer', fontFamily: font, color: '#334155' }}>
                <ChevronLeft size={13} /> Back
              </button>
              <span style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {lastMsg?.subject || '(no subject)'}
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button onClick={() => startComposer('reply')} title="Reply" style={btnIcon}><CornerUpLeft size={14} /> Reply</button>
                <button onClick={() => startComposer('replyAll')} title="Reply all" style={btnIcon}><CornerUpRight size={14} /> All</button>
                <button onClick={() => startComposer('forward')} title="Forward" style={btnIcon}><ForwardIcon size={14} /> Forward</button>
                {lastMsg?.labelIds?.includes('INBOX')
                  ? <button onClick={() => archiveThread(thread.id)} title="Archive (remove from inbox)" style={btnIcon}><Archive size={14} /> Archive</button>
                  : <button onClick={() => archiveThread(thread.id, true)} title="Move back to inbox" style={btnIcon}><ArchiveRestore size={14} /> To inbox</button>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {[...new Set(thread.messages.flatMap((m) => m.labelIds))]
                .filter((id) => labelById[id]?.type === 'user')
                .map((id) => <span key={id} style={chipStyle('accent')}>{labelById[id].name}</span>)}
            </div>
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, paddingRight: 4 }}>
              {thread.messages.map((m, i) => (
                <MessageCard key={m.id} msg={m} mailbox={mailbox} defaultOpen={i === thread.messages.length - 1 || thread.messages.length <= 2} />
              ))}
            </div>
          </div>
        ) : !composer && (
          /* Thread list */
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff' }}>
                <Search size={14} color="#94a3b8" />
                <input
                  value={qDraft}
                  onChange={(e) => setQDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') setQ(qDraft.trim()); }}
                  placeholder={`Search ${selected?.display_name || mailbox} (Gmail search syntax works) — Enter to search`}
                  style={{ flex: 1, padding: '8px 0', fontSize: 13, fontFamily: font, border: 'none', outline: 'none' }}
                />
                {q && <button onClick={() => { setQ(''); setQDraft(''); }} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#64748b', fontSize: 11 }}>clear</button>}
              </div>
              <button onClick={() => loadThreads()} title="Refresh" style={btnIcon}><RefreshCw size={14} /></button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff' }}>
              {listLoading && threads.length === 0 && <div style={{ padding: 20, fontSize: 13, color: '#64748b' }}>Loading…</div>}
              {!listLoading && threads.length === 0 && (
                <div style={{ padding: 26, fontSize: 13, color: '#94a3b8', textAlign: 'center' }}>
                  {q ? 'No results.' : 'Nothing here — inbox zero 🎉'}
                </div>
              )}
              {threads.map((t) => {
                const from = parseAddress(t.from);
                const userLabelChips = (t.labelIds || []).filter((id) => labelById[id]?.type === 'user').slice(0, 3);
                return (
                  <div
                    key={t.id}
                    onClick={() => openThread(t)}
                    style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '9px 14px', borderBottom: '1px solid #f1f5f9', cursor: 'pointer', background: t.unread ? '#fff' : '#fafbfc' }}
                  >
                    <span style={{ width: 170, flexShrink: 0, fontSize: 13, fontWeight: t.unread ? 700 : 500, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {from.name}{t.messageCount > 1 ? ` (${t.messageCount})` : ''}
                    </span>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span style={{ fontWeight: t.unread ? 700 : 500, color: '#1e293b' }}>{t.subject}</span>
                      <span style={{ color: '#94a3b8' }}> — {t.snippet}</span>
                    </span>
                    {userLabelChips.map((id) => <span key={id} style={{ ...chipStyle('accent'), flexShrink: 0 }}>{labelById[id].name}</span>)}
                    <span style={{ flexShrink: 0, fontSize: 11, color: '#94a3b8', width: 52, textAlign: 'right' }}>{fmtDate(t.internalDate)}</span>
                  </div>
                );
              })}
              {nextPage && (
                <button onClick={() => loadThreads({ append: true, pageToken: nextPage })} disabled={listLoading}
                  style={{ width: '100%', padding: 10, fontSize: 12, fontWeight: 600, color: '#0e7fe0', background: 'none', border: 'none', cursor: 'pointer', fontFamily: font }}>
                  {listLoading ? 'Loading…' : 'Load more'}
                </button>
              )}
            </div>
          </div>
        )}
        {threadLoading && <div style={{ fontSize: 12, color: '#64748b' }}>Opening thread…</div>}
      </div>
    </div>
  );
}

const btnIcon = {
  display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px', fontSize: 12, fontWeight: 600,
  border: '1px solid #cbd5e1', background: '#fff', borderRadius: 8, cursor: 'pointer',
  fontFamily: font, color: '#334155',
};
