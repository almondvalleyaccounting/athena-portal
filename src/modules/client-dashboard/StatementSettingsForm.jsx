import React, { useEffect, useRef, useState } from 'react';
import { addressLines } from './openItems';

/*
  Statement settings — the letterhead a client's customer statements carry.

  Shared with the client portal through @dash: the portal shows it on its
  Preferences page and inside the Overdue invoices tab; Athena shows it in the
  staff tab so the letterhead can be set up on a client's behalf. It does no
  fetching of its own — `load` and `save` are handed in, and both end at the
  statement-settings edge function, which decides who may do either.

  Every field is optional. A blank field falls back to what QuickBooks knows
  about the business (shown as the placeholder), so a client who never opens
  this still gets a statement with their name and address on it.

  THE LOGO is scaled in the browser to at most 800×300 and re-encoded as PNG
  (JPEG if the PNG is still too big), so whatever someone uploads — a 6 MB
  photo, an SVG — arrives as a small raster jsPDF can embed. The server and a
  CHECK constraint both hold the result to PNG/JPEG under ~300 KB.
*/

const FIELDS = [
  { key: 'business_name', label: 'Business name', ph: (b) => b?.name || 'As in QuickBooks' },
  { key: 'address', label: 'Address', multi: 3, ph: (b) => addressLines(b?.address).join('\n') || 'One line per row' },
  { key: 'phone', label: 'Phone', ph: (b) => b?.phone || '' },
  { key: 'email', label: 'Email', ph: (b) => b?.email || '' },
  { key: 'website', label: 'Website', ph: (b) => b?.website || '' },
  { key: 'company_number', label: 'Company number', ph: () => 'e.g. SC123456' },
  { key: 'vat_number', label: 'VAT number', ph: () => 'e.g. GB123456789' },
  { key: 'payment_details', label: 'How to pay', multi: 4, ph: () => 'Bank, sort code and account number, and the reference to quote' },
  { key: 'footer_note', label: 'Note on every statement', multi: 3, ph: () => 'Optional — e.g. your payment terms. Left blank, overdue statements carry a polite reminder.' },
];

const MAX_LOGO = 390000;

function fileToLogo(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not an image we can read'));
      img.onload = () => {
        const w0 = img.naturalWidth || img.width || 400;
        const h0 = img.naturalHeight || img.height || 150;
        const k = Math.min(1, 800 / w0, 300 / h0);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w0 * k));
        canvas.height = Math.max(1, Math.round(h0 * k));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        let url = canvas.toDataURL('image/png');
        if (url.length > MAX_LOGO) {
          // JPEG has no transparency: paint white behind it first.
          const flat = document.createElement('canvas');
          flat.width = canvas.width; flat.height = canvas.height;
          const f = flat.getContext('2d');
          f.fillStyle = '#ffffff';
          f.fillRect(0, 0, flat.width, flat.height);
          f.drawImage(canvas, 0, 0);
          url = flat.toDataURL('image/jpeg', 0.85);
        }
        if (url.length > MAX_LOGO) reject(new Error('That logo is too detailed to use — try a simpler or smaller version'));
        else resolve(url);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

const DEFAULT_PALETTE = {
  text: '#1e293b', muted: '#64748b', faint: '#94a3b8', border: '#e2e8f0',
  accent: '#1E4560', accentText: '#ffffff', surface: '#ffffff', soft: '#f6f8f9',
};

export default function StatementSettingsForm({
  load, save, business = null, palette = null, onSaved, onClose, title = 'Statement settings',
}) {
  const p = { ...DEFAULT_PALETTE, ...(palette || {}) };
  const [values, setValues] = useState(null);
  const [logo, setLogo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const s = await load();
        if (!live) return;
        setValues(Object.fromEntries(FIELDS.map((f) => [f.key, s?.[f.key] || ''])));
        setLogo(s?.logo_data_url || null);
      } catch (e) {
        if (live) { setValues(Object.fromEntries(FIELDS.map((f) => [f.key, '']))); setMsg({ bad: true, text: String(e?.message || e) }); }
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setMsg(null);
    try { setLogo(await fileToLogo(file)); } catch (err) { setMsg({ bad: true, text: err.message }); }
  };

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const saved = await save({ ...values, logo_data_url: logo });
      setMsg({ bad: false, text: 'Saved. Your next statements will use these details.' });
      onSaved?.(saved);
    } catch (e) {
      setMsg({ bad: true, text: String(e?.message || e) });
    }
    setBusy(false);
  };

  const input = {
    width: '100%', boxSizing: 'border-box', border: `1px solid ${p.border}`, borderRadius: 9,
    padding: '8px 10px', fontSize: 14, color: p.text, background: p.surface, fontFamily: 'inherit',
  };
  const btn = (primary) => ({
    border: primary ? 'none' : `1px solid ${p.border}`, borderRadius: 9, padding: '8px 14px',
    fontSize: 14, fontWeight: 600, cursor: busy ? 'default' : 'pointer',
    background: primary ? p.accent : p.surface, color: primary ? p.accentText : p.text,
    opacity: busy ? 0.6 : 1,
  });

  return (
    <div style={{ background: p.surface, border: `1px solid ${p.border}`, borderRadius: 14, padding: '16px 18px', marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: p.text }}>{title}</div>
        {onClose && <button onClick={onClose} style={{ ...btn(false), padding: '4px 10px', fontSize: 13 }}>Close</button>}
      </div>
      <div style={{ fontSize: 13, color: p.muted, marginBottom: 14, lineHeight: 1.5 }}>
        What your customer statements carry. Anything left blank uses the details in your QuickBooks.
      </div>

      {!values ? (
        <div style={{ fontSize: 14, color: p.faint }}>Loading…</div>
      ) : (
        <>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: p.muted, marginBottom: 6 }}>Logo</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            <div style={{
              width: 200, height: 76, border: `1px dashed ${p.border}`, borderRadius: 10, background: p.soft,
              display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
            }}>
              {logo
                ? <img src={logo} alt="Your logo" style={{ maxWidth: '92%', maxHeight: '86%', objectFit: 'contain' }} />
                : <span style={{ fontSize: 12.5, color: p.faint }}>No logo yet</span>}
            </div>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif" onChange={pick} style={{ display: 'none' }} />
            <button type="button" onClick={() => fileRef.current?.click()} style={btn(false)}>{logo ? 'Replace logo' : 'Upload logo'}</button>
            {logo && <button type="button" onClick={() => setLogo(null)} style={btn(false)}>Remove</button>}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px 16px' }}>
            {FIELDS.map((f) => (
              <label key={f.key} style={{ display: 'block', gridColumn: f.multi ? '1 / -1' : undefined }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: p.muted, marginBottom: 4 }}>{f.label}</div>
                {f.multi ? (
                  <textarea
                    rows={f.multi} value={values[f.key]} placeholder={f.ph(business)}
                    onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                    style={{ ...input, resize: 'vertical' }}
                  />
                ) : (
                  <input
                    value={values[f.key]} placeholder={f.ph(business)}
                    onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                    style={input}
                  />
                )}
              </label>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
            <button type="button" onClick={submit} disabled={busy} style={btn(true)}>{busy ? 'Saving…' : 'Save settings'}</button>
            {msg && <span style={{ fontSize: 13.5, color: msg.bad ? '#b91c1c' : '#047857' }}>{msg.text}</span>}
          </div>
        </>
      )}
    </div>
  );
}
