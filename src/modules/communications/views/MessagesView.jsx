import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageSquare, Phone, Plus, RefreshCw, Send, X } from 'lucide-react';
import { useAuth } from '../../../shell/AppShell';
import {
  contactsByPhoneSuffix, counterpartNumber, fmtTime, listMessages,
  loadContacts, loadPeoplePhones, peopleByPhoneSuffix, phoneSuffix,
  resolveEntityNames, sendMessage,
} from '../api';

const font = "'Outfit', sans-serif";

// One-time sign-in codes (Government Gateway, Google…) land on the practice
// number. Mask the digits until someone deliberately reveals them — same
// test the telnyx-inbound function uses to keep them out of notifications.
function isVerificationCode(text) {
  const t = text || '';
  const hasCode = /\b\d{4,8}\b/.test(t) || /\b[A-Z]-\d{4,8}\b/.test(t);
  const saysCode = /\b(code|passcode|verification|verify|one[- ]time|OTP|PIN|security number)\b/i.test(t);
  return hasCode && saysCode;
}
const maskCodes = (text) => (isVerificationCode(text) ? text.replace(/\b\d{4,8}\b/g, '••••••') : text);

// Shared conversation UI for the practice Telnyx number. channel='sms'
// or 'whatsapp' — same table (sms_messages), same send function, the
// channel column keeps the two inboxes apart. Clerk SMS in Teams keeps
// receiving everything in parallel via the webhook relay.
export default function MessagesView({ channel }) {
  const { profile } = useAuth();
  const [messages, setMessages] = useState(null);
  const [names, setNames] = useState({});
  const [revealed, setRevealed] = useState(() => new Set());
  const [contactMap, setContactMap] = useState(() => new Map());
  const [peopleMap, setPeopleMap] = useState(() => new Map());
  const [active, setActive] = useState(null); // counterpart number
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [newNumber, setNewNumber] = useState(null); // null = closed, '' = open empty
  const scrollRef = useRef(null);

  const load = useCallback(async (silent = false) => {
    try {
      const rows = await listMessages(channel);
      setMessages(rows);
      const nameMap = await resolveEntityNames(rows.map((m) => m.entity_id));
      setNames(nameMap);
      if (!silent) setError(null);
    } catch (e) {
      if (!silent) setError(e.message);
    }
  }, [channel]);

  useEffect(() => {
    setMessages(null);
    setActive(null);
    load();
    const iv = setInterval(() => load(true), 30000);
    return () => clearInterval(iv);
  }, [load]);

  // Google Contacts (synced in the Email tab) — second source for
  // matching numbers to names, after the client record.
  useEffect(() => {
    loadContacts().then((c) => setContactMap(contactsByPhoneSuffix(c))).catch(() => {});
  }, []);

  // BrightManager client contacts — third source, behind the client record
  // and the Google contact book. Google holds a number for only 10 of its 918
  // contacts, so without this most clients text in as a bare number.
  useEffect(() => {
    loadPeoplePhones().then((p) => setPeopleMap(peopleByPhoneSuffix(p))).catch(() => {});
  }, []);

  const displayName = (conv) => {
    if (conv.entityId && names[conv.entityId]) return names[conv.entityId];
    const suffix = phoneSuffix(conv.number);
    const contact = contactMap.get(suffix);
    if (contact?.display_name) return contact.display_name;
    return peopleMap.get(suffix)?.name || conv.number;
  };

  // Group into conversations by counterpart number, newest first.
  const conversations = useMemo(() => {
    const byNumber = new Map();
    for (const m of messages || []) {
      const num = counterpartNumber(m);
      if (!byNumber.has(num)) byNumber.set(num, []);
      byNumber.get(num).push(m);
    }
    return [...byNumber.entries()]
      .map(([number, msgs]) => {
        const sorted = [...msgs].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        const entityId = sorted.findLast?.((m) => m.entity_id)?.entity_id
          || [...sorted].reverse().find((m) => m.entity_id)?.entity_id || null;
        return { number, msgs: sorted, last: sorted[sorted.length - 1], entityId };
      })
      .sort((a, b) => new Date(b.last.created_at) - new Date(a.last.created_at));
  }, [messages]);

  const activeConv = conversations.find((c) => c.number === active) || null;

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [activeConv?.msgs?.length, active]);

  const doSend = useCallback(async (toNumber, entityId) => {
    const text = draft.trim();
    if (!text || !toNumber) return;
    setSending(true);
    setError(null);
    try {
      await sendMessage({ to: toNumber, body: text, channel, entityId });
      setDraft('');
      setNewNumber(null);
      setActive(toNumber);
      await load(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  }, [draft, channel, load]);

  const label = channel === 'whatsapp' ? 'WhatsApp' : 'text message';

  if (messages === null) {
    return <div style={{ padding: 30, color: '#64748b', fontSize: 14, fontFamily: font }}>Loading…</div>;
  }

  return (
    <div style={{ display: 'flex', gap: 14, height: '100%', minHeight: 0, fontFamily: font }}>
      {/* ── Conversation list ── */}
      <div style={{ width: 270, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => { setNewNumber(''); setActive(null); setDraft(''); }}
            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '8px 12px', fontSize: 14, fontWeight: 600, background: '#1E4560', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: font }}
          >
            <Plus size={14} /> New {channel === 'whatsapp' ? 'WhatsApp' : 'text'}
          </button>
          <button onClick={() => load()} title="Refresh" style={{ padding: '8px 10px', border: '1px solid #cbd5e1', background: '#fff', borderRadius: 8, cursor: 'pointer', color: '#334155' }}>
            <RefreshCw size={14} />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff' }}>
          {conversations.length === 0 && (
            <div style={{ padding: 24, fontSize: 14, color: '#94a3b8', textAlign: 'center' }}>
              {channel === 'whatsapp'
                ? 'No WhatsApp messages yet. Inbound messages to the practice number will appear here automatically.'
                : 'No text messages yet.'}
            </div>
          )}
          {conversations.map((c) => (
            <div
              key={c.number}
              onClick={() => { setActive(c.number); setNewNumber(null); setError(null); }}
              style={{ padding: '10px 12px', borderBottom: '1px solid #f1f5f9', cursor: 'pointer', background: active === c.number ? '#eff6ff' : '#fff' }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  {displayName(c)}
                </span>
                <span style={{ fontSize: 11.5, color: '#94a3b8', flexShrink: 0 }}>{fmtTime(c.last.created_at)}</span>
              </div>
              {displayName(c) !== c.number && <div style={{ fontSize: 12, color: '#64748b' }}>{c.number}</div>}
              <div style={{ fontSize: 13, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
                {c.last.direction === 'out' ? 'You: ' : ''}{maskCodes(c.last.body)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Thread ── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {error && (
          <div style={{ display: 'flex', gap: 10, padding: '8px 12px', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 8, fontSize: 13, color: '#b91c1c' }}>
            <span style={{ flex: 1 }}>{error}</span>
            <button onClick={() => setError(null)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#b91c1c' }}><X size={13} /></button>
          </div>
        )}

        {newNumber !== null ? (
          <div style={{ border: '1px solid #cbd5e1', borderRadius: 10, background: '#fff', padding: 14, display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 520 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Phone size={14} /> New {label}
            </div>
            <input
              value={newNumber}
              onChange={(e) => setNewNumber(e.target.value)}
              placeholder="Mobile number — 07… or +44…"
              style={{ padding: '8px 10px', fontSize: 14, fontFamily: font, border: '1px solid #e2e8f0', borderRadius: 7 }}
            />
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={4}
              placeholder={`Type your ${label}…`}
              style={{ padding: '8px 10px', fontSize: 14, fontFamily: font, border: '1px solid #e2e8f0', borderRadius: 7, resize: 'vertical' }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => doSend(newNumber)}
                disabled={sending || !draft.trim() || !newNumber.trim()}
                style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 16px', fontSize: 14, fontWeight: 600, background: sending ? '#94a3b8' : '#1E4560', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: font }}
              >
                <Send size={13} /> {sending ? 'Sending…' : 'Send'}
              </button>
              <button onClick={() => { setNewNumber(null); setDraft(''); }} style={{ padding: '8px 14px', fontSize: 14, border: '1px solid #cbd5e1', background: '#fff', borderRadius: 8, cursor: 'pointer', fontFamily: font, color: '#334155' }}>Cancel</button>
            </div>
            {channel === 'whatsapp' && (
              <div style={{ fontSize: 12, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 7, padding: '7px 10px' }}>
                WhatsApp only allows free text within 24 hours of the client&apos;s last message. Use SMS to start a conversation.
              </div>
            )}
          </div>
        ) : activeConv ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <MessageSquare size={15} color="#64748b" />
              <span style={{ fontSize: 14.5, fontWeight: 700, color: '#0f172a' }}>
                {displayName(activeConv)}
              </span>
              <span style={{ fontSize: 13, color: '#94a3b8' }}>{activeConv.number}</span>
              {activeConv.entityId && (
                <Link to={`/clients/${activeConv.entityId}`} style={{ fontSize: 13, color: '#0e7fe0', textDecoration: 'none', fontWeight: 600 }}>
                  Client record →
                </Link>
              )}
            </div>
            <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 10, background: '#f8fafc', padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {activeConv.msgs.map((m) => (
                <div key={m.id} style={{ display: 'flex', justifyContent: m.direction === 'out' ? 'flex-end' : 'flex-start' }}>
                  <div style={{
                    maxWidth: '72%', padding: '8px 12px', borderRadius: 12, fontSize: 14, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    background: m.direction === 'out' ? '#0e7fe0' : '#fff',
                    color: m.direction === 'out' ? '#fff' : '#1e293b',
                    border: m.direction === 'out' ? 'none' : '1px solid #e2e8f0',
                  }}>
                    {revealed.has(m.id) ? m.body : maskCodes(m.body)}
                    {!revealed.has(m.id) && isVerificationCode(m.body) && (
                      <button
                        type="button"
                        onClick={() => setRevealed((prev) => new Set(prev).add(m.id))}
                        style={{ display: 'block', marginTop: 4, padding: 0, border: 'none', background: 'none', color: '#0e7fe0', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: font }}
                      >
                        Show code
                      </button>
                    )}
                    <div style={{ fontSize: 11, marginTop: 4, opacity: 0.75, textAlign: 'right' }}>
                      {fmtTime(m.created_at)}
                      {m.direction === 'out' && ` · ${m.status === 'failed' ? `failed${m.error ? ` — ${m.error}` : ''}` : m.status}`}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(activeConv.number, activeConv.entityId); } }}
                rows={2}
                placeholder={`Reply by ${label}… (Enter to send)`}
                style={{ flex: 1, padding: '9px 12px', fontSize: 14, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 10, resize: 'none', lineHeight: 1.4 }}
              />
              <button
                onClick={() => doSend(activeConv.number, activeConv.entityId)}
                disabled={sending || !draft.trim()}
                style={{ alignSelf: 'stretch', display: 'flex', alignItems: 'center', gap: 7, padding: '0 18px', fontSize: 14, fontWeight: 600, background: sending || !draft.trim() ? '#94a3b8' : '#1E4560', color: '#fff', border: 'none', borderRadius: 10, cursor: sending ? 'default' : 'pointer', fontFamily: font }}
              >
                <Send size={14} /> Send
              </button>
            </div>
          </>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 14, border: '1px dashed #e2e8f0', borderRadius: 10 }}>
            {conversations.length ? 'Pick a conversation' : channel === 'whatsapp'
              ? 'WhatsApp traffic on the practice number will collect here.'
              : 'Texts to and from the practice number will collect here.'}
          </div>
        )}
      </div>
    </div>
  );
}
