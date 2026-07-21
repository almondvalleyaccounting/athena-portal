import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageSquare, Phone, Plus, RefreshCw, Send, X } from 'lucide-react';
import { useAuth } from '../../../shell/AppShell';
import { counterpartNumber, fmtTime, listMessages, resolveEntityNames, sendMessage } from '../api';

const font = "'Outfit', sans-serif";

// Shared conversation UI for the practice Telnyx number. channel='sms'
// or 'whatsapp' — same table (sms_messages), same send function, the
// channel column keeps the two inboxes apart. Clerk SMS in Teams keeps
// receiving everything in parallel via the webhook relay.
export default function MessagesView({ channel }) {
  const { profile } = useAuth();
  const [messages, setMessages] = useState(null);
  const [names, setNames] = useState({});
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
    return <div style={{ padding: 30, color: '#64748b', fontSize: 13, fontFamily: font }}>Loading…</div>;
  }

  return (
    <div style={{ display: 'flex', gap: 14, height: '100%', minHeight: 0, fontFamily: font }}>
      {/* ── Conversation list ── */}
      <div style={{ width: 270, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => { setNewNumber(''); setActive(null); setDraft(''); }}
            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '8px 12px', fontSize: 13, fontWeight: 600, background: '#0f172a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: font }}
          >
            <Plus size={14} /> New {channel === 'whatsapp' ? 'WhatsApp' : 'text'}
          </button>
          <button onClick={() => load()} title="Refresh" style={{ padding: '8px 10px', border: '1px solid #cbd5e1', background: '#fff', borderRadius: 8, cursor: 'pointer', color: '#334155' }}>
            <RefreshCw size={14} />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff' }}>
          {conversations.length === 0 && (
            <div style={{ padding: 24, fontSize: 13, color: '#94a3b8', textAlign: 'center' }}>
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
                <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  {c.entityId ? (names[c.entityId] || c.number) : c.number}
                </span>
                <span style={{ fontSize: 10.5, color: '#94a3b8', flexShrink: 0 }}>{fmtTime(c.last.created_at)}</span>
              </div>
              {c.entityId && <div style={{ fontSize: 11, color: '#64748b' }}>{c.number}</div>}
              <div style={{ fontSize: 12, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
                {c.last.direction === 'out' ? 'You: ' : ''}{c.last.body}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Thread ── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {error && (
          <div style={{ display: 'flex', gap: 10, padding: '8px 12px', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 8, fontSize: 12, color: '#b91c1c' }}>
            <span style={{ flex: 1 }}>{error}</span>
            <button onClick={() => setError(null)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#b91c1c' }}><X size={13} /></button>
          </div>
        )}

        {newNumber !== null ? (
          <div style={{ border: '1px solid #cbd5e1', borderRadius: 10, background: '#fff', padding: 14, display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 520 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Phone size={14} /> New {label}
            </div>
            <input
              value={newNumber}
              onChange={(e) => setNewNumber(e.target.value)}
              placeholder="Mobile number — 07… or +44…"
              style={{ padding: '8px 10px', fontSize: 13, fontFamily: font, border: '1px solid #e2e8f0', borderRadius: 7 }}
            />
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={4}
              placeholder={`Type your ${label}…`}
              style={{ padding: '8px 10px', fontSize: 13, fontFamily: font, border: '1px solid #e2e8f0', borderRadius: 7, resize: 'vertical' }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => doSend(newNumber)}
                disabled={sending || !draft.trim() || !newNumber.trim()}
                style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 16px', fontSize: 13, fontWeight: 600, background: sending ? '#94a3b8' : '#0e7fe0', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: font }}
              >
                <Send size={13} /> {sending ? 'Sending…' : 'Send'}
              </button>
              <button onClick={() => { setNewNumber(null); setDraft(''); }} style={{ padding: '8px 14px', fontSize: 13, border: '1px solid #cbd5e1', background: '#fff', borderRadius: 8, cursor: 'pointer', fontFamily: font, color: '#334155' }}>Cancel</button>
            </div>
            {channel === 'whatsapp' && (
              <div style={{ fontSize: 11, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 7, padding: '7px 10px' }}>
                WhatsApp only allows free-form replies within 24h of the client&apos;s last message. Outside that window the send will fail unless a pre-approved template is registered — starting new conversations is usually better done by SMS.
              </div>
            )}
          </div>
        ) : activeConv ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <MessageSquare size={15} color="#64748b" />
              <span style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>
                {activeConv.entityId ? (names[activeConv.entityId] || activeConv.number) : activeConv.number}
              </span>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>{activeConv.number}</span>
              {activeConv.entityId && (
                <Link to={`/clients/${activeConv.entityId}`} style={{ fontSize: 12, color: '#0e7fe0', textDecoration: 'none', fontWeight: 600 }}>
                  Client record →
                </Link>
              )}
            </div>
            <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 10, background: '#f8fafc', padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {activeConv.msgs.map((m) => (
                <div key={m.id} style={{ display: 'flex', justifyContent: m.direction === 'out' ? 'flex-end' : 'flex-start' }}>
                  <div style={{
                    maxWidth: '72%', padding: '8px 12px', borderRadius: 12, fontSize: 13, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    background: m.direction === 'out' ? '#0e7fe0' : '#fff',
                    color: m.direction === 'out' ? '#fff' : '#1e293b',
                    border: m.direction === 'out' ? 'none' : '1px solid #e2e8f0',
                  }}>
                    {m.body}
                    <div style={{ fontSize: 10, marginTop: 4, opacity: 0.75, textAlign: 'right' }}>
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
                style={{ flex: 1, padding: '9px 12px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 10, resize: 'none', lineHeight: 1.4 }}
              />
              <button
                onClick={() => doSend(activeConv.number, activeConv.entityId)}
                disabled={sending || !draft.trim()}
                style={{ alignSelf: 'stretch', display: 'flex', alignItems: 'center', gap: 7, padding: '0 18px', fontSize: 13, fontWeight: 600, background: sending || !draft.trim() ? '#94a3b8' : '#0e7fe0', color: '#fff', border: 'none', borderRadius: 10, cursor: sending ? 'default' : 'pointer', fontFamily: font }}
              >
                <Send size={14} /> Send
              </button>
            </div>
          </>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 13, border: '1px dashed #e2e8f0', borderRadius: 10 }}>
            {conversations.length ? 'Pick a conversation' : channel === 'whatsapp'
              ? 'WhatsApp traffic on the practice number will collect here.'
              : 'Texts to and from the practice number will collect here.'}
          </div>
        )}
      </div>
    </div>
  );
}
