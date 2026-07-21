import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, ArchiveRestore, BookUser, Forward as ForwardIcon, Inbox as InboxIcon,
  Layers, Mail, MailOpen, Paperclip, PenSquare, Plus, RefreshCw,
  Reply as ReplyIcon, ReplyAll as ReplyAllIcon, Search, Send, Tag, X,
} from 'lucide-react';
import { useAuth } from '../../../shell/AppShell';
import { chipStyle, tones } from '../../../lib/tokens';
import {
  connectMailboxUrl, downloadAttachment, effectiveSignature, gmail, listMailboxes,
  loadContacts, loadSignatures, mailboxNeedsReconnect, parseAddress, saveSignature, syncContacts,
} from '../api';

const font = "'Outfit', sans-serif";

// System labels worth showing, in order. 'ALL' is our pseudo-label —
// no labelIds filter, i.e. all mail including archived.
const SYSTEM_LABELS = [
  { id: 'INBOX', label: 'Inbox' },
  { id: 'STARRED', label: 'Starred' },
  { id: 'SENT', label: 'Sent' },
  { id: 'DRAFT', label: 'Drafts' },
  { id: 'ALL', label: 'All mail' },
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
// the portal session. Height is re-measured on a short schedule after
// load because images/remote assets arrive late and grow the document
// (the "few cm tall then suddenly expands" bug).
function HtmlBody({ html }) {
  const ref = useRef(null);
  const [height, setHeight] = useState(160);

  const measure = useCallback(() => {
    try {
      const doc = ref.current?.contentDocument;
      if (!doc) return;
      const h = Math.max(doc.body?.scrollHeight || 0, doc.documentElement?.scrollHeight || 0);
      if (h > 0) setHeight(Math.min(h + 24, 2400));
    } catch { /* leave as-is */ }
  }, []);

  const onLoad = () => {
    measure();
    // Late-loading images change the height — re-measure on a schedule,
    // and again whenever an image inside finishes loading.
    [200, 600, 1200, 2500, 5000].forEach((ms) => setTimeout(measure, ms));
    try {
      const doc = ref.current?.contentDocument;
      for (const img of doc?.images || []) {
        if (!img.complete) img.addEventListener('load', measure, { once: true });
      }
    } catch { /* sandbox quirks */ }
  };

  const srcDoc = `<!doctype html><html><head><base target="_blank"><style>body{font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;margin:8px;word-break:break-word}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`;
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

// To/Cc input with Google Contacts autocomplete. Comma-separated;
// suggestions apply to the token being typed.
function AddressInput({ value, onChange, contacts, placeholder, bold }) {
  const [focus, setFocus] = useState(false);
  const parts = String(value || '').split(',');
  const token = parts[parts.length - 1].trim().toLowerCase();

  const suggestions = useMemo(() => {
    if (!focus || token.length < 2) return [];
    const out = [];
    for (const c of contacts) {
      for (const email of c.emails || []) {
        const name = c.display_name || '';
        if (email.includes(token) || name.toLowerCase().includes(token)) {
          out.push({ name, email, org: c.organisation });
          break;
        }
      }
      if (out.length >= 6) break;
    }
    return out;
  }, [focus, token, contacts]);

  const pick = (email) => {
    const kept = parts.slice(0, -1).map((p) => p.trim()).filter(Boolean);
    onChange([...kept, email].join(', ') + ', ');
  };

  return (
    <div style={{ position: 'relative' }}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setTimeout(() => setFocus(false), 150)}
        placeholder={placeholder}
        style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', fontSize: 13, fontFamily: font, border: '1px solid #e2e8f0', borderRadius: 7, fontWeight: bold ? 600 : 400 }}
      />
      {suggestions.length > 0 && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, background: '#fff', border: '1px solid #cbd5e1', borderRadius: 8, boxShadow: '0 8px 24px rgba(15,23,42,.12)', overflow: 'hidden' }}>
          {suggestions.map((s) => (
            <div
              key={s.email}
              onMouseDown={(e) => { e.preventDefault(); pick(s.email); }}
              style={{ padding: '7px 10px', cursor: 'pointer', fontSize: 12.5, display: 'flex', gap: 8, alignItems: 'baseline' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#eff6ff'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = '#fff'; }}
            >
              <span style={{ fontWeight: 600, color: '#0f172a' }}>{s.name || s.email}</span>
              <span style={{ color: '#64748b' }}>{s.email}</span>
              {s.org && <span style={{ color: '#94a3b8', fontSize: 11 }}>{s.org}</span>}
            </div>
          ))}
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
  return `On ${when}, ${from.name} <${from.email}> wrote:\n${text.split('\n').map((l) => `> ${l}`).join('\n')}`;
}

function forwardBody(msg) {
  const text = msg.bodyText || msg.snippet || '';
  return `---------- Forwarded message ----------\nFrom: ${msg.from}\nDate: ${msg.date}\nSubject: ${msg.subject}\nTo: ${msg.to}\n\n${text}`;
}

export default function EmailView() {
  const { profile } = useAuth();
  const isAdmin = profile?.is_portal_admin || profile?.can_manage_portal;

  const [mailboxes, setMailboxes] = useState(null);
  const [mailbox, setMailbox] = useState(() => localStorage.getItem('comms_mailbox') || '');
  const [labels, setLabels] = useState([]);
  const [labelId, setLabelId] = useState('INBOX');
  const [threads, setThreads] = useState([]);
  const [nextPage, setNextPage] = useState(null);
  const [listLoading, setListLoading] = useState(false);
  const [q, setQ] = useState('');
  const [qDraft, setQDraft] = useState('');
  const [thread, setThread] = useState(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [composer, setComposer] = useState(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [contacts, setContacts] = useState([]);
  const [signatures, setSignatures] = useState([]);
  const [sigOpen, setSigOpen] = useState(false);
  const [sigDraft, setSigDraft] = useState('');
  const [sigScope, setSigScope] = useState('*');
  const [syncBusy, setSyncBusy] = useState(false);
  const paneRef = useRef(null);

  const mailboxObj = useMemo(
    () => (mailboxes || []).find((m) => m.account_email === mailbox) || null,
    [mailboxes, mailbox],
  );
  const labelById = useMemo(() => Object.fromEntries(labels.map((l) => [l.id, l])), [labels]);
  const userLabels = labels.filter((l) => l.type === 'user' && l.labelListVisibility !== 'labelHide');
  const sigText = useMemo(() => effectiveSignature(signatures, mailbox), [signatures, mailbox]);

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(null), 3000); };

  // ── Mailboxes / contacts / signatures ──
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

  useEffect(() => {
    if (!profile) return;
    loadMailboxes();
    loadContacts().then(setContacts).catch(() => {});
    loadSignatures(profile.id).then(setSignatures).catch(() => {});
  }, [profile, loadMailboxes]);
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
        labelIds: q || labelId === 'ALL' ? undefined : [labelId],
        q: q || undefined,
        pageToken,
      });
      setThreads((prev) => (append ? [...prev, ...res.threads] : res.threads));
      setNextPage(res.nextPageToken);
      if (!append) setSelected(new Set());
    } catch (e) {
      if (e.code !== 'no_gmail_connection') setError(e.message);
      if (!append) { setThreads([]); setNextPage(null); }
    } finally {
      setListLoading(false);
    }
  }, [mailbox, labelId, q]);

  useEffect(() => { setThread(null); setComposer(null); loadLabels(); }, [mailbox, loadLabels]);
  useEffect(() => { setThread(null); loadThreads(); }, [loadThreads]);

  // ── Thread (preview pane) ──
  const openThread = useCallback(async (summary) => {
    setThreadLoading(true);
    setComposer((c) => (c?.mode === 'new' ? c : null));
    setError(null);
    try {
      const res = await gmail.getThread(mailbox, summary.id);
      // Newest first — latest reply on top, oldest at the bottom.
      res.thread.messages = [...res.thread.messages].sort((a, b) => b.internalDate - a.internalDate);
      setThread(res.thread);
      setComposer(null);
      if (paneRef.current) paneRef.current.scrollTop = 0;
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

  const latestMsg = thread?.messages?.[0] || null;

  const archiveThread = useCallback(async (threadId, restore = false) => {
    try {
      await gmail.modifyThread(mailbox, threadId, restore
        ? { addLabelIds: ['INBOX'] }
        : { removeLabelIds: ['INBOX'] });
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      setThread(null);
      flash(restore ? 'Moved back to inbox.' : 'Archived.');
    } catch (e) {
      setError(e.code === 'needs_reconnect'
        ? 'Archiving needs the upgraded Gmail permission — reconnect this mailbox.'
        : e.message);
    }
  }, [mailbox]);

  // ── Bulk actions ──
  const toggleSelect = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const bulkModify = useCallback(async ({ addLabelIds = [], removeLabelIds = [], verb }) => {
    setBulkBusy(true);
    setError(null);
    let failed = 0;
    for (const id of selected) {
      try {
        await gmail.modifyThread(mailbox, id, { addLabelIds, removeLabelIds });
      } catch { failed++; }
    }
    setBulkBusy(false);
    flash(`${verb} ${selected.size - failed} conversation${selected.size - failed === 1 ? '' : 's'}${failed ? ` (${failed} failed)` : ''}.`);
    setSelected(new Set());
    loadThreads();
  }, [selected, mailbox, loadThreads]);

  const bulkTagArchive = useCallback(async (labelChoice) => {
    let targetLabel = labelChoice;
    if (labelChoice === '__new__') {
      const name = window.prompt('New label name:');
      if (!name?.trim()) return;
      try {
        const res = await gmail.createLabel(mailbox, name.trim());
        targetLabel = res.label.id;
        await loadLabels();
      } catch (e) { setError(`Could not create label: ${e.message}`); return; }
    }
    await bulkModify({ addLabelIds: [targetLabel], removeLabelIds: ['INBOX'], verb: 'Tagged & archived' });
  }, [mailbox, bulkModify, loadLabels]);

  // ── Composer ──
  const startComposer = useCallback((mode) => {
    setError(null);
    const sig = sigText ? `\n\n${sigText}` : '';
    if (mode === 'new') {
      setComposer({ mode, to: '', cc: '', subject: '', body: `${sig}` });
      return;
    }
    if (!latestMsg) return;
    const from = parseAddress(latestMsg.from);
    const subject = latestMsg.subject || '';
    const reSubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
    const references = [latestMsg.references, latestMsg.messageIdHeader].filter(Boolean).join(' ');
    if (mode === 'reply' || mode === 'replyAll') {
      let to = from.email;
      let cc = '';
      if (mode === 'replyAll') {
        const others = [latestMsg.to, latestMsg.cc].filter(Boolean).join(', ')
          .split(',').map((s) => parseAddress(s).email).filter((e) => e && e.toLowerCase() !== mailbox);
        cc = [...new Set(others)].join(', ');
      }
      setComposer({ mode, to, cc, subject: reSubject, body: `${sig}\n\n${quoteBody(latestMsg)}`, threadId: thread.id, inReplyTo: latestMsg.messageIdHeader, references });
    } else if (mode === 'forward') {
      const fwdSubject = /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`;
      setComposer({ mode, to: '', cc: '', subject: fwdSubject, body: `${sig}\n\n${forwardBody(latestMsg)}` });
    }
    if (paneRef.current) paneRef.current.scrollTop = 0;
  }, [latestMsg, thread, mailbox, sigText]);

  const sendComposer = useCallback(async () => {
    if (!composer?.to?.trim() || !composer?.subject?.trim()) { setError('To and subject are required.'); return; }
    setSending(true);
    setError(null);
    try {
      await gmail.send(mailbox, {
        to: composer.to.trim().replace(/,\s*$/, ''),
        cc: composer.cc?.trim().replace(/,\s*$/, '') || undefined,
        subject: composer.subject.trim(),
        bodyText: composer.body || '',
        threadId: composer.threadId || undefined,
        inReplyTo: composer.inReplyTo || undefined,
        references: composer.references || undefined,
      });
      const wasReply = !!composer.threadId;
      setComposer(null);
      flash('Sent.');
      if (wasReply && thread) openThread({ id: thread.id, unread: false });
    } catch (e) {
      setError(`Send failed: ${e.message}`);
    } finally {
      setSending(false);
    }
  }, [composer, mailbox, thread, openThread]);

  // ── Contacts sync / signature save ──
  const doSyncContacts = useCallback(async () => {
    setSyncBusy(true);
    setError(null);
    try {
      const res = await syncContacts(mailbox);
      setContacts(await loadContacts());
      flash(`Synced ${res.stored} contacts from ${res.mailbox}.`);
    } catch (e) {
      setError(e.code === 'needs_reconnect'
        ? `${e.message}`
        : `Contacts sync failed: ${e.message}`);
    } finally {
      setSyncBusy(false);
    }
  }, [mailbox]);

  const openSigEditor = () => {
    const hasExact = signatures.some((s) => s.mailbox_email === mailbox);
    setSigScope(hasExact ? mailbox : '*');
    setSigDraft(effectiveSignature(signatures, mailbox));
    setSigOpen(true);
  };

  const doSaveSignature = useCallback(async () => {
    try {
      await saveSignature(profile.id, sigScope, sigDraft);
      setSignatures(await loadSignatures(profile.id));
      setSigOpen(false);
      flash('Signature saved.');
    } catch (e) {
      setError(`Could not save signature: ${e.message}`);
    }
  }, [profile, sigScope, sigDraft]);

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

  if (!mailboxes.length) {
    return (
      <div style={{ maxWidth: 560, margin: '40px auto', textAlign: 'center', fontFamily: font }}>
        <Mail size={34} color="#94a3b8" style={{ marginBottom: 10 }} />
        <div style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', marginBottom: 6 }}>No mailboxes connected yet</div>
        <div style={{ fontSize: 13, color: '#64748b', marginBottom: 18 }}>
          Connect your own inbox to read, reply, forward and archive from Athena.
          {isAdmin ? ' As an admin you can also connect shared mailboxes like info@ or accounts@ — sign into that Google account when prompted.' : ''}
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <a href={connectPersonalUrl} style={{ padding: '9px 18px', fontSize: 13, fontWeight: 600, background: '#0f172a', color: '#fff', borderRadius: 8, textDecoration: 'none' }}>Connect my inbox</a>
          {isAdmin && <a href={connectSharedUrl} style={{ padding: '9px 18px', fontSize: 13, fontWeight: 600, background: '#fff', color: '#0f172a', border: '1px solid #cbd5e1', borderRadius: 8, textDecoration: 'none' }}>Add a shared mailbox</a>}
        </div>
      </div>
    );
  }

  const needsReconnect = mailboxNeedsReconnect(mailboxObj);
  const reconnectUrl = mailboxObj ? connectMailboxUrl({
    staffId: profile?.id, kind: mailboxObj.kind, displayName: mailboxObj.display_name,
  }) : '#';

  const paneContent = () => {
    if (composer?.mode === 'new' || composer?.mode === 'forward') {
      return renderComposer();
    }
    if (thread) {
      return (
        <>
          {/* Header + actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', flex: 1, minWidth: 200 }}>
              {latestMsg?.subject || '(no subject)'}
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => startComposer('reply')} title="Reply" style={btnIcon}><ReplyIcon size={14} /> Reply</button>
              <button onClick={() => startComposer('replyAll')} title="Reply all" style={btnIcon}><ReplyAllIcon size={14} /> Reply all</button>
              <button onClick={() => startComposer('forward')} title="Forward" style={btnIcon}><ForwardIcon size={14} /> Forward</button>
              {latestMsg?.labelIds?.includes('INBOX') || thread.messages.some((m) => m.labelIds.includes('INBOX'))
                ? <button onClick={() => archiveThread(thread.id)} title="Archive (remove from inbox)" style={btnIcon}><Archive size={14} /> Archive</button>
                : <button onClick={() => archiveThread(thread.id, true)} title="Move back to inbox" style={btnIcon}><ArchiveRestore size={14} /> To inbox</button>}
              <button onClick={() => setThread(null)} title="Close" style={btnIcon}><X size={14} /></button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[...new Set(thread.messages.flatMap((m) => m.labelIds))]
              .filter((id) => labelById[id]?.type === 'user')
              .map((id) => <span key={id} style={chipStyle('accent')}>{labelById[id].name}</span>)}
          </div>
          {/* Inline reply composer sits above the messages */}
          {composer && renderComposer()}
          {/* Newest first; latest expanded */}
          {thread.messages.map((m, i) => (
            <MessageCard key={m.id} msg={m} mailbox={mailbox} defaultOpen={i === 0} />
          ))}
        </>
      );
    }
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 13, border: '1px dashed #e2e8f0', borderRadius: 10, minHeight: 240 }}>
        {threadLoading ? 'Opening…' : 'Select an email to preview it here'}
      </div>
    );
  };

  function renderComposer() {
    return (
      <div style={{ border: '1px solid #94a3b8', borderRadius: 10, background: '#fff', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#0f172a' }}>
            {composer.mode === 'new' ? 'New email' : composer.mode === 'forward' ? 'Forward' : composer.mode === 'replyAll' ? 'Reply all' : 'Reply'} — from {mailboxObj?.display_name || mailbox}
          </span>
          <button onClick={() => setComposer(null)} style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: '#64748b' }}><X size={14} /></button>
        </div>
        <AddressInput value={composer.to} onChange={(v) => setComposer((c) => ({ ...c, to: v }))} contacts={contacts} placeholder="To" />
        <AddressInput value={composer.cc} onChange={(v) => setComposer((c) => ({ ...c, cc: v }))} contacts={contacts} placeholder="Cc (optional)" />
        <input value={composer.subject} onChange={(e) => setComposer((c) => ({ ...c, subject: e.target.value }))} placeholder="Subject"
          style={{ padding: '7px 10px', fontSize: 13, fontFamily: font, border: '1px solid #e2e8f0', borderRadius: 7, fontWeight: 600 }} />
        <textarea value={composer.body} onChange={(e) => setComposer((c) => ({ ...c, body: e.target.value }))} rows={10} autoFocus
          style={{ padding: '8px 10px', fontSize: 13, fontFamily: font, border: '1px solid #e2e8f0', borderRadius: 7, resize: 'vertical', lineHeight: 1.5 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={sendComposer} disabled={sending}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', fontSize: 13, fontWeight: 600, background: sending ? '#94a3b8' : '#0e7fe0', color: '#fff', border: 'none', borderRadius: 8, cursor: sending ? 'default' : 'pointer', fontFamily: font }}>
            <Send size={13} /> {sending ? 'Sending…' : 'Send'}
          </button>
          {composer.mode === 'forward' && <span style={{ fontSize: 11, color: '#94a3b8' }}>Attachments aren&apos;t carried over on forwards yet.</span>}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 14, height: '100%', minHeight: 0, fontFamily: font }}>
      {/* ── Left rail: mailbox + labels ── */}
      <div style={{ width: 208, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' }}>
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
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: -4, paddingLeft: 2 }}>{mailboxObj?.account_email}</div>

        {(!myPersonal || isAdmin) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button
              onClick={() => setAddOpen((o) => !o)}
              style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', fontSize: 12.5, fontWeight: 600, background: '#fff', color: '#334155', border: '1px dashed #94a3b8', borderRadius: 8, cursor: 'pointer', fontFamily: font }}
            >
              <Plus size={13} /> Add mailbox
            </button>
            {addOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, border: '1px solid #e2e8f0', borderRadius: 8, background: '#f8fafc' }}>
                {!myPersonal && (
                  <a href={connectPersonalUrl} style={addOptionStyle}>
                    <Mail size={13} /> Connect my inbox
                  </a>
                )}
                {isAdmin && (
                  <a
                    href={connectSharedUrl}
                    onClick={(e) => { if (!window.confirm('You’ll be sent to Google — sign in as the SHARED mailbox you want to add (e.g. accounts@ or payroll@), not your own account. Continue?')) e.preventDefault(); }}
                    style={addOptionStyle}
                  >
                    <InboxIcon size={13} /> Add shared mailbox
                  </a>
                )}
                <div style={{ fontSize: 10.5, color: '#94a3b8', lineHeight: 1.4 }}>
                  Shared = the whole team sees it (info@, accounts@…). You&apos;ll sign into that Google account once.
                </div>
              </div>
            )}
          </div>
        )}

        <button
          onClick={() => { setThread(null); startComposer('new'); }}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', fontSize: 13, fontWeight: 600, background: '#0f172a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: font }}
        >
          <PenSquare size={14} /> New email
        </button>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {SYSTEM_LABELS.filter((s) => s.id === 'INBOX' || s.id === 'ALL' || labelById[s.id]).map((s) => (
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
              {s.id === 'INBOX' ? <InboxIcon size={14} /> : s.id === 'ALL' ? <Layers size={14} /> : <Tag size={13} />} {s.label}
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

        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 10 }}>
          <button onClick={doSyncContacts} disabled={syncBusy} style={railBtn}>
            <BookUser size={13} /> {syncBusy ? 'Syncing…' : 'Sync Google contacts'}
          </button>
          <button onClick={openSigEditor} style={railBtn}>
            <PenSquare size={13} /> Signature
          </button>
        </div>
      </div>

      {/* ── Middle: thread list ── */}
      <div style={{ width: 385, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff' }}>
            <Search size={14} color="#94a3b8" />
            <input
              value={qDraft}
              onChange={(e) => setQDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setQ(qDraft.trim()); }}
              placeholder="Search this mailbox — Enter"
              style={{ flex: 1, padding: '8px 0', fontSize: 13, fontFamily: font, border: 'none', outline: 'none', minWidth: 0 }}
            />
            {q && <button onClick={() => { setQ(''); setQDraft(''); }} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#64748b', fontSize: 11 }}>clear</button>}
          </div>
          <button onClick={() => loadThreads()} title="Refresh" style={btnIcon}><RefreshCw size={14} /></button>
        </div>

        {/* Bulk action bar */}
        {selected.size > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: '#eff6ff', border: '1px solid #93c5fd', borderRadius: 8, fontSize: 12, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, color: '#0c4a6e' }}>{selected.size} selected</span>
            <select
              defaultValue=""
              disabled={bulkBusy}
              onChange={(e) => { const v = e.target.value; e.target.value = ''; if (v) bulkTagArchive(v); }}
              style={{ fontSize: 12, padding: '4px 6px', border: '1px solid #93c5fd', borderRadius: 6, fontFamily: font, background: '#fff', color: '#0c4a6e', maxWidth: 140 }}
            >
              <option value="" disabled>Tag + archive…</option>
              {userLabels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              <option value="__new__">+ New label…</option>
            </select>
            <button disabled={bulkBusy} onClick={() => bulkModify({ removeLabelIds: ['INBOX'], verb: 'Archived' })} style={bulkBtn}><Archive size={12} /> Archive</button>
            <button disabled={bulkBusy} onClick={() => bulkModify({ removeLabelIds: ['UNREAD'], verb: 'Marked read' })} style={bulkBtn}><MailOpen size={12} /> Read</button>
            <button disabled={bulkBusy} onClick={() => setSelected(new Set())} style={{ ...bulkBtn, marginLeft: 'auto' }}>Clear</button>
            {bulkBusy && <span style={{ color: '#0c4a6e' }}>Working…</span>}
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff', minHeight: 0 }}>
          {listLoading && threads.length === 0 && <div style={{ padding: 20, fontSize: 13, color: '#64748b' }}>Loading…</div>}
          {!listLoading && threads.length === 0 && (
            <div style={{ padding: 26, fontSize: 13, color: '#94a3b8', textAlign: 'center' }}>
              {q ? 'No results.' : 'Nothing here — inbox zero 🎉'}
            </div>
          )}
          {threads.map((t) => {
            const from = parseAddress(t.from);
            const isOpen = thread?.id === t.id;
            const userLabelChips = (t.labelIds || []).filter((id) => labelById[id]?.type === 'user').slice(0, 2);
            return (
              <div
                key={t.id}
                onClick={() => openThread(t)}
                style={{ display: 'flex', gap: 8, padding: '8px 10px', borderBottom: '1px solid #f1f5f9', cursor: 'pointer', background: isOpen ? '#eff6ff' : t.unread ? '#fff' : '#fafbfc' }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(t.id)}
                  onChange={() => toggleSelect(t.id)}
                  onClick={(e) => e.stopPropagation()}
                  style={{ marginTop: 3, cursor: 'pointer' }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontSize: 12.5, fontWeight: t.unread ? 700 : 500, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {from.name}{t.messageCount > 1 ? ` (${t.messageCount})` : ''}
                    </span>
                    {userLabelChips.map((id) => <span key={id} style={{ ...chipStyle('accent'), flexShrink: 0 }}>{labelById[id].name}</span>)}
                    <span style={{ fontSize: 10.5, color: '#94a3b8', flexShrink: 0 }}>{fmtDate(t.internalDate)}</span>
                  </div>
                  <div style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span style={{ fontWeight: t.unread ? 700 : 500, color: '#1e293b' }}>{t.subject}</span>
                    <span style={{ color: '#94a3b8' }}> — {t.snippet}</span>
                  </div>
                </div>
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

      {/* ── Right: preview pane ── */}
      <div style={{ flex: 1, minWidth: 380, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
        {needsReconnect && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 12, color: '#92400e' }}>
            {mailboxObj?.status !== 'active'
              ? <span>This mailbox&apos;s connection is broken ({mailboxObj?.error_message || mailboxObj?.status}).</span>
              : <span>This mailbox was connected with an older permission set — a quick reconnect unlocks everything.</span>}
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
        <div ref={paneRef} style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, paddingRight: 4, minHeight: 0 }}>
          {paneContent()}
        </div>
      </div>

      {/* ── Signature editor ── */}
      {sigOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ width: 520, maxWidth: '92vw', background: '#fff', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 12, fontFamily: font }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>Email signature</span>
              <button onClick={() => setSigOpen(false)} style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: '#64748b' }}><X size={16} /></button>
            </div>
            <textarea
              value={sigDraft}
              onChange={(e) => setSigDraft(e.target.value)}
              rows={7}
              placeholder={'Kind regards,\nBobby\nAlmond Valley Accounting'}
              style={{ padding: '9px 11px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8, resize: 'vertical', lineHeight: 1.5 }}
            />
            <div style={{ display: 'flex', gap: 14, fontSize: 12.5, color: '#334155' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="radio" checked={sigScope === '*'} onChange={() => setSigScope('*')} /> All my mailboxes
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="radio" checked={sigScope === mailbox} onChange={() => setSigScope(mailbox)} /> Only {mailboxObj?.display_name || mailbox}
              </label>
            </div>
            <div style={{ fontSize: 11.5, color: '#94a3b8' }}>
              Added automatically when you compose or reply. Plain text for now.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setSigOpen(false)} style={{ padding: '8px 14px', fontSize: 13, border: '1px solid #cbd5e1', background: '#fff', borderRadius: 8, cursor: 'pointer', fontFamily: font, color: '#334155' }}>Cancel</button>
              <button onClick={doSaveSignature} style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, background: '#0e7fe0', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: font }}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const btnIcon = {
  display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px', fontSize: 12, fontWeight: 600,
  border: '1px solid #cbd5e1', background: '#fff', borderRadius: 8, cursor: 'pointer',
  fontFamily: font, color: '#334155',
};

const bulkBtn = {
  display: 'flex', alignItems: 'center', gap: 5, padding: '4px 9px', fontSize: 12, fontWeight: 600,
  border: '1px solid #93c5fd', background: '#fff', borderRadius: 6, cursor: 'pointer',
  fontFamily: font, color: '#0c4a6e',
};

const railBtn = {
  display: 'flex', alignItems: 'center', gap: 7, padding: '6px 10px', fontSize: 12, fontWeight: 600,
  border: '1px solid #e2e8f0', background: '#fff', borderRadius: 8, cursor: 'pointer',
  fontFamily: font, color: '#475569', textAlign: 'left',
};

const addOptionStyle = {
  display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', fontSize: 12.5, fontWeight: 600,
  background: '#fff', color: '#0f172a', border: '1px solid #cbd5e1', borderRadius: 7,
  textDecoration: 'none', fontFamily: font,
};
