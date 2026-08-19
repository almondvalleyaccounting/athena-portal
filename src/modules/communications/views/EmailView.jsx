import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, ArchiveRestore, BookUser, CalendarPlus, ChevronDown, ChevronRight,
  Forward as ForwardIcon, Inbox as InboxIcon, Layers, Mail, MailOpen, Paperclip,
  PenSquare, Plus, RefreshCw, Reply as ReplyIcon, ReplyAll as ReplyAllIcon,
  Search, Send, Sparkles, Tag, Trash2, X,
} from 'lucide-react';
import { useAuth } from '../../../shell/AppShell';
import { chipStyle, tones } from '../../../lib/tokens';
import {
  buildTagSuggester, startMailboxConnect, downloadAttachment, effectiveSignature, gmail, listMailboxes,
  loadContacts, loadSignatures, loadTagRules, mailboxNeedsReconnect, parseAddress, recordTagRule,
  saveSignature, syncContacts,
} from '../api';

const font = "'Outfit', sans-serif";

// How many conversations to load per view, and the most comms-gmail will
// summarise in one call (Gmail's own threads.list ceiling).
const PAGE_SIZES = [50, 100, 250, 500];
const SERVER_PAGE = 100;
const AUTO_REFRESH_MS = 5 * 60 * 1000;

// Pseudo-mailbox: merge every mailbox this person can see into one list.
// Gmail's system label ids (INBOX, SENT, …) are the same in every account, so
// the folders still work across a merge; user labels and the learned tag rules
// are per-account, so those features stand down while it's on.
const ALL_MAILBOXES = '*';

// System labels worth showing, in order. 'ALL' is our pseudo-label —
// no labelIds filter, i.e. all mail including archived.
const SYSTEM_LABELS = [
  { id: 'INBOX', label: 'Inbox' },
  { id: 'STARRED', label: 'Starred' },
  { id: 'SENT', label: 'Sent' },
  { id: 'DRAFT', label: 'Drafts' },
  { id: 'ALL', label: 'All mail' },
  { id: 'TRASH', label: 'Bin' },
];

