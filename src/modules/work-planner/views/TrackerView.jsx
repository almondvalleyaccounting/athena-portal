import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../shell/AppShell';
import { useWorkPlanner } from '../WorkPlannerModule';
import Avatar from '../components/Avatar';
import { BTN } from '../../../lib/buttonStyles';

// Tracker (Bobby, 2026-09-27; sql/332): Margaret's client control file as a
// tab. One row per bookkeeping client with her columns. Green cells are live
// (QuickBooks, BrightManager, the journal check); dark cells are typed and
// edit in place. Dates tint by age. A row opens the drawer: every bank and
// card account with its reconciled-to date, the control-account lines and
// queries, and a refresh from QuickBooks.

const font = "'Outfit', sans-serif";
const LIVE = '#0f6e56';
const fmt = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '');
const fmtMonth = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }) : '');
const fmtPeriod = (ym) => (ym ? new Date(`${ym}-01T12:00:00`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }) : '');
const daysAgo = (iso) => (iso ? Math.round((Date.now() - new Date(`${String(iso).slice(0, 10)}T12:00:00`).getTime()) / 86400000) : null);
// Tint by age: within 45 days fine, 90 getting old, beyond that stale.
const tint = (iso, okDays = 45, warnDays = 90) => {
  const d = daysAgo(iso);
  if (d === null) return {};
  if (d <= okDays) return { background: '#eaf3de', color: '#27500a' };
  if (d <= warnDays) return { background: '#faeeda', color: '#633806' };
  return { background: '#fcebeb', color: '#791f1f' };
};
const periodTint = (ym) => (ym ? tint(`${ym}-28`, 45, 75) : {});

export async function callTracker(payload) {
  const { data, error } = await supabase.functions.invoke('tracker', { body: payload });
  if (error || !data?.success) {
    let msg = data?.error || 'Could not save';
    try { const j = await error?.context?.json?.(); if (j?.error) msg = j.error; } catch { /* body already read */ }
    throw new Error(msg);
  }
  return data;
}

