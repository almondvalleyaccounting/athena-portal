import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, ArchiveRestore, BookUser, CalendarPlus, ChevronDown, ChevronRight,
  Forward as ForwardIcon, Inbox as InboxIcon, Layers, Mail, MailOpen, Paperclip,
  PenSquare, Plus, RefreshCw, Reply as ReplyIcon, ReplyAll as ReplyAllIcon,
  Check, Clock, Keyboard, Search, Send, Settings2, Smile, Sparkles, Tag, Trash2, X,
} from 'lucide-react';
import { useAuth } from '../../../shell/AppShell';
import { supabase } from '../../../lib/supabase';
import { chipStyle, tones } from '../../../lib/tokens';
import { decodeEntities } from '../../../lib/decodeEntities';
import {
  buildTagSuggester, startMailboxConnect, downloadAttachment, effectiveSignature, gmail, listMailboxes,
  loadContacts, loadSignatures, loadTagRules, mailboxNeedsReconnect, parseAddress, recordTagRule,
  saveSignature, syncContacts,
} from '../api';
import { BTN } from '../../../lib/buttonStyles';

const font = "'Outfit', sans-serif";

// How many conversations to load per view, and the most comms-gmail will
// summarise in one call (Gmail's own threads.list ceiling).
const PAGE_SIZES = [50, 100, 250, 500];
const SERVER_PAGE = 100;
// Options (the rail's Options button). Per browser, like the other view
// preferences here. Older separate keys are read once as the starting point.
const AUTO_CHECK_MINUTES = [0, 1, 5, 15, 30];
const OPTION_DEFAULTS = {
  markRead: 'open',       // open | delay | never
  afterRemove: 'next',    // next | prev | none — after delete / archive
  confirmDelete: false,
  remoteImages: true,     // false = pictures from the web wait for a click
  includeOriginal: true,  // quote the original on replies / forwards
  autoSignature: true,    // add my signature to new emails and replies
  autoCheckMins: 5,
};
function loadOptions() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('comms_options') || '{}'); } catch { /* defaults */ }
  if (saved.autoCheckMins === undefined && localStorage.getItem('comms_auto') === '0') saved.autoCheckMins = 0;
  return { ...OPTION_DEFAULTS, ...saved };
}

