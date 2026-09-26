import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { fetchAllRows } from '../../../lib/fetchAllRows';
import { rescheduleTask } from '../setup/queries';
import { formatISO, addDays } from '../lib/helpers';
import { BTN } from '../../../lib/buttonStyles';

// The Job Selector (Bobby, 2026-09-26): pull BrightManager jobs onto a day
// when there is room. Grouped like Ready Now — Urgent, Expedite, then the
// rest — filtered by type of work. Ticking a limited company's accounts also
// ticks the directors' self assessments when they can be done: the tax year
// the year end falls in must have ended by the day the work is planned for.
// The modal closes only from its Close button.

const font = "'Outfit', sans-serif";
const TYPES = [
  { id: 'all',         label: 'All' },
  { id: 'accounts',    label: 'Accounts',        services: ['Annual Accounts', 'Accounts', 'Corporation Tax'] },
  { id: 'vat',         label: 'VAT returns',     services: ['VAT'] },
  { id: 'sa',          label: 'Self assessment', services: ['Self Assessment', 'Personal Tax'] },
  { id: 'bookkeeping', label: 'Bookkeeping',     services: ['Bookkeeping', 'Management Accounts'] },
  { id: 'other',       label: 'Other' },
];
const KNOWN = new Set(TYPES.flatMap((t) => t.services || []));
const typeOf = (service) => TYPES.find((t) => t.services?.includes(service))?.id || 'other';
const URGENT_DAYS = 14;

function periodEndOf(name) {
  const m = String(name || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const t = String(name || '').match(/Tax Year\s+(\d{4})\/(\d{2})/i);
  if (t) return `${Number(t[1]) + 1}-04-05`;
  return null;
}
// The tax year a year end falls in ends on the 5 April on or after it.
function taxYearEndFor(periodEndISO) {
  const y = Number(periodEndISO.slice(0, 4));
  return periodEndISO <= `${y}-04-05` ? `${y}-04-05` : `${y + 1}-04-05`;
}
const shortName = (n) => String(n || '').replace(/\s*(Year End|Quarterly End|Monthly End|Period End|Tax Year).*$/i, '');
const fmt = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '');

