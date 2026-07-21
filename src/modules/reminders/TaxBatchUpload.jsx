import React, { useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { supabase } from '../../lib/supabase';
import { parseCsv, guessColumns, parseAmount, matchEntityByUtrSurname, fmtMoney, utr10 } from './lib';

const font = "'Outfit', sans-serif";

/*
  TaxBatchUpload — upload a TaxCalc / POA report (.xlsx or .csv) of
  personal-tax payments on account.

  Flow: choose a file → parse (SheetJS for xlsx, robust CSV parser
  otherwise) → auto-find the header row (reports often carry a couple of
  title rows first) → map Forename / Surname / UTR / Amount → live preview
  with SAFE matching to clients by UTR + surname → save a
  tax_payment_batches row plus tax_payments_due items. Only rows that
  carry a payment-on-account amount are imported.

  Matching is deliberately strict (data protection): a row matches only
  when its UTR hits exactly one active client whose name contains the
  surname. Anything else imports unmatched, to be resolved by hand in
  Client Reminders — it is never mis-delivered.

  Props:
    entities  — [{ id, name, utr }] used for UTR + surname matching
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
// Sticky header so the whole preview list scrolls under fixed column titles.
const thSticky = { ...th, position: 'sticky', top: 0, background: '#fff', zIndex: 1 };

const REASON_LABEL = {
  'no-utr': 'no UTR in file',
  'utr-not-found': 'UTR not on any client',
  'utr-ambiguous': 'UTR matches >1 client',
  'surname-mismatch': 'surname ≠ UTR client',
};

// Find the header row: the first row (within the first 15) that looks like
// it holds a surname/name column plus a UTR/reference column. Falls back
// to row 0 so a plain header-first file still works.
function findHeaderRow(rows) {
  const limit = Math.min(rows.length, 15);
  for (let i = 0; i < limit; i++) {
    const g = guessColumns((rows[i] || []).map((c) => String(c ?? '')));
    if (g.reference >= 0 && (g.surname >= 0 || g.name >= 0 || g.forename >= 0)) return i;
  }
  return 0;
}

export default function TaxBatchUpload({ entities, ignoreUtrs = [], profileId, onSaved }) {
  const year = new Date().getFullYear();
  const ignoreSet = useMemo(() => new Set((ignoreUtrs || []).map(String)), [ignoreUtrs]);
  const isIgnored = (r) => { const u = utr10(r.reference_raw); return !!u && ignoreSet.has(u); };
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState([]);
  const [dataRows, setDataRows] = useState([]);
  const [mapping, setMapping] = useState({ forename: -1, surname: -1, amount: -1, reference: -1 });
  const [label, setLabel] = useState(`July ${year} payments on account`);
  const [dueDate, setDueDate] = useState(`${year}-07-31`);
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);

  const ingestRows = (rows) => {
    const clean = (rows || []).filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim() !== ''));
    if (clean.length < 2) { setErr('That file has no data rows — expected a header row plus at least one client.'); return; }
    const hIdx = findHeaderRow(clean);
    const hdr = (clean[hIdx] || []).map((h) => String(h ?? '').trim());
    setHeaders(hdr);
    setDataRows(clean.slice(hIdx + 1));
    setMapping(guessColumns(hdr));
  };

  const onFile = (e) => {
    setErr(null);
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const isExcel = /\.(xlsx|xls)$/i.test(f.name);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        setFileName(f.name);
        if (isExcel) {
          const wb = XLSX.read(reader.result, { type: 'array' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: null });
          ingestRows(rows);
        } else {
          ingestRows(parseCsv(String(reader.result || '')));
        }
      } catch (ex) {
        setErr(`Could not read that file: ${ex.message}`);
      }
    };
    reader.onerror = () => setErr('Could not read that file.');
    if (isExcel) reader.readAsArrayBuffer(f); else reader.readAsText(f);
  };

  const cell = (r, idx) => (idx >= 0 ? String(r[idx] ?? '').trim() : '');

  // Live preview — only rows carrying a POA amount are importable.
  const parsed = useMemo(() => {
    if (mapping.amount < 0) return [];
    return dataRows
      .map((r) => {
        const forename = cell(r, mapping.forename);
        const surname = cell(r, mapping.surname);
        const name = [forename, surname].filter(Boolean).join(' ').trim();
        return {
          client_name_raw: name,
          surname,
          amount: parseAmount(r[mapping.amount]),
          reference_raw: cell(r, mapping.reference) || null,
        };
      })
      .filter((r) => r.amount != null && (r.client_name_raw || r.reference_raw));
  }, [dataRows, mapping]);

  const stats = useMemo(() => {
    const s = { ok: 0, ignored: 0, byReason: {} };
    for (const r of parsed) {
      if (isIgnored(r)) { s.ignored += 1; continue; }
      const m = matchEntityByUtrSurname(r.reference_raw, r.surname, entities);
      if (m.reason === 'ok') s.ok += 1;
      else s.byReason[m.reason] = (s.byReason[m.reason] || 0) + 1;
    }
    return s;
  }, [parsed, entities, ignoreSet]);

  const canSave = fileName && mapping.surname >= 0 && mapping.reference >= 0 && mapping.amount >= 0
    && label.trim() && dueDate && parsed.length > 0 && !saving;

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
      const items = parsed.map((r) => {
        const ignored = isIgnored(r);
        return {
          batch_id: batch.id,
          entity_id: ignored ? null : matchEntityByUtrSurname(r.reference_raw, r.surname, entities).id,
          client_name_raw: r.client_name_raw,
          reference_raw: r.reference_raw,
          amount: r.amount,
          status: ignored ? 'excluded' : 'unpaid',
        };
      });
      for (let i = 0; i < items.length; i += 500) {
        const { error: iErr } = await supabase.from('tax_payments_due').insert(items.slice(i, i + 500));
        if (iErr) throw iErr;
      }
      setFileName('');
      setHeaders([]);
      setDataRows([]);
      setMapping({ forename: -1, surname: -1, amount: -1, reference: -1 });
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

  const unmatchedTotal = parsed.length - stats.ok - stats.ignored;

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
        <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls,text/csv" onChange={onFile} style={{ display: 'none' }} />
        <button onClick={() => fileRef.current && fileRef.current.click()} style={btnGhost}>
          {fileName ? `File: ${fileName} — choose another` : 'Choose file (.xlsx or .csv)…'}
        </button>
      </div>

      {headers.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
            {[['forename', 'Forename', false], ['surname', 'Surname', true], ['reference', 'UTR', true], ['amount', 'POA amount', true]].map(([key, title, req]) => (
              <div key={key}>
                <span style={lbl}>{title}{req ? ' *' : ' (optional)'}</span>
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
            {parsed.length} row{parsed.length === 1 ? '' : 's'} with a POA amount will import
            {mapping.reference >= 0 && mapping.surname >= 0 && (
              <> — <strong style={{ color: '#166534' }}>{stats.ok} matched</strong> by UTR + surname
                {stats.ignored > 0 && <>, {stats.ignored} ignored (not clients)</>}
                {unmatchedTotal > 0 && <>, {unmatchedTotal} unmatched (
                  {Object.entries(stats.byReason).map(([r, n], i) => (
                    <span key={r}>{i > 0 ? ', ' : ''}{n} {REASON_LABEL[r] || r}</span>
                  ))})</>}
              </>
            )}.
          </div>
          {unmatchedTotal > 0 && (
            <div style={{ fontSize: 11.5, color: '#94a3b8', marginBottom: 6 }}>
              Unmatched rows still import. After saving, open <strong>Client Reminders</strong> to match
              each to a client (per-row picker) or mark it <strong>Excluded</strong> — e.g. someone whose
              tax return you file but who isn’t a practice client. Only matched, opted-in clients are emailed.
            </div>
          )}

          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, marginBottom: 14, maxHeight: 440, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thSticky}>Client</th>
                  <th style={thSticky}>Amount</th>
                  <th style={thSticky}>UTR</th>
                  <th style={thSticky}>Match</th>
                </tr>
              </thead>
              <tbody>
                {parsed.map((r, i) => {
                  const ignored = isIgnored(r);
                  const m = ignored ? null : matchEntityByUtrSurname(r.reference_raw, r.surname, entities);
                  const ent = m && m.id ? entities.find((e) => e.id === m.id) : null;
                  return (
                    <tr key={i}>
                      <td style={td}>{r.client_name_raw || '—'}</td>
                      <td style={td}>{r.amount != null ? `£${fmtMoney(r.amount)}` : <span style={{ color: '#b91c1c' }}>no amount</span>}</td>
                      <td style={td}>{r.reference_raw || '—'}</td>
                      <td style={td}>{ignored
                        ? <span style={{ color: '#94a3b8' }}>not a client (ignored)</span>
                        : ent
                          ? <span style={{ color: '#166534' }}>{ent.name}</span>
                          : <span style={{ color: '#b91c1c' }}>{REASON_LABEL[m.reason] || 'unmatched'}</span>}
                      </td>
                    </tr>
                  );
                })}
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
