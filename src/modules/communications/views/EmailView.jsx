import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, ArchiveRestore, BookUser, ChevronDown, ChevronRight,
  Forward as ForwardIcon, Inbox as InboxIcon, Layers, Mail, MailOpen, Paperclip,
  PenSquare, Plus, RefreshCw, Reply as ReplyIcon, ReplyAll as ReplyAllIcon,
  Search, Send, Sparkles, Tag, Trash2, X,
} from 'lucide-react';
import { useAuth } from '../../../shell/AppShell';
import { chipStyle, tones } from '../../../lib/tokens';
import {
  buildTagSuggester, connectMailboxUrl, downloadAttachment, effectiveSignature, gmail, listMailboxes,
  loadContacts, loadSignatures, loadTagRules, mailboxNeedsReconnect, parseAddress, recordTagRule,
  saveSignature, syncContacts,
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
  { id: 'TRASH', label: 'Bin' },
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

// Who a list row is about. Our own outbound mail can carry both SENT and
// INBOX (anything sent to a list this mailbox is on), so a row that named the
// latest sender read as inbound mail from ourselves. Name the other side
// instead — the person we replied to, or the recipient when the thread is
// only ours.
function rowParty(t, mailbox, showRecipient) {
  const last = parseAddress(t.from);
  const own = last.email.toLowerCase() === mailbox;
  const [rcpt, count] = recipients(t);
  const toLabel = rcpt ? `To ${rcpt.name}${count > 1 ? ` +${count - 1}` : ''}` : null;
  if (showRecipient && toLabel) return { name: toLabel, own };
  if (own) {
    if (t.counterpartFrom) return { name: parseAddress(t.counterpartFrom).name, own };
    if (toLabel) return { name: toLabel, own };
  }
  return { name: last.name, own };
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
  const [sort, setSort] = useState(() => localStorage.getItem('comms_email_sort') || 'date');
  const [hideOwn, setHideOwn] = useState(() => localStorage.getItem('comms_hide_own') !== '0');
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

  const mailboxObj = useMemo(
    () => (mailboxes || []).find((m) => m.account_email === mailbox) || null,
    [mailboxes, mailbox],
  );
  const labelById = useMemo(() => Object.fromEntries(labels.map((l) => [l.id, l])), [labels]);
  const userLabels = useMemo(
    () => labels.filter((l) => l.type === 'user' && l.labelListVisibility !== 'labelHide'),
    [labels],
  );
  const labelTree = useMemo(() => buildLabelTree(userLabels), [userLabels]);
  const sigText = useMemo(() => effectiveSignature(signatures, mailbox), [signatures, mailbox]);

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
    if (!mailbox) return [];
    try {
      const res = await gmail.listLabels(mailbox);
      setLabels(res.labels || []);
      return res.labels || [];
    } catch (e) {
      setLabels([]);
      setError(e.code === 'no_gmail_connection' ? null : `Labels: ${e.message}`);
      return [];
    }
  }, [mailbox]);

  const loadThreads = useCallback(async ({ append, pageToken } = {}) => {
    if (!mailbox) return;
    setListLoading(true);
    setError(null);
    try {
      // Gmail matches a label or query against any message in the thread, so
      // "-from:me" drops threads that are only our own sent mail while keeping
      // conversations we happen to have replied to last.
      const res = await gmail.listThreads(mailbox, {
        labelIds: q || labelId === 'ALL' ? undefined : [labelId],
        q: q || (labelId === 'INBOX' && hideOwn ? '-from:me' : undefined),
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
  }, [mailbox, labelId, q, hideOwn]);

  // Gmail can only return newest-first, so any other order is applied to the
  // conversations loaded so far ("Load more" extends the pool).
  const showRecipient = sort === 'recipient' || labelId === 'SENT' || labelId === 'DRAFT';
  const visibleThreads = useMemo(() => {
    if (sort !== 'recipient') return threads;
    return [...threads].sort((a, b) => {
      const ka = recipientKey(a);
      const kb = recipientKey(b);
      if (!ka !== !kb) return ka ? -1 : 1; // unaddressed rows last
      return ka.localeCompare(kb) || b.internalDate - a.internalDate;
    });
  }, [threads, sort]);

  useEffect(() => { setThread(null); setComposer(null); loadLabels(); }, [mailbox, loadLabels]);
  useEffect(() => { setThread(null); loadThreads(); }, [loadThreads]);

  // ── Auto-suggested tags ──
  // Sender→label rules learned from this mailbox's history + every manual
  // tag. First visit with no rules kicks off a background history scan.
  const refreshTagRules = useCallback(async () => {
    if (!mailbox) return [];
    try {
      const rules = await loadTagRules(mailbox);
      setTagRules(rules);
      return rules;
    } catch {
      setTagRules([]);
      return [];
    }
  }, [mailbox]);

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
    if (!mailbox) return;
    (async () => {
      const rules = await refreshTagRules();
      if (!rules.length && !autoLearned.current.has(mailbox)) {
        autoLearned.current.add(mailbox);
        doLearnTags(true);
      }
    })();
  }, [mailbox, refreshTagRules, doLearnTags]);

  const suggestTag = useMemo(() => buildTagSuggester(tagRules), [tagRules]);

  // Suggestion for one inbox thread — only labels that still exist.
  const suggestionFor = useCallback((t) => {
    if (labelId !== 'INBOX' || q) return null;
    const sender = parseAddress(t.counterpartFrom || t.from).email.toLowerCase();
    if (!sender || sender === mailbox) return null;
    const s = suggestTag(sender);
    if (!s) return null;
    let label = labelById[s.label_id];
    if (!label || label.type !== 'user') {
      label = userLabels.find((l) => l.name === s.label_name) || null;
    }
    if (!label) return null;
    return { label, sender };
  }, [labelId, q, suggestTag, labelById, userLabels, mailbox]);

  const suggested = useMemo(
    () => threads.map((t) => ({ t, sug: suggestionFor(t) })).filter((x) => x.sug),
    [threads, suggestionFor],
  );

  const acceptSuggestion = useCallback(async (t, sug) => {
    try {
      await gmail.modifyThread(mailbox, t.id, { addLabelIds: [sug.label.id], removeLabelIds: ['INBOX'] });
      recordTagRule(mailbox, sug.sender, sug.label);
      setThreads((prev) => prev.filter((x) => x.id !== t.id));
      setSelected((prev) => { const n = new Set(prev); n.delete(t.id); return n; });
      setThread((prev) => (prev?.id === t.id ? null : prev));
      flash(`Tagged “${sug.label.name}” & archived.`);
    } catch (e) {
      setError(e.message);
    }
  }, [mailbox]);

  const acceptAllSuggestions = useCallback(async () => {
    setSweepBusy(true);
    let done = 0;
    let failed = 0;
    for (const { t, sug } of suggested) {
      try {
        await gmail.modifyThread(mailbox, t.id, { addLabelIds: [sug.label.id], removeLabelIds: ['INBOX'] });
        recordTagRule(mailbox, sug.sender, sug.label);
        setThreads((prev) => prev.filter((x) => x.id !== t.id));
        done++;
      } catch {
        failed++;
      }
    }
    setSweepBusy(false);
    setSelected(new Set());
    flash(`Cleared ${done} conversation${done === 1 ? '' : 's'} as suggested${failed ? ` (${failed} failed)` : ''}.`);
  }, [suggested, mailbox]);

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
  const openThread = useCallback(async (summary) => {
    setThreadLoading(true);
    setError(null);
    try {
      const res = await gmail.getThread(mailbox, summary.id);
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
  const threadInTrash = !!thread && thread.messages.some((m) => m.labelIds.includes('TRASH'));

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

  // Delete = Gmail bin (recoverable ~30 days), never permanent.
  const trashThread = useCallback(async (threadId) => {
    try {
      await gmail.trashThread(mailbox, threadId);
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      setThread(null);
      flash('Moved to bin.', async () => {
        await gmail.untrashThread(mailbox, threadId).catch(() => {});
        loadThreads();
      });
    } catch (e) {
      setError(e.message);
    }
  }, [mailbox, loadThreads]);

  const restoreThread = useCallback(async (threadId) => {
    try {
      await gmail.untrashThread(mailbox, threadId);
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      setThread(null);
      flash('Restored from bin.');
    } catch (e) {
      setError(e.message);
    }
  }, [mailbox]);

  const tagThread = useCallback(async (label) => {
    if (!thread) return;
    try {
      await gmail.modifyThread(mailbox, thread.id, { addLabelIds: [label.id] });
      const sender = thread.messages
        .map((m) => parseAddress(m.from).email.toLowerCase())
        .find((e) => e && e !== mailbox);
      recordTagRule(mailbox, sender, label);
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

  const bulkTrash = useCallback(async () => {
    setBulkBusy(true);
    setError(null);
    const ids = [...selected];
    let failed = 0;
    for (const id of ids) {
      try { await gmail.trashThread(mailbox, id); } catch { failed++; }
    }
    setBulkBusy(false);
    setSelected(new Set());
    flash(`Binned ${ids.length - failed} conversation${ids.length - failed === 1 ? '' : 's'}.`, async () => {
      for (const id of ids) await gmail.untrashThread(mailbox, id).catch(() => {});
      loadThreads();
    });
    loadThreads();
  }, [selected, mailbox, loadThreads]);

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

  const selectLabel = (id) => { setQ(''); setQDraft(''); setLabelId(id); };

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
              <LabelPicker
                labels={userLabels}
                onPick={tagThread}
                onCreate={ensureLabel}
                align="right"
                trigger={<button title="Tag with a label" style={btnIcon}><Tag size={13} /> Tag</button>}
              />
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
              .map((id) => <span key={id} style={chipStyle('accent')}>{labelById[id].name}</span>)}
          </div>
          {composer && renderComposer()}
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

  return (
    <div style={{ display: 'flex', gap: 14, height: '100%', minHeight: 0, fontFamily: font }}>
      {/* ── Left rail ── */}
      <div style={{ width: 212, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto' }}>
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
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: -2, paddingLeft: 2 }}>{mailboxObj?.account_email}</div>

        {/* Mailbox tools — directly under the switcher */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          {(!myPersonal || isAdmin) && (
            <button onClick={() => setAddOpen((o) => !o)} style={{ ...railBtn, border: '1px dashed #94a3b8' }}>
              <Plus size={12} /> Add mailbox
            </button>
          )}
          <a
            href={reconnectUrl}
            onClick={(e) => { if (!window.confirm(`Reconnect ${mailboxObj?.account_email}? You'll be sent to Google to re-approve — sign in as that account. This refreshes the mailbox's permissions.`)) e.preventDefault(); }}
            style={{ ...railBtn, textDecoration: 'none', ...(needsReconnect ? { border: '1px solid #fcd34d', background: '#fffbeb', color: '#92400e' } : {}) }}
          >
            <RefreshCw size={12} /> Reconnect{needsReconnect ? ' ⚠' : ''}
          </a>
          <button onClick={doSyncContacts} disabled={syncBusy} style={railBtn}>
            <BookUser size={12} /> {syncBusy ? 'Syncing…' : 'Contacts'}
          </button>
          <button onClick={openSigEditor} style={railBtn}>
            <PenSquare size={12} /> Signature
          </button>
        </div>
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
          {sort === 'recipient' && (
            <span style={{ color: '#94a3b8' }}>
              {threads.length} loaded{nextPage ? ' — Load more to sort further' : ''}
            </span>
          )}
        </div>

        {/* Auto-suggested tags: eyeball, then one-click clear */}
        {labelId === 'INBOX' && !q && (suggested.length > 0 || learnBusy || tagRules.length === 0) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: '#fefce8', border: '1px solid #fde047', borderRadius: 8, fontSize: 12, flexWrap: 'wrap' }}>
            <Sparkles size={13} color="#a16207" style={{ flexShrink: 0 }} />
            {learnBusy ? (
              <span style={{ color: '#a16207' }}>Learning from this mailbox&apos;s labelled history…</span>
            ) : suggested.length > 0 ? (
              <>
                <span style={{ fontWeight: 700, color: '#854d0e' }}>
                  {suggested.length} suggested tag{suggested.length === 1 ? '' : 's'}
                </span>
                <button disabled={sweepBusy} onClick={acceptAllSuggestions} style={sweepBtn}>
                  {sweepBusy ? 'Clearing…' : 'Tag + archive all'}
                </button>
              </>
            ) : (
              <span style={{ color: '#a16207' }}>No tag suggestions yet.</span>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: '#eff6ff', border: '1px solid #93c5fd', borderRadius: 8, fontSize: 12, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, color: '#0c4a6e' }}>{selected.size} selected</span>
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
            <button disabled={bulkBusy} onClick={() => bulkModify({ removeLabelIds: ['INBOX'], verb: 'Archived' })} style={bulkBtn}><Archive size={12} /> Archive</button>
            <button disabled={bulkBusy} onClick={() => bulkModify({ removeLabelIds: ['UNREAD'], verb: 'Marked read' })} style={bulkBtn}><MailOpen size={12} /> Read</button>
            <button disabled={bulkBusy} onClick={bulkTrash} style={{ ...bulkBtn, color: '#b91c1c', borderColor: '#fca5a5' }}><Trash2 size={12} /> Delete</button>
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
          {visibleThreads.map((t) => {
            const party = rowParty(t, mailbox, showRecipient);
            const isOpen = thread?.id === t.id;
            const userLabelChips = (t.labelIds || []).filter((id) => labelById[id]?.type === 'user').slice(0, 2);
            const sug = suggestionFor(t);
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
                      {party.own && <Send size={10} color="#94a3b8" style={{ marginRight: 4, verticalAlign: -1 }} title="You sent the latest message" />}
                      {party.name}{t.messageCount > 1 ? ` (${t.messageCount})` : ''}
                    </span>
                    {userLabelChips.map((id) => <span key={id} style={{ ...chipStyle('accent'), flexShrink: 0 }}>{labelById[id].name.split('/').pop()}</span>)}
                    {sug && (
                      <button
                        onClick={(e) => { e.stopPropagation(); acceptSuggestion(t, sug); }}
                        disabled={sweepBusy}
                        title={`Tag “${sug.label.name}” and archive`}
                        style={suggChipBtn}
                      >
                        <Sparkles size={10} /> {sug.label.name.split('/').pop()}
                      </button>
                    )}
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
  border: '1px solid #93c5fd', background: '#fff', borderRadius: 6, cursor: 'pointer',
  fontFamily: font, color: '#0c4a6e',
};

const sweepBtn = {
  display: 'flex', alignItems: 'center', gap: 5, padding: '4px 9px', fontSize: 12, fontWeight: 600,
  border: '1px solid #eab308', background: '#fff', borderRadius: 6, cursor: 'pointer',
  fontFamily: font, color: '#854d0e',
};

// One-click "tag as suggested + archive" chip on an inbox row.
const suggChipBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', fontSize: 10.5, fontWeight: 700,
  color: '#854d0e', background: '#fef9c3', border: '1px dashed #eab308', borderRadius: 999,
  cursor: 'pointer', fontFamily: font, flexShrink: 0, whiteSpace: 'nowrap',
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