// A typed cell: click to edit, Enter or blur saves, Escape cancels.
function TypedCell({ value, onSave, options, multiline, placeholder }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value || '');
  useEffect(() => { if (!editing) setV(value || ''); }, [value, editing]);
  const save = async () => { setEditing(false); if ((v || '') !== (value || '')) await onSave(v); };
  if (!editing) {
    return (
      <div onClick={(e) => { e.stopPropagation(); setEditing(true); }} title="Click to edit"
        style={{ minHeight: 18, cursor: 'text', color: value ? '#0f172a' : '#cbd5e1', whiteSpace: multiline ? 'normal' : 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {value || placeholder || '·'}
      </div>
    );
  }
  if (options) {
    return (
      <select autoFocus value={v} onChange={(e) => setV(e.target.value)} onBlur={save} onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') { setEditing(false); setV(value || ''); } if (e.key === 'Enter') save(); }}
        style={{ fontFamily: font, fontSize: 12.5, padding: '2px 4px', border: '1px solid #0e7fe0', borderRadius: 4 }}>
        <option value="">—</option>{options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  const Tag = multiline ? 'textarea' : 'input';
  return (
    <Tag autoFocus value={v} onChange={(e) => setV(e.target.value)} onBlur={save} onClick={(e) => e.stopPropagation()} rows={multiline ? 3 : undefined}
      onKeyDown={(e) => { if (e.key === 'Escape') { setEditing(false); setV(value || ''); } if (e.key === 'Enter' && !multiline) save(); }}
      style={{ fontFamily: font, fontSize: 12.5, padding: '2px 6px', border: '1px solid #0e7fe0', borderRadius: 4, width: '100%', boxSizing: 'border-box', resize: 'vertical' }} />
  );
}

export default function TrackerView() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const { staffMap, staffColours, filters } = useWorkPlanner();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [staleOnly, setStaleOnly] = useState(false);
  const [open, setOpen] = useState(null); // entity_id in the drawer

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const { data, error: e } = await supabase.from('v_tracker').select('*').order('client').limit(1000);
      if (e) throw e;
      setRows(data || []);
    } catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const isStale = (r) => {
    if (r.realm_id && (!r.oldest_reconciled_to || daysAgo(r.oldest_reconciled_to) > 90)) return true;
    if (r.realm_id && r.payroll === 'BP' && (!r.jrn_checked || daysAgo(`${r.jrn_checked}-28`) > 75)) return true;
    return r.open_queries > 0;
  };
  const visible = useMemo(() => {
    let l = rows;
    if (filters.teamFilter) l = l.filter((r) => r.preparer_id === filters.teamFilter);
    if (search.trim()) { const q = search.trim().toLowerCase(); l = l.filter((r) => (r.client || '').toLowerCase().includes(q) || (r.notes || '').toLowerCase().includes(q)); }
    if (staleOnly) l = l.filter(isStale);
    return l;
  }, [rows, filters.teamFilter, search, staleOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const setCell = async (entityId, col, value) => {
    try {
      await callTracker({ action: 'set_cell', entity_id: entityId, col, value });
      setRows((prev) => prev.map((r) => (r.entity_id === entityId ? { ...r, [col === 'payroll' ? 'payroll' : col === 'vat_qtr' ? 'vat_qtr' : col]: value || (col === 'payroll' || col === 'vat_qtr' ? r[col] : null) } : r)));
      await load();
    } catch (e) { setError(e.message || String(e)); }
  };

  const th = { padding: '8px 8px', fontSize: 11.5, fontWeight: 700, color: '#475569', background: '#f8fafc', borderBottom: '1px solid #e5e7eb', textAlign: 'left', whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1 };
  const td = { padding: '6px 8px', fontSize: 12.5, borderBottom: '1px solid #f1f5f9', verticalAlign: 'top', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
  const live = { color: LIVE, fontWeight: 500 };
  const pill = (t, extra) => ({ display: 'inline-block', padding: '1px 7px', borderRadius: 8, fontSize: 12, fontWeight: 500, ...t, ...extra });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: font, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: '1px solid #e5e7eb', background: '#fff', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>Tracker</div>
        <div style={{ fontSize: 12.5, color: '#64748b' }}>· {visible.length} of {rows.length} clients{loading ? ' · loading…' : ''}</div>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search client or notes…" style={{ padding: '4px 10px', fontSize: 13, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 8, width: 220 }} />
        <button onClick={() => setStaleOnly((s) => !s)} style={{ ...BTN.secondary.sm, background: staleOnly ? '#dbeafe' : '#fff', borderColor: staleOnly ? '#0e7fe0' : '#cbd5e1', color: staleOnly ? '#0e7fe0' : '#334155' }}>Stale only</button>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 12, fontSize: 11.5, color: '#64748b', alignItems: 'center' }}>
          <span><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: LIVE, marginRight: 5 }} />live</span>
          <span><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: '#0f172a', marginRight: 5 }} />typed · click to edit</span>
          <span><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: '#eaf3de', marginRight: 5 }} />≤45d</span>
          <span><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: '#faeeda', marginRight: 5 }} />≤90d</span>
          <span><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: '#fcebeb', marginRight: 5 }} />older</span>
        </div>
      </div>
      {error && <div style={{ margin: '8px 14px 0', padding: '8px 12px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13 }}>{error}</div>}

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed', minWidth: 1180 }}>
          <colgroup>
            <col style={{ width: 44 }} /><col style={{ width: 56 }} /><col style={{ width: 210 }} /><col style={{ width: 86 }} /><col style={{ width: 118 }} /><col style={{ width: 150 }} /><col style={{ width: 90 }} /><col style={{ width: 80 }} /><col style={{ width: 70 }} /><col style={{ width: 84 }} /><col />
          </colgroup>
          <thead>
            <tr>
              <th style={th}>Prep</th><th style={th}>M/Q</th><th style={th}>Client</th><th style={th}>VAT qtr</th><th style={th}>Bank rec (main)</th><th style={th}>Other accounts</th><th style={th}>ME jrns</th><th style={th}>Year end</th><th style={th}>Payroll</th><th style={th}>Jrn checked</th><th style={th}>Notes</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.entity_id} onClick={() => setOpen(r.entity_id)} style={{ cursor: 'pointer', background: open === r.entity_id ? '#eff6ff' : '#fff' }}
                onMouseEnter={(e) => { if (open !== r.entity_id) e.currentTarget.style.background = '#f8fafc'; }} onMouseLeave={(e) => { if (open !== r.entity_id) e.currentTarget.style.background = '#fff'; }}>
                <td style={td}>{r.preparer_id ? <span title={r.preparer_name}><Avatar id={r.preparer_id} staffMap={staffMap} size={20} customColour={staffColours?.[r.preparer_id]} /></span> : <span style={{ color: '#cbd5e1' }}>·</span>}</td>
                <td style={td}><TypedCell value={r.cadence} options={['M', 'Q', 'A']} onSave={(v) => setCell(r.entity_id, 'cadence', v)} /></td>
                <td style={{ ...td, fontWeight: 500 }}>
                  {r.client}
                  {r.open_queries > 0 && <span title="Open queries" style={{ marginLeft: 6, ...pill({ background: '#fef3c7', color: '#92400e' }) }}>{r.open_queries} query{r.open_queries === 1 ? '' : 'ies'}</span>}
                  {!r.realm_id && <span title="No QuickBooks connection" style={{ marginLeft: 6, fontSize: 11, color: '#94a3b8' }}>no QBO</span>}
                </td>
                <td style={td}><TypedCell value={r.vat_qtr} placeholder="—" onSave={(v) => setCell(r.entity_id, 'vat_qtr', v)} /></td>
                <td style={td} title={r.main_account || ''}>{r.main_reconciled_to ? <span style={pill(tint(r.main_reconciled_to))}>{fmt(r.main_reconciled_to)}</span> : r.realm_id ? <span style={{ color: '#94a3b8' }}>not yet read</span> : <span style={{ color: '#cbd5e1' }}>·</span>}</td>
                <td style={td}>{r.bank_accounts > 1 ? <span style={pill(tint(r.oldest_reconciled_to))}>{r.bank_accounts} accts · oldest {r.oldest_reconciled_to ? fmt(r.oldest_reconciled_to) : 'never'}</span> : <span style={{ color: '#cbd5e1' }}>·</span>}</td>
                <td style={td}><TypedCell value={r.me_journals} onSave={(v) => setCell(r.entity_id, 'me_journals', v)} /></td>
                <td style={{ ...td, ...live }}>{r.year_end ? fmtMonth(r.year_end) : <span style={{ color: '#cbd5e1' }}>·</span>}</td>
                <td style={td}><TypedCell value={r.payroll} placeholder="—" onSave={(v) => setCell(r.entity_id, 'payroll', v)} /></td>
                <td style={td}>{r.jrn_checked ? <span style={pill(periodTint(r.jrn_checked), live)}>{fmtPeriod(r.jrn_checked)}</span> : <span style={{ color: '#cbd5e1' }}>·</span>}</td>
                <td style={{ ...td, whiteSpace: 'normal' }}><TypedCell value={r.notes} multiline placeholder="—" onSave={(v) => setCell(r.entity_id, 'notes', v)} /></td>
              </tr>
            ))}
            {!loading && visible.length === 0 && <tr><td colSpan={11} style={{ padding: 20, color: '#94a3b8', fontSize: 13 }}>Nothing matches.</td></tr>}
          </tbody>
        </table>
      </div>

      {open && <Drawer row={rows.find((r) => r.entity_id === open)} profile={profile} onClose={() => setOpen(null)} onChanged={load} navigate={navigate} />}
    </div>
  );
}

