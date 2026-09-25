import React, { useEffect, useMemo, useState } from 'react';
import { X, ArrowRight, ArrowLeft, Download, FileText, Mail, Plus, RotateCcw, Trash2, ExternalLink } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fmtGbpDetailed } from '../../lib/money';
import { BTN } from '../../lib/buttonStyles';
import {
  BUCKETS, REASONS, REASON_BY_KEY, OUR_FEES_FOOTNOTE, VAT_RATE,
  bucketFor, suggestReason, reasonFromSaved, reasonText, summarise, firstOfNextMonth, longDate,
} from './repriceReasons';
import { buildRepricePdf, pdfBase64, pdfFilename, serviceName } from './repricePdf';
import { composeRepriceEmail, defaultCoveringText } from './composeRepriceEmail';
import { resolvePrimaryContact, firstNameOf, candidateAddresses } from './recipients';

const font = "'Outfit', sans-serif";
const serif = "'Playfair Display', serif";

// Reprice one client, then write to them about it.
//
// Step 1 — Reprice: every approved service the client takes, old beside
// new. Each changed line carries a reason, suggested from the amounts
// and service and changeable (or "Other" + free text). Saving stages
// the new amounts exactly as the matrix does (pending_monthly_amount on
// the service line, row → staged), so it still goes through Push
// uplifts for approval before anything reaches QBO.
//
// Step 2 — Write to the client: an editable covering note above the
// summary table, the letter as a PDF with the waterfall, and a Gmail
// draft with the PDF attached. Nothing is sent from here — the draft
// is finished and sent in Gmail, as on Push uplifts.
export default function RepriceClientModal({ entity, rows, qboItems, profile, onSaveRow, onClose, onOpenClient }) {
  const clientRows = useMemo(() => rows.filter((r) => r.entity_id === entity.id), [rows, entity.id]);

  const [step, setStep] = useState('price'); // price | email
  const [lines, setLines] = useState(() => initialLines(clientRows));
  const [effectiveAt, setEffectiveAt] = useState(() => initialEffective(clientRows));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);

  const summary = useMemo(() => summarise(lines.map(asNumbers)), [lines]);
  const dirty = useMemo(() => lines.some((l) => lineDirty(l)) || effectiveAt !== initialEffective(clientRows), [lines, effectiveAt, clientRows]);
  const missingReason = lines.some((l) => isChanged(l) && l.reasonKey === 'other' && !l.otherText.trim());

  const setLine = (key, patch) => setLines((prev) => prev.map((l) => {
    if (l.key !== key) return l;
    const next = { ...l, ...patch };
    // Re-suggest while the reason is still ours; once staff pick one it stays.
    if ('next' in patch && !next.reasonTouched) {
      next.reasonKey = suggestReason({ serviceId: next.serviceId, current: next.current, next: Number(next.next) || 0 });
    }
    return next;
  }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const byRow = new Map();
      for (const l of lines) {
        if (!byRow.has(l.rowId)) byRow.set(l.rowId, []);
        byRow.get(l.rowId).push(l);
      }
      const stamp = new Date().toISOString();
      const saved = new Map(); // rowId → services as written
      for (const [rowId, rowLines] of byRow) {
        const row = clientRows.find((r) => r.id === rowId);
        if (!row) continue;
        const services = [...(row.services || [])];
        let touched = false;
        for (const l of rowLines) {
          const neu = round2(l.next);
          if (l.isNew) {
            if (!(neu > 0)) continue;
            services.push({
              service_id: l.serviceId,
              qbo_item_id: l.qboItemId || null,
              description: l.description || l.serviceId,
              cadence: 'monthly',
              cadence_months: 1,
              monthly_amount: 0,
              annual_amount: 0,
              approval_status: 'approved',
              approved_by: profile?.id || null,
              approved_at: stamp,
              billing_type: 'recurring',
              ...pendingFields(l, neu, effectiveAt, stamp, 'manual'),
            });
            touched = true;
            continue;
          }
          const s = services[l.idx];
          if (!s) continue;
          if (neu === l.current) {
            if (s.pending_monthly_amount != null) {
              services[l.idx] = { ...s, pending_monthly_amount: null, pending_effective_at: null, pending_uplift_reason: null, pending_uplift_reason_key: null, pending_uplift_staged_at: null };
              touched = true;
            }
            continue;
          }
          // An amount typed here is a manual price; keeping the value a
          // bulk pass staged keeps that pass's strategy.
          const strategy = s.pending_monthly_amount != null && round2(s.pending_monthly_amount) === neu
            ? (s.pending_uplift_strategy || 'manual')
            : 'manual';
          const updated = { ...s, ...pendingFields(l, neu, effectiveAt, s.pending_uplift_staged_at && strategy !== 'manual' ? s.pending_uplift_staged_at : stamp, strategy) };
          if (JSON.stringify(updated) !== JSON.stringify(s)) { services[l.idx] = updated; touched = true; }
        }
        if (touched) { await onSaveRow(rowId, services); saved.set(rowId, services); }
      }
      // Re-read the lines from what was written, so a new service is now
      // an existing line (a second Save must not add it twice) and the
      // dirty check starts again from the saved state.
      setLines(initialLines(clientRows.map((r) => (saved.has(r.id) ? { ...r, services: saved.get(r.id) } : r))));
      return true;
    } catch (e) {
      setError(e.message || String(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveAndWrite = async () => {
    if (dirty && !(await save())) return;
    setStep('email');
  };

  const changedCount = lines.filter(isChanged).length;

  return (
    <div style={overlay} onClick={onClose}>
      <div style={shell} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={{ padding: '16px 22px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', letterSpacing: '0.04em' }}>
              {step === 'price' ? 'STEP 1 OF 2 · REPRICE' : 'STEP 2 OF 2 · WRITE TO THE CLIENT'}
            </div>
            <h2 style={{ fontFamily: serif, fontSize: 22, fontWeight: 500, color: '#0f172a', margin: '2px 0 0' }}>{entity.name}</h2>
          </div>
          <button onClick={onOpenClient} style={{ ...BTN.secondary.sm, display: 'inline-flex', alignItems: 'center', gap: 5, marginLeft: 6 }} title="Open the client record">
            <ExternalLink size={12} /> Client record
          </button>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', padding: 4 }} aria-label="Close"><X size={18} /></button>
        </div>

        {step === 'price' ? (
          <PriceStep
            lines={lines}
            summary={summary}
            effectiveAt={effectiveAt}
            setEffectiveAt={setEffectiveAt}
            setLine={setLine}
            onRemoveNew={(key) => setLines((prev) => prev.filter((l) => l.key !== key))}
            adding={adding}
            setAdding={setAdding}
            qboItems={qboItems}
            onAdd={(item, amount) => {
              const target = clientRows.find((r) => r.qbo_recurring_txn_id) || clientRows[0];
              if (!target) return;
              setLines((prev) => [...prev, {
                key: `new-${Date.now()}`, rowId: target.id, idx: null, isNew: true,
                serviceId: item.name, qboItemId: item.qbo_item_id, description: item.description || item.name,
                cadence: 'monthly', current: 0, next: String(amount), original: 0,
                reasonKey: 'new_service', otherText: '', reasonTouched: false, originalReason: '',
              }]);
              setAdding(false);
            }}
          />
        ) : (
          <EmailStep
            entity={entity}
            clientRows={clientRows}
            lines={lines.map(asNumbers).filter((l) => !(l.isNew && !(l.next > 0)))}
            summary={summary}
            effectiveAt={effectiveAt}
            onBack={() => setStep('price')}
          />
        )}

        {step === 'price' && (
          <div style={{ padding: '12px 22px', borderTop: '1px solid #e5e7eb', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
            <span style={{ flex: '1 1 260px', fontSize: 12, color: error ? '#b91c1c' : '#64748b' }}>
              {error ? `Save failed: ${error}` : missingReason
                ? 'Give the "Other" reason some words — the client reads it.'
                : `${changedCount} change${changedCount === 1 ? '' : 's'} · saving stages them for Push uplifts; nothing reaches QBO until pushed.`}
            </span>
            <div style={{ flex: 1 }} />
            <button onClick={onClose} disabled={saving} style={BTN.secondary.md}>Cancel</button>
            <button onClick={save} disabled={saving || !dirty || missingReason} style={{ ...BTN.secondary.md, opacity: (!dirty || missingReason) ? 0.5 : 1 }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={saveAndWrite}
              disabled={saving || missingReason || changedCount === 0}
              title={changedCount === 0 ? 'Change a fee first' : ''}
              style={{ ...BTN.primary.md, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (missingReason || changedCount === 0) ? 0.5 : 1 }}
            >
              {dirty ? 'Save & write to client' : 'Write to client'} <ArrowRight size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Step 1 ──────────────────────────────────────────────────────────

function PriceStep({ lines, summary, effectiveAt, setEffectiveAt, setLine, onRemoveNew, adding, setAdding, qboItems, onAdd }) {
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '18px 22px' }}>
      {/* Old vs new */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginBottom: 16 }}>
        <PriceCard title="Current" monthly={summary.current} />
        <PriceCard title="New" monthly={summary.next} delta={summary.delta} emphasis />
      </div>

      {/* Table and rail sit side by side on a wide screen and stack on a
          narrow one; the table scrolls sideways rather than clip a column. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: '999 1 560px', minWidth: 0, border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 640, borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                <th style={{ ...th, textAlign: 'left' }}>Service</th>
                <th style={th}>Current / mo</th>
                <th style={th}>New / mo</th>
                <th style={th}>Change</th>
                <th style={{ ...th, textAlign: 'left', width: 230 }}>Reason</th>
                <th style={{ ...th, width: 34 }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const n = asNumbers(l);
                const d = round2(n.next - n.current);
                const changed = d !== 0;
                const bucket = changed ? bucketFor(n) : null;
                return (
                  <tr key={l.key} style={{ borderTop: '1px solid #f1f5f9', background: changed ? '#fcfbff' : '#fff' }}>
                    <td style={{ ...td, textAlign: 'left' }}>
                      <div style={{ fontWeight: 500, color: '#0f172a' }}>{serviceName(l.serviceId)}</div>
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>
                        {l.isNew ? 'New service' : l.cadence === 'annual' ? 'Annual service · shown per month' : l.serviceId.includes(':') ? l.serviceId.split(':')[0] : ''}
                      </div>
                    </td>
                    <td style={{ ...td, fontFamily: 'monospace', color: changed ? '#94a3b8' : '#0f172a', textDecoration: changed ? 'line-through' : 'none' }}>
                      {fmtGbpDetailed(l.current)}
                    </td>
                    <td style={{ ...td, padding: '4px 8px' }}>
                      <input
                        type="number" step="0.5" min="0" value={l.next}
                        onChange={(e) => setLine(l.key, { next: e.target.value })}
                        style={{ width: 84, padding: '5px 7px', fontSize: 13, fontFamily: 'monospace', textAlign: 'right', border: `1px solid ${changed ? '#a78bfa' : '#e5e7eb'}`, borderRadius: 6, outline: 'none', boxSizing: 'border-box' }}
                      />
                      {n.current > 0 && (
                        <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 2 }}>
                          {changed ? `${d > 0 ? '+' : ''}${((d / n.current) * 100).toFixed(1)}%` : ' '}
                        </div>
                      )}
                    </td>
                    <td style={{ ...td, fontFamily: 'monospace', fontWeight: 600, color: d > 0 ? '#15803d' : d < 0 ? '#b91c1c' : '#cbd5e1' }}>
                      {changed ? `${d > 0 ? '+' : ''}${fmtGbpDetailed(d)}` : '—'}
                    </td>
                    <td style={{ ...td, textAlign: 'left' }}>
                      {changed ? (
                        <>
                          <select
                            value={l.reasonKey}
                            onChange={(e) => setLine(l.key, { reasonKey: e.target.value, reasonTouched: true })}
                            style={{ ...input, width: '100%' }}
                          >
                            {BUCKETS.map((b) => (
                              <optgroup key={b.key} label={b.label}>
                                {REASONS.filter((r) => r.bucket === b.key).map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                              </optgroup>
                            ))}
                          </select>
                          {l.reasonKey === 'other' && (
                            <input
                              autoFocus value={l.otherText} placeholder="Explain in a few words…"
                              onChange={(e) => setLine(l.key, { otherText: e.target.value })}
                              style={{ ...input, width: '100%', marginTop: 4, borderColor: l.otherText.trim() ? '#e5e7eb' : '#fca5a5' }}
                            />
                          )}
                          {bucket && REASON_BY_KEY[l.reasonKey]?.bucket !== bucket && (
                            <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 3 }}>
                              Shown to the client under “{BUCKETS.find((b) => b.key === bucket)?.label}”
                            </div>
                          )}
                        </>
                      ) : <span style={{ fontSize: 12, color: '#cbd5e1' }}>No change</span>}
                    </td>
                    <td style={{ ...td, padding: '4px 6px' }}>
                      {l.isNew ? (
                        <IconBtn title="Drop this new service" onClick={() => onRemoveNew(l.key)}><X size={13} /></IconBtn>
                      ) : changed ? (
                        <IconBtn title="Back to the current fee" onClick={() => setLine(l.key, { next: String(l.current), reasonTouched: false })}><RotateCcw size={13} /></IconBtn>
                      ) : (
                        <IconBtn title="Remove this service (fee to £0)" onClick={() => setLine(l.key, { next: '0' })}><Trash2 size={13} /></IconBtn>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          <div style={{ padding: '10px 12px', borderTop: '1px solid #f1f5f9', background: '#fafafa' }}>
            {adding
              ? <AddLine qboItems={qboItems} taken={new Set(lines.map((l) => l.serviceId))} onCancel={() => setAdding(false)} onAdd={onAdd} />
              : <button onClick={() => setAdding(true)} style={{ ...BTN.secondary.sm, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={13} /> Add a service</button>}
          </div>
        </div>

        {/* Right rail: where the change comes from */}
        <div style={{ flex: '1 1 280px', maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 8 }}>Where the change comes from</div>
            <MiniWaterfall summary={summary} />
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 14px', fontSize: 13 }}>
            <SummaryTable summary={summary} />
            <p style={{ fontSize: 11, color: '#94a3b8', margin: '8px 0 0', lineHeight: 1.45 }}>* {OUR_FEES_FOOTNOTE}</p>
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 5 }}>New fees apply from</div>
            <input type="date" value={effectiveAt} onChange={(e) => setEffectiveAt(e.target.value)} style={{ ...input, width: '100%' }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function PriceCard({ title, monthly, delta, emphasis }) {
  const vat = round2(monthly * VAT_RATE);
  return (
    <div style={{ border: `1px solid ${emphasis ? '#c7d7e3' : '#e5e7eb'}`, background: emphasis ? '#f4f8fb' : '#fff', borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'flex-end', gap: 22 }}>
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b' }}>{title} · per month, net</div>
        <div style={{ fontSize: 26, fontWeight: 700, fontFamily: 'monospace', color: emphasis ? '#193a50' : '#0f172a', marginTop: 2 }}>{fmtGbpDetailed(monthly)}</div>
      </div>
      <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.6, paddingBottom: 3 }}>
        <div>{fmtGbpDetailed(monthly * 12)} a year</div>
        <div>{fmtGbpDetailed(monthly + vat)} / mo inc VAT</div>
      </div>
      {delta != null && delta !== 0 && (
        <div style={{ marginLeft: 'auto', textAlign: 'right', paddingBottom: 3 }}>
          <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'monospace', color: delta > 0 ? '#15803d' : '#b91c1c' }}>
            {delta > 0 ? '+' : ''}{fmtGbpDetailed(delta)}
          </div>
          <div style={{ fontSize: 11.5, color: '#64748b' }}>{delta > 0 ? '+' : ''}{fmtGbpDetailed(delta * 12)} a year</div>
        </div>
      )}
    </div>
  );
}

function SummaryTable({ summary }) {
  const rowS = { display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #f1f5f9' };
  const step = (v) => (v === 0 ? <span style={{ color: '#cbd5e1' }}>—</span> : <span style={{ color: v > 0 ? '#15803d' : '#b91c1c' }}>{v > 0 ? '+' : ''}{fmtGbpDetailed(v)}</span>);
  return (
    <div style={{ fontFamily: font }}>
      <div style={{ ...rowS, fontWeight: 600 }}><span>Current fees</span><span style={{ fontFamily: 'monospace' }}>{fmtGbpDetailed(summary.current)}</span></div>
      {BUCKETS.map((b) => (
        <div key={b.key} style={{ ...rowS, paddingLeft: 10, color: '#475569' }}>
          <span>{b.label}{b.star ? ' *' : ''}</span><span style={{ fontFamily: 'monospace' }}>{step(summary.buckets[b.key])}</span>
        </div>
      ))}
      <div style={{ ...rowS, fontWeight: 600 }}><span>New fees (net)</span><span style={{ fontFamily: 'monospace' }}>{fmtGbpDetailed(summary.next)}</span></div>
      <div style={{ ...rowS, color: '#475569' }}><span>VAT at 20%</span><span style={{ fontFamily: 'monospace' }}>{fmtGbpDetailed(summary.vat)}</span></div>
      <div style={{ ...rowS, borderBottom: 'none', fontWeight: 700, color: '#193a50' }}><span>Total inc VAT</span><span style={{ fontFamily: 'monospace' }}>{fmtGbpDetailed(summary.gross)}</span></div>
      <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 2 }}>Per month</div>
    </div>
  );
}

// The same waterfall the PDF draws, small, so staff see the shape of
// the letter while pricing. Zero-based, like the PDF.
function MiniWaterfall({ summary }) {
  const steps = [
    { label: 'Now', total: true, v: summary.current },
    ...BUCKETS.filter((b) => summary.buckets[b.key] !== 0).map((b) => ({ label: b.label.replace('Increases in our fees', 'Our fees*'), v: summary.buckets[b.key] })),
    { label: 'New', total: true, v: summary.next },
  ];
  let run = 0, peak = 0;
  const bars = steps.map((s) => {
    if (s.total) { run = s.v; peak = Math.max(peak, run); return { ...s, from: 0, to: run }; }
    const from = run; run += s.v; peak = Math.max(peak, from, run); return { ...s, from, to: run };
  });
  peak = peak || 1;
  const W = 272, H = 150, top = 16, bottom = 118, slot = W / bars.length, bw = Math.min(34, slot * 0.6);
  const y = (v) => bottom - (v / peak) * (bottom - top);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Waterfall from current to new monthly fee">
      <line x1="0" x2={W} y1={bottom} y2={bottom} stroke="#cbd5e1" />
      {bars.map((b, i) => {
        const cx = slot * i + slot / 2;
        const t = y(Math.max(b.from, b.to)), h = Math.max(1.5, y(Math.min(b.from, b.to)) - t);
        const fill = b.total ? '#193a50' : b.v > 0 ? '#c98a3e' : '#2f855a';
        return (
          <g key={i}>
            <rect x={cx - bw / 2} y={t} width={bw} height={h} rx="2" fill={fill} />
            {i < bars.length - 1 && <line x1={cx + bw / 2} x2={cx + slot - bw / 2} y1={y(b.to)} y2={y(b.to)} stroke="#94a3b8" strokeDasharray="2 2" />}
            <text x={cx} y={t - 4} textAnchor="middle" fontSize="9.5" fontWeight="600" fill={b.total ? '#193a50' : fill} fontFamily="monospace">
              {b.total ? `£${Math.round(b.v)}` : `${b.v > 0 ? '+' : '−'}£${Math.abs(b.v).toFixed(b.v % 1 ? 2 : 0)}`}
            </text>
            <text x={cx} y={bottom + 13} textAnchor="middle" fontSize="9" fill="#475569" fontFamily={font}>
              {b.label.length > 12 ? b.label.split(' ').slice(0, 2).join(' ') : b.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function AddLine({ qboItems, taken, onCancel, onAdd }) {
  const options = qboItems.filter((it) => !taken.has(it.name));
  const [id, setId] = useState('');
  const item = options.find((it) => it.qbo_item_id === id);
  const [amount, setAmount] = useState('');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <select value={id} onChange={(e) => { setId(e.target.value); const it = options.find((o) => o.qbo_item_id === e.target.value); if (it && !amount) setAmount(String(it.unit_price || '')); }} style={{ ...input, flex: 1, minWidth: 220 }}>
        <option value="">— pick a QBO product —</option>
        {options.map((it) => <option key={it.qbo_item_id} value={it.qbo_item_id}>{it.name}</option>)}
      </select>
      <input type="number" step="0.5" min="0" placeholder="£ / month" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ ...input, width: 100, fontFamily: 'monospace', textAlign: 'right' }} />
      <button onClick={() => item && Number(amount) > 0 && onAdd(item, Number(amount))} disabled={!item || !(Number(amount) > 0)} style={{ ...BTN.primary.sm, opacity: item && Number(amount) > 0 ? 1 : 0.5 }}>Add</button>
      <button onClick={onCancel} style={BTN.secondary.sm}>Cancel</button>
    </div>
  );
}

// ─── Step 2 ──────────────────────────────────────────────────────────

function EmailStep({ entity, clientRows, lines, summary, effectiveAt, onBack }) {
  const [info, setInfo] = useState(null); // { contact, contactName, candidates }
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [covering, setCovering] = useState('');
  const [busy, setBusy] = useState(null); // 'pdf' | 'view' | 'draft'
  const [drafted, setDrafted] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const { data } = await supabase
        .from('entities')
        .select('id, name, billing_email, entity_people(is_primary_contact, person:people(id, name, first_name, preferred_name, email)), qbo_customer_mappings(qbo_email, role)')
        .eq('id', entity.id)
        .maybeSingle();
      if (!live) return;
      const contact = resolvePrimaryContact(data);
      const contactName = firstNameOf(contact);
      const candidates = candidateAddresses(data, contact);
      setInfo({ contact, contactName, candidates });
      setTo(candidates[0]?.addr || '');
      const draft = composeRepriceEmail({ clientName: entity.name, coveringText: '', effectiveAt, summary });
      setSubject(draft.subject);
      setCovering(defaultCoveringText({ contactName, clientName: entity.name, effectiveAt, lines, summary }));
    })();
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity.id]);

  const email = useMemo(
    () => composeRepriceEmail({ clientName: entity.name, coveringText: covering, effectiveAt, summary }),
    [entity.name, covering, effectiveAt, summary],
  );

  const makePdf = () => buildRepricePdf({ clientName: entity.name, contactName: info?.contactName, effectiveAt, lines, summary });

  const download = async () => {
    setBusy('pdf');
    try { (await makePdf()).save(pdfFilename(entity.name)); }
    catch (e) { setError(e.message || String(e)); }
    finally { setBusy(null); }
  };

  const view = async () => {
    setBusy('view');
    try {
      const doc = await makePdf();
      window.open(URL.createObjectURL(doc.output('blob')), '_blank', 'noopener');
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(null); }
  };

  // The billing row the draft is stamped on: the one carrying the pending
  // change (the template row when there is one), so Push uplifts shows
  // the DRAFT chip against it.
  const billingId = (clientRows.find((r) => (r.services || []).some((s) => s.pending_monthly_amount != null) && r.qbo_recurring_txn_id)
    || clientRows.find((r) => (r.services || []).some((s) => s.pending_monthly_amount != null))
    || clientRows[0])?.id;

  const draft = async () => {
    if (!to) { setError('Pick or type a recipient first.'); return; }
    setBusy('draft');
    setError(null);
    try {
      const doc = await makePdf();
      const { data, error: fnErr } = await supabase.functions.invoke('gmail-create-draft', {
        body: {
          billing_id: billingId,
          to,
          subject,
          body_text: email.body,
          body_html: email.bodyHtml,
          attachments: [{ filename: pdfFilename(entity.name), mime_type: 'application/pdf', content_base64: pdfBase64(doc) }],
        },
      });
      if (fnErr || !data?.success) {
        if (data?.code === 'no_gmail_connection') throw new Error('No active Gmail connection — connect one on Push uplifts first.');
        throw new Error(data?.error || fnErr?.message || 'Draft creation failed');
      }
      setDrafted(data.account_email || 'Gmail');
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexWrap: 'wrap' }}>
        {/* Compose */}
        <div style={{ flex: '1 1 360px', maxWidth: 440, minWidth: 0, borderRight: '1px solid #e5e7eb', padding: '16px 18px', overflow: 'auto', maxHeight: '100%', display: 'flex', flexDirection: 'column', gap: 12, boxSizing: 'border-box' }}>
          {!info ? <p style={{ fontSize: 13, color: '#94a3b8' }}>Loading contacts…</p> : (
            <>
              <Field label="To">
                {info.candidates.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 6 }}>
                    {info.candidates.map((c) => (
                      <label key={c.addr} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                        <input type="radio" checked={to === c.addr} onChange={() => setTo(c.addr)} />
                        <span style={{ fontFamily: 'monospace', fontSize: 12.5 }}>{c.addr}</span>
                        <span style={{ fontSize: 11, color: '#94a3b8' }}>· {c.label}</span>
                      </label>
                    ))}
                  </div>
                )}
                <input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="Type an address…" style={{ ...input, width: '100%' }} />
                {!info.contactName && (
                  <div style={{ fontSize: 11.5, color: '#b45309', marginTop: 4 }}>No primary contact name on file — check the greeting below.</div>
                )}
              </Field>
              <Field label="Subject">
                <input value={subject} onChange={(e) => setSubject(e.target.value)} style={{ ...input, width: '100%' }} />
              </Field>
              <Field label="Covering note" hint="The summary table, footnote and sign-off follow it automatically.">
                <textarea value={covering} onChange={(e) => setCovering(e.target.value)} rows={14} style={{ ...input, width: '100%', resize: 'vertical', lineHeight: 1.5, fontFamily: font }} />
              </Field>
              <Field label="Attachment">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#f8fafc' }}>
                  <FileText size={16} style={{ color: '#b91c1c', flexShrink: 0 }} />
                  <span style={{ fontSize: 12.5, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pdfFilename(entity.name)}</span>
                  <button onClick={view} disabled={!!busy} style={BTN.secondary.sm}>{busy === 'view' ? '…' : 'View'}</button>
                  <button onClick={download} disabled={!!busy} style={{ ...BTN.secondary.sm, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Download size={12} />{busy === 'pdf' ? '…' : 'Save'}</button>
                </div>
              </Field>
            </>
          )}
        </div>

        {/* Preview */}
        <div style={{ flex: '999 1 420px', minWidth: 0, minHeight: 520, height: '100%', display: 'flex', flexDirection: 'column', background: '#f3f5f8' }}>
          <div style={{ padding: '8px 14px', fontSize: 12, color: '#64748b', borderBottom: '1px solid #e5e7eb', background: '#fff' }}>
            <strong style={{ color: '#0f172a' }}>{subject}</strong>
            <span style={{ marginLeft: 8 }}>→ {to || 'no recipient'}</span>
          </div>
          <iframe title="Email preview" srcDoc={email.bodyHtml} sandbox="" style={{ flex: 1, width: '100%', border: 'none' }} />
        </div>
      </div>

      <div style={{ padding: '12px 22px', borderTop: '1px solid #e5e7eb', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <button onClick={onBack} disabled={!!busy} style={{ ...BTN.secondary.md, display: 'inline-flex', alignItems: 'center', gap: 6 }}><ArrowLeft size={14} /> Back to prices</button>
        <span style={{ flex: '1 1 260px', fontSize: 12, color: error ? '#b91c1c' : drafted ? '#15803d' : '#64748b' }}>
          {error || (drafted
            ? `Draft created in ${drafted} with the letter attached — review and send it from Gmail.`
            : `Nothing sends from here. The draft lands in Gmail with the PDF attached. New fees still need approving on Push uplifts${effectiveAt ? ` before ${longDate(effectiveAt)}` : ''}.`)}
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={draft}
          disabled={!!busy || !info || !to || !billingId}
          style={{ ...BTN.primary.md, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (!info || !to) ? 0.5 : 1 }}
        >
          <Mail size={14} /> {busy === 'draft' ? 'Creating draft…' : drafted ? 'Create another draft' : 'Create Gmail draft'}
        </button>
      </div>
    </>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────

function initialLines(clientRows) {
  const out = [];
  for (const r of clientRows) {
    (r.services || []).forEach((s, idx) => {
      if (s.approval_status !== 'approved' || s.recurring_status === 'ending') return;
      if (s.cadence !== 'monthly' && s.cadence !== 'annual') return;
      const current = round2(s.monthly_amount);
      const next = s.pending_monthly_amount != null ? round2(s.pending_monthly_amount) : current;
      const saved = reasonFromSaved(s);
      const serviceId = s.service_id || s.description || 'Service';
      const reasonKey = saved?.reasonKey || suggestReason({ serviceId, current, next });
      const otherText = saved?.otherText || '';
      out.push({
        key: `${r.id}:${idx}`, rowId: r.id, idx, isNew: false,
        serviceId, cadence: s.cadence, current, next: String(next), original: next,
        reasonKey, otherText, reasonTouched: !!saved,
        // What is stored now: a staged line with no saved reason key (a
        // bulk pass) counts as unsaved until its reason is written.
        originalReason: saved ? `${reasonKey}|${otherText}` : '',
      });
    });
  }
  return out.sort((a, b) => b.current - a.current);
}

function initialEffective(clientRows) {
  const today = new Date().toISOString().slice(0, 10);
  for (const r of clientRows) for (const s of r.services || []) {
    if (s.pending_monthly_amount != null && s.pending_effective_at && s.pending_effective_at >= today) return s.pending_effective_at;
  }
  return firstOfNextMonth();
}

function pendingFields(l, amount, effectiveAt, stagedAt, strategy) {
  return {
    pending_monthly_amount: amount,
    pending_effective_at: effectiveAt,
    pending_uplift_reason: reasonText(l),
    pending_uplift_reason_key: l.reasonKey,
    pending_uplift_staged_at: stagedAt,
    pending_uplift_strategy: strategy,
  };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const asNumbers = (l) => ({ ...l, next: round2(l.next) });
const isChanged = (l) => round2(l.next) !== l.current;
// Unsaved: a new line, an amount moved from what was loaded, or a
// changed line whose reason differs from the one stored on it.
const lineDirty = (l) => l.isNew || round2(l.next) !== l.original || (isChanged(l) && `${l.reasonKey}|${l.otherText}` !== l.originalReason);

function Field({ label, hint, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 5 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function IconBtn({ title, onClick, children }) {
  return (
    <button onClick={onClick} title={title} aria-label={title} style={{ width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: '1px solid transparent', borderRadius: 6, color: '#94a3b8', cursor: 'pointer', padding: 0 }}>
      {children}
    </button>
  );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, fontFamily: font, padding: 16 };
const shell = { background: '#fff', borderRadius: 14, width: 1180, maxWidth: '100%', height: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.3)' };
const th = { padding: '8px 10px', fontSize: 11.5, fontWeight: 600, color: '#64748b', textAlign: 'right', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' };
const td = { padding: '8px 10px', textAlign: 'right', verticalAlign: 'top' };
const input = { padding: '6px 9px', fontSize: 13, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#0f172a', outline: 'none', boxSizing: 'border-box' };