// Pictures from the web, held back until asked for (they can tell the sender
// you opened the email). Attached/inline images (cid:, data:) still show.
function holdRemoteImages(html) {
  let held = 0;
  const out = html.replace(/(<img\b[^>]*?)\ssrc\s*=\s*(["'])(https?:[^"']*)\2/gi, (m, pre, q, url) => {
    held++;
    return `${pre} data-held-src=${q}${url}${q}`;
  });
  return { html: out, held };
}

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
// the portal session.
//
// Sized from the moment the document is parsed, not on iframe `load`: load
// waits for every remote image, so a newsletter sat in a 160px box with its
// own scrollbar for seconds. A ResizeObserver then follows the document as
// images arrive and grow it.
// Links: the sandbox (no scripts, no popups) also blocked every click, so an
// email address or web link in an email did nothing. Clicks are caught here
// instead — a mailto starts a new email in Athena, a web link opens in a new
// tab. The email itself still can't run anything.
function handleEmailLink(e, onMailto) {
  const a = e.target.closest?.('a[href]');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  e.preventDefault();
  if (/^mailto:/i.test(href)) {
    const [addr, query] = href.replace(/^mailto:/i, '').split('?');
    const params = new URLSearchParams(query || '');
    onMailto?.({ to: decodeURIComponent(addr || ''), subject: params.get('subject') || '' });
  } else if (/^https?:/i.test(href)) {
    window.open(href, '_blank', 'noopener,noreferrer');
  }
}

// Plain-text emails: email addresses become clickable (new email to them).
function linkifyEmails(text, onMailto) {
  if (!onMailto) return text;
  const parts = String(text).split(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g);
  return parts.map((p, i) => (i % 2
    ? <a key={i} href={`mailto:${p}`} onClick={(e) => { e.preventDefault(); onMailto({ to: p }); }} style={{ color: tones.info.solid }}>{p}</a>
    : p));
}

function HtmlBody({ html, onMailto }) {
  const mailtoRef = useRef(onMailto);
  mailtoRef.current = onMailto;
  const ref = useRef(null);
  const [height, setHeight] = useState(160);

  const measure = useCallback(() => {
    try {
      const doc = ref.current?.contentDocument;
      if (!doc) return;
      const h = Math.max(doc.body?.scrollHeight || 0, doc.documentElement?.scrollHeight || 0);
      // Exact height, no padding: a body sized to the frame then measures the
      // same as the frame and the observer settles, instead of growing it
      // step by step. The CSS above stops emails sizing themselves to the
      // window in the first place.
      if (h > 0) setHeight((prev) => (Math.abs(prev - h) > 2 ? Math.min(h, 12000) : prev));
    } catch { /* leave as-is */ }
  }, []);

  useEffect(() => {
    let observer = null;
    let raf = 0;
    let tries = 0;
    const attach = () => {
      try {
        const doc = ref.current?.contentDocument;
        const RO = doc?.defaultView?.ResizeObserver;
        // The initial about:blank is "complete" before srcdoc replaces it.
        if (doc?.URL === 'about:srcdoc' && doc.body && doc.readyState !== 'loading' && RO) {
          measure();
          observer = new RO(measure);
          observer.observe(doc.body);
          doc.addEventListener('click', (e) => handleEmailLink(e, mailtoRef.current));
          return;
        }
      } catch { /* sandbox quirks — onLoad still measures */ }
      if (tries++ < 120) raf = requestAnimationFrame(attach);
    };
    raf = requestAnimationFrame(attach);
    return () => { cancelAnimationFrame(raf); observer?.disconnect(); };
  }, [html, measure]);

  const srcDoc = `<!doctype html><html><head><base target="_blank"><style>html,body{height:auto!important;min-height:0!important}body{font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;margin:8px;word-break:break-word}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`;
  return (
    <iframe
      ref={ref}
      title="email body"
      sandbox="allow-same-origin"
      srcDoc={srcDoc}
      onLoad={measure}
      style={{ width: '100%', height, border: 'none', background: '#fff' }}
    />
  );
}

function MessageCard({ msg, mailbox, defaultOpen, remoteImages = true, onMailto }) {
  const [open, setOpen] = useState(defaultOpen);
  const [showImages, setShowImages] = useState(false);
  const held = useMemo(
    () => (msg.bodyHtml && !remoteImages && !showImages ? holdRemoteImages(msg.bodyHtml) : null),
    [msg.bodyHtml, remoteImages, showImages],
  );
  const from = parseAddress(msg.from);
  return (
    // flexShrink 0: the pane is a flex column, and overflow:hidden lets a flex
    // item shrink below its content — the card was squeezed to the pane's
    // height and cut the email off, leaving nothing to scroll.
    <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff', overflow: 'hidden', flexShrink: 0 }}>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '10px 14px', cursor: 'pointer', background: open ? '#fff' : '#f8fafc' }}
      >
        <span style={{ fontWeight: 600, fontSize: 14, color: '#0f172a', whiteSpace: 'nowrap' }}>{from.name}</span>
        {open && <span style={{ fontSize: 12, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>to {msg.to}{msg.cc ? `, cc ${msg.cc}` : ''}</span>}
        {!open && <span style={{ fontSize: 13, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{decodeEntities(msg.snippet)}</span>}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#94a3b8', whiteSpace: 'nowrap' }}>{fmtDate(msg.internalDate)}</span>
      </div>
      {open && (
        <div style={{ borderTop: '1px solid #f1f5f9' }}>
          {held?.held > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 14px', fontSize: 12.5, color: '#64748b', background: '#f8fafc', borderBottom: '1px solid #f1f5f9' }}>
              Pictures from the web are hidden.
              <button onClick={() => setShowImages(true)} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: tones.info.solid, fontSize: 12.5, fontWeight: 600, fontFamily: font }}>
                Show pictures
              </button>
            </div>
          )}
          {msg.bodyHtml
            ? <HtmlBody html={held ? held.html : msg.bodyHtml} onMailto={onMailto} />
            : <div style={{ padding: 14, fontSize: 14, color: '#1e293b', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{linkifyEmails(msg.bodyText || decodeEntities(msg.snippet), onMailto)}</div>}
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
                  style={{ ...BTN.secondary.sm, display: 'flex', alignItems: 'center', gap: 6 }}
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
        style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', fontSize: 14, fontFamily: font, border: '1px solid #e2e8f0', borderRadius: 7 }}
      />
      {suggestions.length > 0 && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, background: '#fff', border: '1px solid #cbd5e1', borderRadius: 8, boxShadow: '0 8px 24px rgba(15,23,42,.12)', overflow: 'hidden' }}>
          {suggestions.map((s) => (
            <div
              key={s.email}
              onMouseDown={(e) => { e.preventDefault(); pick(s.email); }}
              style={{ padding: '7px 10px', cursor: 'pointer', fontSize: 13.5, display: 'flex', gap: 8, alignItems: 'baseline' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#eff6ff'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = '#fff'; }}
            >
              <span style={{ fontWeight: 600, color: '#0f172a' }}>{s.name || s.email}</span>
              <span style={{ color: '#64748b' }}>{s.email}</span>
              {s.org && <span style={{ color: '#94a3b8', fontSize: 12 }}>{s.org}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// "Inside which label?" — searchable, for nesting a new or moved label.
// value = the parent's full name ('' = top level). Matches anywhere in the
// path, so "ltd" finds "INBOX/Clients - Ltd".
function ParentPicker({ labels, value, onChange, maxHeight = 180 }) {
  const [term, setTerm] = useState('');
  const t = term.trim().toLowerCase();
  const matches = [...labels]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((l) => !t || l.name.toLowerCase().includes(t));
  const row = (on) => ({
    padding: '5px 8px', fontSize: 13, cursor: 'pointer', borderRadius: 6,
    background: on ? tones.info.bg : 'transparent', color: on ? tones.info.fg : '#334155',
    fontWeight: on ? 700 : 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <input
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation(); // don't trigger the outer picker's Enter/Escape
          if (e.key === 'Enter' && matches.length) { e.preventDefault(); onChange(matches[0].name); setTerm(''); }
        }}
        placeholder={value ? `Inside: ${value.split('/').join(' › ')} — type to change` : 'Search for the parent label…'}
        style={{ padding: '5px 8px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', outline: 'none' }}
      />
      <div style={{ maxHeight, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff', padding: 2 }}>
        <div onClick={() => { onChange(''); setTerm(''); }} style={row(!value)}>— top level —</div>
        {matches.map((l) => (
          <div key={l.id} onClick={() => { onChange(l.name); setTerm(''); }} style={row(value === l.name)} title={l.name}>
            {l.name.split('/').join(' › ')}
          </div>
        ))}
        {!matches.length && <div style={{ padding: '5px 8px', fontSize: 12.5, color: '#94a3b8' }}>No label matches “{term.trim()}”.</div>}
      </div>
    </div>
  );
}

// Searchable label picker with create ("Tax/VAT" nests) — used for the
// bulk Tag+archive and the single-thread Tag action.
function LabelPicker({ labels, onPick, onCreate, trigger, align = 'left', onOpenChange }) {
  const [open, setOpen] = useState(false);
  // Lets a hover-only toolbar stay up while its picker is open.
  // Only on a real open/close (the callback is a fresh arrow every render, and
  // 500 rows re-firing it on each render would be wasted work).
  const openChangeRef = useRef(onOpenChange);
  openChangeRef.current = onOpenChange;
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    openChangeRef.current?.(open);
  }, [open]);
  const [term, setTerm] = useState('');
  const [busy, setBusy] = useState(false);
  const [parent, setParent] = useState(''); // full name of the label to create inside
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
      const label = await onCreate(parent ? `${parent}/${term.trim()}` : term.trim());
      if (label) await pick(label);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <span onClick={() => setOpen((o) => !o)}>{trigger}</span>
      {open && (
        <div style={{ position: 'absolute', top: '100%', [align]: 0, marginTop: 4, zIndex: 40, width: 380, maxWidth: '80vw', background: '#fff', border: '1px solid #cbd5e1', borderRadius: 10, boxShadow: '0 10px 30px rgba(15,23,42,.15)', overflow: 'hidden', fontFamily: font }}>
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
            placeholder="Search labels, or type a new one"
            style={{ width: '100%', boxSizing: 'border-box', padding: '9px 11px', fontSize: 13.5, fontFamily: font, border: 'none', borderBottom: '1px solid #e2e8f0', outline: 'none' }}
          />
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {filtered.map((l) => {
              const parts = l.name.split('/');
              const seg = parts.pop();
              return (
                <div
                  key={l.id}
                  onClick={() => pick(l)}
                  style={{ padding: `6px 10px 6px ${10 + parts.length * 14}px`, fontSize: 13.5, cursor: 'pointer', display: 'flex', alignItems: 'baseline', gap: 6 }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = '#eff6ff'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = '#fff'; }}
                >
                  <Tag size={11} color="#94a3b8" style={{ flexShrink: 0 }} />
                  <span style={{ fontWeight: 600, color: '#0f172a', whiteSpace: 'nowrap', flexShrink: 0 }}>{seg}</span>
                  {parts.length > 0 && <span style={{ fontSize: 11.5, color: '#94a3b8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{parts.join(' / ')}</span>}
                </div>
              );
            })}
            {filtered.length === 0 && !term.trim() && (
              <div style={{ padding: 12, fontSize: 13, color: '#94a3b8' }}>No labels yet — type to create one.</div>
            )}
          </div>
          {term.trim() && !exact && (
            <div style={{ borderTop: '1px solid #e2e8f0', background: '#f8fafc', padding: '8px 11px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {/* Nest the new tag under an existing one (Gmail stores it as Parent/Child). */}
              <div style={{ fontSize: 12.5, color: '#64748b' }}>Inside</div>
              <ParentPicker labels={sorted} value={parent} onChange={setParent} maxHeight={150} />
              <button
                onClick={create}
                disabled={busy}
                style={{ padding: '5px 0', fontSize: 13.5, fontWeight: 600, color: '#0e7fe0', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: font }}
              >
                {busy ? 'Creating…' : `+ Create “${term.trim()}”${parent ? ` in ${parent.split('/').pop()}` : ''}`}
              </button>
            </div>
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

// The original email on a reply/forward. Kept OUT of the box you type in —
// pasting it there as "> " lines is what put the chevrons on screen — and
// attached at send time as a real quote, the way Gmail does it.
function originalOf(msg, kind, include = true) {
  const from = parseAddress(msg.from);
  const when = msg.internalDate ? new Date(msg.internalDate).toLocaleString('en-GB') : msg.date;
  const header = kind === 'forward'
    ? `---------- Forwarded message ---------\nFrom: ${msg.from}\nDate: ${msg.date}\nSubject: ${msg.subject}\nTo: ${msg.to}`
    : `On ${when}, ${from.name} <${from.email}> wrote:`;
  return {
    kind, header, include,
    fromName: from.name, when: msg.internalDate,
    text: msg.bodyText || decodeEntities(msg.snippet),
    html: msg.bodyHtml || '',
  };
}

const escHtml = (t) => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// What actually goes out: your text, then the original. The plain-text part
// keeps "> " quoting (that's the convention there and nobody sees it in a
// normal mail client); the HTML part uses a blockquote.
function composeBodies(c) {
  const text = c.body || '';
  const q = c.quote;
  if (!q || q.include === false) return { bodyText: text };
  const bodyText = q.kind === 'forward'
    ? `${text}\n\n${q.header}\n\n${q.text}`
    : `${text}\n\n${q.header}\n${q.text.split('\n').map((l) => `> ${l}`).join('\n')}`;
  const mine = `<div>${escHtml(text).replace(/\r?\n/g, '<br>')}</div>`;
  const original = q.html || `<div style="white-space:pre-wrap">${escHtml(q.text)}</div>`;
  const head = escHtml(q.header).replace(/\n/g, '<br>');
  const bodyHtml = q.kind === 'forward'
    ? `${mine}<br><div class="gmail_quote">${head}<br><br>${original}</div>`
    : `${mine}<br><div class="gmail_quote"><div>${head}</div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${original}</blockquote></div>`;
  return { bodyText, bodyHtml };
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
  // fromSelf comes from the server, which also knows the mailbox's aliases.
  const own = t.fromSelf ?? last.email.toLowerCase() === mailbox;
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

// Drag handle between two columns. While dragging, a full-screen layer takes
// the mouse: otherwise the cursor crossing an email's iframe swallows the
// mousemove/mouseup and the drag sticks. Double-click resets the width.
function Splitter({ width, onChange, min, max, onReset }) {
  const [drag, setDrag] = useState(null); // { x, w }
  const [hover, setHover] = useState(false);
  const move = (e) => onChange(Math.max(min, Math.min(max, drag.w + e.clientX - drag.x)));
  return (
    <>
      <div
        // Start from the column's rendered width — flex may have shrunk it.
        onMouseDown={(e) => {
          e.preventDefault();
          const shown = e.currentTarget.previousElementSibling?.getBoundingClientRect().width;
          setDrag({ x: e.clientX, w: Math.round(shown || width) });
        }}
        onDoubleClick={onReset}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title="Drag to resize · double-click to reset"
        style={{ flex: '0 0 9px', cursor: 'col-resize', display: 'flex', justifyContent: 'center', alignSelf: 'stretch' }}
      >
        <div style={{ width: 2, borderRadius: 2, background: drag || hover ? tones.info.solid : 'transparent', transition: 'background .12s' }} />
      </div>
      {drag && (
        <div
          onMouseMove={move}
          onMouseUp={() => setDrag(null)}
          onMouseLeave={() => setDrag(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 200, cursor: 'col-resize' }}
        />
      )}
    </>
  );
}

const RAIL_W = 212;
const LIST_W = 560;
const readWidth = (key, fallback) => {
  try { return Number(localStorage.getItem(key)) || fallback; } catch { return fallback; }
};

// Send later: when it's on, every email you write waits until this time.
// Per browser, like the other view preferences. A time that has passed
// counts as off (and says so) — a stale setting must never hold mail back
// silently or, worse, send something written at 2am the moment you look.
function loadSendLater() {
  try {
    const v = JSON.parse(localStorage.getItem('comms_send_later') || 'null');
    return v && typeof v.at === 'string' ? { on: !!v.on, at: v.at } : { on: false, at: '' };
  } catch { return { on: false, at: '' }; }
}
// <input type="datetime-local"> wants local "YYYY-MM-DDTHH:MM".
const toLocalInput = (d) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
// Next working morning at 08:00 (tomorrow, or Monday from Fri/Sat).
function nextMorning(hour = 8) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d;
}
const fmtWhen = (iso) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// A composer holds typing once anything differs from how it was opened
// (signature, quoted original) — only then is it worth keeping or confirming.
const withStart = (c) => ({ ...c, start: { to: c.to, cc: c.cc, subject: c.subject, body: c.body } });
function composerDirty(c) {
  if (!c) return false;
  const s = c.start || {};
  return ['to', 'cc', 'subject', 'body'].some((k) => (c[k] || '') !== (s[k] || ''));
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
  const [options, setOptions] = useState(loadOptions);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [moveLabel, setMoveLabel] = useState(null);
  const [labelSearch, setLabelSearch] = useState('');
  const [pickerRow, setPickerRow] = useState(null); // row whose Tag picker is open // { label, leaf, parent, busy }
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useEffect(() => {
    try { localStorage.setItem('comms_options', JSON.stringify(options)); } catch { /* cosmetic */ }
  }, [options]);
  const setOption = (k, v) => setOptions((o) => ({ ...o, [k]: v }));
  const autoRefresh = options.autoCheckMins > 0;
  const [lastChecked, setLastChecked] = useState(null);
  const [sort, setSort] = useState(() => localStorage.getItem('comms_email_sort') || 'date');
  const [hideOwn, setHideOwn] = useState(() => localStorage.getItem('comms_hide_own') !== '0');
  const [pageSize, setPageSize] = useState(
    () => PAGE_SIZES.find((n) => n === Number(localStorage.getItem('comms_page_size'))) || 50,
  );
  const loadGen = useRef(0);
  const [thread, setThread] = useState(null);
  const [threadLoading, setThreadLoading] = useState(false);
  // An unsent draft is kept as you type and comes back after a reload of this
  // tab. Per TAB (sessionStorage), not per browser: a shared copy was picked
  // up by a second Athena tab, and discarding there deleted the first tab's.
  // Cleared on send or discard.
  const [composer, setComposer] = useState(() => {
    try {
      const own = sessionStorage.getItem('comms_draft');
      if (own) return JSON.parse(own);
      // One-off hand-over from the old browser-wide copy, so a draft written
      // before this change still comes back; then it's gone from the shared spot.
      const legacy = localStorage.getItem('comms_draft');
      localStorage.removeItem('comms_draft');
      return legacy ? JSON.parse(legacy) : null;
    } catch { return null; }
  });
  const [sending, setSending] = useState(false);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [sendLater, setSendLaterState] = useState(loadSendLater);
  const [sendLaterOpen, setSendLaterOpen] = useState(false);
  const [slDraft, setSlDraft] = useState({ date: '', time: '08:00' }); // the dialog's working copy
  const setSendLater = (v) => {
    setSendLaterState(v);
    try { localStorage.setItem('comms_send_later', JSON.stringify(v)); } catch { /* cosmetic */ }
  };
  // Re-evaluated each render: the mode lapses by itself once the time passes.
  const sendLaterActive = sendLater.on && !!sendLater.at && new Date(sendLater.at).getTime() > Date.now() + 60_000;
  const sendLaterLapsed = sendLater.on && !!sendLater.at && !sendLaterActive;
  const [sendWarn, setSendWarn] = useState(null);   // { warnings, retry }
  const [pendingSend, setPendingSend] = useState(null); // { id, mailbox, until, draft, reopen }
  const [scheduled, setScheduled] = useState([]);   // my queued 'later' + recent failures
  const [scheduledOpen, setScheduledOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
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
  // Tagging mode: suggestions only appear when asked for. Off, the inbox is
  // just mail. On, every row gets a tag line and the list can be filtered
  // down to one suggested tag to eyeball and approve as a batch.
  const [taggingMode, setTaggingMode] = useState(false);
  const [tagFilter, setTagFilter] = useState('all'); // all | suggested | none | <labelId>
  const [expanded, setExpanded] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('comms_labels_expanded') || '[]')); }
    catch { return new Set(); }
  });
  const paneRef = useRef(null);
  const [railW, setRailW] = useState(() => readWidth('comms_rail_w', RAIL_W));
  const [listW, setListW] = useState(() => readWidth('comms_list_w', LIST_W));
  useEffect(() => { try { localStorage.setItem('comms_rail_w', String(railW)); } catch { /* cosmetic */ } }, [railW]);
  useEffect(() => { try { localStorage.setItem('comms_list_w', String(listW)); } catch { /* cosmetic */ } }, [listW]);

  const isAll = mailbox === ALL_MAILBOXES;
  const mailboxObj = useMemo(
    () => (mailboxes || []).find((m) => m.account_email === mailbox) || null,
    [mailboxes, mailbox],
  );
  // Mailboxes the list is currently reading from, and a short label per address
  // for the per-row chip in merged mode.
  //
  // Both are keyed on their CONTENT, not on the mailboxes array: that array is
  // rebuilt whenever the list is re-read, and a new array with the same
  // addresses used to re-run the whole inbox load — closing the open email
  // and any reply half-written in it.
  const activeKey = isAll ? (mailboxes || []).map((m) => m.account_email).join('|') : mailbox;
  const activeMailboxes = useMemo(() => (activeKey ? activeKey.split('|') : []), [activeKey]);
  const labelKey = JSON.stringify((mailboxes || []).map((m) => [m.account_email, m.display_name || m.account_email.split('@')[0]]));
  const mailboxLabel = useMemo(() => Object.fromEntries(JSON.parse(labelKey)), [labelKey]);
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
  // Keyed on who you are, not the profile object: AppShell re-reads the
  // profile on every sign-in token refresh (about hourly, and when you come
  // back to the tab), and that new object used to reload this whole screen.
  const profileId = profile?.id;
  const profileIsAdmin = !!profile?.is_portal_admin;
  const loadMailboxes = useCallback(async () => {
    try {
      const rows = await listMailboxes({ id: profileId, is_portal_admin: profileIsAdmin });
      setMailboxes(rows);
      const stored = localStorage.getItem('comms_mailbox');
      if (stored === ALL_MAILBOXES && rows.length > 1) { setMailbox(ALL_MAILBOXES); return; }
      const preferred =
        rows.find((m) => m.account_email === stored) ||
        rows.find((m) => m.kind === 'personal' && m.owner_staff_id === profileId) ||
        rows[0];
      if (preferred) setMailbox(preferred.account_email);
    } catch (e) {
      setError(`Could not load mailboxes: ${e.message}`);
      setMailboxes([]);
    }
  }, [profileId, profileIsAdmin]);

  useEffect(() => {
    if (!profileId) return;
    loadMailboxes();
    loadContacts().then(setContacts).catch(() => {});
    loadSignatures(profileId).then(setSignatures).catch(() => {});
  }, [profileId, loadMailboxes]);
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
    if (labelId === 'INBOX' && hideOwn) return { ...folder, q: '-from:me', excludeOwn: true };
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
          const res = await gmail.listMessages(mb, {
            ...listQuery,
            pageToken: token,
            maxResults: Math.min(SERVER_PAGE, perBox - added),
          });
          if (gen !== loadGen.current) return; // superseded — drop these rows
          const rows = (res.messages || []).map((t) => ({ ...t, mailbox: mb }));
          setThreads((prev) => [...prev, ...rows]);
          token = res.nextPageToken || null;
          tokensRef.current = { ...tokensRef.current, [mb]: token };
          setPageTokens(tokensRef.current);
          added += rows.length;
          missed += res.missed || 0;
          if (!(res.scanned ?? rows.length)) break; // a token with nothing behind it
        } while (token && added < perBox);
      } catch (e) {
        if (e.code !== 'no_gmail_connection') {
          failure = activeMailboxes.length > 1 ? `${mailboxLabel[mb] || mb}: ${e.message}` : e.message;
        }
      }
    }));
    if (gen !== loadGen.current) return;
    if (failure) setError(failure);
    if (missed) flash(`${missed} email${missed === 1 ? '' : 's'} couldn't be loaded — refresh to retry.`);
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
        const res = await gmail.listMessages(mb, { ...listQuery, maxResults: 50 });
        if (gen !== loadGen.current) return;
        incoming.push(...(res.messages || []).map((t) => ({ ...t, mailbox: mb })));
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
    }, options.autoCheckMins * 60 * 1000);
    return () => clearInterval(id);
  }, [autoRefresh, options.autoCheckMins, checkForMail]);

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

  // Switching mailbox closes what's open. Not on first load — that would throw
  // away a draft restored from the last visit.
  const prevMailbox = useRef(mailbox);
  useEffect(() => {
    if (prevMailbox.current && prevMailbox.current !== mailbox) {
      setThread(null); setPending(null); setComposer(null);
    }
    prevMailbox.current = mailbox;
    loadLabels();
  }, [mailbox, loadLabels]);
  useEffect(() => { setThread(null); setPending(null); loadThreads(); }, [loadThreads]);

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
    if (!taggingMode || isAll || labelId !== 'INBOX' || q) return null;
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
      .filter(Boolean)
      // Already on the email: nothing to suggest (it showed the same tag twice).
      .filter((l) => !(t.labelIds || []).includes(l.id));
    if (!labelsFor.length) return null;
    return { labels: labelsFor, sender };
  }, [taggingMode, isAll, labelId, q, suggestTag, labelById, userLabels, mailbox, ownDomain]);

  const sugById = useMemo(() => {
    const m = new Map();
    for (const t of threads) {
      const sug = suggestionFor(t);
      if (sug) m.set(t.id, sug);
    }
    return m;
  }, [threads, suggestionFor]);

  // Suggested tags with how many inbox emails each is offered for — the
  // tagging-mode filter list.
  const suggestedLabelCounts = useMemo(() => {
    const m = new Map();
    for (const sug of sugById.values()) {
      for (const l of sug.labels) m.set(l.id, { label: l, n: (m.get(l.id)?.n || 0) + 1 });
    }
    return [...m.values()].sort((a, b) => b.n - a.n || a.label.name.localeCompare(b.label.name));
  }, [sugById]);

  const tagFilterOn = taggingMode && !isAll && labelId === 'INBOX' && !q;
  const listThreads = useMemo(() => {
    if (!tagFilterOn || tagFilter === 'all') return visibleThreads;
    if (tagFilter === 'suggested') return visibleThreads.filter((t) => sugById.has(t.id));
    if (tagFilter === 'none') return visibleThreads.filter((t) => !sugById.has(t.id));
    return visibleThreads.filter((t) => sugById.get(t.id)?.labels.some((l) => l.id === tagFilter));
  }, [tagFilterOn, tagFilter, visibleThreads, sugById]);

  // The list as shown, and the open email, for the keyboard and for
  // "open the next one" after a delete — read through refs so they're current
  // inside handlers made before the latest render.
  const listRef = useRef([]);
  listRef.current = listThreads;
  const openIdRef = useRef(null);
  const openThreadRef = useRef(null);
  // When the open email leaves the list, open its neighbour (below, else above)
  // rather than leaving the pane empty. Call BEFORE removing it from the list.
  const advanceFrom = (id) => {
    if (openIdRef.current !== id) return; // something else was open — leave it
    const l = listRef.current;
    const i = l.findIndex((x) => x.id === id);
    const way = optionsRef.current.afterRemove;
    const next = i < 0 || way === 'none' ? null
      : way === 'prev' ? (l[i - 1] || l[i + 1] || null)
        : (l[i + 1] || l[i - 1] || null);
    if (next) openThreadRef.current?.(next);
    else setThread(null);
  };

  // "Approve" acts on what's on screen, so a filter is also the scope.
  const suggested = useMemo(
    () => listThreads.filter((t) => sugById.has(t.id)).map((t) => ({ t, sug: sugById.get(t.id) })),
    [listThreads, sugById],
  );

  // A filter on a tag that's just been cleared falls back to the rest.
  useEffect(() => {
    if (!['all', 'suggested', 'none'].includes(tagFilter)
      && !suggestedLabelCounts.some((c) => c.label.id === tagFilter)) setTagFilter('all');
  }, [tagFilter, suggestedLabelCounts]);

  // Applies the whole suggested set in one modify, then archives.
  const applySuggestion = useCallback(async (t, sug, { advance = true } = {}) => {
    await gmail.modifyMessage(t.mailbox, t.id, {
      addLabelIds: sug.labels.map((l) => l.id),
      removeLabelIds: ['INBOX'],
    });
    for (const l of sug.labels) recordTagRule(t.mailbox, sug.sender, l);
    threadCache.current.delete(`${t.mailbox}:${t.id}`);
    // A batch approve closes the pane instead — stepping through would open,
    // and mark read, every email in the batch.
    if (advance) advanceFrom(t.id);
    else setThread((prev) => (prev?.id === t.id ? null : prev));
    setThreads((prev) => prev.filter((x) => x.id !== t.id));
    setSelected((prev) => { const n = new Set(prev); n.delete(t.id); return n; });
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
        await applySuggestion(t, sug, { advance: false });
        done++;
      } catch {
        failed++;
      }
    }
    setSweepBusy(false);
    setSelected(new Set());
    flash(`Cleared ${done} email${done === 1 ? '' : 's'} as suggested${failed ? ` (${failed} failed)` : ''}.`);
  }, [suggested, applySuggestion]);

  // "This suggestion is wrong": stored server-side so neither this inbox nor a
  // re-learn offers sender→label again. Applied locally at once — by flagging
  // the rule already loaded, not adding a second copy beside it (the live
  // copy kept the suggestion on screen, so × looked like it did nothing).
  const rejectSuggested = useCallback(async (sender, label, { quiet = false } = {}) => {
    setTagRules((prev) => {
      let hit = false;
      const next = prev.map((r) => {
        if (r.sender_email !== sender || r.label_id !== label.id) return r;
        hit = true;
        return { ...r, rejected: true };
      });
      return hit ? next : [...next, { sender_email: sender, label_id: label.id, label_name: label.name, rejected: true, times_used: 0 }];
    });
    try {
      await gmail.rejectTag(mailbox, sender, label);
      if (!quiet) flash(`Won't suggest “${label.name.split('/').pop()}” for ${sender} again.`);
    } catch (e) {
      setError(`Couldn't save that correction: ${e.message}`);
    }
  }, [mailbox]);

  // Tag a row with a label of your choosing (the fix for a wrong suggestion,
  // or a tag for an email with none) and archive it. Any suggested label you
  // passed over is marked wrong for this sender.
  const tagRowAs = useCallback(async (t, label, sug) => {
    try {
      await gmail.modifyMessage(t.mailbox, t.id, { addLabelIds: [label.id], removeLabelIds: ['INBOX'] });
      const sender = sug?.sender || parseAddress(t.counterpartFrom || t.from).email.toLowerCase();
      if (sender && sender !== mailbox) recordTagRule(t.mailbox, sender, label);
      for (const l of sug?.labels || []) if (l.id !== label.id) rejectSuggested(sug.sender, l);
      threadCache.current.delete(`${t.mailbox}:${t.id}`);
      advanceFrom(t.id);
      setThreads((prev) => prev.filter((x) => x.id !== t.id));
      flash(`Tagged “${label.name}” & archived.`);
    } catch (e) {
      setError(e.message);
    }
  }, [mailbox, rejectSuggested]);

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
  //
  // Speed: the pane used to show the PREVIOUS email until the new one arrived
  // (a full round trip through comms-gmail to Gmail), so a click felt dead.
  // Now the row's own summary paints the header at once, full threads are
  // cached for the session, and hovering a row fetches it ahead of the click.
  const composerRef = useRef(composer);
  useEffect(() => {
    composerRef.current = composer;
    try {
      if (composerDirty(composer)) sessionStorage.setItem('comms_draft', JSON.stringify(composer));
      else sessionStorage.removeItem('comms_draft');
    } catch { /* storage full or blocked — the draft still lives on screen */ }
  }, [composer]);
  // Anything that would close the composer asks first when it holds typing.
  const okToDiscard = () => !composerDirty(composerRef.current)
    || window.confirm('Discard your unsent email?');

  const threadCache = useRef(new Map()); // `${mailbox}:${id}` → thread
  const inflight = useRef(new Map());    // same key → promise
  const openGen = useRef(0);
  const [pending, setPending] = useState(null); // summary being opened

  const fetchThread = useCallback((mb, id) => {
    const key = `${mb}:${id}`;
    if (inflight.current.has(key)) return inflight.current.get(key);
    // One email, not its conversation: Gmail threads by subject as well as by
    // reply, so the thread could open on a different email from the row.
    const p = gmail.getMessage(mb, id).then((res) => {
      const full = { id: res.message.id, threadId: res.message.threadId, messages: [res.message], mailbox: mb };
      threadCache.current.set(key, full);
      return full;
    }).finally(() => inflight.current.delete(key));
    inflight.current.set(key, p);
    return p;
  }, []);

  const prefetchThread = useCallback((summary) => {
    const mb = summary.mailbox || mailbox;
    if (threadCache.current.has(`${mb}:${summary.id}`)) return;
    fetchThread(mb, summary.id).catch(() => { /* a click will retry and report */ });
  }, [mailbox, fetchThread]);

  const openThread = useCallback(async (summary) => {
    if (!okToDiscard()) return null;
    const mb = summary.mailbox || mailbox;
    const gen = ++openGen.current;
    setError(null);
    setComposer(null);
    if (paneRef.current) paneRef.current.scrollTop = 0;
    // Options → "Mark as read": at once, after 3 seconds still open, or never
    // (then u / the Mark read button does it).
    const how = optionsRef.current.markRead;
    if (summary.unread && how !== 'never') {
      const markIt = () => gmail.modifyMessage(mb, summary.id, { removeLabelIds: ['UNREAD'] })
        .then(() => {
          setThreads((prev) => prev.map((t) => (t.id === summary.id ? { ...t, unread: false } : t)));
          setThread((prev) => (prev?.id === summary.id ? { ...prev, messages: prev.messages.map((m) => ({ ...m, labelIds: m.labelIds.filter((l) => l !== 'UNREAD') })) } : prev));
        })
        .catch(() => { /* read-state is cosmetic */ });
      if (how === 'delay') setTimeout(() => { if (openIdRef.current === summary.id) markIt(); }, 3000);
      else markIt();
    }
    // New mail on the thread since it was cached → fetch it fresh.
    const cached = threadCache.current.get(`${mb}:${summary.id}`);
    const fresh = cached
      && (!summary.messageCount || cached.messages.length >= summary.messageCount)
      && (cached.messages[0]?.internalDate || 0) >= (summary.internalDate || 0);
    if (fresh) {
      setPending(null);
      setThread(cached);
      return cached;
    }
    setThread(null);
    setPending({ ...summary, mailbox: mb });
    setThreadLoading(true);
    try {
      const opened = await fetchThread(mb, summary.id);
      if (gen !== openGen.current) return opened; // another row was clicked since
      setThread(opened);
      return opened;
    } catch (e) {
      if (gen === openGen.current) setError(e.message);
      return null;
    } finally {
      if (gen === openGen.current) { setPending(null); setThreadLoading(false); }
    }
  }, [mailbox, fetchThread]);

  // A change made to a thread (label, archive…) makes its cached copy stale.
  // Edits to the open thread are written back as they happen; anything that
  // moves a thread out of view just drops it.
  const hoverTimer = useRef(null);
  const forgetThread = (mb, id) => threadCache.current.delete(`${mb}:${id}`);
  useEffect(() => {
    if (thread?.mailbox) threadCache.current.set(`${thread.mailbox}:${thread.id}`, thread);
  }, [thread]);

  const latestMsg = thread?.messages?.[0] || null;
  const threadInTrash = !!thread && thread.messages.some((m) => m.labelIds.includes('TRASH'));
  const threadUnread = !!thread && thread.messages.some((m) => m.labelIds.includes('UNREAD'));
  const threadMailbox = thread?.mailbox || mailbox;

  const archiveThread = useCallback(async (threadId, restore = false) => {
    try {
      await gmail.modifyMessage(threadMailbox, threadId, restore
        ? { addLabelIds: ['INBOX'] }
        : { removeLabelIds: ['INBOX'] });
      forgetThread(threadMailbox, threadId);
      advanceFrom(threadId);
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      flash(restore ? 'Moved back to inbox.' : 'Archived.');
    } catch (e) {
      setError(e.code === 'needs_reconnect'
        ? 'Archiving needs the upgraded Gmail permission — reconnect this mailbox.'
        : e.message);
    }
  }, [threadMailbox]);

  // Delete = Gmail bin (recoverable ~30 days), never permanent.
  const trashThread = useCallback(async (threadId) => {
    if (optionsRef.current.confirmDelete && !window.confirm('Move this email to the bin?')) return;
    try {
      await gmail.trashMessage(threadMailbox, threadId);
      forgetThread(threadMailbox, threadId);
      advanceFrom(threadId);
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      flash('Moved to bin.', async () => {
        await gmail.untrashMessage(threadMailbox, threadId).catch(() => {});
        loadThreads();
      });
    } catch (e) {
      setError(e.message);
    }
  }, [threadMailbox, loadThreads]);

  const restoreThread = useCallback(async (threadId) => {
    try {
      await gmail.untrashMessage(threadMailbox, threadId);
      forgetThread(threadMailbox, threadId);
      advanceFrom(threadId);
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      flash('Restored from bin.');
    } catch (e) {
      setError(e.message);
    }
  }, [threadMailbox]);

  // Tagging an email in the Inbox files it: tag + archive, like Tagging mode
  // — a tagged email is dealt with and shouldn't sit in the Inbox. Elsewhere
  // (Sent, a label, All mail) it just adds the tag.
  const tagThread = useCallback(async (label) => {
    if (!thread) return;
    const fileIt = labelId === 'INBOX' && thread.messages.some((m) => m.labelIds.includes('INBOX'));
    try {
      await gmail.modifyMessage(threadMailbox, thread.id, fileIt
        ? { addLabelIds: [label.id], removeLabelIds: ['INBOX'] }
        : { addLabelIds: [label.id] });
      const sender = thread.messages
        .map((m) => parseAddress(m.from).email.toLowerCase())
        .find((e) => e && e !== threadMailbox);
      recordTagRule(threadMailbox, sender, label);
      if (fileIt) {
        forgetThread(threadMailbox, thread.id);
        advanceFrom(thread.id);
        setThreads((prev) => prev.filter((t) => t.id !== thread.id));
        flash(`Tagged “${label.name}” & archived.`);
        return;
      }
      setThread((prev) => (prev ? {
        ...prev,
        messages: prev.messages.map((m) => ({ ...m, labelIds: [...new Set([...m.labelIds, label.id])] })),
      } : prev));
      setThreads((prev) => prev.map((t) => (t.id === thread.id ? { ...t, labelIds: [...new Set([...(t.labelIds || []), label.id])] } : t)));
      flash(`Tagged “${label.name}”.`);
    } catch (e) {
      setError(e.message);
    }
  }, [labelId, thread, threadMailbox]);

  // Tag one email from its row (hover → Tag). Same as Tag on the open email,
  // without opening it first.
  const tagRow = useCallback(async (t, label) => {
    const fileIt = labelId === 'INBOX' && (t.labelIds || []).includes('INBOX');
    try {
      await gmail.modifyMessage(t.mailbox, t.id, fileIt
        ? { addLabelIds: [label.id], removeLabelIds: ['INBOX'] }
        : { addLabelIds: [label.id] });
      const sender = parseAddress(t.counterpartFrom || t.from).email.toLowerCase();
      if (sender && sender !== t.mailbox) recordTagRule(t.mailbox, sender, label);
      if (fileIt) {
        forgetThread(t.mailbox, t.id);
        advanceFrom(t.id);
        setThreads((prev) => prev.filter((x) => x.id !== t.id));
        flash(`Tagged “${label.name}” & archived.`);
        return;
      }
      const add = (ids) => [...new Set([...(ids || []), label.id])];
      setThreads((prev) => prev.map((x) => (x.id === t.id ? { ...x, labelIds: add(x.labelIds) } : x)));
      setThread((prev) => (prev?.id === t.id ? { ...prev, messages: prev.messages.map((m) => ({ ...m, labelIds: add(m.labelIds) })) } : prev));
      flash(`Tagged “${label.name}”.`);
    } catch (e) {
      setError(e.message);
    }
  }, [labelId]);

  // Take a tag off the open thread — the fix for a tag applied by mistake.
  // It also stops the inbox suggesting that tag for the people on the thread:
  // removing it is the same "this is wrong" as × on a suggestion.
  const untagThread = useCallback(async (label) => {
    if (!thread) return;
    try {
      await gmail.modifyMessage(threadMailbox, thread.id, { removeLabelIds: [label.id] });
      const ownDomain = threadMailbox.split('@')[1];
      const senders = new Set(thread.messages
        .map((m) => parseAddress(m.from).email.toLowerCase())
        .filter((e) => e && e !== threadMailbox && !(ownDomain && e.endsWith(`@${ownDomain}`))));
      for (const sender of senders) rejectSuggested(sender, label, { quiet: true });
      setThread((prev) => (prev ? {
        ...prev,
        messages: prev.messages.map((m) => ({ ...m, labelIds: m.labelIds.filter((x) => x !== label.id) })),
      } : prev));
      setThreads((prev) => prev.map((t) => (t.id === thread.id ? { ...t, labelIds: (t.labelIds || []).filter((x) => x !== label.id) } : t)));
      flash(`Removed “${label.name}” — it won't be suggested for this sender again.`);
    } catch (e) {
      setError(e.message);
    }
  }, [thread, threadMailbox, rejectSuggested]);

  // Emoji reaction, Gmail-style: a reply to the sender carrying a reaction
  // part. Gmail shows it under their email; other mail apps get the emoji.
  const [reactOpen, setReactOpen] = useState(false);
  const react = useCallback(async (emoji) => {
    setReactOpen(false);
    const msg = thread?.messages?.[0];
    if (!msg) return;
    const subject = msg.subject || '';
    try {
      await gmail.send(threadMailbox, {
        to: parseAddress(msg.from).email,
        subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
        bodyText: emoji,
        bodyHtml: `<p style="font-size:24px">${emoji}</p>`,
        reaction: emoji,
        threadId: thread.threadId,
        inReplyTo: msg.messageIdHeader,
        references: [msg.references, msg.messageIdHeader].filter(Boolean).join(' '),
      });
      flash(`Reacted ${emoji} to ${parseAddress(msg.from).name}.`);
    } catch (e) {
      setError(`Reaction failed: ${e.message}`);
    }
  }, [thread, threadMailbox]);

  // Read ↔ unread on the open email (button, or u).
  const setReadState = useCallback(async (id, unread) => {
    try {
      await gmail.modifyMessage(threadMailbox, id, unread ? { addLabelIds: ['UNREAD'] } : { removeLabelIds: ['UNREAD'] });
      setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, unread } : t)));
      setThread((prev) => (prev?.id === id ? {
        ...prev,
        messages: prev.messages.map((m) => ({ ...m, labelIds: unread ? [...new Set([...m.labelIds, 'UNREAD'])] : m.labelIds.filter((l) => l !== 'UNREAD') })),
      } : prev));
    } catch (e) {
      setError(e.message);
    }
  }, [threadMailbox]);

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
        await gmail.modifyMessage(boxOf(id), id, { addLabelIds, removeLabelIds });
      } catch { failed++; }
    }
    setBulkBusy(false);
    threadCache.current.clear();
    flash(`${verb} ${selected.size - failed} email${selected.size - failed === 1 ? '' : 's'}${failed ? ` (${failed} failed)` : ''}.`);
    // Change the rows in place — read/unread just flips bold — rather than
    // reloading the list. A row that no longer belongs in this folder (archived
    // out of the Inbox, say) drops out.
    const done = new Set(selected);
    setThreads((prev) => prev.flatMap((t) => {
      if (!done.has(t.id)) return [t];
      const ids = new Set(t.labelIds || []);
      addLabelIds.forEach((l) => ids.add(l));
      removeLabelIds.forEach((l) => ids.delete(l));
      if (labelId !== 'ALL' && !q && !ids.has(labelId)) return [];
      return [{ ...t, labelIds: [...ids], unread: ids.has('UNREAD') }];
    }));
    if (thread && done.has(thread.id) && labelId !== 'ALL' && !q && removeLabelIds.includes(labelId)) setThread(null);
    setSelected(new Set());
  }, [selected, boxOf, labelId, q, thread]);

  const bulkTrash = useCallback(async () => {
    if (optionsRef.current.confirmDelete && !window.confirm(`Move ${selected.size} email${selected.size === 1 ? '' : 's'} to the bin?`)) return;
    setBulkBusy(true);
    setError(null);
    const ids = [...selected].map((id) => [id, boxOf(id)]);
    let failed = 0;
    for (const [id, mb] of ids) {
      try { await gmail.trashMessage(mb, id); } catch { failed++; }
    }
    setBulkBusy(false);
    threadCache.current.clear();
    setSelected(new Set());
    const gone = new Set(ids.map(([id]) => id));
    setThreads((prev) => prev.filter((t) => !gone.has(t.id)));
    if (thread && gone.has(thread.id)) setThread(null);
    flash(`Binned ${ids.length - failed} email${ids.length - failed === 1 ? '' : 's'}.`, async () => {
      for (const [id, mb] of ids) await gmail.untrashMessage(mb, id).catch(() => {});
      loadThreads();
    });
  }, [selected, boxOf, loadThreads, thread]);

  // ── Composer ──
  const startComposer = useCallback((mode) => {
    if (!okToDiscard()) return;
    setError(null);
    // Signature belongs to the account the mail actually leaves from.
    const sigBody = optionsRef.current.autoSignature
      ? effectiveSignature(signatures, mode === 'new' ? sendFrom : threadMailbox)
      : '';
    const sig = sigBody ? `\n\n${sigBody}` : '';
    if (mode === 'new') {
      setComposer(withStart({ mode, to: '', cc: '', subject: '', body: `${sig}`, mailbox: sendFrom }));
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
      setComposer(withStart({ mode, to, cc, subject: reSubject, body: sig, quote: originalOf(latestMsg, 'reply', optionsRef.current.includeOriginal), threadId: thread.threadId, inReplyTo: latestMsg.messageIdHeader, references, mailbox: threadMailbox, contextId: latestMsg.id }));
    } else if (mode === 'forward') {
      const fwdSubject = /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`;
      setComposer(withStart({ mode, to: '', cc: '', subject: fwdSubject, body: sig, quote: originalOf(latestMsg, 'forward', optionsRef.current.includeOriginal), mailbox: threadMailbox, contextId: latestMsg.id }));
    }
    if (paneRef.current) paneRef.current.scrollTop = 0;
  }, [latestMsg, thread, threadMailbox, sendFrom, signatures]);

  // A new email to an address clicked in an email body (mailto link). Sent
  // from the mailbox you're reading, with your signature if that's on.
  const composeTo = useCallback(({ to, subject = '' }) => {
    if (!okToDiscard()) return;
    const from = threadMailbox || sendFrom;
    const sigBody = optionsRef.current.autoSignature ? effectiveSignature(signatures, from) : '';
    setComposer(withStart({ mode: 'new', to, cc: '', subject, body: sigBody ? `

${sigBody}` : '', mailbox: from }));
    if (paneRef.current) paneRef.current.scrollTop = 0;
  }, [threadMailbox, sendFrom, signatures]);

  // ── Row actions ──
  // Reply/forward from a list row needs the full latest message (for the quote)
  // and the thread's own mailbox, so it opens the thread first and lets the
  // normal composer run once it's there — one code path for both entry points.
  //
  // It waits for a request rather than for the thread to change: replying from
  // the row of the email ALREADY open left the thread unchanged, the old
  // trigger never fired, and the hover Reply / Reply all did nothing.
  const [composeReq, setComposeReq] = useState(null); // { id, mode }
  useEffect(() => {
    if (!composeReq || thread?.id !== composeReq.id) return;
    setComposeReq(null);
    startComposer(composeReq.mode);
  }, [composeReq, thread, startComposer]);

  const rowCompose = useCallback(async (t, mode) => {
    if (thread?.id === t.id) { startComposer(mode); return; }
    const opened = await openThread(t);
    if (opened) setComposeReq({ id: opened.id, mode });
  }, [openThread, thread, startComposer]);

  const rowTrash = useCallback(async (t) => {
    if (optionsRef.current.confirmDelete && !window.confirm('Move this email to the bin?')) return;
    try {
      await gmail.trashMessage(t.mailbox, t.id);
      forgetThread(t.mailbox, t.id);
      advanceFrom(t.id);
      setThreads((prev) => prev.filter((x) => x.id !== t.id));
      flash('Moved to bin.', async () => {
        await gmail.untrashMessage(t.mailbox, t.id).catch(() => {});
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
        decodeEntities(t.snippet),
        '',
        `From: ${t.from}`,
        `Email: https://mail.google.com/mail/?authuser=${t.mailbox}#all/${t.threadId || t.id}`,
      ].join('\n'),
    });
    if (other.email) params.set('add', other.email);
    window.open(`https://calendar.google.com/calendar/render?${params.toString()}`, '_blank', 'noopener');
  }, []);

  // ── Sending: everything goes through the outbox (sql/364) ──
  // Checked on the server first (too many outside recipients is refused;
  // a cross-client warning needs your go-ahead), then held: 20 seconds to
  // undo, or until the Send later time. This tab sends it at 20s; if the tab
  // closes first, the every-minute outbox job does.
  const refreshScheduled = useCallback(async () => {
    if (!profileId) return;
    const since = new Date(Date.now() - 7 * 86400_000).toISOString();
    const { data } = await supabase
      .from('comms_outbox')
      .select('id, mailbox, subject, to_summary, send_at, kind, status, error, payload, created_at')
      .eq('staff_id', profileId)
      .or(`and(status.eq.queued,kind.eq.later),and(status.eq.failed,created_at.gte.${since})`)
      .order('send_at');
    setScheduled(data || []);
  }, [profileId]);
  useEffect(() => { refreshScheduled(); }, [refreshScheduled]);

  const sendNowFromOutbox = useCallback(async (item) => {
    try {
      await gmail.sendQueued(item.mailbox, item.id);
    } catch (e) {
      setError(`Send failed: ${e.message}`);
    }
  }, []);

  // The 20-second undo window, counted down in the notice bar.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!pendingSend) return undefined;
    const tick = setInterval(() => setTick((n) => n + 1), 1000);
    const fire = setTimeout(async () => {
      const ps = pendingSend;
      setPendingSend(null);
      await sendNowFromOutbox(ps);
      flash('Sent.');
      if (ps.reopen) { forgetThread(ps.reopen.mailbox, ps.reopen.id); openThread({ ...ps.reopen, unread: false }); }
    }, Math.max(0, pendingSend.until - Date.now()));
    return () => { clearInterval(tick); clearTimeout(fire); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSend]);

  const undoSend = useCallback(async () => {
    const ps = pendingSend;
    if (!ps) return;
    setPendingSend(null);
    try {
      await gmail.cancelQueued(ps.mailbox, ps.id);
      setComposer(ps.draft);
      flash('Not sent — back in the composer.');
    } catch (e) {
      setError(e.code === 'already_sent' ? 'Too late — it had already gone.' : e.message);
    }
  }, [pendingSend]);

  const sendComposer = useCallback(async ({ acknowledged = false, warnings = [] } = {}) => {
    if (!composer?.to?.trim() || !composer?.subject?.trim()) { setError('To and subject are required.'); return; }
    // Composer's own choice wins ('now' or a time); otherwise the Send later mode.
    const sendAt = composer.sendAt === 'now' ? null
      : composer.sendAt ? new Date(composer.sendAt).toISOString()
        : sendLaterActive ? new Date(sendLater.at).toISOString() : null;
    if (sendAt && new Date(sendAt).getTime() <= Date.now() + 30_000) {
      setError('That send time has passed — pick a new one or send now.');
      return;
    }
    // A send already counting down goes now, so two never overlap.
    if (pendingSend) { const ps = pendingSend; setPendingSend(null); sendNowFromOutbox(ps); }
    setSending(true);
    setError(null);
    const draft = { ...composer };
    try {
      const res = await gmail.queueSend(composer.mailbox || mailbox, {
        to: composer.to.trim().replace(/,\s*$/, ''),
        cc: composer.cc?.trim().replace(/,\s*$/, '') || undefined,
        subject: composer.subject.trim(),
        ...composeBodies(composer),
        threadId: composer.threadId || undefined,
        inReplyTo: composer.inReplyTo || undefined,
        references: composer.references || undefined,
        mode: composer.mode,
        contextMessageId: composer.contextId || undefined,
        sendAt: sendAt || undefined,
        acknowledged,
        acknowledgedWarnings: warnings,
        draft,
      });
      // Gone from the composer NOW (the ref updates after render, and the
      // reopen below would otherwise ask "Discard your unsent email?").
      composerRef.current = null;
      setComposer(null);
      if (res.kind === 'later') {
        flash(`Scheduled for ${fmtWhen(res.sendAt)}.`);
        refreshScheduled();
      } else {
        const reopen = draft.threadId && thread ? { id: thread.id, mailbox: threadMailbox } : null;
        setPendingSend({ id: res.id, mailbox: draft.mailbox || mailbox, until: Date.now() + 20_000, draft, reopen });
      }
    } catch (e) {
      if (e.code === 'needs_confirmation') {
        setSendWarn({ warnings: e.warnings || [e.message] });
      } else {
        setError(e.code === 'too_many_recipients' ? e.message : `Send failed: ${e.message}`);
      }
    } finally {
      setSending(false);
    }
  }, [composer, mailbox, thread, threadMailbox, sendLater, sendLaterActive, pendingSend, sendNowFromOutbox, refreshScheduled]);

  // Cancel a scheduled email and reopen it as a draft.
  const reopenScheduled = useCallback(async (item) => {
    if (!okToDiscard()) return;
    try {
      if (item.status === 'queued') await gmail.cancelQueued(item.mailbox, item.id);
      const d = item.payload?.draft;
      setComposer(d ? { ...d, sendAt: undefined } : withStart({
        mode: 'new', to: item.payload?.to || '', cc: item.payload?.cc || '', subject: item.payload?.subject || '',
        body: item.payload?.bodyText || '', mailbox: item.mailbox,
      }));
      setScheduledOpen(false);
      refreshScheduled();
    } catch (e) {
      setError(e.code === 'already_sent' ? 'Too late — it has already been sent.' : e.message);
      refreshScheduled();
    }
  }, [refreshScheduled]);

  // ── Keyboard ──
  // Ignored while typing in any box, and with Ctrl/Cmd/Alt held (so browser
  // and app shortcuts like "/" search keep working). Clicking inside an
  // email's body moves focus into it — click the list to get keys back.
  openIdRef.current = thread?.id || null;
  openThreadRef.current = openThread;
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || sigOpen) return;
      const el = e.target;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      const list = listRef.current;
      const i = list.findIndex((x) => x.id === openIdRef.current);
      const go = (t) => { if (t) openThread(t); };
      const inInbox = thread?.messages.some((m) => m.labelIds.includes('INBOX'));
      const run = {
        ArrowDown: () => go(i < 0 ? list[0] : list[i + 1]),
        j: () => go(i < 0 ? list[0] : list[i + 1]),
        ArrowUp: () => go(i < 0 ? list[0] : list[i - 1]),
        k: () => go(i < 0 ? list[0] : list[i - 1]),
        Delete: () => thread && !threadInTrash && trashThread(thread.id),
        '#': () => thread && !threadInTrash && trashThread(thread.id),
        e: () => thread && inInbox && archiveThread(thread.id),
        r: () => thread && startComposer('reply'),
        a: () => thread && startComposer('replyAll'),
        f: () => thread && startComposer('forward'),
        x: () => thread && toggleSelect(thread.id),
        u: () => thread && setReadState(thread.id, !threadUnread),
        Escape: () => { if (keysOpen) setKeysOpen(false); else if (thread && okToDiscard()) { setComposer(null); setThread(null); } },
        '?': () => setKeysOpen((o) => !o),
      }[e.key];
      if (!run) return;
      e.preventDefault();
      run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Keep the open email's row in view as the arrows move through the list.
  useEffect(() => {
    if (!thread?.id) return;
    document.querySelector(`[data-mid="${thread.id}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [thread?.id]);

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
    return <div style={{ padding: 30, color: '#64748b', fontSize: 14 }}>Loading mailboxes…</div>;
  }

  if (!mailboxes.length) {
    return (
      <div style={{ maxWidth: 560, margin: '40px auto', textAlign: 'center', fontFamily: font }}>
        <Mail size={34} color="#94a3b8" style={{ marginBottom: 10 }} />
        <div style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', marginBottom: 6 }}>No mailboxes connected yet</div>
        <div style={{ fontSize: 14, color: '#64748b', marginBottom: 18 }}>
          Connect your own inbox to read, reply, forward and archive from Athena.
          {isAdmin ? ' As an admin you can also connect shared mailboxes like info@ or accounts@ — sign into that Google account when prompted.' : ''}
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <a href="#" onClick={(e) => { e.preventDefault(); connectPersonal(); }} style={{ padding: '9px 18px', fontSize: 14, fontWeight: 600, background: '#0f172a', color: '#fff', borderRadius: 8, textDecoration: 'none' }}>Connect my inbox</a>
          {isAdmin && <a href="#" onClick={(e) => { e.preventDefault(); connectShared(); }} style={{ padding: '9px 18px', fontSize: 14, fontWeight: 600, background: '#fff', color: '#0f172a', border: '1px solid #cbd5e1', borderRadius: 8, textDecoration: 'none' }}>Add a shared mailbox</a>}
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

  // Move / rename a label from the rail (the ✎ on hover).
  const doMoveLabel = async () => {
    const leaf = moveLabel.leaf.trim().replace(/\//g, '-');
    if (!leaf) return;
    const name = moveLabel.parent ? `${moveLabel.parent}/${leaf}` : leaf;
    setMoveLabel((m) => ({ ...m, busy: true }));
    try {
      await gmail.renameLabel(mailbox, moveLabel.label.id, name);
      if (moveLabel.parent) {
        // Open the path down to it so you can see where it went.
        setExpanded((prev) => {
          const next = new Set(prev);
          moveLabel.parent.split('/').reduce((acc, seg) => { const p = acc ? `${acc}/${seg}` : seg; next.add(p); return p; }, '');
          localStorage.setItem('comms_labels_expanded', JSON.stringify([...next]));
          return next;
        });
      }
      setMoveLabel(null);
      await loadLabels();
      refreshTagRules();
      flash(`Moved to “${name.split('/').join(' › ')}”.`);
    } catch (e) {
      setMoveLabel((m) => ({ ...m, busy: false }));
      setError(`Couldn't move the label: ${e.message}`);
    }
  };

  const renderTreeNode = (node, depth) => {
    const isActive = node.label && labelId === node.label.id && !q;
    const hasKids = node.children.length > 0;
    const isOpen = expanded.has(node.full);
    return (
      <React.Fragment key={node.full}>
        <div className="group/lbl" style={{ display: 'flex', alignItems: 'center' }}>
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
              flex: 1, display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', fontSize: 13.5,
              fontWeight: isActive ? 700 : 500,
              background: isActive ? tones.info.bg : 'transparent',
              color: isActive ? tones.info.fg : node.label ? '#475569' : '#94a3b8',
              border: 'none', borderRadius: 7, cursor: 'pointer', textAlign: 'left', fontFamily: font, minWidth: 0,
            }}
          >
            <Tag size={11} style={{ flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.seg}</span>
            {hasKids && <span style={{ fontSize: 11, color: '#cbd5e1', flexShrink: 0 }}>{node.children.length}</span>}
          </button>
          {node.label && (
            <button
              className="invisible group-hover/lbl:visible"
              onClick={() => {
                const parts = node.label.name.split('/');
                const leaf = parts.pop();
                setMoveLabel({ label: node.label, leaf, parent: parts.join('/'), busy: false });
              }}
              title="Move or rename"
              style={{ width: 20, height: 20, padding: 0, border: 'none', background: 'none', cursor: 'pointer', color: '#94a3b8', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <PenSquare size={11} />
            </button>
          )}
        </div>
        {hasKids && isOpen && node.children.map((c) => renderTreeNode(c, depth + 1))}
      </React.Fragment>
    );
  };

  function renderComposer() {
    return (
      // Ctrl+Enter (Cmd+Enter on a Mac) sends from any box in the composer.
      <div
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !sending) { e.preventDefault(); sendComposer(); }
        }}
        style={{ border: '1px solid #94a3b8', borderRadius: 10, background: '#fff', padding: 12, display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>
            {composer.mode === 'new' ? 'New email' : composer.mode === 'forward' ? 'Forward' : composer.mode === 'replyAll' ? 'Reply all' : 'Reply'} — from {mailboxLabel[composer.mailbox] || composer.mailbox || mailbox}
          </span>
          <button onClick={() => { if (okToDiscard()) setComposer(null); }} title="Discard" style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: '#64748b' }}><X size={14} /></button>
        </div>
        <AddressInput value={composer.to} onChange={(v) => setComposer((c) => ({ ...c, to: v }))} contacts={contacts} placeholder="To" />
        <AddressInput value={composer.cc} onChange={(v) => setComposer((c) => ({ ...c, cc: v }))} contacts={contacts} placeholder="Cc (optional)" />
        <input value={composer.subject} onChange={(e) => setComposer((c) => ({ ...c, subject: e.target.value }))} placeholder="Subject"
          style={{ padding: '7px 10px', fontSize: 14, fontFamily: font, border: '1px solid #e2e8f0', borderRadius: 7, fontWeight: 600 }} />
        <textarea value={composer.body} onChange={(e) => setComposer((c) => ({ ...c, body: e.target.value }))} rows={10} autoFocus
          style={{ padding: '8px 10px', fontSize: 14, fontFamily: font, border: '1px solid #e2e8f0', borderRadius: 7, resize: 'vertical', lineHeight: 1.5 }} />
        {composer.quote && (
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 7, background: '#f8fafc', fontSize: 12.5, color: '#64748b' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={composer.quote.include !== false}
                  onChange={(e) => setComposer((c) => ({ ...c, quote: { ...c.quote, include: e.target.checked } }))}
                />
                {composer.quote.kind === 'forward' ? 'Forwarded email' : 'Original email'} from {composer.quote.fromName}
                {composer.quote.when ? `, ${fmtDate(composer.quote.when)}` : ''} — included when you send
              </label>
              <button
                onClick={() => setQuoteOpen((o) => !o)}
                style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: tones.info.solid, fontSize: 12.5, fontFamily: font }}
              >
                {quoteOpen ? 'Hide' : 'Show'}
              </button>
            </div>
            {quoteOpen && (
              <div style={{ borderTop: '1px solid #e2e8f0', maxHeight: 320, overflowY: 'auto', background: '#fff' }}>
                {composer.quote.html
                  ? <HtmlBody html={composer.quote.html} />
                  : <div style={{ padding: 10, whiteSpace: 'pre-wrap', color: '#334155' }}>{composer.quote.text}</div>}
              </div>
            )}
          </div>
        )}
        {(() => {
          // When it will go: the composer's own choice, else the Send later mode.
          const custom = composer.sendAt && composer.sendAt !== 'now' ? composer.sendAt : null;
          const when = custom || (composer.sendAt !== 'now' && sendLaterActive ? sendLater.at : null);
          const setAt = (v) => setComposer((c) => ({ ...c, sendAt: v }));
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5, color: '#64748b' }}>
              {when ? (
                <>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 999, background: tones.warning?.bg || '#fef3c7', color: tones.warning?.fg || '#92400e', fontWeight: 600 }}>
                    <Clock size={12} /> Will send {fmtWhen(when)}
                  </span>
                  <input
                    type="datetime-local"
                    value={toLocalInput(new Date(when))}
                    onChange={(e) => setAt(e.target.value || undefined)}
                    style={{ padding: '2px 6px', fontSize: 12.5, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 6 }}
                  />
                  <button onClick={() => setAt('now')} style={linkBtn}>Send now instead</button>
                </>
              ) : (
                <button onClick={() => setAt(toLocalInput(nextMorning()))} style={linkBtn}>
                  <Clock size={12} style={{ verticalAlign: -2 }} /> Schedule…
                </button>
              )}
            </div>
          );
        })()}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={() => sendComposer()} disabled={sending} title="Send — Ctrl+Enter"
            style={{ ...BTN.primary.md, display: 'flex', alignItems: 'center', gap: 8, opacity: sending ? 0.45 : 1, cursor: sending ? 'not-allowed' : 'pointer' }}>
            <Send size={13} /> {sending ? 'Checking…'
              : (composer.sendAt && composer.sendAt !== 'now') || (composer.sendAt !== 'now' && sendLaterActive) ? 'Schedule' : 'Send'}
          </button>
          {composer.mode === 'forward' && <span style={{ fontSize: 12, color: '#94a3b8' }}>Attachments aren&apos;t carried over on forwards yet.</span>}
        </div>
      </div>
    );
  }

  const paneContent = () => {
    if (composer && (composer.mode === 'new' || composer.mode === 'forward' || !thread || composer.threadId !== thread.threadId)) {
      return renderComposer();
    }
    if (thread) {
      return (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15.5, fontWeight: 700, color: '#0f172a', flex: 1, minWidth: 200 }}>
              {latestMsg?.subject || '(no subject)'}
            </span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button onClick={() => startComposer('reply')} title="Reply" style={btnText}><ReplyIcon size={14} /> Reply</button>
              <button onClick={() => startComposer('replyAll')} title="Reply all" style={btnText}><ReplyAllIcon size={14} /> All</button>
              <button onClick={() => startComposer('forward')} title="Forward" style={btnText}><ForwardIcon size={14} /> Forward</button>
              {/* Not on our own email — you react to what someone sent you. */}
              {latestMsg && parseAddress(latestMsg.from).email.toLowerCase() !== threadMailbox && (
                <div style={{ position: 'relative' }}>
                  <button onClick={() => setReactOpen((o) => !o)} title="React with an emoji (sends to the sender, like Gmail)" style={btnText}>
                    <Smile size={14} />
                  </button>
                  {reactOpen && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 40, display: 'flex', gap: 2, padding: 6, background: '#fff', border: '1px solid #cbd5e1', borderRadius: 10, boxShadow: '0 10px 30px rgba(15,23,42,.15)' }}>
                      {['👍', '❤️', '😂', '🎉', '🙏', '👏', '😮', '😢', '✅'].map((em) => (
                        <button
                          key={em}
                          onClick={() => react(em)}
                          title={`Send ${em}`}
                          style={{ width: 32, height: 32, fontSize: 18, border: 'none', borderRadius: 8, background: 'transparent', cursor: 'pointer' }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = '#f1f5f9'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        >
                          {em}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {/* Labels are per-account, so tagging waits for a single mailbox. */}
              {!isAll && (
                <LabelPicker
                  labels={userLabels}
                  onPick={tagThread}
                  onCreate={ensureLabel}
                  align="right"
                  trigger={<button title={labelId === 'INBOX' ? 'Tag and archive' : 'Tag with a label'} style={btnText}><Tag size={13} /> Tag</button>}
                />
              )}
              {thread.messages.some((m) => m.labelIds.includes('INBOX'))
                ? <button onClick={() => archiveThread(thread.id)} title="Archive (remove from inbox) — e" style={btnText}><Archive size={14} /> Archive</button>
                : !threadInTrash && <button onClick={() => archiveThread(thread.id, true)} title="Move back to inbox" style={btnText}><ArchiveRestore size={14} /> To inbox</button>}
              <button
                onClick={() => setReadState(thread.id, !threadUnread)}
                title={threadUnread ? 'Mark as read — u' : 'Mark as unread — u'}
                style={btnText}
              >
                {threadUnread ? <MailOpen size={14} /> : <Mail size={14} />} {threadUnread ? 'Mark read' : 'Unread'}
              </button>
              {threadInTrash
                ? <button onClick={() => restoreThread(thread.id)} title="Restore from bin" style={btnText}><ArchiveRestore size={14} /> Restore</button>
                : <button onClick={() => trashThread(thread.id)} title="Move to bin (recoverable for ~30 days in Gmail)" style={{ ...BTN.danger.sm, display: 'flex', alignItems: 'center', gap: 5 }}><Trash2 size={14} /> Delete</button>}
              <button onClick={() => { if (okToDiscard()) { setComposer(null); setThread(null); } }} title="Close" style={btnIcon}><X size={14} /></button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[...new Set(thread.messages.flatMap((m) => m.labelIds))]
              .filter((id) => taggingMode && labelById[id]?.type === 'user')
              .map((id) => (
                <span key={id} style={{ ...chipStyle('teal'), display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {labelById[id].name}
                  {!isAll && (
                    <button onClick={() => untagThread(labelById[id])} title={`Remove the “${labelById[id].name}” tag`} style={{ ...chipX, width: 14, height: 14 }}>
                      <X size={10} />
                    </button>
                  )}
                </span>
              ))}
            {isAll && (
              <span style={chipStyle('neutral')}>{mailboxLabel[threadMailbox] || threadMailbox}</span>
            )}
          </div>
          {composer && renderComposer()}
          {thread.messages.map((m, i) => (
            <MessageCard key={m.id} msg={m} mailbox={threadMailbox} defaultOpen={i === 0} remoteImages={options.remoteImages} onMailto={composeTo} />
          ))}
        </>
      );
    }
    // Opening: paint what the list row already knows straight away.
    if (pending) {
      const from = parseAddress(pending.from);
      return (
        <>
          <span style={{ fontSize: 15.5, fontWeight: 700, color: '#0f172a' }}>{pending.subject || '(no subject)'}</span>
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff', overflow: 'hidden', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '10px 14px' }}>
              <span style={{ fontWeight: 600, fontSize: 14, color: '#0f172a', whiteSpace: 'nowrap' }}>{from.name}</span>
              <span style={{ fontSize: 12, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>to {pending.to}</span>
              <span style={{ marginLeft: 'auto', fontSize: 12, color: '#94a3b8', whiteSpace: 'nowrap' }}>{fmtDate(pending.internalDate)}</span>
            </div>
            <div style={{ padding: '4px 14px 14px', fontSize: 14, color: '#64748b' }}>
              {decodeEntities(pending.snippet)}…
              <div style={{ marginTop: 10, fontSize: 12.5, color: '#94a3b8' }}>Loading the full message…</div>
            </div>
          </div>
        </>
      );
    }
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 14, border: '1px dashed #e2e8f0', borderRadius: 10, minHeight: 240 }}>
        {threadLoading ? 'Opening…' : 'Select an email to preview it here'}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', gap: 3, height: '100%', minHeight: 0, fontFamily: font }}>
      {/* ── Left rail ── */}
      <div style={{ width: railW, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto' }}>
        <select
          value={mailbox}
          onChange={(e) => { if (okToDiscard()) setMailbox(e.target.value); }}
          style={{ padding: '8px 10px', fontSize: 14, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8, background: '#fff', fontWeight: 600, color: '#0f172a' }}
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
        <div style={{ fontSize: 12, color: '#94a3b8', marginTop: -2, paddingLeft: 2 }}>
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
          <button onClick={() => setOptionsOpen(true)} style={railBtn}>
            <Settings2 size={12} /> Options
          </button>
          {!isAll && (
            <a
              // One handler: two onClick props meant the second replaced the
              // first, so OK on the confirm did nothing.
              href="#"
              onClick={(e) => {
                e.preventDefault();
                if (window.confirm(`Reconnect ${mailboxObj?.account_email}? You'll be sent to Google to re-approve — sign in as that account. This refreshes the mailbox's permissions.`)) reconnect();
              }}
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
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  if (window.confirm('You’ll be sent to Google — sign in as the SHARED mailbox you want to add (e.g. accounts@ or payroll@), not your own account. Continue?')) connectShared();
                }}
                style={addOptionStyle}
              >
                <InboxIcon size={13} /> Add shared mailbox
              </a>
            )}
            <div style={{ fontSize: 11.5, color: '#94a3b8', lineHeight: 1.4 }}>
              Shared = the whole team sees it (info@, accounts@…). You&apos;ll sign into that Google account once.
            </div>
          </div>
        )}

        <button
          onClick={() => { if (!okToDiscard()) return; composerRef.current = null; setThread(null); startComposer('new'); }}
          style={{ ...BTN.primary.md, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
        >
          <PenSquare size={14} /> New email
        </button>

        {/* Send later mode: everything written while it's on waits until then. */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => {
              const at = sendLater.at && new Date(sendLater.at).getTime() > Date.now() ? new Date(sendLater.at) : nextMorning(8);
              setSlDraft({ date: toLocalInput(at).slice(0, 10), time: toLocalInput(at).slice(11, 16) });
              setSendLaterOpen(true);
            }}
            title="Send later — hold every email you write until a set time"
            style={{
              ...railBtn, width: '100%', justifyContent: 'flex-start',
              ...(sendLaterActive ? { background: '#fef3c7', border: '1px solid #f59e0b', color: '#92400e', fontWeight: 700 } : {}),
              ...(sendLaterLapsed ? { border: '1px dashed #f59e0b', color: '#92400e' } : {}),
            }}
          >
            <Clock size={12} />
            {sendLaterActive ? `Send later: ${fmtWhen(sendLater.at)}` : sendLaterLapsed ? 'Send later: time passed' : 'Send later: off'}
          </button>
        </div>
        {scheduled.length > 0 && (
          <button onClick={() => { refreshScheduled(); setScheduledOpen(true); }} style={{ ...railBtn, width: '100%', justifyContent: 'flex-start' }}>
            <Clock size={12} /> Scheduled ({scheduled.filter((x) => x.status === 'queued').length})
            {scheduled.some((x) => x.status === 'failed') && <span style={{ color: '#b91c1c', fontWeight: 700 }}> · failed</span>}
          </button>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {/* System label ids are identical in every Gmail account, so the
              merged view offers the full set even with no labels loaded. */}
          {SYSTEM_LABELS.filter((s) => isAll || s.id === 'INBOX' || s.id === 'ALL' || labelById[s.id]).map((s) => (
            <button
              key={s.id}
              onClick={() => selectLabel(s.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', fontSize: 14,
                fontWeight: labelId === s.id && !q ? 700 : 500,
                background: labelId === s.id && !q ? tones.info.bg : 'transparent',
                color: labelId === s.id && !q ? tones.info.fg : '#334155',
                border: 'none', borderRadius: 8, cursor: 'pointer', textAlign: 'left', fontFamily: font,
              }}
            >
              {s.id === 'INBOX' ? <InboxIcon size={14} /> : s.id === 'ALL' ? <Layers size={14} /> : s.id === 'TRASH' ? <Trash2 size={13} /> : <Tag size={13} />} {s.label}
            </button>
          ))}
          {labelTree.length > 0 && <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', padding: '8px 10px 2px' }}>Labels</div>}
          {labelTree.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '2px 4px 4px', padding: '0 8px', border: '1px solid #e2e8f0', borderRadius: 7, background: '#fff' }}>
              <Search size={12} color="#94a3b8" />
              <input
                value={labelSearch}
                onChange={(e) => setLabelSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setLabelSearch(''); }}
                placeholder="Find a label"
                style={{ flex: 1, minWidth: 0, padding: '5px 0', fontSize: 13, fontFamily: font, border: 'none', outline: 'none', background: 'transparent' }}
              />
              {labelSearch && (
                <button onClick={() => setLabelSearch('')} title="Clear" style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: '#94a3b8', display: 'flex' }}>
                  <X size={12} />
                </button>
              )}
            </div>
          )}
          {/* Searching: a flat list of matches with their path, anywhere in the
              tree. Otherwise the folding tree. */}
          {labelSearch.trim() ? (() => {
            const t = labelSearch.trim().toLowerCase();
            const hits = [...userLabels].filter((l) => l.name.toLowerCase().includes(t)).sort((a, b) => a.name.localeCompare(b.name));
            if (!hits.length) return <div style={{ padding: '4px 12px', fontSize: 12.5, color: '#94a3b8' }}>No label matches.</div>;
            return hits.map((l) => {
              const parts = l.name.split('/');
              const leaf = parts.pop();
              const isActive = labelId === l.id && !q;
              return (
                <button
                  key={l.id}
                  onClick={() => selectLabel(l.id)}
                  title={l.name}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0, padding: '4px 10px', fontSize: 13.5,
                    fontWeight: isActive ? 700 : 500, background: isActive ? tones.info.bg : 'transparent',
                    color: isActive ? tones.info.fg : '#475569', border: 'none', borderRadius: 7, cursor: 'pointer', textAlign: 'left', fontFamily: font, minWidth: 0,
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, maxWidth: '100%' }}>
                    <Tag size={11} style={{ flexShrink: 0 }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{leaf}</span>
                  </span>
                  {parts.length > 0 && (
                    <span style={{ fontSize: 11, color: '#94a3b8', paddingLeft: 17, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {parts.join(' › ')}
                    </span>
                  )}
                </button>
              );
            });
          })() : labelTree.map((n) => renderTreeNode(n, 0))}
        </div>
      </div>

      <Splitter width={railW} onChange={setRailW} min={160} max={380} onReset={() => setRailW(RAIL_W)} />

      {/* ── Middle: thread list ── Width is draggable (saved per browser).
          It still shrinks on a laptop so the preview keeps its 380px. */}
      <div style={{ flex: `0 1 ${listW}px`, minWidth: 300, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff' }}>
            <Search size={14} color="#94a3b8" />
            <input
              value={qDraft}
              onChange={(e) => setQDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setQ(qDraft.trim()); }}
              placeholder={`Search ${searchAll ? 'all mail' : currentFolderName} — Enter`}
              style={{ flex: 1, padding: '8px 0', fontSize: 14, fontFamily: font, border: 'none', outline: 'none', minWidth: 0 }}
            />
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: searchAll ? tones.info.fg : '#94a3b8', cursor: 'pointer', whiteSpace: 'nowrap' }}
              title={`Search every message in the mailbox instead of just ${currentFolderName}`}
            >
              <input type="checkbox" checked={searchAll} onChange={(e) => setSearchAll(e.target.checked)} style={{ cursor: 'pointer' }} />
              All mail
            </label>
            {q && <button onClick={() => { setQ(''); setQDraft(''); setSearchAll(false); }} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#64748b', fontSize: 12 }}>clear</button>}
          </div>
          <button
            onClick={() => { setLastChecked(Date.now()); loadThreads(); }}
            title={`Send / receive${lastChecked ? ` — last checked ${fmtClock(lastChecked)}` : ''}`}
            style={btnIcon}
          >
            <RefreshCw size={14} />
          </button>
          {/* Labels and learned rules are per-account, so tagging needs one mailbox. */}
          {!isAll && (
            <button
              onClick={() => { setTaggingMode((on) => !on); setTagFilter('all'); }}
              title={taggingMode ? 'Leave tagging mode' : 'Tagging mode — see suggested tags and tag emails in bulk'}
              style={{ ...btnIcon, ...(taggingMode ? { background: tones.teal.bg, borderColor: tones.teal.solid, color: tones.teal.fg } : {}) }}
            >
              <Tag size={13} /> {taggingMode ? 'Tagging on' : 'Tagging'}
            </button>
          )}
          <div style={{ position: 'relative' }}>
            <button onClick={() => setKeysOpen((o) => !o)} title="Keyboard shortcuts (?)" style={btnIcon}>
              <Keyboard size={14} />
            </button>
            {keysOpen && (
              <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 40, width: 250, padding: '10px 12px', background: '#fff', border: '1px solid #cbd5e1', borderRadius: 10, boxShadow: '0 10px 30px rgba(15,23,42,.15)', fontSize: 13, color: '#334155' }}>
                <div style={{ fontWeight: 700, color: '#0f172a', marginBottom: 6 }}>Keyboard shortcuts</div>
                {[
                  ['↓  or  j', 'Next email'],
                  ['↑  or  k', 'Previous email'],
                  ['Delete  or  #', 'Move to bin'],
                  ['e', 'Archive'],
                  ['r', 'Reply'],
                  ['a', 'Reply all'],
                  ['f', 'Forward'],
                  ['x', 'Tick / untick the open email'],
                  ['u', 'Mark read / unread'],
                  ['Ctrl+Enter', 'Send (while writing)'],
                  ['Esc', 'Close the email'],
                  ['?', 'Show / hide this list'],
                ].map(([k, what]) => (
                  <div key={k} style={{ display: 'flex', gap: 10, padding: '2px 0' }}>
                    <span style={{ flex: '0 0 92px', fontFamily: 'ui-monospace, monospace', fontSize: 12, color: '#0f172a' }}>{k}</span>
                    <span>{what}</span>
                  </div>
                ))}
                <div style={{ marginTop: 6, fontSize: 11.5, color: '#94a3b8' }}>Not while typing in a box. After clicking inside an email, click the list to use keys again.</div>
              </div>
            )}
          </div>
        </div>

        {/* Sort + count. The rest of the view settings live in Options. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: '#64748b', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            Sort
            <select
              value={sort}
              onChange={(e) => { setSort(e.target.value); localStorage.setItem('comms_email_sort', e.target.value); }}
              style={{ padding: '3px 6px', fontSize: 12.5, fontFamily: font, border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff', color: '#334155' }}
            >
              <option value="date">Newest first</option>
              <option value="recipient">Recipient email (A–Z)</option>
              <option value="sender">Sender email (A–Z)</option>
            </select>
          </label>
          <span style={{ color: '#94a3b8', marginLeft: 'auto' }}>
            {listLoading && threads.length > 0
              ? `${threads.length} loaded…`
              : `${threads.length}${hasMore ? ' — Load more' : ''}`}
            {isAll ? ` across ${activeMailboxes.length}` : ''}
            {lastChecked ? ` · ${fmtClock(lastChecked)}` : ''}
          </span>
        </div>

        {/* Tagging mode: filter to a suggested tag, eyeball, approve. */}
        {taggingMode && !isAll && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '6px 10px', background: tones.teal.bg, border: `1px solid ${tones.teal.border}`, borderRadius: 8, fontSize: 13 }}>
            {labelId !== 'INBOX' || q ? (
              <span style={{ color: tones.teal.fg }}>
                Suggestions work on the Inbox. Here, tick emails and use <b>Tag + archive</b>, or tag one from its row.
              </span>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Sparkles
                    size={13}
                    color={tones.teal.solid}
                    style={{ flexShrink: 0, cursor: 'help' }}
                    title="✓ tags the email as suggested and archives it. Hover a row for × (this tag is wrong for that sender — never suggested again) and the tag button (pick the right one). All of these archive."
                  />
                  {learnBusy ? (
                    <span style={{ color: tones.teal.fg }}>Learning from this mailbox&apos;s labelled history…</span>
                  ) : (
                    <>
                      <select
                        value={tagFilter}
                        onChange={(e) => setTagFilter(e.target.value)}
                        style={{ padding: '3px 6px', fontSize: 12.5, fontFamily: font, border: `1px solid ${tones.teal.border}`, borderRadius: 6, background: '#fff', color: '#334155', maxWidth: 260 }}
                      >
                        <option value="all">Everything ({visibleThreads.length})</option>
                        <option value="suggested">With a suggestion ({sugById.size})</option>
                        <option value="none">No suggestion ({visibleThreads.length - sugById.size})</option>
                        {suggestedLabelCounts.length > 0 && (
                          <optgroup label="Suggested tag">
                            {suggestedLabelCounts.map(({ label, n }) => (
                              <option key={label.id} value={label.id}>{label.name} ({n})</option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                      {suggested.length > 0 && (
                        <button disabled={sweepBusy} onClick={acceptAllSuggestions} style={sweepBtn} title="Tag each email shown with its suggestion and archive it">
                          <Check size={12} /> {sweepBusy ? 'Approving…' : `Approve ${suggested.length} shown`}
                        </button>
                      )}
                    </>
                  )}
                  <button
                    disabled={learnBusy || sweepBusy}
                    onClick={() => doLearnTags(false)}
                    title="Learn tags again from how your existing mail is labelled"
                    style={{ marginLeft: 'auto', border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: tones.teal.fg, fontSize: 12.5, fontFamily: font, textDecoration: 'underline' }}
                  >
                    {tagRules.length === 0 && !learnBusy ? 'Learn from my labels' : 'Re-learn'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Bulk action bar */}
        {selected.size > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: tones.info.bg, border: `1px solid ${tones.info.border}`, borderRadius: 8, fontSize: 13, flexWrap: 'wrap' }}>
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
            <button disabled={bulkBusy} onClick={() => bulkModify({ addLabelIds: ['UNREAD'], verb: 'Marked unread' })} style={bulkBtn}><Mail size={12} /> Unread</button>
            <button disabled={bulkBusy} onClick={bulkTrash} style={{ ...BTN.danger.sm, display: 'flex', alignItems: 'center', gap: 5 }}><Trash2 size={12} /> Delete</button>
            <button disabled={bulkBusy} onClick={() => setSelected(new Set())} style={{ ...bulkBtn, marginLeft: 'auto' }}>Clear</button>
            {bulkBusy && <span style={{ color: tones.info.fg }}>Working…</span>}
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff', minHeight: 0 }}>
          {listLoading && threads.length === 0 && <div style={{ padding: 20, fontSize: 14, color: '#64748b' }}>Loading…</div>}
          {!listLoading && threads.length === 0 && (
            <div style={{ padding: 26, fontSize: 14, color: '#94a3b8', textAlign: 'center' }}>
              {q ? 'No results.' : 'Nothing here — inbox zero 🎉'}
            </div>
          )}
          {tagFilterOn && listThreads.length === 0 && threads.length > 0 && (
            <div style={{ padding: 26, fontSize: 14, color: '#94a3b8', textAlign: 'center' }}>Nothing matches this filter.</div>
          )}
          {listThreads.map((t) => {
            const party = rowParty(t, t.mailbox || mailbox, showRecipient);
            const isOpen = thread?.id === t.id;
            // Applied tags, like suggestions, only show in tagging mode.
            const userLabelChips = !taggingMode ? [] : (t.labelIds || []).filter((id) => labelById[id]?.type === 'user').slice(0, 2);
            const sug = sugById.get(t.id);
            // Tagging mode's second line: the suggestion with approve / wrong /
            // change, or a plain tag picker when there's nothing to suggest.
            // Tagging mode, on the row itself: the suggested tag and a ✓. The ×
            // (wrong) and the tag picker appear on hover, so a page of
            // suggestions reads as a list, not a wall of buttons.
            const tagControls = taggingMode && !isAll && (
              <span
                onClick={(e) => { if (e.target.closest('button, [data-picker]')) e.stopPropagation(); }}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}
              >
                {sug && sug.labels.map((l) => (
                  <span key={l.id} style={suggPill} title={l.name}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.name.split('/').pop()}</span>
                    <button
                      className="hidden group-hover:inline-flex"
                      onClick={() => rejectSuggested(sug.sender, l)}
                      title={`Wrong — stop suggesting “${l.name}” for ${sug.sender}`}
                      style={chipX}
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
                <span data-picker className={pickerRow === t.id ? '' : 'opacity-0 group-hover:opacity-100'}>
                  <LabelPicker
                    labels={userLabels}
                    onPick={(label) => tagRowAs(t, label, sug)}
                    onCreate={ensureLabel}
                    onOpenChange={(o) => setPickerRow((cur) => (o ? t.id : cur === t.id ? null : cur))}
                    align="right"
                    trigger={<button title={sug ? 'Pick a different tag (and archive)' : 'Tag (and archive)'} style={tagIconBtn}><Tag size={11} /></button>}
                  />
                </span>
                {sug && (
                  <button disabled={sweepBusy} onClick={() => acceptSuggestion(t, sug)} title="Approve — tag as suggested and archive" style={approveIconBtn}>
                    <Check size={12} />
                  </button>
                )}
              </span>
            );
            const sender = (
              <span style={{ fontWeight: t.unread ? 700 : 500, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...(compact ? { flex: '0 0 150px' } : { flex: 1 }) }}>
                {party.name}{t.messageCount > 1 ? ` (${t.messageCount})` : ''}
                {party.to && <span style={{ fontWeight: 400, color: '#94a3b8' }}> → {party.to}</span>}
              </span>
            );
            const subject = (
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...(compact ? { flex: 1, minWidth: 0 } : {}) }}>
                <span style={{ fontWeight: t.unread ? 700 : 500, color: '#1e293b' }}>{t.subject}</span>
                <span style={{ color: '#94a3b8' }}> — {decodeEntities(t.snippet)}</span>
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
                {tagControls}
              </>
            );
            // Actions sit under the date and swap in on hover, so a dense list
            // stays readable. group-hover rather than React state: re-rendering
            // 500 rows on every mouse move would crawl.
            const actions = tagControls ? (
              <span style={{ fontSize: 11.5, color: '#94a3b8', whiteSpace: 'nowrap', flexShrink: 0 }}>{fmtDate(t.internalDate)}</span>
            ) : (
              <span className="relative flex-shrink-0" style={{ display: 'inline-flex', alignItems: 'center' }}>
                <span className={pickerRow === t.id ? 'invisible' : 'group-hover:invisible'} style={{ fontSize: 11.5, color: '#94a3b8', whiteSpace: 'nowrap' }}>
                  {fmtDate(t.internalDate)}
                </span>
                {/* Stays up while this row's Tag picker is open, so moving the
                    mouse off the row doesn't close it — only picking, clicking
                    elsewhere or Esc does. */}
                <span
                  className={pickerRow === t.id ? 'visible' : 'invisible group-hover:visible'}
                  // The transform makes this its own layer, which trapped the Tag
                  // picker's z-index inside the row — later rows (and their
                  // dates) drew over it. Lift the whole toolbar while it's open.
                  style={{ position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)', display: 'flex', gap: 2, background: isOpen ? tones.info.bg : '#fff', paddingLeft: 6, borderRadius: 6, zIndex: pickerRow === t.id ? 50 : 1 }}
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
                  {/* One-off tag from the row, no Tagging mode: adds the tag and
                      leaves the email where it is, like Tag on an open email. */}
                  {!isAll && (
                    <span onClick={(e) => e.stopPropagation()}>
                      <LabelPicker
                        labels={userLabels}
                        onPick={(label) => tagRow(t, label)}
                        onCreate={ensureLabel}
                        onOpenChange={(o) => setPickerRow((cur) => (o ? t.id : cur === t.id ? null : cur))}
                        align="right"
                        trigger={<button title={labelId === 'INBOX' ? 'Tag (and archive)' : 'Tag'} style={rowActionBtn}><Tag size={12} /></button>}
                      />
                    </span>
                  )}
                </span>
              </span>
            );
            return (
              <div
                key={t.id}
                data-mid={t.id}
                onClick={() => openThread(t)}
                onMouseEnter={() => { clearTimeout(hoverTimer.current); hoverTimer.current = setTimeout(() => prefetchThread(t), 250); }}
                onMouseLeave={() => clearTimeout(hoverTimer.current)}
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
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
                      {sender}{subject}{marks}{actions}
                    </div>
                  </div>
                ) : (
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13.5 }}>
                      {sender}{marks}{actions}
                    </div>
                    <div style={{ fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subject}</div>
                  </div>
                )}
              </div>
            );
          })}
          {hasMore && (
            <button onClick={() => loadThreads({ append: true })} disabled={listLoading}
              style={{ width: '100%', padding: 10, fontSize: 13, fontWeight: 600, color: tones.info.solid, background: 'none', border: 'none', cursor: 'pointer', fontFamily: font }}>
              {listLoading ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      </div>

      <Splitter width={listW} onChange={setListW} min={300} max={1200} onReset={() => setListW(LIST_W)} />

      {/* ── Right: preview pane ── */}
      <div style={{ flex: 1, minWidth: 380, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
        {needsReconnect && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: tones.info.bg, border: `1px solid ${tones.info.border}`, borderRadius: 8, fontSize: 13, color: tones.info.fg }}>
            {mailboxObj?.status !== 'active'
              ? <span>This mailbox&apos;s connection is broken ({mailboxObj?.error_message || mailboxObj?.status}).</span>
              : <span>This mailbox was connected with an older permission set — a quick reconnect unlocks everything.</span>}
            <a href="#" onClick={(e) => { e.preventDefault(); reconnect(); }} style={{ marginLeft: 'auto', fontWeight: 700, color: tones.info.fg }}>Reconnect</a>
          </div>
        )}
        {error && (
          <div style={{ display: 'flex', gap: 10, padding: '8px 12px', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 8, fontSize: 13, color: '#b91c1c' }}>
            <span style={{ flex: 1 }}>{error}</span>
            <button onClick={() => setError(null)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#b91c1c' }}><X size={13} /></button>
          </div>
        )}
        {pendingSend && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#eff6ff', border: `1px solid ${tones.info.border}`, borderRadius: 8, fontSize: 13, color: tones.info.fg }}>
            <span style={{ flex: 1 }}>Sending in {Math.max(0, Math.ceil((pendingSend.until - Date.now()) / 1000))}s…</span>
            <button onClick={undoSend} style={{ fontSize: 13, fontWeight: 700, color: tones.info.fg, background: '#fff', border: `1px solid ${tones.info.border}`, borderRadius: 6, padding: '3px 12px', cursor: 'pointer', fontFamily: font }}>
              Undo
            </button>
          </div>
        )}
        {notice && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, fontSize: 13, color: '#166534' }}>
            <span style={{ flex: 1 }}>{notice.text}</span>
            {notice.undo && (
              <button
                onClick={async () => { const u = notice.undo; setNotice(null); await u(); }}
                style={{ fontSize: 13, fontWeight: 700, color: '#166534', background: 'none', border: '1px solid #86efac', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontFamily: font }}
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

      {/* ── Send later ── */}
      {sendLaterOpen && (() => {
        const at = slDraft.date && slDraft.time ? new Date(`${slDraft.date}T${slDraft.time}`) : null;
        const valid = at && !isNaN(at.getTime()) && at.getTime() > Date.now() + 60_000;
        const pick = (d) => setSlDraft({ date: toLocalInput(d).slice(0, 10), time: toLocalInput(d).slice(11, 16) });
        const tomorrow = (h) => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(h, 0, 0, 0); return d; };
        const monday = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); d.setHours(8, 0, 0, 0); return d; };
        const quick = [['Tomorrow 8:00', tomorrow(8)], ['Tomorrow 9:00', tomorrow(9)], ['Monday 8:00', monday()]];
        const field = { padding: '7px 10px', fontSize: 14, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 7, background: '#fff' };
        return (
          <div onMouseDown={(e) => { if (e.target === e.currentTarget) setSendLaterOpen(false); }} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
            <div style={{ width: 420, maxWidth: '92vw', background: '#fff', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 14, fontFamily: font }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Clock size={16} color="#d97706" />
                <span style={{ fontSize: 15.5, fontWeight: 700, color: '#0f172a' }}>Send later</span>
                <button onClick={() => setSendLaterOpen(false)} style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: '#64748b' }}><X size={16} /></button>
              </div>
              <div style={{ fontSize: 13, color: '#64748b', lineHeight: 1.45 }}>
                While it&apos;s on, every email you write waits until this time instead of sending. You can still send any one straight away from the composer.
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {quick.map(([label, d]) => {
                  const on = slDraft.date === toLocalInput(d).slice(0, 10) && slDraft.time === toLocalInput(d).slice(11, 16);
                  return (
                    <button key={label} onClick={() => pick(d)} style={{ ...railBtn, ...(on ? { background: '#fef3c7', border: '1px solid #f59e0b', color: '#92400e' } : {}) }}>
                      {label}
                    </button>
                  );
                })}
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <label style={{ flex: 1.4, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5, color: '#64748b' }}>
                  Date
                  <input type="date" value={slDraft.date} onChange={(e) => setSlDraft((d) => ({ ...d, date: e.target.value }))} style={field} />
                </label>
                <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5, color: '#64748b' }}>
                  Time
                  <input type="time" step={900} value={slDraft.time} onChange={(e) => setSlDraft((d) => ({ ...d, time: e.target.value }))} style={field} />
                </label>
              </div>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: valid ? '#92400e' : '#b91c1c' }}>
                {!at ? 'Pick a date and time.' : valid ? `Emails will send ${fmtWhen(at.toISOString())}.` : 'That time has already passed.'}
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                {sendLaterActive && (
                  <button onClick={() => { setSendLater({ ...sendLater, on: false }); setSendLaterOpen(false); }} style={{ ...BTN.secondary.md, cursor: 'pointer', marginRight: 'auto' }}>
                    Turn off
                  </button>
                )}
                <button onClick={() => setSendLaterOpen(false)} style={{ ...BTN.secondary.md, cursor: 'pointer' }}>Cancel</button>
                <button
                  disabled={!valid}
                  onClick={() => { setSendLater({ on: true, at: at.toISOString() }); setSendLaterOpen(false); }}
                  style={{ ...BTN.primary.md, cursor: valid ? 'pointer' : 'not-allowed', opacity: valid ? 1 : 0.5 }}
                >
                  {sendLaterActive ? 'Update' : 'Turn on'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Send check: the server's warnings, before anything goes ── */}
      {sendWarn && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 110 }}>
          <div style={{ width: 500, maxWidth: '92vw', background: '#fff', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 12, fontFamily: font, borderTop: '4px solid #f59e0b' }}>
            <span style={{ fontSize: 15.5, fontWeight: 700, color: '#0f172a' }}>Check before this goes</span>
            <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14, color: '#334155' }}>
              {sendWarn.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
            <div style={{ fontSize: 12.5, color: '#94a3b8' }}>Clients must never see each other&apos;s emails or addresses.</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button autoFocus onClick={() => setSendWarn(null)} style={{ ...BTN.primary.md, cursor: 'pointer' }}>Go back and fix</button>
              <button
                onClick={() => { const w = sendWarn.warnings; setSendWarn(null); sendComposer({ acknowledged: true, warnings: w }); }}
                style={{ ...BTN.secondary.md, cursor: 'pointer', color: '#b91c1c' }}
              >
                Send anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Scheduled emails ── */}
      {scheduledOpen && (
        <div onMouseDown={(e) => { if (e.target === e.currentTarget) setScheduledOpen(false); }} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ width: 620, maxWidth: '94vw', maxHeight: 'calc(100vh - 48px)', overflowY: 'auto', background: '#fff', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 10, fontFamily: font }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: 15.5, fontWeight: 700, color: '#0f172a' }}>Scheduled emails</span>
              <button onClick={() => setScheduledOpen(false)} style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: '#64748b' }}><X size={16} /></button>
            </div>
            {scheduled.length === 0 && <div style={{ fontSize: 13.5, color: '#94a3b8' }}>Nothing scheduled.</div>}
            {scheduled.map((it) => (
              <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.subject || '(no subject)'}</div>
                  <div style={{ fontSize: 12, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>To {it.to_summary}</div>
                  {it.status === 'failed'
                    ? <div style={{ fontSize: 12, color: '#b91c1c' }}>Didn&apos;t send: {it.error}</div>
                    : <div style={{ fontSize: 12, color: '#92400e', fontWeight: 600 }}>{fmtWhen(it.send_at)}</div>}
                </div>
                {it.status === 'queued' && (
                  <button onClick={async () => { await sendNowFromOutbox(it); flash('Sent.'); refreshScheduled(); }} style={{ ...BTN.secondary.sm, cursor: 'pointer' }}>Send now</button>
                )}
                <button onClick={() => reopenScheduled(it)} style={{ ...BTN.secondary.sm, cursor: 'pointer' }}>
                  {it.status === 'queued' ? 'Cancel & edit' : 'Open as draft'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Move / rename a label ── */}
      {moveLabel && (
        <div onMouseDown={(e) => { if (e.target === e.currentTarget) setMoveLabel(null); }} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ width: 440, maxWidth: '92vw', background: '#fff', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 12, fontFamily: font }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: 15.5, fontWeight: 700, color: '#0f172a' }}>Move or rename label</span>
              <button onClick={() => setMoveLabel(null)} style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: '#64748b' }}><X size={16} /></button>
            </div>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5, color: '#64748b' }}>
              Name
              <input
                value={moveLabel.leaf}
                onChange={(e) => setMoveLabel((m) => ({ ...m, leaf: e.target.value }))}
                style={{ padding: '7px 10px', fontSize: 14, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 7 }}
              />
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5, color: '#64748b' }}>
              Inside
              {/* Not itself or anything inside it. */}
              <ParentPicker
                labels={userLabels.filter((l) => l.id !== moveLabel.label.id && !l.name.startsWith(`${moveLabel.label.name}/`))}
                value={moveLabel.parent}
                onChange={(v) => setMoveLabel((m) => ({ ...m, parent: v }))}
                maxHeight={240}
              />
            </div>
            <div style={{ fontSize: 12, color: '#94a3b8' }}>
              Emails keep this label — it just moves in the list. Labels inside it move with it. The change shows in Gmail too.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setMoveLabel(null)} style={{ ...BTN.secondary.md, cursor: 'pointer' }}>Cancel</button>
              <button onClick={doMoveLabel} disabled={moveLabel.busy} style={{ ...BTN.primary.md, cursor: 'pointer' }}>{moveLabel.busy ? 'Moving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Options ── */}
      {optionsOpen && (
        <div onMouseDown={(e) => { if (e.target === e.currentTarget) setOptionsOpen(false); }} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ width: 520, maxWidth: '92vw', maxHeight: 'calc(100vh - 48px)', overflowY: 'auto', background: '#fff', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 4, fontFamily: font }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 15.5, fontWeight: 700, color: '#0f172a' }}>Email options</span>
              <button onClick={() => setOptionsOpen(false)} style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: '#64748b' }}><X size={16} /></button>
            </div>

            <div style={optSection}>Reading</div>
            <OptionRow label="Mark an email as read" hint="When you open it in the preview.">
              <select value={options.markRead} onChange={(e) => setOption('markRead', e.target.value)} style={optSelect}>
                <option value="open">As soon as I open it</option>
                <option value="delay">After 3 seconds open</option>
                <option value="never">Never — I&apos;ll mark it myself (u)</option>
              </select>
            </OptionRow>
            <OptionRow label="After delete or archive" hint="What the preview shows next.">
              <select value={options.afterRemove} onChange={(e) => setOption('afterRemove', e.target.value)} style={optSelect}>
                <option value="next">Open the next email</option>
                <option value="prev">Open the previous email</option>
                <option value="none">Nothing — back to the list</option>
              </select>
            </OptionRow>
            <OptionRow label="Show pictures from the web" hint="Off: pictures wait for a click, so senders can't tell you've opened it.">
              <YesNo value={options.remoteImages} onChange={(v) => setOption('remoteImages', v)} />
            </OptionRow>

            <div style={optSection}>List</div>
            <OptionRow label="Compact rows" hint="One line per email.">
              <YesNo value={compact} onChange={(v) => { setCompact(v); localStorage.setItem('comms_compact', v ? '1' : '0'); }} />
            </OptionRow>
            <OptionRow label="Hide my own sent mail in the Inbox" hint="Mail you sent that also lands in the Inbox (e.g. to a group you're in).">
              <YesNo value={hideOwn} onChange={(v) => { setHideOwn(v); localStorage.setItem('comms_hide_own', v ? '1' : '0'); }} />
            </OptionRow>
            <OptionRow label="Emails to load" hint="More takes longer to load.">
              <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); localStorage.setItem('comms_page_size', e.target.value); }} style={optSelect}>
                {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </OptionRow>
            <OptionRow label="Check for new mail" hint="In the background, while this screen is open.">
              <select value={options.autoCheckMins} onChange={(e) => setOption('autoCheckMins', Number(e.target.value))} style={optSelect}>
                {AUTO_CHECK_MINUTES.map((m) => <option key={m} value={m}>{m === 0 ? 'Off — refresh button only' : `Every ${m} minute${m === 1 ? '' : 's'}`}</option>)}
              </select>
            </OptionRow>

            <div style={optSection}>Writing</div>
            <OptionRow label="Add my signature automatically" hint="To new emails, replies and forwards. Edit it with the Signature button.">
              <YesNo value={options.autoSignature} onChange={(v) => setOption('autoSignature', v)} />
            </OptionRow>
            <OptionRow label="Include the original email in replies" hint="You can still tick or untick it per email.">
              <YesNo value={options.includeOriginal} onChange={(v) => setOption('includeOriginal', v)} />
            </OptionRow>
            <OptionRow label="Ask before moving an email to the bin" hint="Delete is always recoverable from Bin for about 30 days.">
              <YesNo value={options.confirmDelete} onChange={(v) => setOption('confirmDelete', v)} />
            </OptionRow>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>Saved in this browser as you change them.</span>
              <button onClick={() => setOptionsOpen(false)} style={{ ...BTN.primary.md, marginLeft: 'auto', cursor: 'pointer' }}>Done</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Signature editor ── */}
      {sigOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ width: 520, maxWidth: '92vw', maxHeight: 'calc(100vh - 48px)', overflowY: 'auto', background: '#fff', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 12, fontFamily: font }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: 15.5, fontWeight: 700, color: '#0f172a' }}>Email signature</span>
              <button onClick={() => setSigOpen(false)} style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: '#64748b' }}><X size={16} /></button>
            </div>
            <textarea
              value={sigDraft}
              onChange={(e) => setSigDraft(e.target.value)}
              rows={7}
              placeholder={'Kind regards,\nJane Smith\nAlmond Valley Accounting'}
              style={{ padding: '9px 11px', fontSize: 14, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8, resize: 'vertical', lineHeight: 1.5 }}
            />
            <div style={{ display: 'flex', gap: 14, fontSize: 13.5, color: '#334155' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="radio" checked={sigScope === '*'} onChange={() => setSigScope('*')} /> All my mailboxes
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="radio" checked={sigScope === mailbox} onChange={() => setSigScope(mailbox)} /> Only {mailboxObj?.display_name || mailbox}
              </label>
            </div>
            <div style={{ fontSize: 12.5, color: '#94a3b8' }}>
              Added automatically when you compose or reply. Plain text for now.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setSigOpen(false)} style={{ ...BTN.secondary.md, cursor: 'pointer' }}>Cancel</button>
              <button onClick={doSaveSignature} style={{ ...BTN.primary.md, cursor: 'pointer' }}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const btnIcon = {
  display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px', fontSize: 13, fontWeight: 600,
  border: '1px solid #cbd5e1', background: '#fff', borderRadius: 8, cursor: 'pointer',
  fontFamily: font, color: '#334155',
};

// Text action buttons in the thread header (Reply, Archive…).
const btnText = { ...BTN.secondary.sm, display: 'flex', alignItems: 'center', gap: 5 };

const bulkBtn = { ...BTN.secondary.sm, display: 'flex', alignItems: 'center', gap: 5 };

const sweepBtn = {
  display: 'flex', alignItems: 'center', gap: 5, padding: '4px 9px', fontSize: 13, fontWeight: 600,
  border: `1px solid ${tones.teal.solid}`, background: '#fff', borderRadius: 6, cursor: 'pointer',
  fontFamily: font, color: tones.teal.fg,
};

// Tagging mode, per row: a quiet tag pill, an icon ✓, an icon tag picker.
const suggPill = {
  display: 'inline-flex', alignItems: 'center', gap: 2, padding: '1px 8px', fontSize: 11.5, fontWeight: 600,
  // Dashed and white: a suggestion, not a tag the email already has.
  color: tones.teal.fg, background: '#fff', border: `1px dashed ${tones.teal.solid}`, borderRadius: 999,
  fontFamily: font, whiteSpace: 'nowrap', maxWidth: 170,
};
const chipX = {
  alignItems: 'center', justifyContent: 'center', width: 15, height: 15, padding: 0, marginRight: -4,
  border: 'none', borderRadius: 999, background: 'transparent', color: tones.teal.fg, cursor: 'pointer', flexShrink: 0,
};
const tagIconBtn = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, padding: 0,
  border: '1px solid #e2e8f0', borderRadius: 5, background: '#fff', color: '#64748b', cursor: 'pointer',
};
const approveIconBtn = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, padding: 0,
  border: `1px solid ${tones.teal.solid}`, borderRadius: 5, background: '#fff', color: tones.teal.solid, cursor: 'pointer',
};

