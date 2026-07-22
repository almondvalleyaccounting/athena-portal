import React, { useEffect, useState } from 'react';
import { Mail, MessageSquare, Send } from 'lucide-react';
import { listMessages, sendApplicantEmail, sendApplicantSms } from '../../api';
import { font, input, fieldLabel, btn, fmtNoteTime, EMAIL_TEMPLATES } from '../../recruitmentShared';

// Applicant communications: a timeline of sent messages + a compose box.
// Email rides the recruitment-email edge function (Resend); SMS rides the
// shared sms-send. Both log to recruitment_messages.
export default function CommsPanel({ app, vacancyTitle, profileId }) {
  const c = app.candidate;
  const [messages, setMessages] = useState(null);
  const [channel, setChannel] = useState('email');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [okMsg, setOkMsg] = useState(null);

  useEffect(() => {
    let live = true;
    listMessages(app.id).then((m) => { if (live) setMessages(m); }).catch(() => setMessages([]));
    return () => { live = false; };
  }, [app.id]);

  function applyTemplate(key) {
    const t = EMAIL_TEMPLATES.find((x) => x.key === key);
    if (!t) return;
    const fill = (s) => s.replace(/\{\{name\}\}/g, (c?.full_name || '').split(' ')[0] || 'there').replace(/\{\{role\}\}/g, vacancyTitle || 'the role');
    setSubject(fill(t.subject));
    setBody(fill(t.body));
  }

  async function send() {
    setError(null); setOkMsg(null);
    if (sending) return;
    if (channel === 'email' && !c?.email) { setError('No email on this candidate.'); return; }
    if (channel === 'sms' && !c?.phone) { setError('No phone on this candidate.'); return; }
    if (!body.trim()) { setError('Message body is empty.'); return; }
    if (channel === 'email' && !subject.trim()) { setError('Subject is empty.'); return; }
    setSending(true);
    try {
      if (channel === 'email') {
        await sendApplicantEmail({ applicationId: app.id, to: c.email, subject: subject.trim(), body: body.trim() });
      } else {
        await sendApplicantSms({ applicationId: app.id, candidateId: c.id, to: c.phone, body: body.trim(), channel: 'sms', createdBy: profileId });
      }
      setOkMsg('Sent.');
      setSubject(''); setBody('');
      setMessages(await listMessages(app.id));
    } catch (e) {
      setError(e.message || 'Send failed');
    } finally { setSending(false); }
  }

  const toggle = (val, label, Icon) => (
    <button onClick={() => setChannel(val)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', fontSize: 12.5, fontWeight: 600,
        fontFamily: font, borderRadius: 8, cursor: 'pointer',
        background: channel === val ? '#eff6ff' : '#fff', color: channel === val ? '#0c4a6e' : '#64748b',
        border: `1px solid ${channel === val ? '#93c5fd' : '#e5e7eb'}`,
      }}><Icon size={13} /> {label}</button>
  );

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        {messages === null && <div style={{ fontSize: 12.5, color: '#94a3b8' }}>Loading…</div>}
        {messages !== null && messages.length === 0 && <div style={{ fontSize: 12.5, color: '#94a3b8' }}>No messages yet.</div>}
        {(messages || []).map((m) => (
          <div key={m.id} style={{ padding: '9px 11px', borderRadius: 8, background: '#f8fafc', marginBottom: 8, border: '1px solid #f1f5f9' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              {m.channel === 'email' ? <Mail size={12} color="#94a3b8" /> : <MessageSquare size={12} color="#94a3b8" />}
              <span style={{ fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase' }}>{m.channel}</span>
              {m.status === 'failed' && <span style={{ fontSize: 10, color: '#b91c1c', fontWeight: 700 }}>FAILED</span>}
              <span style={{ marginLeft: 'auto', fontSize: 11, color: '#94a3b8' }}>{fmtNoteTime(m.created_at)}</span>
            </div>
            {m.subject && <div style={{ fontSize: 12.5, fontWeight: 600, color: '#0f172a' }}>{m.subject}</div>}
            <div style={{ fontSize: 12.5, color: '#334155', whiteSpace: 'pre-wrap' }}>{m.body}</div>
            {m.error && <div style={{ fontSize: 11, color: '#b91c1c', marginTop: 3 }}>{m.error}</div>}
          </div>
        ))}
      </div>

      <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 14 }}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          {toggle('email', 'Email', Mail)}
          {toggle('sms', 'SMS', MessageSquare)}
        </div>

        {channel === 'email' && (
          <>
            <select onChange={(e) => applyTemplate(e.target.value)} value="" style={{ ...input, marginBottom: 8 }}>
              <option value="">Insert a template…</option>
              {EMAIL_TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
            <label style={fieldLabel}>To</label>
            <input value={c?.email || ''} disabled style={{ ...input, background: '#f8fafc', color: '#64748b', marginBottom: 8 }} />
            <label style={fieldLabel}>Subject</label>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} style={{ ...input, marginBottom: 8 }} placeholder="Subject" />
          </>
        )}
        {channel === 'sms' && (
          <>
            <label style={fieldLabel}>To</label>
            <input value={c?.phone || ''} disabled style={{ ...input, background: '#f8fafc', color: '#64748b', marginBottom: 8 }} />
          </>
        )}

        <label style={fieldLabel}>Message</label>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={channel === 'email' ? 7 : 4}
          style={{ ...input, resize: 'vertical' }} placeholder={channel === 'email' ? 'Write your email…' : 'Write your text…'} />

        {error && <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 8 }}>{error}</div>}
        {okMsg && <div style={{ fontSize: 12, color: '#166534', marginTop: 8 }}>{okMsg}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
          <button onClick={send} disabled={sending} style={{ ...btn('primary'), opacity: sending ? 0.6 : 1 }}>
            <Send size={13} /> {sending ? 'Sending…' : `Send ${channel === 'email' ? 'email' : 'text'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
