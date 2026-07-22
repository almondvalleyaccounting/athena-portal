import React, { useEffect, useState } from 'react';
import { getOffer, upsertOffer } from '../../api';
import { input, fieldLabel, btn, font, SALARY_PERIODS, OFFER_STATUSES, fmtDate } from '../../recruitmentShared';

const STATUS_MAP = Object.fromEntries(OFFER_STATUSES.map((s) => [s.key, s]));

export default function OfferPanel({ app, profileId }) {
  const [offer, setOffer] = useState(undefined); // undefined=loading, null=none
  const [f, setF] = useState({ salary: '', salary_period: 'year', start_date: '', letter_url: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    getOffer(app.id).then((o) => {
      if (!live) return;
      setOffer(o);
      if (o) setF({ salary: o.salary ?? '', salary_period: o.salary_period || 'year', start_date: o.start_date || '', letter_url: o.letter_url || '', notes: o.notes || '' });
    }).catch((e) => { setOffer(null); setError(e.message); });
    return () => { live = false; };
  }, [app.id]);

  async function save(extra = {}) {
    setSaving(true); setError(null);
    try {
      const o = await upsertOffer(app.id, {
        salary: f.salary === '' ? null : Number(f.salary),
        salary_period: f.salary_period,
        start_date: f.start_date || null,
        letter_url: f.letter_url.trim() || null,
        notes: f.notes.trim() || null,
        ...extra,
      }, profileId);
      setOffer(o);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  if (offer === undefined) return <div style={{ fontSize: 12.5, color: '#94a3b8' }}>Loading…</div>;
  const st = offer ? STATUS_MAP[offer.status] : null;
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  return (
    <div>
      {st && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 9px', borderRadius: 999, background: st.tone.bg, color: st.tone.fg, border: `1px solid ${st.tone.border}`, textTransform: 'uppercase' }}>{st.label}</span>
          {offer.sent_at && <span style={{ fontSize: 11.5, color: '#94a3b8' }}>Sent {fmtDate(offer.sent_at)}</span>}
          {offer.responded_at && <span style={{ fontSize: 11.5, color: '#94a3b8' }}>· Responded {fmtDate(offer.responded_at)}</span>}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <label style={fieldLabel}>Salary (£)</label>
          <input type="number" value={f.salary} onChange={set('salary')} style={input} placeholder="30000" />
        </div>
        <div style={{ width: 110 }}>
          <label style={fieldLabel}>Per</label>
          <select value={f.salary_period} onChange={set('salary_period')} style={input}>
            {SALARY_PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label.replace('per ', '')}</option>)}
          </select>
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <label style={fieldLabel}>Start date</label>
        <input type="date" value={f.start_date} onChange={set('start_date')} style={input} />
      </div>
      <div style={{ marginTop: 10 }}>
        <label style={fieldLabel}>Offer letter link</label>
        <input value={f.letter_url} onChange={set('letter_url')} style={input} placeholder="Drive / URL" />
      </div>
      <div style={{ marginTop: 10 }}>
        <label style={fieldLabel}>Notes</label>
        <textarea value={f.notes} onChange={set('notes')} rows={2} style={{ ...input, resize: 'vertical' }} />
      </div>

      {error && <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 8 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button onClick={() => save()} disabled={saving} style={btn('primary')}>{offer ? 'Save' : 'Create draft offer'}</button>
        {offer && offer.status === 'draft' && <button onClick={() => save({ status: 'sent', sent_at: new Date().toISOString() })} style={btn('secondary')}>Mark sent</button>}
        {offer && offer.status === 'sent' && <>
          <button onClick={() => save({ status: 'accepted', responded_at: new Date().toISOString() })} style={{ ...btn('secondary'), color: '#166534', borderColor: '#bbf7d0' }}>Accepted</button>
          <button onClick={() => save({ status: 'declined', responded_at: new Date().toISOString() })} style={{ ...btn('secondary'), color: '#b91c1c', borderColor: '#fecaca' }}>Declined</button>
        </>}
      </div>
      <p style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 12 }}>
        Tip: send the offer wording from the Comms tab (there's an “Offer” email template), then track its status here.
      </p>
    </div>
  );
}
