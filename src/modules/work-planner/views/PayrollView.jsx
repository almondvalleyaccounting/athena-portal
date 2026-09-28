import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../shell/AppShell';
import { useWorkPlanner } from '../WorkPlannerModule';
import Avatar from '../components/Avatar';
import { BTN } from '../../../lib/buttonStyles';

// Payroll (Bobby, 2026-09-27): the team's weekly and monthly BrightPay
// checklists as an interactive tick list, replacing two spreadsheets from
// October 2026 (sql/333). One row per payroll client, one column per step,
// one sheet per tax week or tax month. Pay date, cut-off, runner, pay type
// and the standing note are held once per client. Every tick records who
// and when. "Journal posted" is the one live column, from the journal
// control check. Controls is a third sheet, in development: the team's
// ticks against BrightPay and HMRC.

const font = "'Outfit', sans-serif";
const STEPS = [
  { id: 'approval',  label: 'Approval / entry requested' },
  { id: 'hours',     label: 'Hours / salary checked for each employee' },
  { id: 'processed', label: 'Payroll reviewed and processed' },
  { id: 'fps',       label: 'FPS sent to HMRC' },
  { id: 'payslips',  label: 'Payslips released to employees / directors' },
  { id: 'modulr',    label: 'Approval sent to Modulr' },
  { id: 'pension',   label: 'Pension submission sent' },
  { id: 'eps',       label: 'EPS checked and sent to HMRC' },
];
const PAY_TYPES = [['', '—'], ['fixed', 'Fixed'], ['variable', 'Variable'], ['entry', 'Payroll entry']];
const fmt = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');
const fmtTs = (ts) => (ts ? new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// The notes that show in a period: its own, plus any "going forward" note
// whose window overlaps it (sql/340).
const notesForPeriod = (q, p) => q.or(`period_id.eq.${p.id},and(kind.eq.ongoing,starts_on.lte.${p.end_date},or(ends_on.is.null,ends_on.gte.${p.start_date}))`);

async function callPayroll(payload) {
  const { data, error } = await supabase.functions.invoke('payroll-tracker', { body: payload });
  if (error || !data?.success) {
    let msg = data?.error || 'Could not save';
    try { const j = await error?.context?.json?.(); if (j?.error) msg = j.error; } catch { /* body already read */ }
    throw new Error(msg);
  }
  return data;
}

// The calendar month a tax month is paid in: tax month n of 2026/27 starts 6
// April 2026 + (n-1) months, so its journal period is that month.
const journalPeriodOf = (p) => (p?.frequency === 'monthly' ? String(p.start_date).slice(0, 7) : null);
// A cut-off like "20th" inside the pay month; null when it is not a day.
const cutoffDate = (p, cutoff) => {
  const d = parseInt(String(cutoff || '').replace(/\D/g, ''), 10);
  if (!p || !d || d < 1 || d > 31) return null;
  const s = new Date(`${p.start_date}T12:00:00`);
  const m = new Date(s.getFullYear(), s.getMonth() + (d < 6 ? 1 : 0), d);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}-${String(m.getDate()).padStart(2, '0')}`;
};
const groupOf = (c) => {
  if (c.frequency === 'eps_only') return { key: 'z-eps', label: 'EPS only' };
  if (c.batch) return { key: 'y-batch', label: 'Batch · last working day · run together' };
  const pd = String(c.pay_day || '').toLowerCase();
  if (c.frequency === 'weekly') return { key: `w-${pd || 'zz'}`, label: pd ? `Paid ${c.pay_day}` : 'Weekly' };
  if (/lwd|last/.test(pd)) return { key: 'x-lwd', label: 'Last working day' };
  const n = parseInt(pd.replace(/\D/g, ''), 10);
  return n ? { key: `m-${String(n).padStart(2, '0')}`, label: `Paid ${c.pay_day}` } : { key: 'm-zz', label: 'Pay date not set' };
};

export default function PayrollView() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const { staffList, staffMap, staffColours, filters, setTeamFilter, entityList = [], entityMap = {} } = useWorkPlanner();
  const displayName = (c) => (c.entity_id && entityMap[c.entity_id]?.name) || c.name;
  const [sheet, setSheet] = useState(() => { try { return localStorage.getItem('payroll.sheet') || 'monthly'; } catch { return 'monthly'; } });
  const [periods, setPeriods] = useState([]);
  const [periodId, setPeriodId] = useState(null);
  const [clients, setClients] = useState([]);
  const [ticks, setTicks] = useState({}); // `${client}|${step}` -> tick row
  const [noteCounts, setNoteCounts] = useState({});
  const [journal, setJournal] = useState({}); // realm_id -> status
  const [outstandingOnly, setOutstandingOnly] = useState(false);
  const [includeCeased, setIncludeCeased] = useState(false);
  const [search, setSearch] = useState('');
  const [drawer, setDrawer] = useState(null); // client id, or 'new'
  const [colFilters, setColFilters] = useState({}); // column key -> array of allowed values
  const [filterMenu, setFilterMenu] = useState(null); // { key, label, x, y }
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const today = todayISO();
  const who = filters.teamFilter || null;
  const freq = sheet === 'controls' ? 'monthly' : sheet;

  useEffect(() => { try { localStorage.setItem('payroll.sheet', sheet); } catch { /* private window */ } }, [sheet]);

  // Periods for this sheet; land on the one that contains today.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: e } = await supabase.from('payroll_periods').select('*').eq('frequency', freq).order('start_date');
      if (cancelled) return;
      if (e) { setError(e.message); return; }
      setPeriods(data || []);
      const cur = (data || []).find((p) => p.start_date <= today && p.end_date >= today) || (data || [])[0];
      setPeriodId((pid) => ((data || []).some((p) => p.id === pid) ? pid : cur?.id || null));
    })();
    return () => { cancelled = true; };
  }, [freq, today]);
  const period = periods.find((p) => p.id === periodId) || null;
  const pIndex = periods.findIndex((p) => p.id === periodId);

  const load = useCallback(async () => {
    if (!period) return;
    setLoading(true); setError(null);
    try {
      const wantFreq = freq === 'monthly' ? ['monthly', 'eps_only'] : ['weekly'];
      const [{ data: cs, error: e1 }, { data: ts, error: e2 }, { data: ns }] = await Promise.all([
        supabase.from('payroll_clients').select('*').in('frequency', wantFreq).order('sort_order').order('name').limit(1000),
        supabase.from('payroll_ticks').select('*').eq('period_id', period.id).limit(5000),
        notesForPeriod(supabase.from('payroll_period_notes').select('client_id'), period).is('retired_at', null).limit(2000),
      ]);
      if (e1) throw e1; if (e2) throw e2;
      setClients(cs || []);
      const m = {}; (ts || []).forEach((t) => { m[`${t.client_id}|${t.step}`] = t; }); setTicks(m);
      const nc = {}; (ns || []).forEach((n) => { nc[n.client_id] = (nc[n.client_id] || 0) + 1; }); setNoteCounts(nc);
      const jp = journalPeriodOf(period);
      if (jp) {
        const { data: js } = await supabase.rpc('payroll_journal_status', { p_period: jp });
        setJournal(Object.fromEntries((js || []).map((r) => [r.realm_id, r.status])));
      } else setJournal({});
    } catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, [period, freq]);
  useEffect(() => { load(); }, [load]);

  const tickOf = (c, step) => ticks[`${c.id}|${step}`] || null;
  const stateOf = (c, step) => (c.na_steps || []).includes(step) ? 'na-fixed' : (tickOf(c, step)?.state || 'open');
  const isComplete = (c) => STEPS.every((s) => stateOf(c, s.id) !== 'open');
  const lateFor = (c) => {
    if (!period) return false;
    const cut = freq === 'monthly' ? (cutoffDate(period, c.cutoff) || period.end_date) : period.end_date;
    return today > cut;
  };

  // The value a column shows for a row, as the filter sees it.
  const valueOf = (c, key) => {
    if (key === 'pay_day') return c.pay_day || '—';
    if (key === 'cutoff') return c.cutoff || '—';
    if (key === 'runner') return c.runner_id ? (staffMap[c.runner_id]?.name || '?') : (c.runner_name || (c.batch ? 'Batch' : '—'));
    if (key === 'cover') return c.cover_id ? (staffMap[c.cover_id]?.name || '?') : '—';
    if (key === 'journal') return c.frequency === 'eps_only' || !c.realm_id ? 'no realm' : journal[c.realm_id] === 'checked' ? 'posted' : 'not yet seen';
    if (key === 'note') return c.standing_note ? 'has a note' : 'no note';
    if (key === 'group') return groupOf(c).label;
    const st = stateOf(c, key);
    return st === 'done' ? 'done' : st === 'open' ? 'not yet' : 'n/a';
  };
  const activeFilterKeys = Object.keys(colFilters).filter((k) => colFilters[k] && colFilters[k].length);
  const visible = useMemo(() => {
    let list = clients.filter((c) => includeCeased || (c.active && !c.ceased_on));
    for (const k of activeFilterKeys) { const allow = new Set(colFilters[k]); list = list.filter((c) => allow.has(valueOf(c, k))); }
    if (who) list = list.filter((c) => c.runner_id === who || c.cover_id === who);
    if (search.trim()) { const q = search.trim().toLowerCase(); list = list.filter((c) => displayName(c).toLowerCase().includes(q) || c.name.toLowerCase().includes(q) || (c.standing_note || '').toLowerCase().includes(q)); }
    if (outstandingOnly) list = list.filter((c) => !isComplete(c));
    return list;
  }, [clients, includeCeased, who, search, outstandingOnly, ticks, colFilters, journal]); // eslint-disable-line react-hooks/exhaustive-deps
  // Distinct values for the open filter menu, from everything that is not hidden by the other filters.
  const menuValues = useMemo(() => {
    if (!filterMenu) return [];
    let list = clients.filter((c) => includeCeased || (c.active && !c.ceased_on));
    for (const k of activeFilterKeys) { if (k === filterMenu.key) continue; const allow = new Set(colFilters[k]); list = list.filter((c) => allow.has(valueOf(c, k))); }
    const counts = new Map();
    list.forEach((c) => { const v = valueOf(c, filterMenu.key); counts.set(v, (counts.get(v) || 0) + 1); });
    return [...counts.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  }, [filterMenu, clients, includeCeased, colFilters, ticks, journal]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleValue = (key, v) => setColFilters((f) => {
    const cur = f[key] && f[key].length ? [...f[key]] : menuValues.map(([x]) => x);
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    const all = menuValues.map(([x]) => x);
    if (all.every((x) => next.includes(x))) { const n = { ...f }; delete n[key]; return n; }
    return { ...f, [key]: next };
  });
  const openFilter = (e, key, label) => { e.stopPropagation(); setFilterMenu((m) => (m?.key === key ? null : { key, label, x: e.clientX, y: e.clientY })); };
  const isFiltered = (key) => !!(colFilters[key] && colFilters[key].length);
  const groups = useMemo(() => {
    const m = new Map();
    visible.forEach((c) => { const g = groupOf(c); if (!m.has(g.key)) m.set(g.key, { ...g, items: [] }); m.get(g.key).items.push(c); });
    return [...m.values()].sort((a, b) => a.key.localeCompare(b.key));
  }, [visible]);
  const activeClients = clients.filter((c) => c.active && !c.ceased_on);
  const complete = activeClients.filter(isComplete).length;

  // Click cycles open → done → n/a → open. Optimistic; the server records who and when.
  // A step either applies to a client or it does not (right-click sets that,
  // and it sticks for every period). When it applies, a click toggles done.
  const [naMenu, setNaMenu] = useState(null); // { client, step, x, y }
  const setNa = async (c, step, na) => {
    const next = na ? [...new Set([...(c.na_steps || []), step])] : (c.na_steps || []).filter((x) => x !== step);
    setClients((cs) => cs.map((x) => (x.id === c.id ? { ...x, na_steps: next } : x)));
    setNaMenu(null);
    try { await callPayroll({ action: 'save_client', id: c.id, na_steps: next }); }
    catch (e) { setError(e.message); await load(); }
  };
  // n/a for this period only: a tick row with state 'na' (right-click sets it)
  const setNaPeriod = async (c, step, na) => {
    const key = `${c.id}|${step}`;
    const prev = ticks[key];
    setNaMenu(null);
    setTicks((t) => { const n = { ...t }; if (na) n[key] = { client_id: c.id, period_id: period.id, step, state: 'na', by_id: profile?.id, by_name: profile?.name, at: new Date().toISOString() }; else delete n[key]; return n; });
    try { await callPayroll({ action: 'set_tick', client_id: c.id, period_id: period.id, step, state: na ? 'na' : null }); }
    catch (e) { setError(e.message); setTicks((t) => { const n = { ...t }; if (prev) n[key] = prev; else delete n[key]; return n; }); }
  };
  const cycle = async (c, step) => {
    const cur = stateOf(c, step);
    if (cur === 'na-fixed' || cur === 'na') return; // right-click to make it apply again
    const next = cur === 'done' ? null : 'done';
    const key = `${c.id}|${step}`;
    const prev = ticks[key];
    setTicks((t) => { const n = { ...t }; if (next) n[key] = { client_id: c.id, period_id: period.id, step, state: next, by_id: profile?.id, by_name: profile?.name, at: new Date().toISOString() }; else delete n[key]; return n; });
    try { await callPayroll({ action: 'set_tick', client_id: c.id, period_id: period.id, step, state: next }); }
    catch (e) { setError(e.message); setTicks((t) => { const n = { ...t }; if (prev) n[key] = prev; else delete n[key]; return n; }); }
  };

  const runnerLabel = (c) => (c.runner_id ? (staffMap[c.runner_id]?.name || '').split(' ')[0] : (c.runner_name || (c.batch ? 'Batch' : '—')));
  const periodLabel = (p) => (p ? `${p.frequency === 'weekly' ? 'Week' : 'Month'} ${p.number} · ${p.tax_year} · ${fmt(p.start_date)} – ${fmt(p.end_date)}${p.frequency === 'monthly' ? ` · paid ${new Date(`${p.start_date}T12:00:00`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}` : ''}` : '');

  // ── styles ──
  const th = { position: 'sticky', top: 0, zIndex: 3, background: '#f8fafc', borderBottom: '1px solid #cbd5e1', padding: '6px 6px', fontSize: 11, fontWeight: 600, color: '#475569', textAlign: 'center', verticalAlign: 'bottom', whiteSpace: 'normal', lineHeight: 1.25, height: 64, minWidth: 64, cursor: 'pointer', userSelect: 'none' };
  const thF = (key) => (isFiltered(key) ? { background: '#dbeafe', color: '#0c447c', boxShadow: 'inset 0 -2px 0 #0e7fe0' } : {});
  const Funnel = ({ k }) => (isFiltered(k) ? <span title="Filtered — click to change" style={{ marginLeft: 3, color: '#0e7fe0' }}>▼</span> : null);
  const thL = { ...th, textAlign: 'left' };
  const td = { padding: '5px 6px', borderBottom: '1px solid #f1f5f9', fontSize: 12.5, textAlign: 'center', whiteSpace: 'nowrap', background: '#fff' };
  const sticky1 = { position: 'sticky', left: 0, zIndex: 2, background: '#fff', minWidth: 190, maxWidth: 240, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', borderRight: '1px solid #f1f5f9' };
  const sticky2 = { position: 'sticky', left: 240, zIndex: 2, background: '#fff', minWidth: 62, textAlign: 'left', borderRight: '1px solid #e5e7eb' };
  const tile = (state, late) => ({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 5, cursor: state === 'na-fixed' ? 'default' : 'pointer', fontSize: 13, fontWeight: 700, userSelect: 'none',
    ...(state === 'done' ? { background: '#dcfce7', color: '#166534', border: '1px solid #86efac' }
      : state === 'na' || state === 'na-fixed' ? { background: '#e2e8f0', color: '#e2e8f0', border: '1px solid #e2e8f0' }
      : { border: `1px solid ${late ? '#fca5a5' : '#cbd5e1'}`, background: late ? '#fef2f2' : '#fff', color: 'transparent' }),
  });
  const pill = (bg, fg) => ({ display: 'inline-block', padding: '1px 7px', borderRadius: 8, fontSize: 10.5, fontWeight: 600, background: bg, color: fg });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: font, minHeight: 0 }}>
      {/* sheet + period bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid #e5e7eb', background: '#fff', flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', border: '1px solid #cbd5e1', borderRadius: 6, overflow: 'hidden' }}>
          {[['weekly', 'Weekly'], ['monthly', 'Monthly'], ['controls', 'Controls']].map(([id, label]) => (
            <button key={id} onClick={() => setSheet(id)} style={{ ...BTN.secondary.sm, border: 'none', borderRadius: 0, padding: '4px 12px', fontSize: 12.5, background: sheet === id ? '#dbeafe' : '#fff', color: sheet === id ? '#0e7fe0' : '#334155', fontWeight: sheet === id ? 600 : 500 }}>
              {label}{id === 'controls' && <span style={{ ...pill('#fef3c7', '#92400e'), marginLeft: 6 }}>In development</span>}
            </button>
          ))}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <button onClick={() => pIndex > 0 && setPeriodId(periods[pIndex - 1].id)} disabled={pIndex <= 0} style={{ ...BTN.secondary.sm, padding: '2px 8px' }}>‹</button>
          <select value={periodId || ''} onChange={(e) => setPeriodId(e.target.value)} style={{ padding: '4px 8px', fontSize: 12.5, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', maxWidth: 360 }}>
            {periods.map((p) => <option key={p.id} value={p.id}>{periodLabel(p)}</option>)}
          </select>
          <button onClick={() => pIndex >= 0 && pIndex < periods.length - 1 && setPeriodId(periods[pIndex + 1].id)} disabled={pIndex < 0 || pIndex >= periods.length - 1} style={{ ...BTN.secondary.sm, padding: '2px 8px' }}>›</button>
          <button onClick={() => { const cur = periods.find((p) => p.start_date <= today && p.end_date >= today); if (cur) setPeriodId(cur.id); }} style={BTN.secondary.sm}>Now</button>
        </span>
        {sheet !== 'controls' && (
          <>
            <button onClick={() => setOutstandingOnly((v) => !v)} style={outstandingOnly ? { ...BTN.secondary.sm, background: '#dbeafe', borderColor: '#0e7fe0', color: '#0e7fe0' } : BTN.secondary.sm}>Outstanding only</button>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search clients…" style={{ padding: '4px 10px', fontSize: 12.5, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 8, width: 170 }} />
            <label style={{ fontSize: 12, color: '#64748b', display: 'inline-flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={includeCeased} onChange={(e) => setIncludeCeased(e.target.checked)} /> ceased</label>
          </>
        )}
        {activeFilterKeys.length > 0 && (
          <button onClick={() => setColFilters({})} title={activeFilterKeys.join(', ')} style={{ ...BTN.secondary.sm, background: '#dbeafe', borderColor: '#0e7fe0', color: '#0c447c' }}>
            ▼ {activeFilterKeys.length} column filter{activeFilterKeys.length === 1 ? '' : 's'} on · clear
          </button>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12.5, color: '#64748b' }}>{visible.length !== activeClients.length && !who && !search && !outstandingOnly ? `${visible.length} shown · ` : ''}{complete} of {activeClients.length} complete{who ? ` · ${(staffMap[who]?.name || '').split(' ')[0]} only` : ''}{loading ? ' · loading…' : ''}</span>
        {sheet !== 'controls' && <button onClick={() => setDrawer('new')} style={BTN.primary.sm}>+ Payroll client</button>}
      </div>
      {error && <div style={{ margin: '8px 12px 0', padding: '8px 12px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13 }}>{error}</div>}

      {sheet === 'controls' ? (
        <ControlsSheet period={period} clients={clients} journal={journal} ticks={ticks} stateOf={stateOf} />
      ) : (
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '0 0 12px' }}>
          <table style={{ borderCollapse: 'separate', borderSpacing: 0, minWidth: '100%' }}>
            <thead>
              <tr>
                <th style={{ ...thL, ...sticky1, zIndex: 4 }}>Client</th>
                <th onClick={(e) => openFilter(e, 'pay_day', 'Pay date')} style={{ ...thL, ...sticky2, zIndex: 4, ...thF('pay_day') }}>Pay date<Funnel k="pay_day" /></th>
                <th onClick={(e) => openFilter(e, 'cutoff', 'Cut-off')} style={{ ...th, minWidth: 56, ...thF('cutoff') }}>Cut-off<Funnel k="cutoff" /></th>
                <th onClick={(e) => openFilter(e, 'runner', 'Runner')} style={{ ...th, textAlign: 'left', minWidth: 96, ...thF('runner') }}>Runner<Funnel k="runner" /></th>
                <th onClick={(e) => openFilter(e, 'cover', 'Cover')} style={{ ...th, textAlign: 'left', minWidth: 90, ...thF('cover') }}>Cover<Funnel k="cover" /></th>
                {STEPS.map((s) => <th key={s.id} onClick={(e) => openFilter(e, s.id, s.label)} style={{ ...th, maxWidth: 92, ...thF(s.id) }}>{s.label}<Funnel k={s.id} /></th>)}
                {freq === 'monthly' && <th onClick={(e) => openFilter(e, 'journal', 'Journal posted')} style={{ ...th, maxWidth: 80, background: '#f0fdfa', color: '#0f766e', ...thF('journal') }}>Journal posted to QuickBooks (live)<Funnel k="journal" /></th>}
                <th onClick={(e) => openFilter(e, 'note', 'Important notes')} style={{ ...thL, minWidth: 220, ...thF('note') }}>Important notes<Funnel k="note" /></th>
                <th style={{ ...th, minWidth: 44 }}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <React.Fragment key={g.key}>
                  <tr><td colSpan={7 + STEPS.length + (freq === 'monthly' ? 1 : 0)} style={{ padding: '8px 10px 4px', fontSize: 11.5, fontWeight: 700, color: '#64748b', background: '#f8fafc', borderBottom: '1px solid #e5e7eb', position: 'sticky', left: 0 }}>{g.label} <span style={{ fontWeight: 500, color: '#94a3b8' }}>· {g.items.length}</span></td></tr>
                  {g.items.map((c) => {
                    const late = lateFor(c) && !isComplete(c);
                    const js = c.realm_id ? journal[c.realm_id] : undefined;
                    return (
                      <tr key={c.id} style={{ opacity: c.active && !c.ceased_on ? 1 : 0.55 }}>
                        <td style={{ ...td, ...sticky1, cursor: 'pointer', fontWeight: 500 }} onClick={() => setDrawer(c.id)} title={displayName(c)}>{displayName(c)}{c.entity_id ? '' : <span title="Not yet linked to a client record — open and pick the client" style={{ marginLeft: 6, color: '#f59e0b' }}>•</span>}</td>
                        <td style={{ ...td, ...sticky2 }}>{c.pay_day || <span style={{ color: '#cbd5e1' }}>—</span>}</td>
                        <td style={td}>{c.cutoff || <span style={{ color: '#cbd5e1' }}>—</span>}</td>
                        <td style={{ ...td, textAlign: 'left' }}>{c.runner_id ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Avatar id={c.runner_id} staffMap={staffMap} size={16} customColour={staffColours?.[c.runner_id]} />{runnerLabel(c)}</span> : runnerLabel(c)}</td>
                        <td style={{ ...td, textAlign: 'left' }}>{c.cover_id ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Avatar id={c.cover_id} staffMap={staffMap} size={16} customColour={staffColours?.[c.cover_id]} />{(staffMap[c.cover_id]?.name || '').split(' ')[0]}</span> : ''}</td>
                        {STEPS.map((s) => {
                          const st = stateOf(c, s.id);
                          const t = tickOf(c, s.id);
                          const title = st === 'na-fixed' ? 'Not applicable for this client (set in the drawer)' : st === 'open' ? `${s.label} · not yet${late ? ' · past cut-off' : ''}` : `${st === 'done' ? 'Done' : 'Not applicable'} · ${t?.by_name || 'unknown'} · ${t?.source === 'import' ? 'from the spreadsheet' : fmtTs(t?.at)}`;
                          return (
                            <td key={s.id} style={td}>
                              <span onClick={() => cycle(c, s.id)} onContextMenu={(e) => { e.preventDefault(); setNaMenu({ client: c, step: s.id, label: s.label, x: e.clientX, y: e.clientY }); }} title={`${title} · right-click to change whether this step applies`} style={tile(st, late)}>{st === 'done' ? '✓' : ''}</span>
                            </td>
                          );
                        })}
                        {freq === 'monthly' && (
                          <td style={td} title={c.realm_id ? `Journal control check, ${journalPeriodOf(period)}` : 'No QuickBooks realm linked'}>
                            {c.frequency === 'eps_only' || !c.realm_id ? <span style={{ color: '#cbd5e1' }}>–</span>
                              : js === 'checked' ? <span style={{ ...tile('done'), background: '#ccfbf1', color: '#0f766e', cursor: 'default' }}>✓</span>
                              : <span style={{ ...tile('open'), border: 'none', background: '#fef3c7', color: '#92400e', cursor: 'default' }}>?</span>}
                          </td>
                        )}
                        <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal', maxWidth: 320, fontSize: 11.5, color: '#64748b', lineHeight: 1.3 }}>{c.standing_note}</td>
                        <td style={{ ...td, cursor: 'pointer', color: noteCounts[c.id] ? '#0e7fe0' : '#cbd5e1' }} onClick={() => setDrawer(c.id)}>{noteCounts[c.id] || '+'}</td>
                      </tr>
                    );
                  })}
                </React.Fragment>
              ))}
              {!loading && visible.length === 0 && (
                <tr><td colSpan={16} style={{ padding: 20, fontSize: 13, color: '#475569', position: 'sticky', left: 0 }}>
                  {clients.length === 0 ? 'No payroll clients on this sheet yet.'
                    : who ? <>Showing only payrolls run or covered by {staffMap[who]?.name || 'the person picked'} in the Team filter, and there are none. <button onClick={() => setTeamFilter && setTeamFilter('')} style={{ ...BTN.secondary.sm, marginLeft: 6 }}>Show everyone</button></>
                    : activeFilterKeys.length ? <>Every row is hidden by the column filters. <button onClick={() => setColFilters({})} style={{ ...BTN.secondary.sm, marginLeft: 6 }}>Clear filters</button></>
                    : outstandingOnly ? <>Everything on this sheet is complete. <button onClick={() => setOutstandingOnly(false)} style={{ ...BTN.secondary.sm, marginLeft: 6 }}>Show all</button></>
                    : search ? 'No client matches that search.' : 'Nothing to show.'}
                </td></tr>
              )}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 14, padding: '8px 12px', fontSize: 11, color: '#94a3b8', flexWrap: 'wrap' }}>
            <span><span style={{ ...tile('done'), width: 14, height: 14, fontSize: 10, verticalAlign: -2 }}>✓</span> green tick · done, hover for who and when</span>
            <span><span style={{ ...tile('open'), width: 14, height: 14, verticalAlign: -2 }} /> white · not done · click to tick, click again to untick</span>
            <span><span style={{ ...tile('na'), width: 14, height: 14, verticalAlign: -2 }} /> grey · not applicable · right-click a cell: this period, or going forward</span>
            <span><span style={{ ...tile('open', true), width: 14, height: 14, verticalAlign: -2 }} /> past cut-off, still open</span>
            {freq === 'monthly' && <span><span style={{ ...tile('done'), background: '#ccfbf1', color: '#0f766e', width: 14, height: 14, fontSize: 10, verticalAlign: -2 }}>✓</span> journal seen in QuickBooks (live, not tickable)</span>}
            <span><span style={{ color: '#f59e0b' }}>•</span> not linked to a client record</span>
          </div>
        </div>
      )}

      {naMenu && (
        <div onClick={() => setNaMenu(null)} onContextMenu={(e) => { e.preventDefault(); setNaMenu(null); }} style={{ position: 'fixed', inset: 0, zIndex: 95 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ position: 'fixed', left: Math.min(naMenu.x, window.innerWidth - 300), top: Math.min(naMenu.y, window.innerHeight - 120), width: 280, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.12)', padding: 6, fontFamily: font, fontSize: 13 }}>
            <div style={{ padding: '4px 8px 6px', fontSize: 11.5, color: '#64748b' }}>{displayName(naMenu.client)} · {naMenu.label}</div>
            {(() => {
              const item = { display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px', border: 'none', background: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: font, fontSize: 13, color: '#0f172a' };
              const hint = { fontSize: 11.5, color: '#64748b' };
              const c = naMenu.client, step = naMenu.step;
              if ((c.na_steps || []).includes(step)) return <button onClick={() => setNa(c, step, false)} style={item}>This step applies again, going forward<div style={hint}>Takes it off the not-applicable list for this client.</div></button>;
              if (tickOf(c, step)?.state === 'na') return <button onClick={() => setNaPeriod(c, step, false)} style={item}>This step applies this period after all<div style={hint}>Back to a white box for this period.</div></button>;
              return (<>
                <button onClick={() => setNaPeriod(c, step, true)} style={item}>Not applicable this period<div style={hint}>Grey for this period only.</div></button>
                <button onClick={() => setNa(c, step, true)} style={item}>Not applicable going forward<div style={hint}>Grey in every period for this client until changed.</div></button>
              </>);
            })()}
          </div>
        </div>
      )}
      {filterMenu && (
        <div onClick={() => setFilterMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 90 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ position: 'fixed', left: Math.min(filterMenu.x, window.innerWidth - 260), top: Math.min(filterMenu.y + 8, window.innerHeight - 320), width: 240, maxHeight: 300, overflowY: 'auto', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.12)', padding: 8, fontFamily: font, fontSize: 12.5 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <span style={{ fontWeight: 700, color: '#0f172a', flex: 1 }}>{filterMenu.label}</span>
              {isFiltered(filterMenu.key) && <button onClick={() => setColFilters((f) => { const n = { ...f }; delete n[filterMenu.key]; return n; })} style={{ ...BTN.secondary.sm, padding: '0 7px', fontSize: 11 }}>Clear</button>}
            </div>
            {menuValues.map(([v, n]) => {
              const on = !isFiltered(filterMenu.key) || colFilters[filterMenu.key].includes(v);
              return (
                <label key={String(v)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 2px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={on} onChange={() => toggleValue(filterMenu.key, v)} />
                  <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{String(v)}</span>
                  <span style={{ color: '#94a3b8' }}>{n}</span>
                </label>
              );
            })}
            {menuValues.length === 0 && <div style={{ color: '#cbd5e1' }}>Nothing to filter.</div>}
          </div>
        </div>
      )}

      {drawer && (
        <ClientDrawer
          client={drawer === 'new' ? null : clients.find((c) => c.id === drawer)}
          defaultFrequency={freq}
          period={period}
          ticks={ticks}
          staffList={staffList} staffMap={staffMap} entityList={entityList} entityMap={entityMap} navigate={navigate}
          onClose={() => setDrawer(null)}
          onSaved={async () => { await load(); }}
        />
      )}
    </div>
  );
}

function ControlsSheet({ period, clients, journal, ticks, stateOf }) {
  const rows = clients.filter((c) => c.active && !c.ceased_on && c.frequency !== 'eps_only');
  const withRealm = rows.filter((c) => c.realm_id);
  const seen = withRealm.filter((c) => journal[c.realm_id] === 'checked').length;
  const said = rows.filter((c) => stateOf(c, 'processed') === 'done').length;
  return (
    <div style={{ padding: 16, overflow: 'auto', fontSize: 13.5, color: '#334155', maxWidth: 900 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>Controls <span style={{ display: 'inline-block', padding: '1px 7px', borderRadius: 8, fontSize: 10.5, fontWeight: 600, background: '#fef3c7', color: '#92400e', marginLeft: 6 }}>In development</span></div>
      <p style={{ margin: '6px 0 12px', color: '#64748b' }}>Three-way check for {period ? `${period.frequency === 'weekly' ? 'week' : 'month'} ${period.number}, ${period.tax_year}` : 'the period'}: what the team ticked, what BrightPay shows, what HMRC shows. The BrightPay and HMRC legs are not connected yet; the QuickBooks journal leg is live.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(160px, 1fr))', gap: 10, marginBottom: 14 }}>
        {[['Team says processed', `${said} of ${rows.length}`, '#0e7fe0'], ['Journal seen in QuickBooks', `${seen} of ${withRealm.length}`, '#0f766e'], ['BrightPay and HMRC', 'not connected', '#94a3b8']].map(([l, v, col]) => (
          <div key={l} style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 12px', background: '#fff' }}>
            <div style={{ fontSize: 11.5, color: '#64748b' }}>{l}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: col }}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: '#475569', marginBottom: 4 }}>Team vs QuickBooks, this month</div>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
        <thead><tr>{['Client', 'Team: processed', 'Team: FPS sent', 'QuickBooks: journal', 'Reads as'].map((h) => <th key={h} style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #cbd5e1', fontSize: 11, color: '#475569' }}>{h}</th>)}</tr></thead>
        <tbody>
          {withRealm.map((c) => {
            const proc = stateOf(c, 'processed') === 'done', fps = stateOf(c, 'fps') === 'done', jr = journal[c.realm_id] === 'checked';
            const verdict = proc && jr ? ['agree', '#166534'] : proc && !jr ? ['team says done, no journal yet', '#92400e'] : !proc && jr ? ['journal posted, not ticked', '#92400e'] : ['not yet', '#94a3b8'];
            return (
              <tr key={c.id}>
                <td style={{ padding: '5px 8px', borderBottom: '1px solid #f1f5f9' }}>{c.name}</td>
                <td style={{ padding: '5px 8px', borderBottom: '1px solid #f1f5f9' }}>{proc ? '✓' : '·'}</td>
                <td style={{ padding: '5px 8px', borderBottom: '1px solid #f1f5f9' }}>{fps ? '✓' : '·'}</td>
                <td style={{ padding: '5px 8px', borderBottom: '1px solid #f1f5f9' }}>{jr ? '✓' : '?'}</td>
                <td style={{ padding: '5px 8px', borderBottom: '1px solid #f1f5f9', color: verdict[1], fontWeight: 600 }}>{verdict[0]}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p style={{ marginTop: 14, fontSize: 12, color: '#94a3b8' }}>Next: the BrightPay scraper (pay run and FPS status per employer) and the HMRC PAYE data, so a tick can be checked against both. BrightPay's audit report is the likely source.</p>
    </div>
  );
}

function ClientDrawer({ client, defaultFrequency, period, ticks, staffList, staffMap, entityList, entityMap, navigate, onClose, onSaved }) {
  const isNew = !client;
  const [form, setForm] = useState(() => ({
    name: client?.name || '', entity_id: client?.entity_id || '', frequency: client?.frequency || defaultFrequency, pay_day: client?.pay_day || '', cutoff: client?.cutoff || '',
    pay_type: client?.pay_type || '', runner_id: client?.runner_id || '', runner_name: client?.runner_name || '', cover_id: client?.cover_id || '', batch: !!client?.batch,
    na_steps: client?.na_steps || [], standing_note: client?.standing_note || '', active: client ? client.active : true, ceased_on: client?.ceased_on || '',
  }));
  const [notes, setNotes] = useState([]);
  const [note, setNote] = useState('');
  const [ongoing, setOngoing] = useState(false);
  const [endsOn, setEndsOn] = useState(''); // '' = leave it open
  const [log, setLog] = useState({}); // note id -> [log rows]
  const [showRetired, setShowRetired] = useState(false);
  const [showSettings, setShowSettings] = useState(!client);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [entityQ, setEntityQ] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  // Unsaved work: the client form differs from what was opened, or a period
  // note is typed but not added. Closing then asks; the backdrop never closes.
  const [saved, setSaved] = useState(() => JSON.stringify(form));
  const formDirty = JSON.stringify(form) !== saved;
  const dirty = formDirty || note.trim().length > 0;
  const [confirmClose, setConfirmClose] = useState(false);
  const requestClose = () => { if (dirty) setConfirmClose(true); else onClose(); };

  const reloadNotes = useCallback(async () => {
    if (!client || !period) return;
    const { data } = await notesForPeriod(supabase.from('payroll_period_notes').select('*').eq('client_id', client.id), period).order('at', { ascending: false });
    setNotes(data || []);
    const ids = (data || []).map((n) => n.id);
    if (!ids.length) { setLog({}); return; }
    const { data: ls } = await supabase.from('payroll_note_log').select('*').in('note_id', ids).order('at');
    const m = {}; (ls || []).forEach((l) => { (m[l.note_id] = m[l.note_id] || []).push(l); }); setLog(m);
  }, [client, period]);
  useEffect(() => { reloadNotes(); }, [reloadNotes]);
  const retire = async (n, retired) => {
    setBusy(true); setErr(null);
    try { await callPayroll({ action: 'retire_note', id: n.id, retired }); await reloadNotes(); await onSaved(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const pWord = period?.frequency === 'weekly' ? 'week' : 'month';
  const scopeLabel = (n) => (n.kind === 'ongoing'
    ? `Every ${pWord} from ${fmt(n.starts_on)} · ${n.ends_on ? `until ${new Date(`${n.ends_on}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : 'open-ended'}`
    : `This ${pWord} only`);
  const scopePill = (n) => ({ display: 'inline-block', padding: '0 6px', borderRadius: 8, fontSize: 10.5, fontWeight: 600, ...(n.kind === 'ongoing' ? { background: '#e0f2fe', color: '#075985' } : { background: '#f1f5f9', color: '#64748b' }) });
  const live = notes.filter((n) => !n.retired_at);
  const retired = notes.filter((n) => n.retired_at);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await callPayroll({ action: 'save_client', id: client?.id, ...form, entity_id: form.entity_id || null, runner_id: form.runner_id || null, cover_id: form.cover_id || null, pay_type: form.pay_type || null, ceased_on: form.ceased_on || null });
      setSaved(JSON.stringify(form)); await onSaved(); if (isNew) onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const addNote = async () => {
    if (!note.trim() || !client || !period) return;
    if (ongoing && endsOn && endsOn < period.start_date) { setErr('The end date is before this period starts.'); return; }
    setBusy(true); setErr(null);
    try {
      await callPayroll({ action: 'add_note', client_id: client.id, period_id: period.id, note, ongoing, ends_on: ongoing ? (endsOn || null) : null });
      setNote(''); setOngoing(false); setEndsOn(''); await reloadNotes(); await onSaved();
    }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const inp = { padding: '5px 8px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 6, width: '100%', boxSizing: 'border-box', background: '#fff' };
  const lab = { fontSize: 10.5, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 2 };
  const entities = entityQ.trim().length >= 2 ? entityList.filter((e) => e.name.toLowerCase().includes(entityQ.trim().toLowerCase())).slice(0, 8) : [];
  const linked = form.entity_id ? entityList.find((e) => e.id === form.entity_id) : null;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.25)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 720, maxWidth: '96vw', maxHeight: '90vh', background: '#fff', borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.15)', display: 'flex', flexDirection: 'column', fontFamily: font }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px 8px', borderBottom: '1px solid #e5e7eb' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase' }}>{isNew ? 'New payroll client' : 'Payroll client'}</div>
            <div style={{ fontSize: 16, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{(form.entity_id && entityMap[form.entity_id]?.name) || form.name || 'Pick a client'}</div>
          </div>
          {linked && <button onClick={() => navigate(`/clients/${linked.id}`)} style={BTN.secondary.sm}>Open the client</button>}
          {dirty && !confirmClose && <span style={{ fontSize: 12, fontWeight: 600, color: '#9a3412', background: '#fff7ed', border: '1px solid #fdba74', borderRadius: 8, padding: '2px 8px' }}>Unsaved changes</span>}
          {!isNew && formDirty && !confirmClose && <button onClick={save} disabled={busy || !form.entity_id} style={BTN.primary.sm}>{busy ? 'Saving…' : 'Save'}</button>}
          <button onClick={requestClose} style={BTN.secondary.sm}>Close</button>
        </div>
        {confirmClose && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', background: '#fff7ed', borderBottom: '1px solid #fdba74', fontSize: 13, color: '#9a3412', flexWrap: 'wrap' }}>
            <b style={{ flex: 1, minWidth: 200 }}>You have unsaved changes{note.trim() ? ' and a note that has not been added' : ''}.</b>
            {form.entity_id && !note.trim() && <button onClick={async () => { await save(); setConfirmClose(false); onClose(); }} disabled={busy} style={BTN.primary.sm}>Save and close</button>}
            {note.trim() && client && <button onClick={async () => { await addNote(); setConfirmClose(false); }} disabled={busy} style={BTN.primary.sm}>Add the note</button>}
            <button onClick={() => { setConfirmClose(false); onClose(); }} style={{ ...BTN.secondary.sm, color: '#991b1b' }}>Discard and close</button>
            <button onClick={() => setConfirmClose(false)} style={BTN.secondary.sm}>Keep editing</button>
          </div>
        )}
        <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {err && <div style={{ padding: '8px 12px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13 }}>{err}</div>}
          <div style={{ border: '3px solid #0891b2', background: '#ecfeff', borderRadius: 10, padding: '10px 14px' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#0e7490', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 4 }}>Important notes <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>· shown on every sheet</span></div>
            <textarea value={form.standing_note} onChange={(e) => set('standing_note', e.target.value)} rows={Math.min(8, Math.max(2, (form.standing_note || '').split(String.fromCharCode(10)).length + 1))} placeholder="Anything the runner must know every time: who sends the hours, when, how payslips go out…"
              style={{ width: '100%', boxSizing: 'border-box', border: 'none', background: 'transparent', resize: 'vertical', fontFamily: font, fontSize: 15, fontWeight: 500, lineHeight: 1.5, color: '#164e63', outline: 'none', padding: 0 }} />
          </div>
          {client && period && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: '#475569', display: 'flex', alignItems: 'baseline', gap: 8 }}>
                Notes · {pWord === 'week' ? 'Week' : 'Month'} {period.number}, {period.tax_year} <span style={{ fontWeight: 500, color: '#94a3b8' }}>· {live.length} live</span>
                {retired.length > 0 && <button onClick={() => setShowRetired((v) => !v)} style={{ ...BTN.secondary.sm, padding: '0 7px', fontSize: 11, marginLeft: 'auto' }}>{showRetired ? 'Hide' : 'Show'} {retired.length} retired</button>}
              </div>
              <div style={{ border: '1px solid #cbd5e1', borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 6, background: '#f8fafc' }}>
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder={`Add a note for ${pWord} ${period.number}…`} style={{ ...inp, resize: 'vertical', fontSize: 13.5 }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addNote(); } }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', fontSize: 12.5, color: '#334155' }}>
                  <label style={{ display: 'inline-flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}><input type="radio" checked={!ongoing} onChange={() => setOngoing(false)} /> This {pWord} only</label>
                  <label style={{ display: 'inline-flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}><input type="radio" checked={ongoing} onChange={() => setOngoing(true)} /> Going forward</label>
                  {ongoing && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, paddingLeft: 10, borderLeft: '1px solid #cbd5e1' }}>
                      <label style={{ display: 'inline-flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}><input type="radio" checked={!endsOn} onChange={() => setEndsOn('')} /> Leave it open</label>
                      <label style={{ display: 'inline-flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}><input type="radio" checked={!!endsOn} onChange={() => setEndsOn(endsOn || period.end_date)} /> Until</label>
                      <input type="date" value={endsOn} min={period.start_date} onChange={(e) => setEndsOn(e.target.value)} style={{ ...inp, width: 140, padding: '3px 6px' }} />
                    </span>
                  )}
                  <div style={{ flex: 1 }} />
                  <button onClick={addNote} disabled={busy || !note.trim()} style={BTN.primary.sm}>Add note</button>
                </div>
              </div>
              {live.length === 0 && <div style={{ fontSize: 12.5, color: '#94a3b8' }}>No live notes. Retire a note once it has been acted on so the sheet stays quiet.</div>}
              {live.map((n) => (
                <div key={n.id} style={{ fontSize: 12.5, padding: '6px 8px', borderRadius: 6, background: '#fffbeb', border: '1px solid #fde68a', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ color: '#94a3b8' }}>{n.by_name || (n.source === 'import' ? 'from the spreadsheet' : 'someone')} · {n.source === 'import' ? 'from the spreadsheet' : fmtTs(n.at)}</span>
                    <span style={{ ...scopePill(n), marginLeft: 6 }}>{scopeLabel(n)}</span>
                    <div style={{ whiteSpace: 'pre-wrap', color: '#0f172a' }}>{n.note}</div>
                  </div>
                  <button onClick={() => retire(n, true)} disabled={busy} title={n.kind === 'ongoing' ? 'Keep it on record, but stop showing it from now on' : 'Keep it on record, but take it off the sheet'} style={{ ...BTN.secondary.sm, padding: '1px 8px', fontSize: 11 }}>Retire</button>
                </div>
              ))}
              {showRetired && retired.map((n) => (
                <div key={n.id} style={{ fontSize: 12, padding: '4px 8px', color: '#94a3b8', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ ...scopePill(n), opacity: 0.7 }}>{scopeLabel(n)}</span>
                    <div style={{ whiteSpace: 'pre-wrap', textDecoration: 'line-through' }}>{n.note}</div>
                    <div style={{ fontSize: 11 }}>{(log[n.id] || []).map((l) => `${l.action} · ${l.by_name || 'someone'} · ${fmtTs(l.at)}`).join('  —  ') || `retired ${fmtTs(n.retired_at)}`}</div>
                  </div>
                  <button onClick={() => retire(n, false)} disabled={busy} style={{ ...BTN.secondary.sm, padding: '1px 8px', fontSize: 11 }}>Restore</button>
                </div>
              ))}
              <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 10, marginTop: 4, fontSize: 12.5, fontWeight: 700, color: '#475569' }}>This period · {period.frequency === 'weekly' ? 'week' : 'month'} {period.number}, {period.tax_year}</div>
              <div style={{ fontSize: 12.5, display: 'grid', gridTemplateColumns: '1fr auto', gap: '3px 10px' }}>
                {STEPS.map((s) => { const t = ticks[`${client.id}|${s.id}`]; const na = (client.na_steps || []).includes(s.id); return (
                  <React.Fragment key={s.id}>
                    <span style={{ color: na ? '#94a3b8' : '#0f172a' }}>{s.label}</span>
                    <span style={{ color: '#64748b', whiteSpace: 'nowrap' }}>{na ? 'n/a for this client' : t ? `${t.state === 'done' ? 'Done' : 'n/a'} · ${t.by_name || '?'} · ${t.source === 'import' ? 'from the spreadsheet' : fmtTs(t.at)}` : 'not yet'}</span>
                  </React.Fragment>); })}
              </div>
            </div>
          )}
          <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 10 }}>
            {!isNew && <button onClick={() => setShowSettings((v) => !v)} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontFamily: font, fontSize: 12.5, fontWeight: 700, color: '#475569' }}>{showSettings ? '▾' : '▸'} Client settings <span style={{ fontWeight: 500, color: '#94a3b8' }}>· pay date, runner, steps that don't apply</span></button>}
          </div>
          {showSettings && (<>
          <div>
            <div style={lab}>Athena client (required)</div>
            {client?.name && (!linked || linked.name !== client.name) && <div style={{ fontSize: 11.5, color: '#94a3b8', marginBottom: 4 }}>On the spreadsheet as “{client.name}”</div>}
            {linked ? <div style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' }}><span style={{ flex: 1 }}>{linked.name}</span><button onClick={() => set('entity_id', '')} style={BTN.secondary.sm}>Change</button></div>
              : <>
                <input value={entityQ} onChange={(e) => setEntityQ(e.target.value)} placeholder="Search Athena clients to link…" style={inp} />
                {entities.map((e) => <div key={e.id} onClick={() => { set('entity_id', e.id); setEntityQ(''); }} style={{ padding: '5px 8px', fontSize: 13, cursor: 'pointer', borderBottom: '1px solid #f1f5f9' }}>{e.name}</div>)}
              </>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div><div style={lab}>Sheet</div><select value={form.frequency} onChange={(e) => set('frequency', e.target.value)} style={inp}><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="eps_only">EPS only</option></select></div>
            <div><div style={lab}>Pay type</div><select value={form.pay_type} onChange={(e) => set('pay_type', e.target.value)} style={inp}>{PAY_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            <div><div style={lab}>Pay date</div><input value={form.pay_day} onChange={(e) => set('pay_day', e.target.value)} placeholder="e.g. 28th, LWD, Friday" style={inp} /></div>
            <div><div style={lab}>Cut-off</div><input value={form.cutoff} onChange={(e) => set('cutoff', e.target.value)} placeholder="e.g. 20th" style={inp} /></div>
            <div><div style={lab}>Runner</div><select value={form.runner_id} onChange={(e) => set('runner_id', e.target.value)} style={inp}><option value="">— {form.runner_name ? `(${form.runner_name})` : ''}</option>{staffList.filter((s) => s.work_planner !== false).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
            <div><div style={lab}>Cover</div><select value={form.cover_id} onChange={(e) => set('cover_id', e.target.value)} style={inp}><option value="">—</option>{staffList.filter((s) => s.work_planner !== false).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
          </div>
          <label style={{ ...inp, display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', background: form.batch ? '#eff6ff' : '#fff', borderColor: form.batch ? '#93c5fd' : '#cbd5e1' }}>
            <input type="checkbox" checked={form.batch} onChange={(e) => set('batch', e.target.checked)} />
            <span>Part of the Batch <span style={{ color: '#94a3b8' }}>· run together on the last working day</span></span>
          </label>
          <div>
            <div style={lab}>Steps for this client</div>
            <div style={{ fontSize: 11.5, color: '#94a3b8', marginBottom: 6 }}>Click a step that never applies to this client. It shows grey in every period until you click it back.</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: `repeat(${Math.ceil(STEPS.length / 2)}, auto)`, gridAutoFlow: 'column', gap: 6 }}>
              {STEPS.map((s, i) => {
                const na = form.na_steps.includes(s.id);
                return (
                  <button key={s.id} type="button" onClick={() => set('na_steps', na ? form.na_steps.filter((x) => x !== s.id) : [...form.na_steps, s.id])}
                    title={na ? 'Not applicable for this client — click to make it apply' : 'Applies — click if it never applies to this client'}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontFamily: font, fontSize: 12.5, textAlign: 'left',
                      border: `1px solid ${na ? '#e2e8f0' : '#cbd5e1'}`, background: na ? '#f1f5f9' : '#fff', color: na ? '#94a3b8' : '#0f172a' }}>
                    <span style={{ width: 18, height: 18, flexShrink: 0, borderRadius: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700,
                      ...(na ? { background: '#e2e8f0', color: '#94a3b8' } : { background: '#dcfce7', color: '#166534' }) }}>{i + 1}</span>
                    <span style={{ flex: 1, textDecoration: na ? 'line-through' : 'none' }}>{s.label}</span>
                    {na && <span style={{ fontSize: 10.5, fontWeight: 600 }}>n/a</span>}
                  </button>
                );
              })}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div><div style={lab}>Status</div>
              <label style={{ ...inp, display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}><input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} /> Active</label>
            </div>
            <div><div style={lab}>Ceased on</div><input type="date" value={form.ceased_on} onChange={(e) => set('ceased_on', e.target.value)} style={inp} /></div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={save} disabled={busy || !form.entity_id} title={form.entity_id ? '' : 'Pick the Athena client first'} style={BTN.primary.sm}>{busy ? 'Saving…' : isNew ? 'Add client' : 'Save'}</button>
          </div>

          </>)}
        </div>
      </div>
    </div>
  );
}