// The client drawer: bank accounts from QuickBooks, the journal check, and the
// control-account lines and queries with a date, note and author.
function Drawer({ row, profile, onClose, onChanged, navigate }) {
  const { staffMap } = useWorkPlanner();
  const [recs, setRecs] = useState([]);
  const [lines, setLines] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [draft, setDraft] = useState(null); // { id?, account, kind, last_date, amount, note }
  const entityId = row?.entity_id;

  const load = useCallback(async () => {
    if (!entityId) return;
    const [{ data: r }, { data: l }] = await Promise.all([
      supabase.from('tracker_bank_recs').select('*').eq('entity_id', entityId).order('account_name'),
      supabase.from('tracker_control_lines').select('*').eq('entity_id', entityId).order('resolved_at', { nullsFirst: true }).order('kind').order('account'),
    ]);
    setRecs(r || []); setLines(l || []);
  }, [entityId]);
  useEffect(() => { load(); }, [load]);

  if (!row) return null;
  const run = async (fn) => { setBusy(true); setErr(null); try { await fn(); await load(); onChanged && onChanged(); } catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); } };
  const who = (id) => (id ? (staffMap[id]?.name || '').split(' ')[0] : '');
  const openLines = lines.filter((l) => !l.resolved_at);
  const doneLines = lines.filter((l) => l.resolved_at);
  const lab = { fontSize: 10.5, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3 };
  const inp = { fontFamily: font, fontSize: 12.5, padding: '4px 8px', border: '1px solid #cbd5e1', borderRadius: 6 };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.18)', zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 520, maxWidth: '96vw', background: '#fff', boxShadow: '-4px 0 16px rgba(0,0,0,0.12)', display: 'flex', flexDirection: 'column', fontFamily: font }}>
        <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.client}</div>
            <div style={{ fontSize: 12.5, color: '#64748b' }}>{row.preparer_name ? `${row.preparer_name} · ` : ''}{row.vat_qtr ? `VAT ${row.vat_qtr} · ` : ''}{row.year_end ? `YE ${fmtMonth(row.year_end)}` : ''}</div>
          </div>
          <button onClick={() => navigate(`/clients/${entityId}`)} style={BTN.secondary.sm}>Open the client</button>
          <button onClick={onClose} style={BTN.secondary.sm}>Close</button>
        </div>
        {err && <div style={{ margin: '8px 16px 0', padding: '8px 12px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 12.5 }}>{err}</div>}
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 16px 16px' }}>

          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', flex: 1 }}>Bank and card accounts <span style={{ fontWeight: 500, color: LIVE, fontSize: 11.5 }}>· QuickBooks</span></div>
            {row.realm_id ? <button disabled={busy} onClick={() => run(() => callTracker({ action: 'refresh_recs', entity_id: entityId }))} style={BTN.secondary.sm}>{busy ? 'Reading…' : 'Refresh from QuickBooks'}</button> : <span style={{ fontSize: 12, color: '#94a3b8' }}>no connection</span>}
          </div>
          {row.recs_checked_at && <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 2 }}>last read {new Date(row.recs_checked_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>}
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, marginTop: 6, overflow: 'hidden' }}>
            {recs.length === 0 && <div style={{ padding: 10, fontSize: 12.5, color: '#cbd5e1' }}>{row.realm_id ? 'Not read yet — refresh, or wait for tonight.' : 'No QuickBooks connection for this client.'}</div>}
            {recs.map((a) => (
              <div key={a.qbo_account_id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 96px 110px', gap: 8, alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid #f1f5f9', fontSize: 12.5, opacity: a.active === false ? 0.5 : 1 }}>
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={a.account_name}>{a.account_name}<span style={{ color: '#94a3b8', fontSize: 11 }}> · {a.account_sub_type || a.account_type}{a.active === false ? ' · inactive' : ''}</span></span>
                <span style={{ textAlign: 'right', color: '#475569', fontVariantNumeric: 'tabular-nums' }}>{a.current_balance != null ? Number(a.current_balance).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''}</span>
                <span style={{ textAlign: 'right' }}>{a.reconciled_to ? <span style={{ display: 'inline-block', padding: '1px 7px', borderRadius: 8, fontSize: 12, fontWeight: 500, ...tint(a.reconciled_to) }}>{fmt(a.reconciled_to)}</span> : <span style={{ color: '#94a3b8' }}>never reconciled</span>}</span>
              </div>
            ))}
          </div>

          <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', marginTop: 16 }}>Payroll journal <span style={{ fontWeight: 500, color: LIVE, fontSize: 11.5 }}>· journal control check</span></div>
          <div style={{ fontSize: 12.5, color: '#475569', marginTop: 4 }}>
            {row.payroll ? `Payroll: ${row.payroll}. ` : 'No payroll recorded. '}
            {row.jrn_checked ? <>Last month checked against the client's QuickBooks: <span style={{ display: 'inline-block', padding: '1px 7px', borderRadius: 8, fontSize: 12, fontWeight: 500, ...periodTint(row.jrn_checked) }}>{fmtPeriod(row.jrn_checked)}</span></> : 'No month checked yet.'}
          </div>

          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', flex: 1 }}>Control accounts and queries <span style={{ fontWeight: 500, color: '#64748b', fontSize: 11.5 }}>· typed</span></div>
            <button onClick={() => setDraft({ account: '', kind: 'control', last_date: '', amount: '', note: '' })} style={BTN.secondary.sm}>+ Add</button>
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, marginTop: 6, overflow: 'hidden' }}>
            {openLines.length === 0 && !draft && <div style={{ padding: 10, fontSize: 12.5, color: '#cbd5e1' }}>Nothing recorded. Add a control account with the date it was last reconciled, or a query.</div>}
            {openLines.map((l) => (
              <div key={l.id} style={{ padding: '7px 10px', borderBottom: '1px solid #f1f5f9', fontSize: 12.5 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <span style={{ fontWeight: 500, flex: 1, minWidth: 0 }}>{l.kind === 'query' ? <span style={{ display: 'inline-block', padding: '0 6px', borderRadius: 8, fontSize: 10.5, fontWeight: 600, background: '#fef3c7', color: '#92400e', marginRight: 6 }}>query</span> : null}{l.account}</span>
                  {l.amount != null && <span style={{ color: '#475569', fontVariantNumeric: 'tabular-nums' }}>{Number(l.amount).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>}
                  {l.last_date && <span style={{ display: 'inline-block', padding: '1px 7px', borderRadius: 8, fontSize: 12, fontWeight: 500, ...tint(l.last_date) }}>{fmt(l.last_date)}</span>}
                </div>
                {l.note && <div style={{ color: '#475569', marginTop: 2, whiteSpace: 'pre-wrap' }}>{l.note}</div>}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
                  <span style={{ fontSize: 11, color: '#94a3b8', flex: 1 }}>{who(l.updated_by || l.created_by)} · {fmt(l.updated_at || l.created_at)}</span>
                  <button onClick={() => setDraft({ id: l.id, account: l.account, kind: l.kind, last_date: l.last_date || '', amount: l.amount ?? '', note: l.note || '' })} style={{ ...BTN.secondary.sm, padding: '1px 7px', fontSize: 11 }}>Edit</button>
                  <button disabled={busy} onClick={() => run(() => callTracker({ action: 'save_line', id: l.id, entity_id: entityId, account: l.account, kind: l.kind, last_date: l.last_date, amount: l.amount, note: l.note, resolved: true }))} style={{ ...BTN.secondary.sm, padding: '1px 7px', fontSize: 11 }}>{l.kind === 'query' ? 'Resolved' : 'Archive'}</button>
                </div>
              </div>
            ))}
            {draft && (
              <div style={{ padding: 10, background: '#eff6ff', borderTop: '1px solid #bfdbfe', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input value={draft.account} onChange={(e) => setDraft((d) => ({ ...d, account: e.target.value }))} placeholder="Account, e.g. Payroll clearing" style={{ ...inp, flex: 1 }} autoFocus />
                  <select value={draft.kind} onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value }))} style={inp}><option value="control">Control account</option><option value="query">Query</option></select>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <label style={{ ...lab, display: 'flex', flexDirection: 'column', gap: 2 }}>Last reconciled<input type="date" value={draft.last_date} onChange={(e) => setDraft((d) => ({ ...d, last_date: e.target.value }))} style={inp} /></label>
                  <label style={{ ...lab, display: 'flex', flexDirection: 'column', gap: 2 }}>Balance<input type="number" step="0.01" value={draft.amount} onChange={(e) => setDraft((d) => ({ ...d, amount: e.target.value }))} style={{ ...inp, width: 120 }} /></label>
                </div>
                <textarea value={draft.note} onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))} placeholder="Note" rows={2} style={{ ...inp, resize: 'vertical' }} />
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  {draft.id && <button disabled={busy} onClick={() => { if (window.confirm('Delete this line?')) run(() => callTracker({ action: 'delete_line', id: draft.id })).then(() => setDraft(null)); }} style={{ ...BTN.secondary.sm, color: '#991b1b' }}>Delete</button>}
                  <div style={{ flex: 1 }} />
                  <button onClick={() => setDraft(null)} style={BTN.secondary.sm}>Cancel</button>
                  <button disabled={busy || !draft.account.trim()} onClick={() => run(() => callTracker({ action: 'save_line', ...draft, entity_id: entityId, last_date: draft.last_date || null, amount: draft.amount === '' ? null : Number(draft.amount) })).then(() => setDraft(null))} style={BTN.primary.sm}>{busy ? 'Saving…' : 'Save'}</button>
                </div>
              </div>
            )}
          </div>
          {doneLines.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ fontSize: 12, color: '#64748b', cursor: 'pointer' }}>{doneLines.length} archived or resolved</summary>
              {doneLines.map((l) => (
                <div key={l.id} style={{ display: 'flex', gap: 8, padding: '4px 4px', fontSize: 12, color: '#94a3b8', borderBottom: '1px solid #f8fafc' }}>
                  <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.account}{l.note ? ` — ${l.note}` : ''}</span>
                  <span>{fmt(l.last_date)}</span>
                  <button disabled={busy} onClick={() => run(() => callTracker({ action: 'save_line', id: l.id, entity_id: entityId, account: l.account, kind: l.kind, last_date: l.last_date, amount: l.amount, note: l.note, resolved: false }))} style={{ ...BTN.secondary.sm, padding: '0 6px', fontSize: 11 }}>Reopen</button>
                </div>
              ))}
            </details>
          )}
          <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 14 }}>Typed cells on the grid (cadence, VAT quarter, month-end journals, payroll, notes) edit in place. {profile?.name ? `You are ${profile.name.split(' ')[0]}.` : ''}</div>
        </div>
      </div>
    </div>
  );
}
