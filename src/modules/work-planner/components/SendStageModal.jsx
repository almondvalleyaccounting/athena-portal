import React, { useEffect, useState } from 'react';
import { callJobPlan } from '../plan/planQueries';
import { BTN } from '../../../lib/buttonStyles';

// The client chaser in two screens (Bobby, 2026-09-26). First the draft:
// what to ask for (select all / none per section), whether to include the
// friendly opener, which sign-off, name or signature — each person's choices
// are their defaults next time. Then Next: the email itself, editable,
// then Send. Requests and chases close on send.

const font = "'Outfit', sans-serif";
const GRP_LABEL = { company: 'Company records', personal: 'Director’s personal tax', other: 'Other' };
const SIGNOFFS = ['Kind regards', 'Best regards', 'Thanks', 'Cheers', 'Many thanks'];
const input = { padding: '6px 10px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 6, width: '100%' };
const small = { fontSize: 12, fontWeight: 600, color: '#94a3b8' };

export default function SendStageModal({ milestone, myEmail, onClose, onSent }) {
  const [step, setStep] = useState(1);
  const [preview, setPreview] = useState(null);
  const [to, setTo] = useState('');
  const [picker, setPicker] = useState(null);
  const [custom, setCustom] = useState('');
  const [prefs, setPrefs] = useState(null);
  const [hasSignature, setHasSignature] = useState(false);
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const p = milestone.job_plans;

  const picked = (pk = picker) => (pk || []).filter((i) => i.ticked).map((i) => (i.key ? { key: i.key } : { text: i.label }));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [res, pr] = await Promise.all([
          callJobPlan({ action: 'preview_comms', milestone_id: milestone.id }),
          callJobPlan({ action: 'get_comms_prefs' }),
        ]);
        if (cancelled) return;
        setPreview(res.preview); setTo(res.preview.to || '');
        if (res.preview.picker) setPicker(res.preview.picker);
        setPrefs(pr.prefs); setHasSignature(!!pr.has_signature);
        if (res.sent_at) setNote(`Already sent ${res.sent_at.slice(0, 10)} to ${res.sent_to}`);
      } catch (e) { if (!cancelled) setError(e.message || String(e)); }
    })();
    return () => { cancelled = true; };
  }, [milestone.id]);

  const setGroup = (grp, ticked) => setPicker((pk) => pk.map((i) => (i.grp === grp ? { ...i, ticked } : i)));
  const addCustom = () => {
    const t = custom.trim();
    if (!t) return;
    setPicker((pk) => [...pk, { key: null, label: t, grp: 'other', ticked: true, remembered: false }]);
    setCustom('');
  };

  // Next: render with the draft choices, then let the text be edited.
  const next = async () => {
    setBusy(true); setError(null);
    try {
      const res = await callJobPlan({ action: 'preview_comms', milestone_id: milestone.id, ...(picker ? { items: picked() } : {}), prefs });
      setSubject(res.preview.subject); setText(res.preview.text);
      setStep(2);
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };

  const saveDefaults = async () => {
    try { await callJobPlan({ action: 'set_comms_prefs', prefs }); setNote('Saved as your defaults.'); }
    catch (e) { setError(e.message || String(e)); }
  };

  const send = async (test) => {
    setBusy(true); setError(null);
    try {
      const res = await callJobPlan({
        action: 'send_comms', milestone_id: milestone.id, test,
        to: test ? myEmail : (to !== preview?.to ? to : undefined),
        ...(picker ? { items: picked() } : {}), prefs, subject, text,
      });
      if (test) setNote(`Test copy sent to ${res.to}.`);
      else { onSent(); onClose(); }
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };

  const groups = picker ? ['company', 'personal', 'other'].filter((g) => picker.some((i) => i.grp === g)) : [];

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.25)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 10, width: step === 1 && picker ? 900 : 660, maxWidth: '96vw', maxHeight: '92vh', overflow: 'auto', padding: 18, fontFamily: font, boxShadow: '0 4px 16px rgba(0,0,0,0.15)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
          <div style={{ fontSize: 16, fontWeight: 600, flex: 1 }}>{milestone.label} · {p.entities?.name}</div>
          <div style={{ fontSize: 12, color: '#94a3b8' }}>Step {step} of 2 · {step === 1 ? 'Draft' : 'Email'}</div>
        </div>
        <div style={{ fontSize: 12.5, color: '#64748b', marginBottom: 10 }}>
          {preview?.from_email ? `Goes from your mailbox (${preview.from_email})` : `Goes from the practice mailbox with ${preview?.from_name ? `${preview.from_name}’s` : 'your'} name on it`}, plain text, and is logged on the client page.
        </div>
        {error && <div style={{ padding: '8px 12px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13, marginBottom: 8 }}>{error}</div>}
        {note && <div style={{ padding: '8px 12px', borderRadius: 8, background: '#dcfce7', color: '#166534', fontSize: 13, marginBottom: 8 }}>{note}</div>}
        {!preview || !prefs ? <div style={{ color: '#94a3b8' }}>Rendering…</div> : step === 1 ? (
          <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start' }}>
            {picker && (
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ ...small, marginBottom: 4 }}>What to ask this client for</div>
                <div style={{ fontSize: 11.5, color: '#94a3b8', marginBottom: 8 }}>{picker.some((i) => i.remembered) ? 'Pre-ticked from what we asked them for last time.' : 'Pre-ticked defaults for this kind of request.'} Your ticks are remembered for next year.</div>
                {groups.map((g) => (
                  <div key={g} style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '4px 0' }}>
                      <span style={{ fontSize: 11.5, fontWeight: 600, color: '#475569', flex: 1 }}>{GRP_LABEL[g]}</span>
                      <button onClick={() => setGroup(g, true)} style={{ ...BTN.secondary.sm, padding: '1px 7px', fontSize: 11.5 }}>All</button>
                      <button onClick={() => setGroup(g, false)} style={{ ...BTN.secondary.sm, padding: '1px 7px', fontSize: 11.5 }}>None</button>
                    </div>
                    {picker.map((i, idx) => i.grp === g && (
                      <label key={i.key || `c${idx}`} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12.5, padding: '2px 0', cursor: 'pointer' }}>
                        <input type="checkbox" checked={i.ticked} onChange={(e) => setPicker((pk) => pk.map((x, n) => (n === idx ? { ...x, ticked: e.target.checked } : x)))} style={{ marginTop: 3 }} />
                        <span>{i.label}{i.remembered && <span style={{ color: '#94a3b8' }}> · last year</span>}</span>
                      </label>
                    ))}
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <input value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addCustom(); }} placeholder="Something specific, e.g. the invoice for the new van" style={{ ...input, padding: '5px 8px', fontSize: 12.5 }} />
                  <button onClick={addCustom} style={BTN.secondary.sm}>Add</button>
                </div>
              </div>
            )}
            <div style={{ width: picker ? 320 : '100%', flexShrink: 0 }}>
              <div style={{ ...small, marginBottom: 6 }}>How it reads</div>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer', marginBottom: 4 }}>
                <input type="checkbox" checked={prefs.opener_enabled} onChange={(e) => setPrefs({ ...prefs, opener_enabled: e.target.checked })} />Include a friendly opener
              </label>
              <input value={prefs.opener_text} disabled={!prefs.opener_enabled} onChange={(e) => setPrefs({ ...prefs, opener_text: e.target.value })} style={{ ...input, marginBottom: 10, opacity: prefs.opener_enabled ? 1 : 0.5 }} />
              <div style={{ ...small, marginBottom: 4 }}>Sign off with</div>
              <select value={prefs.signoff} onChange={(e) => setPrefs({ ...prefs, signoff: e.target.value })} style={{ ...input, marginBottom: 10 }}>
                {SIGNOFFS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <div style={{ display: 'flex', gap: 12, fontSize: 13, marginBottom: 10 }}>
                <label style={{ display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}><input type="radio" checked={prefs.signature_mode === 'name'} onChange={() => setPrefs({ ...prefs, signature_mode: 'name' })} />Your first name</label>
                <label style={{ display: 'flex', gap: 5, alignItems: 'center', cursor: hasSignature ? 'pointer' : 'default', opacity: hasSignature ? 1 : 0.5 }} title={hasSignature ? '' : 'Save a signature under Communications first'}><input type="radio" disabled={!hasSignature} checked={prefs.signature_mode === 'signature'} onChange={() => setPrefs({ ...prefs, signature_mode: 'signature' })} />Your signature</label>
              </div>
              <button onClick={saveDefaults} style={{ ...BTN.secondary.sm, marginBottom: 14 }}>Save as my defaults</button>
              <div style={{ ...small, marginBottom: 4 }}>To</div>
              <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="No email address on file" style={input} />
              {preview.to_reason && <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 3 }}>{preview.to_reason}</div>}
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 16 }}>
                <button onClick={onClose} style={BTN.secondary.sm}>Cancel</button>
                <button onClick={next} disabled={busy} style={BTN.primary.sm}>{busy ? 'Rendering…' : 'Next →'}</button>
              </div>
            </div>
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <span style={{ ...small, width: 56 }}>To</span>
              <input value={to} onChange={(e) => setTo(e.target.value)} style={input} />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <span style={{ ...small, width: 56 }}>Subject</span>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} style={input} />
            </div>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={14} style={{ ...input, fontSize: 13.5, lineHeight: 1.5, resize: 'vertical', background: '#f8fafc', marginBottom: 10 }} />
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button onClick={() => setStep(1)} style={{ ...BTN.secondary.sm, marginRight: 'auto' }}>← Back to the draft</button>
              <button onClick={onClose} style={BTN.secondary.sm}>Cancel</button>
              {myEmail && <button onClick={() => send(true)} disabled={busy} style={BTN.secondary.sm}>Send a copy to me</button>}
              <button onClick={() => send(false)} disabled={busy || !to || !subject.trim() || !text.trim()} style={{ ...BTN.primary.sm, opacity: busy || !to ? 0.5 : 1 }}>{busy ? 'Sending…' : `Send to client${preview.completes ? ' and mark done' : ''}`}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