export default function JobSelectorModal({ staffList, entityMap, profile, defaultDate, teamFilter, onScheduled, onClose }) {
  const [rows, setRows] = useState([]);
  const [links, setLinks] = useState({ dirs: {}, indiv: {} }); // ltd -> [person], person -> individual entity
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [type, setType] = useState('all');
  const [who, setWho] = useState(teamFilter || profile?.id || '');
  const [q, setQ] = useState('');
  const [date, setDate] = useState(defaultDate || formatISO(new Date()));
  const [selected, setSelected] = useState(new Map()); // id -> { reason }
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const today = formatISO(new Date());

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const [data, { data: ep }, { data: ind }] = await Promise.all([
        fetchAllRows(() => supabase.from('bm_task_schedule')
          .select('id, service, bm_task_name, bm_deadline, entity_id, assignee_id, scheduled_for_date, scheduled_hours, status, entities(name, type, expedite, deprioritise_reason, entity_status)')
          .eq('state', 'planned').is('excluded_at', null).order('bm_deadline').order('id')),
        supabase.from('entity_people').select('entity_id, person_id').eq('role', 'director').is('ended_on', null).limit(2000),
        supabase.from('entities').select('id, linked_person_id').not('linked_person_id', 'is', null).limit(2000),
      ]);
      const dirs = {};
      (ep || []).forEach((r) => { (dirs[r.entity_id] ||= []).push(r.person_id); });
      const indiv = {};
      (ind || []).forEach((r) => { indiv[r.linked_person_id] = r.id; });
      setLinks({ dirs, indiv });
      setRows((data || []).filter((r) => r.entities && !['nlac', 'archived'].includes(r.entities.entity_status) && !r.entities.deprioritise_reason)
        .map((r) => ({ ...r, period_end: periodEndOf(r.bm_task_name), type: typeOf(r.service) })));
    } catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const byId = useMemo(() => Object.fromEntries(rows.map((r) => [r.id, r])), [rows]);
  const saByEntity = useMemo(() => {
    const m = {};
    rows.filter((r) => r.service === 'Self Assessment').forEach((r) => { (m[r.entity_id] ||= []).push(r); });
    return m;
  }, [rows]);

  // Directors' SA jobs for an accounts job, split by whether they can be done
  // on the chosen date.
  const directorSA = (job) => {
    if (job.service !== 'Annual Accounts' || !job.period_end) return { doable: [], notYet: [] };
    const tyEnd = taxYearEndFor(job.period_end);
    const people = links.dirs[job.entity_id] || [];
    const out = { doable: [], notYet: [] };
    people.forEach((pid) => {
      const indId = links.indiv[pid];
      if (!indId) return;
      (saByEntity[indId] || []).forEach((sa) => {
        if (sa.period_end !== tyEnd) return;
        (date > tyEnd ? out.doable : out.notYet).push(sa);
      });
    });
    return out;
  };

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (type !== 'all' && r.type !== type) return false;
      if (who && r.assignee_id !== who) return false;
      if (needle && !(`${r.entities.name} ${r.bm_task_name}`.toLowerCase().includes(needle))) return false;
      return true;
    });
  }, [rows, type, who, q]);

  const groups = useMemo(() => {
    const cut = formatISO(addDays(new Date(), URGENT_DAYS));
    const urgent = [], expedite = [], others = [];
    visible.forEach((r) => {
      if (r.bm_deadline && r.bm_deadline <= cut) urgent.push(r);
      else if (r.entities.expedite) expedite.push(r);
      else others.push(r);
    });
    return { urgent, expedite, others };
  }, [visible]);

  const toggle = (job) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(job.id)) {
        next.delete(job.id);
        // Drop the directors' returns that rode along with it.
        [...next.entries()].forEach(([id, v]) => { if (v.via === job.id) next.delete(id); });
      } else {
        next.set(job.id, { reason: 'picked' });
        directorSA(job).doable.forEach((sa) => { if (!next.has(sa.id)) next.set(sa.id, { reason: 'director', via: job.id }); });
      }
      return next;
    });
  };

  const notReady = (r) => r.period_end && r.period_end > date;

  const schedule = async () => {
    const ids = [...selected.keys()].filter((id) => byId[id] && !notReady(byId[id]));
    if (!ids.length) return;
    setBusy(true); setError(null); setDone(null);
    try {
      for (const id of ids) await rescheduleTask(id, date); // eslint-disable-line no-await-in-loop
      setDone(`${ids.length} job${ids.length === 1 ? '' : 's'} planned for ${fmt(date)}.`);
      setSelected(new Map());
      await load();
      onScheduled && onScheduled();
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };

  const selectedHours = [...selected.keys()].reduce((s, id) => s + Number(byId[id]?.scheduled_hours || 0), 0);

  const Row = ({ r, nested }) => {
    const on = selected.has(r.id);
    const blocked = notReady(r);
    const sa = r.service === 'Annual Accounts' ? directorSA(r) : null;
    return (
      <>
        <div onClick={() => !blocked && toggle(r)} style={{ display: 'grid', gridTemplateColumns: '24px 1fr 90px 80px 70px 50px', gap: 8, alignItems: 'center', padding: '5px 10px', paddingLeft: nested ? 34 : 10, borderBottom: '1px solid #f1f5f9', fontSize: 13, cursor: blocked ? 'default' : 'pointer', opacity: blocked ? 0.5 : 1, background: on ? '#eff6ff' : '#fff' }}>
          <input type="checkbox" checked={on} readOnly disabled={blocked} style={{ accentColor: '#0e7fe0' }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.entities.name}{nested ? <span style={{ color: '#64748b', fontWeight: 400 }}> · director's return</span> : ''}</div>
            <div style={{ color: '#64748b', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {shortName(r.bm_task_name)}{r.period_end ? ` · PE ${fmt(r.period_end)}` : ''}{blocked ? ' · period end not reached' : ''}
              {on && selected.get(r.id)?.reason === 'director' ? ' · auto-selected' : ''}
            </div>
          </div>
          <div style={{ fontSize: 12, color: r.bm_deadline && r.bm_deadline < today ? '#b91c1c' : '#475569' }}>{r.bm_deadline ? `due ${fmt(r.bm_deadline)}` : ''}</div>
          <div style={{ fontSize: 12, color: '#94a3b8' }}>{r.scheduled_for_date ? `on ${fmt(r.scheduled_for_date)}` : 'unplanned'}</div>
          <div style={{ fontSize: 12, color: '#94a3b8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{staffList.find((s) => s.id === r.assignee_id)?.name?.split(' ')[0] || ''}</div>
          <div style={{ fontSize: 12, color: '#475569', textAlign: 'right' }}>{Number(r.scheduled_hours || 0)}h</div>
        </div>
        {on && sa && (sa.doable.length > 0 || sa.notYet.length > 0) && (
          <>
            {sa.doable.map((s) => <Row key={s.id} r={s} nested />)}
            {sa.notYet.map((s) => (
              <div key={s.id} style={{ padding: '4px 10px 4px 34px', fontSize: 12, color: '#94a3b8', borderBottom: '1px solid #f1f5f9' }}>
                {s.entities.name} · director's return not until {fmt(addDaysISO(taxYearEndFor(r.period_end), 1))}
              </div>
            ))}
          </>
        )}
      </>
    );
  };

  const Group = ({ title, items, tone }) => (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', marginBottom: 10 }}>
      <div style={{ padding: '7px 10px', fontSize: 12.5, fontWeight: 700, color: tone.fg, background: tone.bg, borderBottom: '1px solid #e5e7eb' }}>{title} <span style={{ fontWeight: 500, opacity: 0.8 }}>· {items.length}</span></div>
      {items.length === 0 ? <div style={{ padding: '8px 10px', fontSize: 12.5, color: '#cbd5e1' }}>None</div> : items.map((r) => <Row key={r.id} r={r} />)}
    </div>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.25)', zIndex: 115, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 10, width: 860, maxWidth: '96vw', height: '88vh', display: 'flex', flexDirection: 'column', fontFamily: font, boxShadow: '0 4px 16px rgba(0,0,0,0.15)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px 8px' }}>
          <div style={{ fontSize: 17, fontWeight: 700, flex: 1 }}>Job Selector</div>
          <button onClick={onClose} style={BTN.secondary.sm}>Close</button>
        </div>
        <div style={{ padding: '0 16px 8px', fontSize: 12.5, color: '#64748b' }}>Pick BrightManager jobs to plan onto a day. A job keeps its BM assignee; only the date moves. Ticking a company's accounts also ticks its directors' returns when their tax year has ended.</div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '0 16px 8px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {TYPES.map((t) => <button key={t.id} onClick={() => setType(t.id)} style={{ ...(type === t.id ? BTN.primary.sm : BTN.secondary.sm), cursor: 'pointer' }}>{t.label}</button>)}
          </div>
          <select value={who} onChange={(e) => setWho(e.target.value)} style={{ padding: '5px 8px', fontSize: 12.5, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 8 }}>
            <option value="">Anyone's jobs</option>
            {staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search client or task" style={{ flex: 1, minWidth: 160, padding: '5px 8px', fontSize: 12.5, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 8 }} />
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '0 16px' }}>
          {error && <div style={{ padding: '8px 12px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13, marginBottom: 8 }}>{error}</div>}
          {done && <div style={{ padding: '8px 12px', borderRadius: 8, background: '#dcfce7', color: '#166534', fontSize: 13, marginBottom: 8 }}>{done}</div>}
          {loading ? <div style={{ fontSize: 13, color: '#94a3b8', padding: 8 }}>Loading jobs…</div> : (
            <>
              <Group title="🔥 Urgent — due within two weeks or overdue" items={groups.urgent} tone={{ bg: '#fef2f2', fg: '#991b1b' }} />
              <Group title="⚡ Expedite" items={groups.expedite} tone={{ bg: '#fffbeb', fg: '#92400e' }} />
              <Group title="Everything else, soonest deadline first" items={groups.others} tone={{ bg: '#f8fafc', fg: '#475569' }} />
            </>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 16px', borderTop: '1px solid #e5e7eb', background: '#f8fafc', borderRadius: '0 0 10px 10px' }}>
          <div style={{ flex: 1, fontSize: 13, color: '#475569' }}>
            {selected.size === 0 ? 'Nothing selected.' : `${selected.size} selected · ${Math.round(selectedHours * 10) / 10}h`}
            {KNOWN.size === 0 ? '' : ''}
          </div>
          <label style={{ fontSize: 12.5, color: '#64748b' }}>Plan for</label>
          <input type="date" value={date} onChange={(e) => { setDate(e.target.value); }} style={{ padding: '5px 8px', fontSize: 12.5, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 8 }} />
          <button onClick={schedule} disabled={busy || selected.size === 0} style={{ ...BTN.primary.sm, cursor: 'pointer' }}>{busy ? 'Planning…' : `Plan ${selected.size || ''} onto that day`}</button>
        </div>
      </div>
    </div>
  );
}

function addDaysISO(iso, n) { return formatISO(addDays(new Date(`${iso}T12:00:00`), n)); }
