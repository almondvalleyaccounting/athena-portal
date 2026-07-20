import React, { useMemo, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { parseCsv, guessColumns, parseAmount, matchEntityByName, fmtMoney } from './lib';

const font = "'Outfit', sans-serif";

/*
  TaxBatchUpload — the TaxCalc CSV upload flow, shared between the Data
  Import area (where it renders as a page section) and anywhere else that
  needs to create a payment batch.

  Flow: choose a CSV → robust parse + column-mapping guesses (lib.js) →
  live preview with auto-matching to entities by name → save as a
  tax_payment_batches row plus tax_payments_due items. Calls onSaved(batchId)
  after a successful save and resets itself for the next file.

  Props:
    entities  — [{ id, name, … }] used for name matching
    profileId — staff id recorded as uploaded_by
    onSaved   — (batchId) => void
*/

const btnPrimary = (enabled) => ({
  padding: '8px 16px', fontSize: 12.5, fontWeight: 600, fontFamily: font,
  background: enabled ? '#0e7fe0' : '#e5e7eb', color: enabled ? '#fff' : '#94a3b8',
  border: 'none', borderRadius: 8, cursor: enabled ? 'pointer' : 'default',
});
const btnGhost = {
  padding: '7px 14px', fontSize: 12.5, fontWeight: 600, fontFamily: font,
  background: '#fff', color: '#334155', border: '1px solid #e5e7eb',
  borderRadius: 8, cursor: 'pointer',
};
const th = {
  padding: '8px 10px', fontSize: 11, fontWeight: 600, color: '#64748b',
  textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.4,
  borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap',
};
const td = { padding: '7px 10px', fontSize: 12.5, color: '#1e293b', borderBottom: '1px solid #f1f5f9', verticalAlign: 'middle' };

export default function TaxBatchUpload({ entities, profileId, onSaved }) {
  const year = new Date().getFullYear();
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState([]);
  const [dataRows, setDataRows] = useState([]);
  const [mapping, setMapping] = useState({ name: -1, amount: -1, reference: -1 });
  const [label, setLabel] = useState(`July ${year} payments on account`);
  const [dueDate, setDueDate] = useState(`${year}-07-31`);
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);

  const onFile = (e) => {
    setErr(null);
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const rows = parseCsv(String(reader.result || ''));
        if (rows.length < 2) { setErr('That file has no data rows — expected a header row plus at least one client.'); return; }
        const hdr = rows[0].map((h) => String(h).trim());
        setFileName(f.name);
        setHeaders(hdr);
        setDataRows(rows.slice(1));
        setMapping(guessColumns(hdr));
      } catch (ex) {
        setErr(`Could not read that file: ${ex.message}`);
      }
    };
    reader.onerror = () => setErr('Could not read that file.');
    reader.readAsText(f);
  };

  // Live preview of how the mapped rows will import.
  const parsed = useMemo(() => {
    if (mapping.name < 0) return [];
    return dataRows
      .map((r) => ({
        client_name_raw: String(r[mapping.name] ?? '').trim(),
        amount: mapping.amount >= 0 ? parseAmount(r[mapping.amount]) : null,
        reference_raw: mapping.reference >= 0 ? String(r[mapping.reference] ?? '').trim() || null : null,
      }))
      .filter((r) => r.client_name_raw);
  }, [dataRows, mapping]);

  const matchedCount = useMemo(
    () => parsed.filter((r) => matchEntityByName(r.client_name_raw, entities)).length,
    [parsed, entities],
  );

  const canSave = fileName && mapping.name >= 0 && mapping.amount >= 0 && label.trim() && dueDate && parsed.length > 0 && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setErr(null);
    try {
      const { data: batch, error: bErr } = await supabase
        .from('tax_payment_batches')
        .insert({ label: label.trim(), due_date: dueDate, source_filename: fileName, uploaded_by: profileId || null })
        .select('id')
        .single();
      if (bErr) throw bErr;
      const items = parsed.map((r) => ({
        batch_id: batch.id,
        entity_id: matchEntityByName(r.client_name_raw, entities),
        client_name_raw: r.client_name_raw,
        reference_raw: r.reference_raw,
        amount: r.amount,
        status: 'unpaid',
      }));
      for (let i = 0; i < items.length; i += 500) {
        const { error: iErr } = await supabase.from('tax_payments_due').insert(items.slice(i, i + 500));
        if (iErr) throw iErr;
      }
      // Reset so another file can go straight in.
      setFileName('');
      setHeaders([]);
      setDataRows([]);
      setMapping({ name: -1, amount: -1, reference: -1 });
      setSaving(false);
      onSaved(batch.id);
    } catch (ex) {
      setErr(`Save failed: ${ex.message || String(ex)}`);
      setSaving(false);
    }
  };

  const selStyle = {
    padding: '5px 8px', fontSize: 12, fontFamily: font, border: '1px solid #e5e7eb',
    borderRadius: 6, background: '#fff', color: '#1e293b',
  };
  const lbl = { fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 3, display: 'block' };

  return (
    <div style={{ fontFamily: font }}>
      {err && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 8, padding: '9px 12px',
          background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8,
          fontSize: 12.5, color: '#b91c1c', marginBottom: 10,
        }}>
          <div style={{ flex: 1 }}>{err}</div>
          <button onClick={() => setErr(null)} style={{ background: 'none', border: 'none', color: '#b91c1c', cursor: 'pointer', fontSize: 13, fontFamily: font, padding: 0 }}>×</button>
        </div>
      )}

      <div style={{ marginBottom: 14 }}>
        <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} style={{ display: 'none' }} />
        <button onClick={() => fileRef.current && fileRef.current.click()} style={btnGhost}>
          {fileName ? `File: ${fileName} — choose another` : 'Choose CSV file…'}
        </button>
      </div>

      {headers.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
            {[['name', 'Client name'], ['amount', 'Amount'], ['reference', 'Reference']].map(([key, title]) => (
              <div key={key}>
                <span style={lbl}>{title}{key !== 'reference' ? ' *' : ' (optional)'}</span>
                <select
                  value={mapping[key]}
                  onChange={(e) => setMapping({ ...mapping, [key]: Number(e.target.value) })}
                  style={selStyle}
                >
                  <option value={-1}>— not set —</option>
                  {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                </select>
              </div>
            ))}
            <div>
              <span style={lbl}>Batch label *</span>
              <input value={label} onChange={(e) => setLabel(e.target.value)} style={{ ...selStyle, width: 220 }} />
            </div>
            <div>
              <span style={lbl}>Due date *</span>
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} style={selStyle} />
            </div>
          </div>

          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>
            {parsed.length} row{parsed.length === 1 ? '' : 's'} will import
            {mapping.name >= 0 && <> — <strong style={{ color: '#166534' }}>{matchedCount} matched</strong> to clients by name, {parsed.length - matchedCount} to match by hand afterwards</>}.
          </div>

          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', marginBottom: 14 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>Client name</th>
                  <th style={th}>Amount</th>
                  <th style={th}>Reference</th>
                  <th style={th}>Match</th>
                </tr>
              </thead>
              <tbody>
                {parsed.slice(0, 8).map((r, i) => {
                  const m = matchEntityByName(r.client_name_raw, entities);
                  const ent = m ? entities.find((e) => e.id === m) : null;
                  return (
                    <tr key={i}>
                      <td style={td}>{r.client_name_raw}</td>
                      <td style={td}>{r.amount != null ? `£${fmtMoney(r.amount)}` : <span style={{ color: '#b91c1c' }}>no amount</span>}</td>
                      <td style={td}>{r.reference_raw || '—'}</td>
                      <td style={td}>{ent ? <span style={{ color: '#166534' }}>{ent.name}</span> : <span style={{ color: '#94a3b8' }}>unmatched</span>}</td>
                    </tr>
                  );
                })}
                {parsed.length > 8 && (
                  <tr><td style={{ ...td, color: '#94a3b8' }} colSpan={4}>…and {parsed.length - 8} more</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={save} disabled={!canSave} style={btnPrimary(canSave)}>
              {saving ? 'Saving…' : 'Save batch'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