const linkBtn = {
  border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: tones.info.solid,
  fontSize: 12.5, fontWeight: 600, fontFamily: font,
};

// Options dialog pieces.
function OptionRow({ label, hint, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '7px 0', borderBottom: '1px solid #f1f5f9' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: '#0f172a' }}>{label}</div>
        {hint && <div style={{ fontSize: 12, color: '#94a3b8' }}>{hint}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}
function YesNo({ value, onChange }) {
  const seg = (on) => ({
    padding: '4px 12px', fontSize: 12.5, fontWeight: 600, fontFamily: font, cursor: 'pointer', border: 'none',
    background: on ? tones.info.solid : '#fff', color: on ? '#fff' : '#475569',
  });
  return (
    <div style={{ display: 'inline-flex', border: '1px solid #cbd5e1', borderRadius: 7, overflow: 'hidden' }}>
      <button onClick={() => onChange(true)} style={seg(value)}>Yes</button>
      <button onClick={() => onChange(false)} style={{ ...seg(!value), borderLeft: '1px solid #cbd5e1' }}>No</button>
    </div>
  );
}
const optSection = { fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.04em', marginTop: 10 };
const optSelect = { padding: '5px 8px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 7, background: '#fff', color: '#334155' };

// Hover-revealed per-row action.
// A 22px square icon button, not a text button — deliberately not BTN.
const rowActionBtn = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 22, height: 22, padding: 0, border: '1px solid #e2e8f0', borderRadius: 5,
  background: '#fff', cursor: 'pointer', color: '#475569',
};

// The rail is 212px with two buttons a row, so these keep their slightly smaller text.
const railBtn = { ...BTN.secondary.sm, fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', textAlign: 'left', whiteSpace: 'nowrap' };

const addOptionStyle = {
  display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', fontSize: 13.5, fontWeight: 600,
  background: '#fff', color: '#0f172a', border: '1px solid #cbd5e1', borderRadius: 7,
  textDecoration: 'none', fontFamily: font,
};
