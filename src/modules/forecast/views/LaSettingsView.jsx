// LA reference data editor — applies globally across forecasts.
// Edit funded hourly rates per age band, NDR poundage and SBB relief,
// and top-up policy per local authority.

import React, { useEffect, useMemo, useState } from 'react';
import {
  listLaReference, upsertLaNdr, upsertLaTopup, upsertLaFundedRate,
} from '../lib/queries';
import { btnGhost, colors, fontStack, inputStyle, Section, Pill } from '../components/ui';

const FUNDED_BANDS = [
  { key: 'three_to_five', label: '3–5s' },
  { key: 'twos', label: '2–3s (eligible)' },
];

export default function LaSettingsView() {
  const [year, setYear] = useState(2026);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [savingFlash, setSavingFlash] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const r = await listLaReference(year);
        if (!cancelled) { setRows(r); setLoading(false); }
      } catch (e) { if (!cancelled) { alert(e.message); setLoading(false); } }
    })();
    return () => { cancelled = true; };
  }, [year]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r => r.council.name.toLowerCase().includes(q) || r.council.code.toLowerCase().includes(q));
  }, [rows, filter]);

  // Helpers — local optimistic update + save on blur
  const updateLocalNdr = (laId, patch) => {
    setRows(prev => prev.map(r => r.council.id === laId
      ? { ...r, ndr: { ...(r.ndr || { la_council_id: laId, period_year: year }), ...patch } } : r));
  };
  const updateLocalTopup = (laId, patch) => {
    setRows(prev => prev.map(r => r.council.id === laId
      ? { ...r, topup: { ...(r.topup || { la_council_id: laId }), ...patch } } : r));
  };
  const updateLocalRate = (laId, band, patch) => {
    setRows(prev => prev.map(r => r.council.id === laId
      ? { ...r, rates: { ...r.rates, [band]: { ...(r.rates[band] || { la_council_id: laId, period_year: year, age_band: band }), ...patch } } }
      : r));
  };

  const flash = (id) => {
    setSavingFlash(id);
    setTimeout(() => setSavingFlash(prev => prev === id ? null : prev), 1200);
  };

  const saveNdrPoundage = async (la) => {
    try {
      await upsertLaNdr({ la_council_id: la.council.id, period_year: year,
        poundage: la.ndr?.poundage ?? 0, small_business_relief_pct: la.ndr?.small_business_relief_pct ?? null });
      flash('ndr-' + la.council.id);
    } catch (e) { alert(e.message); }
  };
  const saveTopup = async (la, allowed) => {
    try {
      await upsertLaTopup({ la_council_id: la.council.id, topup_allowed: !!allowed, notes: la.topup?.notes });
      updateLocalTopup(la.council.id, { topup_allowed: !!allowed });
      flash('topup-' + la.council.id);
    } catch (e) { alert(e.message); }
  };
  const saveFundedRate = async (la, band) => {
    try {
      const rate = la.rates[band]?.hourly_rate_p;
      if (rate == null || rate === '') return;
      await upsertLaFundedRate({ la_council_id: la.council.id, period_year: year,
        age_band: band, hourly_rate_p: Math.round(Number(rate)) });
      flash(`rate-${la.council.id}-${band}`);
    } catch (e) { alert(e.message); }
  };

  return (
    <div>
      <Section
        title={<span>Local authorities <span style={{ fontSize: 12, fontWeight: 400, color: colors.muted, fontFamily: fontStack }}>· Scotland · {rows.length} councils</span></span>}
        right={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              value={filter} onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter…"
              style={{ ...inputStyle, width: 180, padding: '7px 10px', fontFamily: fontStack }}
            />
            <select value={year} onChange={(e) => setYear(Number(e.target.value))}
              style={{ padding: '7px 10px', borderRadius: 8, border: `1px solid ${colors.border}`, fontSize: 12, fontFamily: fontStack, background: '#fff' }}>
              {[2025, 2026, 2027, 2028, 2029].map(y => <option key={y} value={y}>{y}/{(y + 1).toString().slice(2)}</option>)}
            </select>
          </div>
        }
      >
        <p style={{ fontSize: 12, color: colors.muted, margin: '0 0 10px' }}>
          Central reference data for Scottish local authorities. Edits apply globally across all forecasts. NDR poundage default 0.498 (basic 2025/26 band).
          Funded hourly rates vary by LA and age band — populate as you research each council.
          Top-up = whether the LA permits charging parents above the funded rate for wraparound hours.
        </p>

        {loading ? (
          <p style={{ color: colors.muted, fontSize: 13 }}>Loading…</p>
        ) : (
          <div style={{ overflowX: 'auto', border: `1px solid ${colors.border}`, borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: fontStack }}>
              <thead>
                <tr style={{ background: colors.bgSoft }}>
                  <th style={th}>Council</th>
                  <th style={th}>NDR poundage</th>
                  <th style={th}>SBB relief %</th>
                  {FUNDED_BANDS.map(b => (
                    <th key={b.key} style={th}>Funded £/hr ({b.label})</th>
                  ))}
                  <th style={th}>Top-up</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(la => {
                  const id = la.council.id;
                  return (
                    <tr key={id} style={{ borderBottom: `1px solid ${colors.borderSoft}` }}>
                      <td style={td}>
                        <strong>{la.council.name}</strong>
                        <span style={{ fontSize: 10, color: colors.muted, marginLeft: 6, fontFamily: 'ui-monospace, monospace' }}>{la.council.code}</span>
                      </td>
                      <td style={td}>
                        <input
                          defaultValue={la.ndr?.poundage ?? ''}
                          onChange={(e) => updateLocalNdr(id, { poundage: Number(e.target.value) || 0 })}
                          onBlur={() => saveNdrPoundage(la)}
                          inputMode="decimal"
                          style={{ ...cellInput, width: 80 }}
                          placeholder="0.498"
                        />
                        {savingFlash === 'ndr-' + id && <SavedFlash />}
                      </td>
                      <td style={td}>
                        <input
                          defaultValue={la.ndr?.small_business_relief_pct ?? ''}
                          onChange={(e) => updateLocalNdr(id, { small_business_relief_pct: e.target.value === '' ? null : Number(e.target.value) })}
                          onBlur={() => saveNdrPoundage(la)}
                          inputMode="decimal"
                          style={{ ...cellInput, width: 70 }}
                          placeholder="—"
                        />
                      </td>
                      {FUNDED_BANDS.map(b => (
                        <td key={b.key} style={td}>
                          <span style={{ color: colors.muted, marginRight: 4 }}>£</span>
                          <input
                            defaultValue={la.rates[b.key]?.hourly_rate_p != null ? (la.rates[b.key].hourly_rate_p / 100).toFixed(2) : ''}
                            onChange={(e) => {
                              const pounds = e.target.value;
                              const pence = pounds === '' ? null : Math.round(Number(pounds) * 100);
                              updateLocalRate(id, b.key, { hourly_rate_p: pence });
                            }}
                            onBlur={() => saveFundedRate(la, b.key)}
                            inputMode="decimal"
                            style={{ ...cellInput, width: 70 }}
                            placeholder="—"
                          />
                          {savingFlash === `rate-${id}-${b.key}` && <SavedFlash />}
                        </td>
                      ))}
                      <td style={td}>
                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={la.topup?.topup_allowed === true}
                            onChange={(e) => saveTopup(la, e.target.checked)}
                          />
                          <span style={{ fontSize: 11 }}>{la.topup?.topup_allowed ? 'Allowed' : '—'}</span>
                        </label>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

function SavedFlash() {
  return <span style={{ marginLeft: 6, fontSize: 10, color: colors.green, fontWeight: 600 }}>✓</span>;
}

const th = { padding: '8px 10px', textAlign: 'left', fontWeight: 600, color: colors.muted, borderBottom: `1px solid ${colors.border}` };
const td = { padding: '6px 10px', color: colors.ink, verticalAlign: 'middle' };
const cellInput = { padding: '4px 6px', border: `1px solid ${colors.border}`, borderRadius: 4, fontSize: 11, fontFamily: 'ui-monospace, monospace', textAlign: 'right' };
