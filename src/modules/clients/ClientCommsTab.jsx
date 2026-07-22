import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Mail, MessageSquare, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { loadClientEmails, listEntitySms, parseAddress, fmtTime } from '../communications/api';

const font = "'Outfit', sans-serif";
const ACCENT = '#0e7fe0';

// Full email HTML rendered in a sandboxed iframe (same pattern as the
// Communications module's EmailView — prevents stored HTML from touching the
// app DOM). Plain-text-only emails fall back to a <pre> block.
function EmailBody({ html, text }) {
  const ref = useRef(null);
  const [height, setHeight] = useState(160);

  const measure = () => {
    try {
      const doc = ref.current?.contentDocument;
      const h = doc?.body?.scrollHeight;
      if (h) setHeight(Math.min(h + 16, 1400));
    } catch { /* sandbox quirk */ }
  };
  const onLoad = () => { measure(); [200, 600, 1500].forEach((ms) => setTimeout(measure, ms)); };

  if (!html) {
    return (
      <pre style={{ margin: 0, padding: '10px 14px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: font, fontSize: 13, color: '#1e293b' }}>
        {text || '(no content)'}
      </pre>
    );
  }
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

function DirectionChip({ direction }) {
  const inbound = direction === 'in';
  const Icon = inbound ? ArrowDownLeft : ArrowUpRight;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, fontWeight: 600,
      padding: '1px 7px', borderRadius: 999, whiteSpace: 'nowrap',
      background: inbound ? '#eff6ff' : '#f1f5f9', color: inbound ? ACCENT : '#475569',
      border: `1px solid ${inbound ? '#bfdbfe' : '#e2e8f0'}`,
    }}>
      <Icon size={11} /> {inbound ? 'Received' : 'Sent'}
    </span>
  );
}

function ChannelIcon({ kind }) {
  if (kind === 'email') return <Mail size={15} color="#64748b" />;
  return <MessageSquare size={15} color={kind === 'whatsapp' ? '#16a34a' : '#64748b'} />;
}

function EmailItem({ item }) {
  const [open, setOpen] = useState(false);
  const who = item.direction === 'in'
    ? (item.from_name || item.from_email || 'Client')
    : `to ${(item.to_emails || []).join(', ') || item.matched_email || 'client'}`;
  return (
    <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff', overflow: 'hidden' }}>
      <div onClick={() => setOpen((o) => !o)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer' }}>
        <ChannelIcon kind="email" />
        <DirectionChip direction={item.direction} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.subject || '(no subject)'}
          </div>
          <div style={{ fontSize: 11.5, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {who}{!open && item.snippet ? ` — ${item.snippet}` : ''}
          </div>
        </div>
        <span style={{ fontSize: 11, color: '#94a3b8', whiteSpace: 'nowrap' }}>{fmtTime(item.occurred_at)}</span>
      </div>
      {open && (
        <div style={{ borderTop: '1px solid #f1f5f9' }}>
          <div style={{ padding: '6px 14px', fontSize: 11, color: '#94a3b8', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <span>From: {item.from_email || '—'}</span>
            <span>To: {(item.to_emails || []).join(', ') || '—'}</span>
            {item.cc_emails?.length ? <span>Cc: {item.cc_emails.join(', ')}</span> : null}
            <span style={{ marginLeft: 'auto' }}>via {item.mailboxes.join(', ')}</span>
          </div>
          <EmailBody html={item.body_html} text={item.body_text} />
        </div>
      )}
    </div>
  );
}

function SmsItem({ item }) {
  const label = item.kind === 'whatsapp' ? 'WhatsApp' : 'SMS';
  const counterpart = item.direction === 'out' ? item.to_number : item.from_number;
  return (
    <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff', padding: '10px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <ChannelIcon kind={item.kind} />
        <DirectionChip direction={item.direction} />
        <span style={{ fontSize: 12, color: '#334155' }}>{label} · {counterpart || '—'}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#94a3b8', whiteSpace: 'nowrap' }}>{fmtTime(item.created_at)}</span>
      </div>
      <div style={{ fontSize: 13, color: '#1e293b', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{item.body}</div>
    </div>
  );
}

export default function ClientCommsTab({ entityId }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [emails, setEmails] = useState([]);
  const [sms, setSms] = useState([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const [em, sm] = await Promise.all([loadClientEmails(entityId), listEntitySms(entityId)]);
        if (!alive) return;
        setEmails(em);
        setSms(sm);
        setError(null);
      } catch (ex) {
        if (alive) setError(ex.message || String(ex));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [entityId]);

  // Merge into one timeline. Emails de-dupe across mailboxes on the RFC
  // Message-ID (the same mail seen in info@ and a personal inbox shows once,
  // annotated with every mailbox it was found in).
  const timeline = useMemo(() => {
    const byRfc = new Map();
    const items = [];
    for (const e of emails) {
      const key = e.rfc_message_id || `id:${e.id}`;
      if (byRfc.has(key)) {
        const prev = byRfc.get(key);
        if (!prev.mailboxes.includes(e.mailbox)) prev.mailboxes.push(e.mailbox);
        continue;
      }
      const item = { type: 'email', ts: e.occurred_at, ...e, mailboxes: [e.mailbox] };
      byRfc.set(key, item);
      items.push(item);
    }
    for (const s of sms) {
      items.push({ type: 'sms', ts: s.created_at, kind: s.channel || 'sms', ...s });
    }
    items.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    return items;
  }, [emails, sms]);

  if (loading) return <div style={{ padding: 24, fontFamily: font, color: '#64748b', fontSize: 13 }}>Loading communications…</div>;
  if (error) {
    return (
      <div style={{ border: '1px solid #fecaca', background: '#fef2f2', borderRadius: 12, padding: '12px 16px', fontFamily: font, fontSize: 13, color: '#b91c1c' }}>
        Could not load communications: {error}
      </div>
    );
  }
  if (!timeline.length) {
    return (
      <div style={{ border: '1px solid #e5e7eb', background: '#fff', borderRadius: 12, textAlign: 'center', padding: '44px 24px', fontFamily: font }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', marginBottom: 6 }}>No communications yet</div>
        <div style={{ fontSize: 13, color: '#64748b', maxWidth: 460, margin: '0 auto' }}>
          Emails to or from this client's known addresses, plus any SMS/WhatsApp, will appear here.
        </div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: font }}>
      <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 10 }}>
        {timeline.length} item{timeline.length === 1 ? '' : 's'} · emails matched to this client across all connected mailboxes, merged with SMS/WhatsApp
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {timeline.map((it) => (
          it.type === 'email'
            ? <EmailItem key={`e-${it.id}`} item={it} />
            : <SmsItem key={`s-${it.id}`} item={it} />
        ))}
      </div>
    </div>
  );
}