const fmtClock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

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
// load because images/remote assets arrive late and grow the document.
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
function AddressInput({ value, onChange, contacts, placeholder }) {
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
        style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', fontSize: 13, fontFamily: font, border: '1px solid #e2e8f0', borderRadius: 7 }}
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

// Searchable label picker with create ("Tax/VAT" nests) — used for the
// bulk Tag+archive and the single-thread Tag action.
function LabelPicker({ labels, onPick, onCreate, trigger, align = 'left' }) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const sorted = useMemo(() => [...labels].sort((a, b) => a.name.localeCompare(b.name)), [labels]);
  const filtered = term.trim()
    ? sorted.filter((l) => l.name.toLowerCase().includes(term.trim().toLowerCase()))
    : sorted;
  const exact = sorted.some((l) => l.name.toLowerCase() === term.trim().toLowerCase());

  const pick = async (label) => {
    setOpen(false);
    setTerm('');
    await onPick(label);
  };

  const create = async () => {
    setBusy(true);
    try {
      const label = await onCreate(term.trim());
      if (label) await pick(label);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <span onClick={() => setOpen((o) => !o)}>{trigger}</span>
      {open && (
        <div style={{ position: 'absolute', top: '100%', [align]: 0, marginTop: 4, zIndex: 40, width: 260, background: '#fff', border: '1px solid #cbd5e1', borderRadius: 10, boxShadow: '0 10px 30px rgba(15,23,42,.15)', overflow: 'hidden', fontFamily: font }}>
          <input
            autoFocus
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
              if (e.key === 'Enter') {
                if (filtered.length === 1) pick(filtered[0]);
                else if (term.trim() && !exact) create();
              }
            }}
            placeholder="Search labels… (use / to nest)"
            style={{ width: '100%', boxSizing: 'border-box', padding: '9px 11px', fontSize: 12.5, fontFamily: font, border: 'none', borderBottom: '1px solid #e2e8f0', outline: 'none' }}
          />
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {filtered.map((l) => {
              const parts = l.name.split('/');
              const seg = parts.pop();
              return (
                <div
                  key={l.id}
                  onClick={() => pick(l)}
                  style={{ padding: `6px 10px 6px ${10 + parts.length * 14}px`, fontSize: 12.5, cursor: 'pointer', display: 'flex', alignItems: 'baseline', gap: 6 }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = '#eff6ff'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = '#fff'; }}
                >
                  <Tag size={11} color="#94a3b8" />
                  <span style={{ fontWeight: 600, color: '#0f172a' }}>{seg}</span>
                  {parts.length > 0 && <span style={{ fontSize: 10.5, color: '#94a3b8' }}>{parts.join(' / ')}</span>}
                </div>
              );
            })}
            {filtered.length === 0 && !term.trim() && (
              <div style={{ padding: 12, fontSize: 12, color: '#94a3b8' }}>No labels yet — type to create one.</div>
            )}
          </div>
          {term.trim() && !exact && (
            <button
              onClick={create}
              disabled={busy}
              style={{ width: '100%', padding: '8px 11px', fontSize: 12.5, fontWeight: 600, color: '#0e7fe0', background: '#f8fafc', border: 'none', borderTop: '1px solid #e2e8f0', cursor: 'pointer', textAlign: 'left', fontFamily: font }}
            >
              {busy ? 'Creating…' : `+ Create “${term.trim()}”`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Nested labels ("Tax/VAT/Q1") → collapsible tree for the rail.
function buildLabelTree(userLabels) {
  const roots = [];
  const byPath = new Map();
  for (const l of [...userLabels].sort((a, b) => a.name.localeCompare(b.name))) {
    const parts = l.name.split('/');
    let path = '';
    let siblings = roots;
    for (let i = 0; i < parts.length; i++) {
      path = path ? `${path}/${parts[i]}` : parts[i];
      let node = byPath.get(path);
      if (!node) {
        node = { seg: parts[i], full: path, label: null, children: [] };
        byPath.set(path, node);
        siblings.push(node);
      }
      if (i === parts.length - 1) node.label = l;
      siblings = node.children;
    }
  }
  return roots;
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

// Recipients of a thread's latest message: [first, count].
function recipients(t) {
  const parts = String(t.to || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [parts.length ? parseAddress(parts[0]) : null, parts.length];
}

const recipientKey = (t) => (recipients(t)[0]?.email || '').toLowerCase();

// Sort key for "who is this from" — the other party, so a thread we replied to
// last still files under them rather than under us.
const senderKey = (t) => parseAddress(t.counterpartFrom || t.from).email.toLowerCase();

// Who a list row is about. Our own outbound mail can carry both SENT and
// INBOX (anything sent to a list this mailbox is on), so a row that named the
// latest sender read as inbound mail from ourselves. Name the other side
// instead — the person we replied to, or the recipient when the thread is
// only ours.
function rowParty(t, mailbox, showRecipient) {
  const last = parseAddress(t.from);
  const own = last.email.toLowerCase() === mailbox;
  const [rcpt, count] = recipients(t);
  const rcptLabel = rcpt ? `${rcpt.name}${count > 1 ? ` +${count - 1}` : ''}` : null;
  // We replied last: name the person we're talking to, not ourselves.
  if (own && t.counterpartFrom) return { name: parseAddress(t.counterpartFrom).name, own };
  // Nothing but our own mail on the thread (Sent, or an unanswered send).
  if (own && rcptLabel) return { name: `To ${rcptLabel}`, own };
  // Inbound: always the sender. Sorting by recipient keys on an address that
  // isn't the sender's, so that gets shown alongside rather than instead —
  // but only when it isn't this mailbox, because "to me" in my own inbox is
  // noise. What's left is the useful case: mail you were merely cc'd on.
  const informative = showRecipient && rcpt && rcpt.email.toLowerCase() !== mailbox;
  return { name: last.name, own, to: informative ? rcptLabel : null };
}

export default function EmailView() {
  const { profile } = useAuth();
  const isAdmin = profile?.is_portal_admin || profile?.can_manage_portal;

  const [mailboxes, setMailboxes] = useState(null);
  const [mailbox, setMailbox] = useState(() => localStorage.getItem('comms_mailbox') || '');
  const [labels, setLabels] = useState([]);
  const [labelId, setLabelId] = useState('INBOX');
  const [threads, setThreads] = useState([]);
  const [pageTokens, setPageTokens] = useState({}); // mailbox → next page token
  // Same map in a ref: "Load more" needs the tokens from the batch that just
  // landed, and the loader is deliberately not re-memoised per batch.
  const tokensRef = useRef({});
  const [listLoading, setListLoading] = useState(false);
  const [q, setQ] = useState('');
  const [qDraft, setQDraft] = useState('');
  // Deliberately not persisted: every new search starts scoped to the folder,
  // so widening to the whole account is always a conscious choice.
  const [searchAll, setSearchAll] = useState(false);
  const [compact, setCompact] = useState(() => localStorage.getItem('comms_compact') === '1');
  const [autoRefresh, setAutoRefresh] = useState(() => localStorage.getItem('comms_auto') !== '0');
  const [lastChecked, setLastChecked] = useState(null);
  const [sort, setSort] = useState(() => localStorage.getItem('comms_email_sort') || 'date');
  const [hideOwn, setHideOwn] = useState(() => localStorage.getItem('comms_hide_own') !== '0');
  const [pageSize, setPageSize] = useState(
    () => PAGE_SIZES.find((n) => n === Number(localStorage.getItem('comms_page_size'))) || 50,
  );
  const loadGen = useRef(0);
  const [thread, setThread] = useState(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [composer, setComposer] = useState(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null); // { text, undo? }
  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [contacts, setContacts] = useState([]);
  const [signatures, setSignatures] = useState([]);
  const [sigOpen, setSigOpen] = useState(false);
  const [sigDraft, setSigDraft] = useState('');
  const [sigScope, setSigScope] = useState('*');
  const [syncBusy, setSyncBusy] = useState(false);
  const [tagRules, setTagRules] = useState([]);
  const [learnBusy, setLearnBusy] = useState(false);
  const [sweepBusy, setSweepBusy] = useState(false);
  const autoLearned = useRef(new Set());
  const [expanded, setExpanded] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('comms_labels_expanded') || '[]')); }
    catch { return new Set(); }
  });
  const paneRef = useRef(null);

  const isAll = mailbox === ALL_MAILBOXES;
  const mailboxObj = useMemo(
    () => (mailboxes || []).find((m) => m.account_email === mailbox) || null,
    [mailboxes, mailbox],
  );
  // Mailboxes the list is currently reading from, and a short label per address
  // for the per-row chip in merged mode.
  const activeMailboxes = useMemo(() => {
    if (isAll) return (mailboxes || []).map((m) => m.account_email);
    return mailbox ? [mailbox] : [];
  }, [isAll, mailboxes, mailbox]);
  const mailboxLabel = useMemo(() => Object.fromEntries(
    (mailboxes || []).map((m) => [m.account_email, m.display_name || m.account_email.split('@')[0]]),
  ), [mailboxes]);
  // Where a "New email" comes from when no single mailbox is selected.
  const sendFrom = isAll
    ? ((mailboxes || []).find((m) => m.kind === 'personal' && m.owner_staff_id === profile?.id)
      || (mailboxes || [])[0])?.account_email || ''
    : mailbox;
  const labelById = useMemo(() => Object.fromEntries(labels.map((l) => [l.id, l])), [labels]);
  const userLabels = useMemo(
    () => labels.filter((l) => l.type === 'user' && l.labelListVisibility !== 'labelHide'),
    [labels],
  );
  const labelTree = useMemo(() => buildLabelTree(userLabels), [userLabels]);

  const flash = (text, undo = null) => {
    setNotice({ text, undo });
    setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), undo ? 8000 : 3000);
  };

  const toggleExpanded = (full) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(full)) next.delete(full); else next.add(full);
    localStorage.setItem('comms_labels_expanded', JSON.stringify([...next]));
    return next;
  });

  // ── Mailboxes / contacts / signatures ──
  const loadMailboxes = useCallback(async () => {
    try {
      const rows = await listMailboxes(profile);
      setMailboxes(rows);
      const stored = localStorage.getItem('comms_mailbox');
      if (stored === ALL_MAILBOXES && rows.length > 1) { setMailbox(ALL_MAILBOXES); return; }
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
    if (!mailbox || isAll) { setLabels([]); return []; }
    try {
      const res = await gmail.listLabels(mailbox);
      setLabels(res.labels || []);
      return res.labels || [];
    } catch (e) {
      setLabels([]);
      setError(e.code === 'no_gmail_connection' ? null : `Labels: ${e.message}`);
      return [];
    }
  }, [mailbox, isAll]);

  // Gmail's own cap is 100 threads per call (each one costs a metadata fetch),
  // so a bigger page size is walked server-page by server-page and appended as
  // it lands — rows show up in batches instead of after one long wait. Merged
  // mode walks every mailbox at once and splits the page size between them, so
  // "500" stays roughly 500 rows in total rather than 500 each. A newer load
  // (mailbox switch, label change) bumps the generation and the older walk
  // drops its results rather than interleaving them.
  // What to ask Gmail for. labelIds and q are ANDed by threads.list, so a
  // search stays inside the folder you're looking at — searching the inbox
  // used to return the entire account back to 2017, which is never what you
  // meant by typing in the inbox. "All mail" opts out, per search.
  const listQuery = useMemo(() => {
    const folder = labelId === 'ALL' ? {} : { labelIds: [labelId] };
    if (q) return searchAll ? { q } : { ...folder, q };
    if (labelId === 'INBOX' && hideOwn) return { ...folder, q: '-from:me' };
    return folder;
  }, [q, searchAll, labelId, hideOwn]);

  const loadThreads = useCallback(async ({ append } = {}) => {
    if (!activeMailboxes.length) return;
    const gen = ++loadGen.current;
    setListLoading(true);
    setError(null);
    if (!append) {
      setThreads([]);
      setSelected(new Set());
      tokensRef.current = {};
      setPageTokens({});
    }
    const perBox = Math.max(1, Math.ceil(pageSize / activeMailboxes.length));
    let missed = 0;
    let failure = null;
    await Promise.all(activeMailboxes.map(async (mb) => {
      let token = append ? tokensRef.current[mb] : undefined;
      if (append && !token) return; // this mailbox is already exhausted
      let added = 0;
      try {
        do {
          // eslint-disable-next-line no-await-in-loop
          const res = await gmail.listThreads(mb, {
            ...listQuery,
            pageToken: token,
            maxResults: Math.min(SERVER_PAGE, perBox - added),
          });
          if (gen !== loadGen.current) return; // superseded — drop these rows
          const rows = (res.threads || []).map((t) => ({ ...t, mailbox: mb }));
          setThreads((prev) => [...prev, ...rows]);
          token = res.nextPageToken || null;
          tokensRef.current = { ...tokensRef.current, [mb]: token };
          setPageTokens(tokensRef.current);
          added += rows.length;
          missed += res.missed || 0;
          if (!rows.length) break; // a token with nothing behind it
        } while (token && added < perBox);
      } catch (e) {
        if (e.code !== 'no_gmail_connection') {
          failure = activeMailboxes.length > 1 ? `${mailboxLabel[mb] || mb}: ${e.message}` : e.message;
        }
      }
    }));
    if (gen !== loadGen.current) return;
    if (failure) setError(failure);
    if (missed) flash(`${missed} conversation${missed === 1 ? '' : 's'} couldn't be loaded — refresh to retry.`);
    setListLoading(false);
    // pageTokens is read for "Load more" only; including it would re-fire the
    // load effect on every batch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMailboxes, listQuery, pageSize, mailboxLabel]);

  const hasMore = Object.values(pageTokens).some(Boolean);

  // Background send/receive. Only the first page per mailbox — re-walking a
  // 500-row view every five minutes would burn ~5,000 Gmail quota units for a
  // handful of new messages. New threads are merged in and existing ones
  // refreshed (so read/unread keeps up), leaving the deeper pool untouched.
  const busyRef = useRef(false);
  useEffect(() => { busyRef.current = listLoading; }, [listLoading]);

  const checkForMail = useCallback(async () => {
    if (!activeMailboxes.length || busyRef.current) return;
    const gen = loadGen.current; // observe, never cancel, an in-flight walk
    const incoming = [];
    await Promise.all(activeMailboxes.map(async (mb) => {
      try {
        const res = await gmail.listThreads(mb, { ...listQuery, maxResults: 50 });
        if (gen !== loadGen.current) return;
        incoming.push(...(res.threads || []).map((t) => ({ ...t, mailbox: mb })));
      } catch { /* a background check stays quiet */ }
    }));
    if (gen !== loadGen.current) return;
    if (incoming.length) {
      setThreads((prev) => {
        const byId = new Map(prev.map((t) => [t.id, t]));
        for (const t of incoming) byId.set(t.id, t);
        return [...byId.values()];
      });
    }
    setLastChecked(Date.now());
  }, [activeMailboxes, listQuery]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const id = setInterval(() => {
      if (!document.hidden) checkForMail();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [autoRefresh, checkForMail]);

  // Gmail can only return newest-first per mailbox, so ordering is applied here
  // over the conversations loaded so far ("Load more" extends the pool) — which
  // is also what interleaves a merged view into one timeline.
  const showRecipient = sort === 'recipient' || labelId === 'SENT' || labelId === 'DRAFT';
  const visibleThreads = useMemo(() => {
    const list = [...threads];
    const key = sort === 'recipient' ? recipientKey : sort === 'sender' ? senderKey : null;
    if (key) {
      list.sort((a, b) => {
        const ka = key(a);
        const kb = key(b);
        if (!ka !== !kb) return ka ? -1 : 1; // rows with no address last
        return ka.localeCompare(kb) || b.internalDate - a.internalDate;
      });
    } else {
      list.sort((a, b) => b.internalDate - a.internalDate);
    }
    return list;
  }, [threads, sort]);

  useEffect(() => { setThread(null); setComposer(null); loadLabels(); }, [mailbox, loadLabels]);
  useEffect(() => { setThread(null); loadThreads(); }, [loadThreads]);

  // ── Auto-suggested tags ──
  // Sender→label rules learned from this mailbox's history + every manual
  // tag. First visit with no rules kicks off a background history scan.
  const refreshTagRules = useCallback(async () => {
    if (!mailbox || isAll) { setTagRules([]); return []; }
    try {
      const rules = await loadTagRules(mailbox);
      setTagRules(rules);
      return rules;
    } catch {
      setTagRules([]);
      return [];
    }
  }, [mailbox, isAll]);

  const doLearnTags = useCallback(async (silent = false) => {
    setLearnBusy(true);
    try {
      const res = await gmail.learnLabels(mailbox);
      const rules = await loadTagRules(mailbox).catch(() => []);
      setTagRules(rules);
      flash(`Learned from ${res.threadsScanned} archived threads (${res.labelsScanned} labels) — ${res.rules} sender rules${res.partial ? ', partial scan' : ''}.`);
    } catch (e) {
      if (!silent) setError(`Learning tags failed: ${e.message}`);
    } finally {
      setLearnBusy(false);
    }
  }, [mailbox]);

  useEffect(() => {
    if (!mailbox || isAll) return; // rules are per-account
    (async () => {
      const rules = await refreshTagRules();
      if (!rules.length && !autoLearned.current.has(mailbox)) {
        autoLearned.current.add(mailbox);
        doLearnTags(true);
      }
    })();
  }, [mailbox, isAll, refreshTagRules, doLearnTags]);

  const suggestTag = useMemo(() => buildTagSuggester(tagRules), [tagRules]);

  // Our own domain, taken from the connected mailbox rather than hardcoded.
  const ownDomain = (mailbox.split('@')[1] || '').toLowerCase();

  // Suggestions for one inbox thread — every entity the SENDER has been filed
  // under, keyed on their address, narrowed to labels that still exist.
  const suggestionFor = useCallback((t) => {
    if (isAll || labelId !== 'INBOX' || q) return null;
    const sender = parseAddress(t.counterpartFrom || t.from).email.toLowerCase();
    if (!sender || sender === mailbox) return null;
    // A colleague's email is *about* a client rather than from one, and which
    // client is in the wording, not the address — so there's nothing here to
    // infer from and we don't guess. These still get tagged by hand.
    if (ownDomain && sender.endsWith(`@${ownDomain}`)) return null;
    const labelsFor = suggestTag(sender)
      .map((s) => {
        const byId = labelById[s.label_id];
        if (byId?.type === 'user') return byId;
        return userLabels.find((l) => l.name === s.label_name) || null;
      })
      .filter(Boolean);
    if (!labelsFor.length) return null;
    return { labels: labelsFor, sender };
  }, [isAll, labelId, q, suggestTag, labelById, userLabels, mailbox, ownDomain]);

  const suggested = useMemo(
    () => threads.map((t) => ({ t, sug: suggestionFor(t) })).filter((x) => x.sug),
    [threads, suggestionFor],
  );

  // Applies the whole suggested set in one modify, then archives.
  const applySuggestion = useCallback(async (t, sug) => {
    await gmail.modifyThread(t.mailbox, t.id, {
      addLabelIds: sug.labels.map((l) => l.id),
      removeLabelIds: ['INBOX'],
    });
    for (const l of sug.labels) recordTagRule(t.mailbox, sug.sender, l);
    setThreads((prev) => prev.filter((x) => x.id !== t.id));
    setSelected((prev) => { const n = new Set(prev); n.delete(t.id); return n; });
    setThread((prev) => (prev?.id === t.id ? null : prev));
  }, []);

  const acceptSuggestion = useCallback(async (t, sug) => {
    try {
      await applySuggestion(t, sug);
      flash(`Tagged ${sug.labels.map((l) => `“${l.name}”`).join(' + ')} & archived.`);
    } catch (e) {
      setError(e.message);
    }
  }, [applySuggestion]);

  const acceptAllSuggestions = useCallback(async () => {
    setSweepBusy(true);
    let done = 0;
    let failed = 0;
    for (const { t, sug } of suggested) {
      try {
        await applySuggestion(t, sug);
        done++;
      } catch {
        failed++;
      }
    }
    setSweepBusy(false);
    setSelected(new Set());
    flash(`Cleared ${done} conversation${done === 1 ? '' : 's'} as suggested${failed ? ` (${failed} failed)` : ''}.`);
  }, [suggested, applySuggestion]);

  // Ensure a label path exists, creating each missing level ("Tax/VAT"
  // creates "Tax" then "Tax/VAT"). Returns the leaf label.
  const ensureLabel = useCallback(async (name) => {
    const parts = name.split('/').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return null;
    let current = [...labels];
    let path = '';
    let leaf = null;
    for (const p of parts) {
      path = path ? `${path}/${p}` : p;
      leaf = current.find((l) => l.name.toLowerCase() === path.toLowerCase()) || null;
      if (!leaf) {
        try {
          const res = await gmail.createLabel(mailbox, path);
          leaf = res.label;
          current = [...current, leaf];
        } catch (e) {
          setError(`Could not create label “${path}”: ${e.message}`);
          return null;
        }
      }
    }
    setLabels(current);
    loadLabels();
    return leaf;
  }, [labels, mailbox, loadLabels]);

  // ── Thread (preview pane) ──
  // Every thread carries the mailbox it came from, so a merged list can still
  // read, reply to and file each conversation against the right account.
  const openThread = useCallback(async (summary) => {
    const mb = summary.mailbox || mailbox;
    setThreadLoading(true);
    setError(null);
    try {
      const res = await gmail.getThread(mb, summary.id);
      res.thread.messages = [...res.thread.messages].sort((a, b) => b.internalDate - a.internalDate);
      const opened = { ...res.thread, mailbox: mb };
      setThread(opened);
      setComposer(null);
      if (paneRef.current) paneRef.current.scrollTop = 0;
      if (summary.unread) {
        gmail.modifyThread(mb, summary.id, { removeLabelIds: ['UNREAD'] })
          .then(() => setThreads((prev) => prev.map((t) => (t.id === summary.id ? { ...t, unread: false } : t))))
          .catch(() => { /* read-state is cosmetic */ });
      }
      return opened;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setThreadLoading(false);
    }
  }, [mailbox]);

  const latestMsg = thread?.messages?.[0] || null;
  const threadInTrash = !!thread && thread.messages.some((m) => m.labelIds.includes('TRASH'));
  const threadMailbox = thread?.mailbox || mailbox;

  const archiveThread = useCallback(async (threadId, restore = false) => {
    try {
      await gmail.modifyThread(threadMailbox, threadId, restore
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
  }, [threadMailbox]);

  // Delete = Gmail bin (recoverable ~30 days), never permanent.
  const trashThread = useCallback(async (threadId) => {
    try {
      await gmail.trashThread(threadMailbox, threadId);
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      setThread(null);
      flash('Moved to bin.', async () => {
        await gmail.untrashThread(threadMailbox, threadId).catch(() => {});
        loadThreads();
      });
    } catch (e) {
      setError(e.message);
    }
  }, [threadMailbox, loadThreads]);

  const restoreThread = useCallback(async (threadId) => {
    try {
      await gmail.untrashThread(threadMailbox, threadId);
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      setThread(null);
      flash('Restored from bin.');
    } catch (e) {
      setError(e.message);
    }
  }, [threadMailbox]);

  const tagThread = useCallback(async (label) => {
    if (!thread) return;
    try {
      await gmail.modifyThread(threadMailbox, thread.id, { addLabelIds: [label.id] });
      const sender = thread.messages
        .map((m) => parseAddress(m.from).email.toLowerCase())
        .find((e) => e && e !== threadMailbox);
      recordTagRule(threadMailbox, sender, label);
      setThread((prev) => (prev ? {
        ...prev,
        messages: prev.messages.map((m) => ({ ...m, labelIds: [...new Set([...m.labelIds, label.id])] })),
      } : prev));
      setThreads((prev) => prev.map((t) => (t.id === thread.id ? { ...t, labelIds: [...new Set([...(t.labelIds || []), label.id])] } : t)));
      flash(`Tagged “${label.name}”.`);
    } catch (e) {
      setError(e.message);
    }
  }, [mailbox, thread]);

  // ── Bulk actions ──
  const toggleSelect = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const boxOf = useCallback(
    (id) => threads.find((t) => t.id === id)?.mailbox || mailbox,
    [threads, mailbox],
  );

  const bulkModify = useCallback(async ({ addLabelIds = [], removeLabelIds = [], verb }) => {
    setBulkBusy(true);
    setError(null);
    let failed = 0;
    for (const id of selected) {
      try {
        await gmail.modifyThread(boxOf(id), id, { addLabelIds, removeLabelIds });
      } catch { failed++; }
    }
    setBulkBusy(false);
    flash(`${verb} ${selected.size - failed} conversation${selected.size - failed === 1 ? '' : 's'}${failed ? ` (${failed} failed)` : ''}.`);
    setSelected(new Set());
    loadThreads();
  }, [selected, boxOf, loadThreads]);

  const bulkTrash = useCallback(async () => {
    setBulkBusy(true);
    setError(null);
    const ids = [...selected].map((id) => [id, boxOf(id)]);
    let failed = 0;
    for (const [id, mb] of ids) {
      try { await gmail.trashThread(mb, id); } catch { failed++; }
    }
    setBulkBusy(false);
    setSelected(new Set());
    flash(`Binned ${ids.length - failed} conversation${ids.length - failed === 1 ? '' : 's'}.`, async () => {
      for (const [id, mb] of ids) await gmail.untrashThread(mb, id).catch(() => {});
      loadThreads();
    });
    loadThreads();
  }, [selected, boxOf, loadThreads]);

  // ── Composer ──
  const startComposer = useCallback((mode) => {
    setError(null);
    // Signature belongs to the account the mail actually leaves from.
    const sigBody = effectiveSignature(signatures, mode === 'new' ? sendFrom : threadMailbox);
    const sig = sigBody ? `\n\n${sigBody}` : '';
    if (mode === 'new') {
      setComposer({ mode, to: '', cc: '', subject: '', body: `${sig}`, mailbox: sendFrom });
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
          .split(',').map((s) => parseAddress(s).email).filter((e) => e && e.toLowerCase() !== threadMailbox);
        cc = [...new Set(others)].join(', ');
      }
      setComposer({ mode, to, cc, subject: reSubject, body: `${sig}\n\n${quoteBody(latestMsg)}`, threadId: thread.id, inReplyTo: latestMsg.messageIdHeader, references, mailbox: threadMailbox });
    } else if (mode === 'forward') {
      const fwdSubject = /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`;
      setComposer({ mode, to: '', cc: '', subject: fwdSubject, body: `${sig}\n\n${forwardBody(latestMsg)}`, mailbox: threadMailbox });
    }
    if (paneRef.current) paneRef.current.scrollTop = 0;
  }, [latestMsg, thread, threadMailbox, sendFrom, signatures]);

  // ── Row actions ──
  // Reply/forward from a list row needs the full latest message (for the quote)
  // and the thread's own mailbox, so it opens the thread first and lets the
  // normal composer run once it's there — one code path for both entry points.
  const pendingCompose = useRef(null);
  useEffect(() => {
    if (!thread || !pendingCompose.current) return;
    const mode = pendingCompose.current;
    pendingCompose.current = null;
    startComposer(mode);
  }, [thread, startComposer]);

  const rowCompose = useCallback(async (t, mode) => {
    pendingCompose.current = mode;
    const opened = await openThread(t);
    if (!opened) pendingCompose.current = null; // don't fire on the next open
  }, [openThread]);

  const rowTrash = useCallback(async (t) => {
    try {
      await gmail.trashThread(t.mailbox, t.id);
      setThreads((prev) => prev.filter((x) => x.id !== t.id));
      setThread((prev) => (prev?.id === t.id ? null : prev));
      flash('Moved to bin.', async () => {
        await gmail.untrashThread(t.mailbox, t.id).catch(() => {});
        loadThreads();
      });
    } catch (e) {
      setError(e.message);
    }
  }, [loadThreads]);

  // Diarise: hand the thread to Google Calendar's own event editor, prefilled.
  // Nothing is created or invited from here — the invite is saved and sent by
  // whoever clicked, in Google's UI, which is where that decision belongs.
  const diarise = useCallback((t) => {
    const other = parseAddress(t.counterpartFrom || t.from);
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: t.subject || '(no subject)',
      details: [
        t.snippet || '',
        '',
        `From: ${t.from}`,
        `Email: https://mail.google.com/mail/?authuser=${t.mailbox}#all/${t.id}`,
      ].join('\n'),
    });
    if (other.email) params.set('add', other.email);
    window.open(`https://calendar.google.com/calendar/render?${params.toString()}`, '_blank', 'noopener');
  }, []);

  const sendComposer = useCallback(async () => {
    if (!composer?.to?.trim() || !composer?.subject?.trim()) { setError('To and subject are required.'); return; }
    setSending(true);
    setError(null);
    try {
      await gmail.send(composer.mailbox || mailbox, {
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
      if (wasReply && thread) openThread({ id: thread.id, mailbox: threadMailbox, unread: false });
    } catch (e) {
      setError(`Send failed: ${e.message}`);
    } finally {
      setSending(false);
    }
  }, [composer, mailbox, thread, threadMailbox, openThread]);

  // ── Contacts sync / signature save ──
  const doSyncContacts = useCallback(async () => {
    setSyncBusy(true);
    setError(null);
    try {
      const res = await syncContacts(mailbox);
      setContacts(await loadContacts());
      flash(`Synced ${res.stored} contacts from ${res.mailbox}.`);
    } catch (e) {
      setError(e.code === 'needs_reconnect' ? `${e.message}` : `Contacts sync failed: ${e.message}`);
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
  // gmail-auth-init now needs the session (it signs the OAuth state), so these are
  // actions rather than hrefs.
  const connectPersonal = () => startMailboxConnect({
    kind: 'personal',
    displayName: profile?.name ? profile.name.split(' ')[0] : undefined,
  }).catch((e) => setError(e.message));
  const connectShared = () => startMailboxConnect({ kind: 'shared' }).catch((e) => setError(e.message));

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
          <a href="#" onClick={(e) => { e.preventDefault(); connectPersonal(); }} style={{ padding: '9px 18px', fontSize: 13, fontWeight: 600, background: '#0f172a', color: '#fff', borderRadius: 8, textDecoration: 'none' }}>Connect my inbox</a>
          {isAdmin && <a href="#" onClick={(e) => { e.preventDefault(); connectShared(); }} style={{ padding: '9px 18px', fontSize: 13, fontWeight: 600, background: '#fff', color: '#0f172a', border: '1px solid #cbd5e1', borderRadius: 8, textDecoration: 'none' }}>Add a shared mailbox</a>}
        </div>
      </div>
    );
  }

  const needsReconnect = mailboxNeedsReconnect(mailboxObj);
  const reconnect = () => {
    if (!mailboxObj) return;
    startMailboxConnect({ kind: mailboxObj.kind, displayName: mailboxObj.display_name })
      .catch((e) => setError(e.message));
  };

  const selectLabel = (id) => { setQ(''); setQDraft(''); setSearchAll(false); setLabelId(id); };

  // What the search box says it's searching.
  const currentFolderName = SYSTEM_LABELS.find((s) => s.id === labelId)?.label
    || labelById[labelId]?.name.split('/').pop()
    || 'this folder';

  const renderTreeNode = (node, depth) => {
    const isActive = node.label && labelId === node.label.id && !q;
    const hasKids = node.children.length > 0;
    const isOpen = expanded.has(node.full);
    return (
      <React.Fragment key={node.full}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <button
            onClick={() => hasKids && toggleExpanded(node.full)}
            style={{ width: 18, height: 22, padding: 0, border: 'none', background: 'none', cursor: hasKids ? 'pointer' : 'default', color: '#94a3b8', display: 'flex', alignItems: 'center', justifyContent: 'center', marginLeft: depth * 12 }}
          >
            {hasKids ? (isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : null}
          </button>
          <button
            onClick={() => (node.label ? selectLabel(node.label.id) : hasKids && toggleExpanded(node.full))}
            title={node.full}
            style={{
              flex: 1, display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', fontSize: 12.5,
              fontWeight: isActive ? 700 : 500,
              background: isActive ? tones.info.bg : 'transparent',
              color: isActive ? tones.info.fg : node.label ? '#475569' : '#94a3b8',
              border: 'none', borderRadius: 7, cursor: 'pointer', textAlign: 'left', fontFamily: font, minWidth: 0,
            }}
          >
            <Tag size={11} style={{ flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.seg}</span>
            {hasKids && <span style={{ fontSize: 10, color: '#cbd5e1', flexShrink: 0 }}>{node.children.length}</span>}
          </button>
        </div>
        {hasKids && isOpen && node.children.map((c) => renderTreeNode(c, depth + 1))}
      </React.Fragment>
    );
  };

  function renderComposer() {
    return (
      <div style={{ border: '1px solid #94a3b8', borderRadius: 10, background: '#fff', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#0f172a' }}>
            {composer.mode === 'new' ? 'New email' : composer.mode === 'forward' ? 'Forward' : composer.mode === 'replyAll' ? 'Reply all' : 'Reply'} — from {mailboxLabel[composer.mailbox] || composer.mailbox || mailbox}
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

  const paneContent = () => {
    if (composer?.mode === 'new' || composer?.mode === 'forward') {
      return renderComposer();
    }
    if (thread) {
      return (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', flex: 1, minWidth: 200 }}>
              {latestMsg?.subject || '(no subject)'}
            </span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button onClick={() => startComposer('reply')} title="Reply" style={btnIcon}><ReplyIcon size={14} /> Reply</button>
              <button onClick={() => startComposer('replyAll')} title="Reply all" style={btnIcon}><ReplyAllIcon size={14} /> All</button>
              <button onClick={() => startComposer('forward')} title="Forward" style={btnIcon}><ForwardIcon size={14} /> Forward</button>
              {/* Labels are per-account, so tagging waits for a single mailbox. */}
              {!isAll && (
                <LabelPicker
                  labels={userLabels}
                  onPick={tagThread}
                  onCreate={ensureLabel}
                  align="right"
                  trigger={<button title="Tag with a label" style={btnIcon}><Tag size={13} /> Tag</button>}
                />
              )}
              {thread.messages.some((m) => m.labelIds.includes('INBOX'))
                ? <button onClick={() => archiveThread(thread.id)} title="Archive (remove from inbox)" style={btnIcon}><Archive size={14} /> Archive</button>
                : !threadInTrash && <button onClick={() => archiveThread(thread.id, true)} title="Move back to inbox" style={btnIcon}><ArchiveRestore size={14} /> To inbox</button>}
              {threadInTrash
                ? <button onClick={() => restoreThread(thread.id)} title="Restore from bin" style={btnIcon}><ArchiveRestore size={14} /> Restore</button>
                : <button onClick={() => trashThread(thread.id)} title="Move to bin (recoverable for ~30 days in Gmail)" style={{ ...btnIcon, color: '#b91c1c', borderColor: '#fca5a5' }}><Trash2 size={14} /> Delete</button>}
              <button onClick={() => setThread(null)} title="Close" style={btnIcon}><X size={14} /></button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[...new Set(thread.messages.flatMap((m) => m.labelIds))]
              .filter((id) => labelById[id]?.type === 'user')
              .map((id) => <span key={id} style={chipStyle('teal')}>{labelById[id].name}</span>)}
            {isAll && (
              <span style={chipStyle('neutral')}>{mailboxLabel[threadMailbox] || threadMailbox}</span>
            )}
          </div>
          {composer && renderComposer()}
          {thread.messages.map((m, i) => (
            <MessageCard key={m.id} msg={m} mailbox={threadMailbox} defaultOpen={i === 0} />
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

  return (
    <div style={{ display: 'flex', gap: 14, height: '100%', minHeight: 0, fontFamily: font }}>
      {/* ── Left rail ── */}
      <div style={{ width: 212, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto' }}>
        <select
          value={mailbox}
          onChange={(e) => setMailbox(e.target.value)}
          style={{ padding: '8px 10px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8, background: '#fff', fontWeight: 600, color: '#0f172a' }}
        >
          {mailboxes.length > 1 && (
            <option value={ALL_MAILBOXES}>All mailboxes ({mailboxes.length})</option>
          )}
          {mailboxes.map((m) => (
            <option key={m.account_email} value={m.account_email}>
              {m.display_name || m.account_email}{m.kind === 'shared' ? ' (shared)' : ''}
            </option>
          ))}
        </select>
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: -2, paddingLeft: 2 }}>
          {isAll ? activeMailboxes.join(', ') : mailboxObj?.account_email}
        </div>

        {/* Mailbox tools — directly under the switcher. Contacts, signature and
            reconnect all act on one account, so they wait for a single pick. */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          {(!myPersonal || isAdmin) && (
            <button onClick={() => setAddOpen((o) => !o)} style={{ ...railBtn, border: '1px dashed #94a3b8' }}>
              <Plus size={12} /> Add mailbox
            </button>
          )}
          {!isAll && (
            <a
              href="#" onClick={(e) => { e.preventDefault(); reconnect(); }}
              onClick={(e) => { if (!window.confirm(`Reconnect ${mailboxObj?.account_email}? You'll be sent to Google to re-approve — sign in as that account. This refreshes the mailbox's permissions.`)) e.preventDefault(); }}
              style={{ ...railBtn, textDecoration: 'none', ...(needsReconnect ? { border: `1px solid ${tones.info.border}`, background: tones.info.bg, color: tones.info.fg } : {}) }}
            >
              <RefreshCw size={12} /> Reconnect{needsReconnect ? ' ⚠' : ''}
            </a>
          )}
          {!isAll && (
            <button onClick={doSyncContacts} disabled={syncBusy} style={railBtn}>
              <BookUser size={12} /> {syncBusy ? 'Syncing…' : 'Contacts'}
            </button>
          )}
          {!isAll && (
            <button onClick={openSigEditor} style={railBtn}>
              <PenSquare size={12} /> Signature
            </button>
          )}
        </div>
        {addOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, border: '1px solid #e2e8f0', borderRadius: 8, background: '#f8fafc' }}>
            {!myPersonal && (
              <a href="#" onClick={(e) => { e.preventDefault(); connectPersonal(); }} style={addOptionStyle}>
                <Mail size={13} /> Connect my inbox
              </a>
            )}
            {isAdmin && (
              <a
                href="#" onClick={(e) => { e.preventDefault(); connectShared(); }}
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

        <button
          onClick={() => { setThread(null); startComposer('new'); }}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', fontSize: 13, fontWeight: 600, background: '#0f172a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: font }}
        >
          <PenSquare size={14} /> New email
        </button>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {/* System label ids are identical in every Gmail account, so the
              merged view offers the full set even with no labels loaded. */}
          {SYSTEM_LABELS.filter((s) => isAll || s.id === 'INBOX' || s.id === 'ALL' || labelById[s.id]).map((s) => (
            <button
              key={s.id}
              onClick={() => selectLabel(s.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', fontSize: 13,
                fontWeight: labelId === s.id && !q ? 700 : 500,
                background: labelId === s.id && !q ? tones.info.bg : 'transparent',
                color: labelId === s.id && !q ? tones.info.fg : '#334155',
                border: 'none', borderRadius: 8, cursor: 'pointer', textAlign: 'left', fontFamily: font,
              }}
            >
              {s.id === 'INBOX' ? <InboxIcon size={14} /> : s.id === 'ALL' ? <Layers size={14} /> : s.id === 'TRASH' ? <Trash2 size={13} /> : <Tag size={13} />} {s.label}
            </button>
          ))}
          {labelTree.length > 0 && <div style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5, padding: '8px 10px 2px' }}>Labels</div>}
          {labelTree.map((n) => renderTreeNode(n, 0))}
        </div>
      </div>

      {/* ── Middle: thread list ── Wider than it was: one-line rows need room
          for sender + subject + the hover actions, and the reading pane was
          sprawling past a comfortable measure on a wide monitor. */}
      <div style={{ width: 560, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff' }}>
            <Search size={14} color="#94a3b8" />
            <input
              value={qDraft}
              onChange={(e) => setQDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setQ(qDraft.trim()); }}
              placeholder={`Search ${searchAll ? 'all mail' : currentFolderName} — Enter`}
              style={{ flex: 1, padding: '8px 0', fontSize: 13, fontFamily: font, border: 'none', outline: 'none', minWidth: 0 }}
            />
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: searchAll ? tones.info.fg : '#94a3b8', cursor: 'pointer', whiteSpace: 'nowrap' }}
              title={`Search every message in the mailbox instead of just ${currentFolderName}`}
            >
              <input type="checkbox" checked={searchAll} onChange={(e) => setSearchAll(e.target.checked)} style={{ cursor: 'pointer' }} />
              All mail
            </label>
            {q && <button onClick={() => { setQ(''); setQDraft(''); setSearchAll(false); }} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#64748b', fontSize: 11 }}>clear</button>}
          </div>
          <button
            onClick={() => { setLastChecked(Date.now()); loadThreads(); }}
            title={`Send / receive${lastChecked ? ` — last checked ${fmtClock(lastChecked)}` : ''}`}
            style={btnIcon}
          >
            <RefreshCw size={14} />
          </button>
        </div>

        {/* Sort + inbox noise filter */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5, color: '#64748b', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            Sort
            <select
              value={sort}
              onChange={(e) => { setSort(e.target.value); localStorage.setItem('comms_email_sort', e.target.value); }}
              style={{ padding: '3px 6px', fontSize: 11.5, fontFamily: font, border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff', color: '#334155' }}
            >
              <option value="date">Newest first</option>
              <option value="recipient">Recipient email (A–Z)</option>
              <option value="sender">Sender email (A–Z)</option>
            </select>
          </label>
          {labelId === 'INBOX' && !q && (
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}
              title="Threads that are only your own outbound mail — Gmail files these in the inbox when they go to a list this mailbox is on"
            >
              <input
                type="checkbox"
                checked={hideOwn}
                onChange={(e) => { setHideOwn(e.target.checked); localStorage.setItem('comms_hide_own', e.target.checked ? '1' : '0'); }}
                style={{ cursor: 'pointer' }}
              />
              Hide my own sent mail
            </label>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: 5 }} title="Conversations fetched per view. Bigger pages take longer and are what the sort works across.">
            Load
            <select
              value={pageSize}
              onChange={(e) => { setPageSize(Number(e.target.value)); localStorage.setItem('comms_page_size', e.target.value); }}
              style={{ padding: '3px 6px', fontSize: 11.5, fontFamily: font, border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff', color: '#334155' }}
            >
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }} title="One line per email">
            <input
              type="checkbox"
              checked={compact}
              onChange={(e) => { setCompact(e.target.checked); localStorage.setItem('comms_compact', e.target.checked ? '1' : '0'); }}
              style={{ cursor: 'pointer' }}
            />
            Compact
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }} title="Check for new mail every 5 minutes (first page only)">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => { setAutoRefresh(e.target.checked); localStorage.setItem('comms_auto', e.target.checked ? '1' : '0'); }}
              style={{ cursor: 'pointer' }}
            />
            Auto 5m
          </label>
          <span style={{ color: '#94a3b8', marginLeft: 'auto' }}>
            {listLoading && threads.length > 0
              ? `${threads.length} loaded…`
              : `${threads.length}${hasMore ? ' — Load more' : ''}`}
            {isAll ? ` across ${activeMailboxes.length}` : ''}
            {lastChecked ? ` · ${fmtClock(lastChecked)}` : ''}
          </span>
        </div>

        {/* Auto-suggested tags: eyeball, then one-click clear */}
        {!isAll && labelId === 'INBOX' && !q && (suggested.length > 0 || learnBusy || tagRules.length === 0) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: tones.teal.bg, border: `1px solid ${tones.teal.border}`, borderRadius: 8, fontSize: 12, flexWrap: 'wrap' }}>
            <Sparkles size={13} color={tones.teal.solid} style={{ flexShrink: 0 }} />
            {learnBusy ? (
              <span style={{ color: tones.teal.fg }}>Learning from this mailbox&apos;s labelled history…</span>
            ) : suggested.length > 0 ? (
              <>
                <span style={{ fontWeight: 700, color: tones.teal.fg }}>
                  {suggested.length} suggested tag{suggested.length === 1 ? '' : 's'}
                </span>
                <button disabled={sweepBusy} onClick={acceptAllSuggestions} style={sweepBtn}>
                  {sweepBusy ? 'Clearing…' : 'Tag + archive all'}
                </button>
              </>
            ) : (
              <span style={{ color: tones.teal.fg }}>No tag suggestions yet.</span>
            )}
            <button
              disabled={learnBusy || sweepBusy}
              onClick={() => doLearnTags(false)}
              title="Scan this mailbox's labelled threads and refresh the sender→tag rules"
              style={{ ...sweepBtn, marginLeft: 'auto', background: 'transparent' }}
            >
              {tagRules.length === 0 && !learnBusy ? 'Learn from my labels' : 'Re-learn'}
            </button>
          </div>
        )}

        {/* Bulk action bar */}
        {selected.size > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: tones.info.bg, border: `1px solid ${tones.info.border}`, borderRadius: 8, fontSize: 12, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, color: tones.info.fg }}>{selected.size} selected</span>
            {!isAll && (
              <LabelPicker
                labels={userLabels}
                onPick={(label) => {
                  for (const id of selected) {
                    const t = threads.find((x) => x.id === id);
                    const sender = t ? parseAddress(t.counterpartFrom || t.from).email.toLowerCase() : '';
                    if (sender && sender !== mailbox) recordTagRule(mailbox, sender, label);
                  }
                  bulkModify({ addLabelIds: [label.id], removeLabelIds: ['INBOX'], verb: `Tagged “${label.name}” & archived` });
                }}
                onCreate={ensureLabel}
                trigger={<button disabled={bulkBusy} style={bulkBtn}><Tag size={12} /> Tag + archive ▾</button>}
              />
            )}
            <button disabled={bulkBusy} onClick={() => bulkModify({ removeLabelIds: ['INBOX'], verb: 'Archived' })} style={bulkBtn}><Archive size={12} /> Archive</button>
            <button disabled={bulkBusy} onClick={() => bulkModify({ removeLabelIds: ['UNREAD'], verb: 'Marked read' })} style={bulkBtn}><MailOpen size={12} /> Read</button>
            <button disabled={bulkBusy} onClick={bulkTrash} style={{ ...bulkBtn, color: '#b91c1c', borderColor: '#fca5a5' }}><Trash2 size={12} /> Delete</button>
            <button disabled={bulkBusy} onClick={() => setSelected(new Set())} style={{ ...bulkBtn, marginLeft: 'auto' }}>Clear</button>
            {bulkBusy && <span style={{ color: tones.info.fg }}>Working…</span>}
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff', minHeight: 0 }}>
          {listLoading && threads.length === 0 && <div style={{ padding: 20, fontSize: 13, color: '#64748b' }}>Loading…</div>}
          {!listLoading && threads.length === 0 && (
            <div style={{ padding: 26, fontSize: 13, color: '#94a3b8', textAlign: 'center' }}>
              {q ? 'No results.' : 'Nothing here — inbox zero 🎉'}
            </div>
          )}
          {visibleThreads.map((t) => {
            const party = rowParty(t, t.mailbox || mailbox, showRecipient);
            const isOpen = thread?.id === t.id;
            const userLabelChips = (t.labelIds || []).filter((id) => labelById[id]?.type === 'user').slice(0, 2);
            const sug = suggestionFor(t);
            const sender = (
              <span style={{ fontWeight: t.unread ? 700 : 500, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...(compact ? { flex: '0 0 150px' } : { flex: 1 }) }}>
                {party.own && <Send size={10} color="#94a3b8" style={{ marginRight: 4, verticalAlign: -1 }} title="You sent the latest message" />}
                {party.name}{t.messageCount > 1 ? ` (${t.messageCount})` : ''}
                {party.to && <span style={{ fontWeight: 400, color: '#94a3b8' }}> → {party.to}</span>}
              </span>
            );
            const subject = (
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...(compact ? { flex: 1, minWidth: 0 } : {}) }}>
                <span style={{ fontWeight: t.unread ? 700 : 500, color: '#1e293b' }}>{t.subject}</span>
                <span style={{ color: '#94a3b8' }}> — {t.snippet}</span>
              </span>
            );
            const marks = (
              <>
                {isAll && (
                  <span style={{ ...chipStyle('neutral'), flexShrink: 0 }} title={t.mailbox}>
                    {mailboxLabel[t.mailbox] || t.mailbox}
                  </span>
                )}
                {userLabelChips.map((id) => <span key={id} style={{ ...chipStyle('teal'), flexShrink: 0 }}>{labelById[id].name.split('/').pop()}</span>)}
                {sug && (
                  <button
                    onClick={(e) => { e.stopPropagation(); acceptSuggestion(t, sug); }}
                    disabled={sweepBusy}
                    title={`Tag ${sug.labels.map((l) => `“${l.name}”`).join(' + ')} and archive`}
                    style={suggChipBtn}
                  >
                    <Sparkles size={10} /> {sug.labels.map((l) => l.name.split('/').pop()).join(' + ')}
                  </button>
                )}
              </>
            );
            // Actions sit under the date and swap in on hover, so a dense list
            // stays readable. group-hover rather than React state: re-rendering
            // 500 rows on every mouse move would crawl.
            const actions = (
              <span className="relative flex-shrink-0" style={{ display: 'inline-flex', alignItems: 'center' }}>
                <span className="group-hover:invisible" style={{ fontSize: 10.5, color: '#94a3b8', whiteSpace: 'nowrap' }}>
                  {fmtDate(t.internalDate)}
                </span>
                <span
                  className="invisible group-hover:visible"
                  style={{ position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)', display: 'flex', gap: 2, background: isOpen ? tones.info.bg : '#fff', paddingLeft: 6, borderRadius: 6 }}
                >
                  {[
                    { key: 'reply', title: 'Reply', Icon: ReplyIcon, run: () => rowCompose(t, 'reply') },
                    { key: 'replyAll', title: 'Reply all', Icon: ReplyAllIcon, run: () => rowCompose(t, 'replyAll') },
                    { key: 'forward', title: 'Forward', Icon: ForwardIcon, run: () => rowCompose(t, 'forward') },
                    { key: 'diarise', title: 'Diarise — open a prefilled Google Calendar event', Icon: CalendarPlus, run: () => diarise(t) },
                    { key: 'trash', title: 'Move to bin', Icon: Trash2, run: () => rowTrash(t), danger: true },
                  ].map(({ key, title, Icon, run, danger }) => (
                    <button
                      key={key}
                      title={title}
                      onClick={(e) => { e.stopPropagation(); run(); }}
                      style={{ ...rowActionBtn, ...(danger ? { color: '#b91c1c' } : {}) }}
                    >
                      <Icon size={13} />
                    </button>
                  ))}
                </span>
              </span>
            );
            return (
              <div
                key={t.id}
                onClick={() => openThread(t)}
                className="group"
                style={{ display: 'flex', gap: 8, padding: compact ? '5px 10px' : '8px 10px', borderBottom: '1px solid #f1f5f9', cursor: 'pointer', background: isOpen ? tones.info.bg : t.unread ? '#fff' : '#fafbfc' }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(t.id)}
                  onChange={() => toggleSelect(t.id)}
                  onClick={(e) => e.stopPropagation()}
                  style={{ marginTop: compact ? 1 : 3, cursor: 'pointer', flexShrink: 0 }}
                />
                {compact ? (
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                    {sender}{subject}{marks}{actions}
                  </div>
                ) : (
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12.5 }}>
                      {sender}{marks}{actions}
                    </div>
                    <div style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subject}</div>
                  </div>
                )}
              </div>
            );
          })}
          {hasMore && (
            <button onClick={() => loadThreads({ append: true })} disabled={listLoading}
              style={{ width: '100%', padding: 10, fontSize: 12, fontWeight: 600, color: tones.info.solid, background: 'none', border: 'none', cursor: 'pointer', fontFamily: font }}>
              {listLoading ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      </div>

      {/* ── Right: preview pane ── */}
      <div style={{ flex: 1, minWidth: 380, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
        {needsReconnect && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: tones.info.bg, border: `1px solid ${tones.info.border}`, borderRadius: 8, fontSize: 12, color: tones.info.fg }}>
            {mailboxObj?.status !== 'active'
              ? <span>This mailbox&apos;s connection is broken ({mailboxObj?.error_message || mailboxObj?.status}).</span>
              : <span>This mailbox was connected with an older permission set — a quick reconnect unlocks everything.</span>}
            <a href="#" onClick={(e) => { e.preventDefault(); reconnect(); }} style={{ marginLeft: 'auto', fontWeight: 700, color: tones.info.fg }}>Reconnect</a>
          </div>
        )}
        {error && (
          <div style={{ display: 'flex', gap: 10, padding: '8px 12px', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 8, fontSize: 12, color: '#b91c1c' }}>
            <span style={{ flex: 1 }}>{error}</span>
            <button onClick={() => setError(null)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#b91c1c' }}><X size={13} /></button>
          </div>
        )}
        {notice && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, fontSize: 12, color: '#166534' }}>
            <span style={{ flex: 1 }}>{notice.text}</span>
            {notice.undo && (
              <button
                onClick={async () => { const u = notice.undo; setNotice(null); await u(); }}
                style={{ fontSize: 12, fontWeight: 700, color: '#166534', background: 'none', border: '1px solid #86efac', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontFamily: font }}
              >
                Undo
              </button>
            )}
          </div>
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
  border: `1px solid ${tones.info.border}`, background: '#fff', borderRadius: 6, cursor: 'pointer',
  fontFamily: font, color: tones.info.fg,
};

const sweepBtn = {
  display: 'flex', alignItems: 'center', gap: 5, padding: '4px 9px', fontSize: 12, fontWeight: 600,
  border: `1px solid ${tones.teal.solid}`, background: '#fff', borderRadius: 6, cursor: 'pointer',
  fontFamily: font, color: tones.teal.fg,
};

// One-click "tag as suggested + archive" chip on an inbox row.
const suggChipBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', fontSize: 10.5, fontWeight: 700,
  color: tones.teal.fg, background: tones.teal.bg, border: `1px dashed ${tones.teal.solid}`, borderRadius: 999,
  cursor: 'pointer', fontFamily: font, flexShrink: 0, whiteSpace: 'nowrap',
};

// Hover-revealed per-row action.
const rowActionBtn = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 22, height: 22, padding: 0, border: '1px solid #e2e8f0', borderRadius: 5,
  background: '#fff', cursor: 'pointer', color: '#475569',
};

const railBtn = {
  display: 'flex', alignItems: 'center', gap: 5, padding: '6px 8px', fontSize: 11.5, fontWeight: 600,
  border: '1px solid #e2e8f0', background: '#fff', borderRadius: 8, cursor: 'pointer',
  fontFamily: font, color: '#475569', textAlign: 'left', whiteSpace: 'nowrap',
};

const addOptionStyle = {
  display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', fontSize: 12.5, fontWeight: 600,
  background: '#fff', color: '#0f172a', border: '1px solid #cbd5e1', borderRadius: 7,
  textDecoration: 'none', fontFamily: font,
};
