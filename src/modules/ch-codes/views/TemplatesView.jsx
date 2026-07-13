import React, { useEffect, useState } from 'react';
import { Save, Check } from 'lucide-react';
import { tones } from '../../../lib/tokens';
import ChSubNav from '../components/ChSubNav';
import { useAuth } from '../../../shell/AppShell';
import { listTemplates, saveTemplate, getEmailSignature, saveEmailSignature } from '../api';
import { renderTemplate, wrapShell } from '../emailRender';

const font = "'Outfit', sans-serif";
const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 };
const inputStyle = { width: '100%', padding: '9px 11px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8, boxSizing: 'border-box' };
const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, lineHeight: 1.5 };
const SAMPLE = { person: 'Jane Smith', entity: 'Acme Trading Ltd' };

function SaveBtn({ onClick, busy, saved, dirty }) {
  return (
    <button onClick={onClick} disabled={busy || !dirty}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: font, fontSize: 13, fontWeight: 600,
        padding: '8px 16px', borderRadius: 10, border: 'none', cursor: (busy || !dirty) ? 'not-allowed' : 'pointer',
        background: saved ? tones.success.solid : (dirty ? '#0f172a' : '#e5e7eb'), color: (saved || dirty) ? '#fff' : '#94a3b8',
      }}>
      {saved ? <><Check size={15} /> Saved</> : <><Save size={15} /> {busy ? 'Saving…' : 'Save'}</>}
    </button>
  );
}

// The shared signature (Sophie by default) appended to every email.
function SignatureEditor({ initial, onSaved }) {
  const [html, setHtml] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const dirty = html !== initial;

  async function save() {
    setBusy(true); setError(null); setSaved(false);
    try { await saveEmailSignature(html); onSaved(html); setSaved(true); setTimeout(() => setSaved(false), 2500); }
    catch (e) { setError(e.message); }
    setBusy(false);
  }

  return (
    <div style={{ ...card, borderColor: '#dbeafe' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>Signature</div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>Appended to the bottom of every CH-code email.</div>
        </div>
        <SaveBtn onClick={save} busy={busy} saved={saved} dirty={dirty} />
      </div>
      {error && <div style={{ color: tones.danger.fg, fontSize: 13, marginBottom: 10 }}>{error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <textarea value={html} onChange={(e) => setHtml(e.target.value)} rows={6}
          style={{ ...inputStyle, ...mono, resize: 'vertical' }} />
        <iframe title="preview-signature" srcDoc={wrapShell('', { signatureHtml: html })}
          style={{ width: '100%', height: 150, border: '1px solid #e5e7eb', borderRadius: 10, background: '#fff' }} />
      </div>
    </div>
  );
}

function TemplateEditor({ tpl, onSave, actorId, signature }) {
  const [subject, setSubject] = useState(tpl.subject);
  const [body, setBody] = useState(tpl.body_html);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  const dirty = subject !== tpl.subject || body !== tpl.body_html;
  const preview = renderTemplate({ subject, body_html: body }, SAMPLE, { signatureHtml: signature });

  async function save() {
    setBusy(true); setError(null); setSaved(false);
    try {
      await saveTemplate(tpl.key, { subject, body_html: body }, { actorId });
      onSave(tpl.key, { subject, body_html: body });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>{tpl.label}</div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
            Placeholders:{' '}
            <code style={{ background: '#f1f5f9', padding: '1px 5px', borderRadius: 4 }}>{'{{first_name}}'}</code>{' '}
            <code style={{ background: '#f1f5f9', padding: '1px 5px', borderRadius: 4 }}>{'{{person}}'}</code>{' '}
            <code style={{ background: '#f1f5f9', padding: '1px 5px', borderRadius: 4 }}>{'{{entity}}'}</code>
          </div>
        </div>
        <SaveBtn onClick={save} busy={busy} saved={saved} dirty={dirty} />
      </div>

      {error && <div style={{ color: tones.danger.fg, fontSize: 13, marginBottom: 10 }}>{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <label style={{ fontSize: 12, fontWeight: 700, color: '#475569', display: 'block', marginBottom: 5 }}>Subject</label>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} style={inputStyle} />
          <label style={{ fontSize: 12, fontWeight: 700, color: '#475569', display: 'block', margin: '14px 0 5px' }}>Body (HTML)</label>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={14}
            style={{ ...inputStyle, ...mono, resize: 'vertical' }} />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 700, color: '#475569', display: 'block', marginBottom: 5 }}>
            Preview <span style={{ fontWeight: 500, color: '#94a3b8' }}>(sample: {SAMPLE.person} · {SAMPLE.entity})</span>
          </label>
          <div style={{ fontSize: 12.5, color: '#0f172a', fontWeight: 600, padding: '6px 10px', background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, marginBottom: 8 }}>
            {preview.subject}
          </div>
          <iframe title={`preview-${tpl.key}`} srcDoc={preview.html} style={{ width: '100%', height: 420, border: '1px solid #e5e7eb', borderRadius: 10, background: '#fff' }} />
        </div>
      </div>
    </div>
  );
}

export default function TemplatesView() {
  const { profile } = useAuth();
  const [templates, setTemplates] = useState(null);
  const [signature, setSignature] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([listTemplates(), getEmailSignature()])
      .then(([t, sig]) => { setTemplates(t); setSignature(sig); })
      .catch((e) => setError(e.message));
  }, []);

  const handleSaved = (key, patch) => {
    setTemplates((prev) => prev.map((t) => (t.key === key ? { ...t, ...patch } : t)));
  };

  return (
    <div style={{ padding: '24px 28px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a' }}>Email templates</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
            The wording used when you queue CH-code emails. Edits apply to newly-queued emails.
          </p>
        </div>
        <ChSubNav active="Templates" />
      </div>

      {error && <div style={{ color: tones.danger.fg, fontSize: 13, marginBottom: 12 }}>Failed: {error}</div>}
      {!templates && !error && <div style={{ color: '#64748b', fontSize: 13 }}>Loading…</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {templates && <SignatureEditor initial={signature} onSaved={setSignature} />}
        {templates && templates.map((tpl) => (
          <TemplateEditor key={tpl.key} tpl={tpl} onSave={handleSaved} actorId={profile?.id} signature={signature} />
        ))}
      </div>
    </div>
  );
}
