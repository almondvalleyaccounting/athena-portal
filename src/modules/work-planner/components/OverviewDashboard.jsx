import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useWorkPlanner } from '../WorkPlannerModule';
import Avatar from './Avatar';
import { shortTask } from './PlannerBits';
import { BTN } from '../../../lib/buttonStyles';

// The Overview dashboard (Bobby, 2026-09-26/27): BrightManager jobs in the
// next six months, months across, type of work down. Whole team unless a
// person is picked in the team filter. Hover a number for the split by
// person; click it for the jobs. Holidays in a month are flagged. Under the
// grid, five tiles: overdue, this week, next week and the week after (the
// same jobs cut by date — a week ends on Friday, so "this week" shrinks a
// day at a time and resets to seven on Saturday morning), then the open
// quick tasks.
//
// A count is a filing, not a stage: for accounts, VAT, self assessment and
// corporation tax only the "… Submission …" task counts, so the numbers
// reconcile with the Monday deadline digest (v_deadline_buckets) and one
// job is one. Hours still add up every task of that type in the month,
// because the preparation task is where the time is.

const font = "'Outfit', sans-serif";
export const TILE_TYPES = [
  { id: 'accounts',    label: 'Accounts',        services: ['Annual Accounts', 'Accounts'] },
  { id: 'ct',          label: 'Corporation tax', services: ['Corporation Tax'] },
  { id: 'vat',         label: 'VAT returns',     services: ['VAT'] },
  { id: 'sa',          label: 'Self assessment', services: ['Self Assessment', 'Personal Tax'] },
  { id: 'cs',          label: 'Confirmation statements', services: ['Confirmation Statement'] },
  { id: 'bookkeeping', label: 'Bookkeeping',     services: ['Bookkeeping', 'Management Accounts'] },
  { id: 'other',       label: 'Other' },
];
const typeOf = (service) => TILE_TYPES.find((t) => t.services?.includes(service))?.id || 'other';
const STAGED = new Set(['accounts', 'ct', 'vat', 'sa']); // types whose BM job is several tasks
const isFiling = (type, name) => !STAGED.has(type) || /Submission/i.test(name || '');
const monthKey = (iso) => String(iso).slice(0, 7);
const monthLabel = (key) => new Date(`${key}-01T12:00:00`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const BUCKETS = [
  { id: 'overdue', label: 'Overdue' },
  { id: 'week',    label: 'This week' },
  { id: 'next',    label: 'Next week' },
  { id: 'after',   label: 'Week after next' },
  { id: 'quick',   label: 'Other tasks', sub: 'BM NSTs + quick tasks' },
];
const monthShort = (key) => new Date(`${key}-01T12:00:00`).toLocaleDateString('en-GB', { month: 'short' });
const fmt = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');
const h1 = (n) => Math.ceil(n - 1e-9); // dashboard hours round up to the whole hour
// Heat tint by load: four stops of the blue ramp, scaled by the square root
// of the cell's share of the busiest cell so small months still register.
const HEAT = [
  { bg: '#fff',    fg: '#0e7fe0', sub: '#94a3b8' },
  { bg: '#E6F1FB', fg: '#0C447C', sub: '#185FA5' },
  { bg: '#B5D4F4', fg: '#0C447C', sub: '#185FA5' },
  { bg: '#85B7EB', fg: '#042C53', sub: '#0C447C' },
  { bg: '#378ADD', fg: '#fff',    sub: '#E6F1FB' },
];
const heat = (n, max) => (!n ? HEAT[0] : HEAT[Math.max(1, Math.min(4, Math.ceil(4 * Math.sqrt(n / (max || 1)))))]);
const NUM = { fontVariantNumeric: 'tabular-nums' };

export default function OverviewDashboard({ onOpenTask }) {
  const { staffList, staffMap, staffColours, holidays = [], filters, quickTasks = [], entityMap = {} } = useWorkPlanner();
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
      const m3 = new Date(`${months[months.length - 1]}-01T12:00:00`); m3.setMonth(m3.getMonth() + 1);
      const end = `${m3.getFullYear()}-${String(m3.getMonth() + 1).padStart(2, '0')}-01`;
      // PostgREST caps one read at ~1000 rows and returns 200 regardless, so page.
      const bm = [];
      for (let from = 0; ; from += 1000) {
        const { data, error: e1 } = await supabase.from('bm_task_schedule')
          .select('id, service, bm_task_name, bm_deadline, scheduled_for_date, scheduled_hours, entity_id, assignee_id, entities(name, entity_status)')
          .eq('state', 'planned').is('excluded_at', null).not(col, 'is', null).lt(col, end).order(col).order('id').range(from, from + 999);
        if (e1) throw e1;
        bm.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      const { data: openC } = await supabase.from('bm_task_completions').select('bm_task_schedule_id').is('confirmed_at', null).limit(1000);
      const done = new Set((openC || []).map((c) => c.bm_task_schedule_id));
      setJobs((bm || [])
        .filter((r) => !done.has(r.id) && !['nlac', 'archived'].includes(r.entities?.entity_status))
        .map((r) => { const type = typeOf(r.service); return { ...r, type, filing: isFiling(type, r.bm_task_name), month: monthKey(r[col]) }; }));
    } catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, [months, col]);
  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => (who ? jobs.filter((j) => j.assignee_id === who) : jobs), [jobs, who]);
  const today = todayISO();
  // Weeks end on Friday: today to the coming Friday is "this week".
  const weekEnd = useMemo(() => { const d = new Date(`${today}T12:00:00`); return addDays(today, (5 - d.getDay() + 7) % 7); }, [today]);
  const weekEndOf = { week: weekEnd, next: addDays(weekEnd, 7), after: addDays(weekEnd, 14) };
  const bucketOf = (j) => {
    const v = j[col];
    if (v < today) return 'overdue';
    if (v <= weekEndOf.week) return 'week';
    if (v <= weekEndOf.next) return 'next';
    if (v <= weekEndOf.after) return 'after';
    return null;
  };
  // The last tile: quick_tasks, which holds BrightManager's non-standard
  // tasks (source bm_nst) and the ones added in Athena (source manual).
  const quick = useMemo(() => (who ? quickTasks.filter((t) => t.assignee_id === who) : quickTasks).map((t) => ({
    id: t.id, quick: true, assignee_id: t.assignee_id, entity_id: t.entity_id, title: t.title,
    bm_deadline: t.due_date ? String(t.due_date).slice(0, 10) : null, scheduled_for_date: t.planned_date ? String(t.planned_date).slice(0, 10) : null,
    scheduled_hours: t.duration ? t.duration / 60 : 0,
  })), [quickTasks, who]);
  const inWindow = (j) => months.includes(j.month);
  const maxCell = useMemo(() => {
    const m = new Map();
    visible.forEach((j) => { if (j.filing && inWindow(j)) { const k = `${j.month}|${j.type}`; m.set(k, (m.get(k) || 0) + 1); } });
    return Math.max(0, ...m.values());
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  // Counts are filings; hours (all=true) take every task.
  const cell = (month, type, all = false) => visible.filter((j) => (all || j.filing) && (month === 'all' ? inWindow(j) : j.month === month) && (type === 'all' || j.type === type));
  const bucket = (id, all = false) => (id === 'quick' ? quick : visible.filter((j) => (all || j.filing) && bucketOf(j) === id));
  const listFor = (sel, all = false) => (sel.bucket ? bucket(sel.bucket, all) : cell(sel.month, sel.type, all));
  const titleFor = (sel) => (sel.bucket ? `${BUCKETS.find((b) => b.id === sel.bucket)?.label}${weekEndOf[sel.bucket] ? ` · w/e ${fmt(weekEndOf[sel.bucket])}` : ''}` : `${TILE_TYPES.find((t) => t.id === sel.type)?.label} · ${basis === 'planned' ? 'planned' : 'due'} ${monthLabel(sel.month)}`);
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
  const rowHead = { padding: '8px 14px', fontSize: 13.5, fontWeight: 500, color: '#0f172a', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center' };

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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)' }}>
        <div style={head} />
        {months.map((mo) => {
          const off = offByMonth[mo];
          return (
            <div key={mo} style={{ ...head, borderLeft: '1px solid #f1f5f9', display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-end' }}>
              <span>{monthLabel(mo)}</span>
              {off ? <span title={`${off.days} day${off.days === 1 ? '' : 's'} off${!who && off.people.size > 1 ? ` across ${off.people.size} people` : ''}`} style={{ fontSize: 11.5, fontWeight: 600, color: '#9a3412', whiteSpace: 'nowrap' }}>🏖 {off.days} day{off.days === 1 ? '' : 's'} off{!who && off.people.size > 1 ? ` · ${off.people.size} people` : ''}</span> : <span style={{ fontSize: 11.5, fontWeight: 500, color: '#cbd5e1' }}>&nbsp;</span>}
            </div>
          );
        })}
        <div style={{ ...head, borderLeft: '2px solid #cbd5e1', background: '#f1f5f9', color: '#0f172a', textAlign: 'right' }}>6 months</div>

        {TILE_TYPES.map((t) => (
          <React.Fragment key={t.id}>
            <div style={rowHead}>{t.label}</div>
            {months.map((mo) => {
              const list = cell(mo, t.id);
              const n = list.length;
              const hrs = hours(cell(mo, t.id, true));
              const c = heat(n, maxCell);
              return (
                <button key={mo}
                  onClick={() => n && setTile({ month: mo, type: t.id })}
                  onMouseEnter={(e) => n && setHover({ month: mo, type: t.id, x: e.clientX, y: e.clientY })}
                  onMouseMove={(e) => hover && setHover((h) => (h ? { ...h, x: e.clientX, y: e.clientY } : h))}
                  onMouseLeave={() => setHover(null)}
                  disabled={!n}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1, padding: '8px 14px', border: 'none', borderBottom: '1px solid #f1f5f9', borderLeft: '1px solid #f1f5f9', background: c.bg, cursor: n ? 'pointer' : 'default', fontFamily: font, ...NUM }}
                  onFocus={() => {}}>
                  {n ? <>
                    <span style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.15, color: c.fg }}>{n}</span>
                    <span style={{ fontSize: 11.5, lineHeight: 1.2, color: c.sub }}>{h1(hrs)}h</span>
                  </> : <span style={{ fontSize: 17, lineHeight: 1.15, color: '#cbd5e1' }}>·</span>}
                </button>
              );
            })}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1, padding: '8px 14px', borderBottom: '1px solid #f1f5f9', borderLeft: '2px solid #cbd5e1', background: '#f1f5f9', ...NUM }}>
              {cell('all', t.id).length ? <>
                <span style={{ fontSize: 17, fontWeight: 700, lineHeight: 1.15, color: '#0f172a' }}>{cell('all', t.id).length}</span>
                <span style={{ fontSize: 11.5, lineHeight: 1.2, color: '#64748b' }}>{h1(hours(cell('all', t.id, true)))}h</span>
              </> : <span style={{ fontSize: 17, lineHeight: 1.15, color: '#cbd5e1' }}>·</span>}
            </div>
          </React.Fragment>
        ))}

        <div style={{ ...rowHead, fontWeight: 700, background: '#fafafa', borderBottom: 'none' }}>All work</div>
        {months.map((mo) => (
          <div key={mo} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1, padding: '8px 14px', borderLeft: '1px solid #f1f5f9', background: '#fafafa', ...NUM }}>
            <span style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.15, color: '#0f172a' }}>{cell(mo, 'all').length}</span>
            <span style={{ fontSize: 11.5, lineHeight: 1.2, color: '#64748b' }}>{h1(hours(cell(mo, 'all', true)))}h</span>
          </div>
        ))}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1, padding: '8px 14px', borderLeft: '2px solid #cbd5e1', background: '#e2e8f0', ...NUM }}>
          <span style={{ fontSize: 19, fontWeight: 800, lineHeight: 1.15, color: '#0f172a' }}>{cell('all', 'all').length}</span>
          <span style={{ fontSize: 11.5, lineHeight: 1.2, color: '#475569' }}>{h1(hours(cell('all', 'all', true)))}h</span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, padding: '12px 14px 14px', borderTop: '1px solid #e5e7eb', background: '#f8fafc' }}>
        {BUCKETS.map((b) => {
          const list = bucket(b.id);
          const n = list.length;
          const hrs = hours(bucket(b.id, true));
          const red = b.id === 'overdue' && n > 0;
          return (
            <button key={b.id}
              onClick={() => n && setTile({ bucket: b.id })}
              onMouseEnter={(e) => n && setHover({ bucket: b.id, x: e.clientX, y: e.clientY })}
              onMouseMove={(e) => hover && setHover((h) => (h ? { ...h, x: e.clientX, y: e.clientY } : h))}
              onMouseLeave={() => setHover(null)}
              disabled={!n}
              style={{ textAlign: 'left', padding: '10px 14px', border: `1px solid ${red ? '#fca5a5' : '#e5e7eb'}`, borderRadius: 10, background: red ? '#fef2f2' : '#fff', cursor: n ? 'pointer' : 'default', fontFamily: font }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: red ? '#991b1b' : '#64748b' }}>{b.label}{weekEndOf[b.id] ? <span style={{ fontWeight: 500, color: '#94a3b8' }}> · w/e {fmt(weekEndOf[b.id])}</span> : b.sub ? <span style={{ fontWeight: 500, color: '#94a3b8' }}> · {b.sub}</span> : null}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 24, fontWeight: 700, color: n ? (red ? '#b91c1c' : '#0e7fe0') : '#cbd5e1' }}>{n}</span>
                {n > 0 && <span style={{ fontSize: 12, color: '#94a3b8' }}>{h1(hrs)}h</span>}
              </div>
            </button>
          );
        })}
      </div>

      {hover && (() => {
        const list = listFor(hover);
        const work = listFor(hover, true);
        const split = byPerson(list);
        return (
          <div style={{ position: 'fixed', left: Math.min(hover.x + 14, window.innerWidth - 240), top: Math.min(hover.y + 14, window.innerHeight - 40 - split.length * 22), zIndex: 140, background: '#0f172a', color: '#fff', borderRadius: 8, padding: '8px 10px', fontSize: 12.5, minWidth: 180, boxShadow: '0 4px 12px rgba(0,0,0,0.25)', pointerEvents: 'none' }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{hover.bucket ? titleFor(hover) : `${TILE_TYPES.find((t) => t.id === hover.type)?.label} · ${monthShort(hover.month)}`} · {list.length}</div>
            {split.map(([id, n]) => (
              <div key={id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '1px 0' }}>
                <span>{name(id)}</span><span style={{ fontWeight: 600 }}>{n}<span style={{ color: '#94a3b8', fontWeight: 400 }}> · {h1(hours(work.filter((j) => (j.assignee_id || 'none') === id)))}h</span></span>
              </div>
            ))}
            <div style={{ color: '#94a3b8', marginTop: 4 }}>Click for the {hover.bucket === 'quick' ? 'tasks' : 'jobs'}</div>
          </div>
        );
      })()}

      {tile && (() => {
        const list = listFor(tile).sort((a, b) => (name(a.assignee_id || 'none')).localeCompare(name(b.assignee_id || 'none')) || String(a[col]).localeCompare(String(b[col])));
        return (
          <div onClick={() => setTile(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.25)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 10, width: 760, maxWidth: '96vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column', fontFamily: font, boxShadow: '0 4px 16px rgba(0,0,0,0.15)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px 8px' }}>
                <div style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>{titleFor(tile)} · {list.length} {tile.bucket === 'quick' ? 'task' : 'job'}{list.length === 1 ? '' : 's'} · {h1(hours(listFor(tile, true)))}h</div>
                <button onClick={() => setTile(null)} style={BTN.secondary.sm}>Close</button>
              </div>
              <div style={{ overflowY: 'auto', padding: '0 16px 12px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '28px minmax(0, 1.4fr) minmax(0, 1.2fr) 90px 90px 50px 70px', gap: 8, fontSize: 11.5, fontWeight: 600, color: '#94a3b8', padding: '4px 4px', borderBottom: '1px solid #e5e7eb' }}>
                  <span /><span>Client</span><span>Task</span><span>Due</span><span>Planned</span><span>Hours</span><span />
                </div>
                {list.map((j) => (
                  <div key={j.id} style={{ display: 'grid', gridTemplateColumns: '28px minmax(0, 1.4fr) minmax(0, 1.2fr) 90px 90px 50px 70px', gap: 8, alignItems: 'center', padding: '6px 4px', borderBottom: '1px solid #f1f5f9', fontSize: 13 }}>
                    <span title={staffMap[j.assignee_id]?.name || 'Unassigned'}>{j.assignee_id ? <Avatar id={j.assignee_id} staffMap={staffMap} size={20} customColour={staffColours?.[j.assignee_id]} /> : null}</span>
                    <span style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.quick ? (entityMap[j.entity_id]?.name || '') : j.entities?.name}</span>
                    <span style={{ color: '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.quick ? j.title : shortTask(j.bm_task_name)}</span>
                    <span style={{ fontSize: 12, color: '#475569' }}>{fmt(j.bm_deadline)}</span>
                    <span style={{ fontSize: 12, color: '#94a3b8' }}>{j.scheduled_for_date ? fmt(j.scheduled_for_date) : '—'}</span>
                    <span style={{ fontSize: 12, color: '#475569', textAlign: 'right' }}>{j.scheduled_hours ? `${Number(j.scheduled_hours)}h` : ''}</span>
                    {onOpenTask ? <button onClick={() => { setTile(null); onOpenTask({ type: j.quick ? 'quick' : 'bm', id: j.id }); }} style={BTN.secondary.sm}>Open</button> : <span />}
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
