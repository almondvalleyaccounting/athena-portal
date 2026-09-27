import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useWorkPlanner } from '../WorkPlannerModule';
import Avatar from './Avatar';
import { shortTask } from './PlannerBits';
import { BTN } from '../../../lib/buttonStyles';

// The Overview dashboard (Bobby, 2026-09-26/27): BrightManager jobs in the
// next six months, months across, type of work down. Whole team unless a
// person is picked in the team filter. Hover a number for the split by
// person; click it for the jobs. Holidays in a month are flagged.

const font = "'Outfit', sans-serif";
export const TILE_TYPES = [
  { id: 'accounts',    label: 'Accounts',        services: ['Annual Accounts', 'Accounts', 'Corporation Tax'] },
  { id: 'vat',         label: 'VAT returns',     services: ['VAT'] },
  { id: 'sa',          label: 'Self assessment', services: ['Self Assessment', 'Personal Tax'] },
  { id: 'cs',          label: 'Confirmation statements', services: ['Confirmation Statement'] },
  { id: 'bookkeeping', label: 'Bookkeeping',     services: ['Bookkeeping', 'Management Accounts'] },
  { id: 'other',       label: 'Other' },
];
const typeOf = (service) => TILE_TYPES.find((t) => t.services?.includes(service))?.id || 'other';
const monthKey = (iso) => String(iso).slice(0, 7);
const monthLabel = (key) => new Date(`${key}-01T12:00:00`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
const monthShort = (key) => new Date(`${key}-01T12:00:00`).toLocaleDateString('en-GB', { month: 'short' });
const fmt = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');
const h1 = (n) => Math.round(n * 10) / 10;

export default function OverviewDashboard({ onOpenTask }) {
  const { staffList, staffMap, staffColours, holidays = [], filters } = useWorkPlanner();
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tile, setTile] = useState(null); // { month, type } open in the drill-down
  const [hover, setHover] = useState(null); // { month, type, x, y }
  const [basis, setBasisState] = useState(() => { try { return localStorage.getItem('overview.tileBasis') || 'deadline'; } catch { return 'deadline'; } });
  const setBasis = (b) => { setBasisState(b); try { localStorage.setItem('overview.tileBasis', b); } catch { /* private window */ } };
  const col = basis === 'planned' ? 'scheduled_for_date' : 'bm_deadline';
  const who = filters.teamFilter || null;
  const months = useMemo(() => { const d = new Date(); return [0, 1, 2, 3, 4, 5].map((i) => { const m = new Date(d.getFullYear(), d.getMonth() + i, 1); return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`; }); }, []);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const m0 = `${months[0]}-01`;
      const m3 = new Date(`${months[months.length - 1]}-01T12:00:00`); m3.setMonth(m3.getMonth() + 1);
      const end = `${m3.getFullYear()}-${String(m3.getMonth() + 1).padStart(2, '0')}-01`;
      // PostgREST caps one read at ~1000 rows and returns 200 regardless, so page.
      const bm = [];
      for (let from = 0; ; from += 1000) {
        const { data, error: e1 } = await supabase.from('bm_task_schedule')
          .select('id, service, bm_task_name, bm_deadline, scheduled_for_date, scheduled_hours, entity_id, assignee_id, entities(name, entity_status)')
          .eq('state', 'planned').is('excluded_at', null).gte(col, m0).lt(col, end).order(col).order('id').range(from, from + 999);
        if (e1) throw e1;
        bm.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      const { data: openC } = await supabase.from('bm_task_completions').select('bm_task_schedule_id').is('confirmed_at', null).limit(1000);
      const done = new Set((openC || []).map((c) => c.bm_task_schedule_id));
      setJobs((bm || [])
        .filter((r) => !done.has(r.id) && !['nlac', 'archived'].includes(r.entities?.entity_status))
        .map((r) => ({ ...r, type: typeOf(r.service), month: monthKey(r[col]) })));
    } catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, [months, col]);
  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => (who ? jobs.filter((j) => j.assignee_id === who) : jobs), [jobs, who]);
  const cell = (month, type) => visible.filter((j) => j.month === month && (type === 'all' || j.type === type));
  const hours = (list) => list.reduce((s, j) => s + (Number(j.scheduled_hours) || 0), 0);
  const byPerson = (list) => {
    const m = new Map();
    list.forEach((j) => { const k = j.assignee_id || 'none'; m.set(k, (m.get(k) || 0) + 1); });
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const name = (id) => (id === 'none' ? 'Unassigned' : (staffMap[id]?.name || '').split(' ')[0] || 'Someone');

  // Days off in each month, for the person picked or the whole team.
  const offByMonth = useMemo(() => {
    const out = {};
    holidays.filter((h) => !who || h.staff_id === who).forEach((h) => {
      for (let d = new Date(`${h.date_from}T12:00:00`); d <= new Date(`${h.date_to}T12:00:00`); d.setDate(d.getDate() + 1)) {
        if (d.getDay() === 0 || d.getDay() === 6) continue;
        const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (!out[k]) out[k] = { days: 0, people: new Set() };
        out[k].days += h.half_day ? 0.5 : 1; out[k].people.add(h.staff_id);
      }
    });
    return out;
  }, [holidays, who]);

  const head = { padding: '10px 12px', fontSize: 12.5, fontWeight: 700, color: '#475569', background: '#f8fafc', borderBottom: '1px solid #e5e7eb' };
  const rowHead = { padding: '10px 14px', fontSize: 13.5, fontWeight: 500, color: '#0f172a', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center' };
  const totalRow = TILE_TYPES.map((t) => cell('all', t.id)); void totalRow;

  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid #e5e7eb' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>{basis === 'planned' ? 'Planned' : 'Due'} in the next six months</div>
        <div style={{ fontSize: 12.5, color: '#64748b' }}>· {who ? `${name(who)} only` : 'whole team'}{loading ? ' · loading…' : ''}</div>
        <div style={{ flex: 1 }} />
        <span style={{ display: 'inline-flex', border: '1px solid #cbd5e1', borderRadius: 6, overflow: 'hidden' }}>
          {[['deadline', 'By deadline'], ['planned', 'By planned date']].map(([id, label]) => (
            <button key={id} onClick={() => setBasis(id)} style={{ ...BTN.secondary.sm, border: 'none', borderRadius: 0, padding: '3px 10px', fontSize: 12, background: basis === id ? '#dbeafe' : '#fff', color: basis === id ? '#0e7fe0' : '#334155', fontWeight: basis === id ? 600 : 500 }}>{label}</button>
          ))}
        </span>
      </div>
      {error && <div style={{ padding: '8px 14px', color: '#991b1b', fontSize: 13 }}>{error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '170px repeat(6, 1fr) 96px' }}>
        <div style={head} />
        {months.map((mo) => {
          const off = offByMonth[mo];
          return (
            <div key={mo} style={{ ...head, borderLeft: '1px solid #f1f5f9', display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span>{monthLabel(mo)}</span>
              <span style={{ fontSize: 11.5, fontWeight: 500, color: '#94a3b8', whiteSpace: 'nowrap' }}>{cell(mo, 'all').length} · {h1(hours(cell(mo, 'all')))}h{off ? <span title={`${off.days} day${off.days === 1 ? '' : 's'} off${!who && off.people.size > 1 ? ` across ${off.people.size} people` : ''}`} style={{ color: '#9a3412', fontWeight: 600 }}> · 🏖 {off.days}d{!who && off.people.size > 1 ? ` · ${off.people.size}👤` : ''}</span> : null}</span>
            </div>
          );
        })}
        <div style={{ ...head, borderLeft: '1px solid #e5e7eb', textAlign: 'right' }}>6 months</div>

        {TILE_TYPES.map((t) => (
          <React.Fragment key={t.id}>
            <div style={rowHead}>{t.label}</div>
            {months.map((mo) => {
              const list = cell(mo, t.id);
              const n = list.length;
              const off = !!offByMonth[mo];
              return (
                <button key={mo}
                  onClick={() => n && setTile({ month: mo, type: t.id })}
                  onMouseEnter={(e) => n && setHover({ month: mo, type: t.id, x: e.clientX, y: e.clientY })}
                  onMouseMove={(e) => hover && setHover((h) => (h ? { ...h, x: e.clientX, y: e.clientY } : h))}
                  onMouseLeave={() => setHover(null)}
                  disabled={!n}
                  style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '10px 14px', textAlign: 'left', border: 'none', borderBottom: '1px solid #f1f5f9', borderLeft: '1px solid #f1f5f9', background: n ? (off ? '#fff7ed' : '#fff') : '#fff', cursor: n ? 'pointer' : 'default', fontFamily: font }}
                  onFocus={() => {}}>
                  <span style={{ fontSize: 20, fontWeight: 700, color: n ? (off ? '#9a3412' : '#0e7fe0') : '#e2e8f0', minWidth: 28 }}>{n}</span>
                  {n > 0 && <span style={{ fontSize: 12, color: '#94a3b8' }}>{h1(hours(list))}h</span>}
                  {n > 0 && !who && (
                    <span style={{ display: 'inline-flex', marginLeft: 'auto' }}>
                      {byPerson(list).slice(0, 5).map(([id]) => (id !== 'none' ? <span key={id} style={{ marginLeft: -4 }}><Avatar id={id} staffMap={staffMap} size={18} customColour={staffColours?.[id]} /></span> : null))}
                    </span>
                  )}
                </button>
              );
            })}
            <div style={{ padding: '10px 14px', textAlign: 'right', borderBottom: '1px solid #f1f5f9', borderLeft: '1px solid #e5e7eb', fontSize: 14, fontWeight: 600, color: '#475569', background: '#fafafa' }}>{cell('all', t.id).length || <span style={{ color: '#e2e8f0' }}>0</span>}</div>
          </React.Fragment>
        ))}

        <div style={{ ...rowHead, fontWeight: 700, background: '#fafafa', borderBottom: 'none' }}>All work</div>
        {months.map((mo) => (
          <div key={mo} style={{ padding: '10px 14px', borderLeft: '1px solid #f1f5f9', background: '#fafafa', fontSize: 14, fontWeight: 700, color: '#0f172a' }}>{cell(mo, 'all').length} <span style={{ fontSize: 12, fontWeight: 500, color: '#94a3b8' }}>· {h1(hours(cell(mo, 'all')))}h</span></div>
        ))}
        <div style={{ padding: '10px 14px', textAlign: 'right', borderLeft: '1px solid #e5e7eb', background: '#fafafa', fontSize: 14, fontWeight: 700, color: '#0f172a' }}>{visible.length}</div>
      </div>

      {hover && (() => {
        const list = cell(hover.month, hover.type);
        const split = byPerson(list);
        return (
          <div style={{ position: 'fixed', left: Math.min(hover.x + 14, window.innerWidth - 240), top: Math.min(hover.y + 14, window.innerHeight - 40 - split.length * 22), zIndex: 140, background: '#0f172a', color: '#fff', borderRadius: 8, padding: '8px 10px', fontSize: 12.5, minWidth: 180, boxShadow: '0 4px 12px rgba(0,0,0,0.25)', pointerEvents: 'none' }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{TILE_TYPES.find((t) => t.id === hover.type)?.label} · {monthShort(hover.month)} · {list.length}</div>
            {split.map(([id, n]) => (
              <div key={id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '1px 0' }}>
                <span>{name(id)}</span><span style={{ fontWeight: 600 }}>{n}<span style={{ color: '#94a3b8', fontWeight: 400 }}> · {h1(hours(list.filter((j) => (j.assignee_id || 'none') === id)))}h</span></span>
              </div>
            ))}
            <div style={{ color: '#94a3b8', marginTop: 4 }}>Click for the jobs</div>
          </div>
        );
      })()}

      {tile && (() => {
        const list = cell(tile.month, tile.type).sort((a, b) => (name(a.assignee_id || 'none')).localeCompare(name(b.assignee_id || 'none')) || String(a[col]).localeCompare(String(b[col])));
        return (
          <div onClick={() => setTile(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.25)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 10, width: 760, maxWidth: '96vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column', fontFamily: font, boxShadow: '0 4px 16px rgba(0,0,0,0.15)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px 8px' }}>
                <div style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>{TILE_TYPES.find((t) => t.id === tile.type)?.label} · {basis === 'planned' ? 'planned' : 'due'} {monthLabel(tile.month)} · {list.length} job{list.length === 1 ? '' : 's'} · {h1(hours(list))}h</div>
                <button onClick={() => setTile(null)} style={BTN.secondary.sm}>Close</button>
              </div>
              <div style={{ overflowY: 'auto', padding: '0 16px 12px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '28px minmax(0, 1.4fr) minmax(0, 1.2fr) 90px 90px 50px 70px', gap: 8, fontSize: 11.5, fontWeight: 600, color: '#94a3b8', padding: '4px 4px', borderBottom: '1px solid #e5e7eb' }}>
                  <span /><span>Client</span><span>Task</span><span>Due</span><span>Planned</span><span>Hours</span><span />
                </div>
                {list.map((j) => (
                  <div key={j.id} style={{ display: 'grid', gridTemplateColumns: '28px minmax(0, 1.4fr) minmax(0, 1.2fr) 90px 90px 50px 70px', gap: 8, alignItems: 'center', padding: '6px 4px', borderBottom: '1px solid #f1f5f9', fontSize: 13 }}>
                    <span title={staffMap[j.assignee_id]?.name || 'Unassigned'}>{j.assignee_id ? <Avatar id={j.assignee_id} staffMap={staffMap} size={20} customColour={staffColours?.[j.assignee_id]} /> : null}</span>
                    <span style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.entities?.name}</span>
                    <span style={{ color: '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{shortTask(j.bm_task_name)}</span>
                    <span style={{ fontSize: 12, color: '#475569' }}>{fmt(j.bm_deadline)}</span>
                    <span style={{ fontSize: 12, color: '#94a3b8' }}>{j.scheduled_for_date ? fmt(j.scheduled_for_date) : '—'}</span>
                    <span style={{ fontSize: 12, color: '#475569', textAlign: 'right' }}>{j.scheduled_hours ? `${Number(j.scheduled_hours)}h` : ''}</span>
                    {onOpenTask ? <button onClick={() => { setTile(null); onOpenTask({ type: 'bm', id: j.id }); }} style={BTN.secondary.sm}>Open</button> : <span />}
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
