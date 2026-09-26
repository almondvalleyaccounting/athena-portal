import React, { useMemo, useState } from 'react';
import { formatISO } from '../lib/helpers';
import { BLOCK_KINDS, BLOCK_CADENCES, kindOf, callStandingBlocks, suggestClients } from '../lib/blocksApi';
import ClientTypeAhead from './ClientTypeAhead';
import { BTN } from '../../../lib/buttonStyles';

// A block: a repeating block of time BrightManager knows nothing about
// (sql/312, sql/314). Kind, person, cadence, minutes; clients tagged into it
// become sub-tasks when it is completed; carry-over says what happens when
// an occurrence is not done.

const font = "'Outfit', sans-serif";
const labelStyle = { display: 'block', fontSize: 10, fontWeight: 600, color: '#94a3b8', marginBottom: 3, fontFamily: font };
const inputStyle = { padding: '7px 10px', fontSize: 13, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', color: '#0f172a', outline: 'none', width: '100%' };
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];

export default function StandingBlockModal({ block, items = [], staffList, entityList, entityMap, profile, onSaved, onDeleted, onClose, onAddEntity }) {
  const isEdit = !!block?.id;
  const [form, setForm] = useState(() => {
    if (block?.id) {
      const k = kindOf(block.block_kind);
      return {
        title: block.title, block_kind: block.block_kind || 'other', assignee_id: block.assignee_id || '',
        cadence: block.recurring ? (block.recurrence || 'daily') : 'daily',
        weekdays: (block.weekdays || 'mon,tue,wed,thu,fri').split(',').filter(Boolean),
        planned_date: block.planned_date ? formatISO(new Date(block.planned_date)) : formatISO(new Date()),
        minutes: String(block.duration || k.hours * 60),
        span_mode: block.span_end_day ? 'until' : 'days', span_days: String(block.span_days || 1), span_end_day: String(block.span_end_day || ''),
        until: block.until ? String(block.until).slice(0, 10) : '',
        carry_over: !!block.carry_over,
      };
    }
    return { title: 'Mail handling', block_kind: 'mail', assignee_id: profile?.id || '', cadence: 'daily', weekdays: [...DAYS], planned_date: formatISO(new Date()), minutes: '60', span_mode: 'days', span_days: '1', span_end_day: '', until: '', carry_over: false };
  });
  const [list, setList] = useState(() => items.map((it) => ({ entity_id: it.entity_id, label: it.label || '', minutes_default: it.minutes_default ?? '' })));
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [suggesting, setSuggesting] = useState(false);
  const kind = kindOf(form.block_kind);
  const set = (k, v) => { setErr(null); setForm((f) => ({ ...f, [k]: v })); };

  const pickKind = (id) => {
    const k = kindOf(id);
    setForm((f) => ({
      ...f, block_kind: id,
      title: (!f.title || BLOCK_KINDS.some((x) => x.label === f.title)) ? k.label : f.title,
      minutes: String(k.hours * 60),
      cadence: k.monthly ? 'monthly' : id === 'payroll_weekly' ? 'weekly' : f.cadence,
      carry_over: !!k.carry,
    }));
  };

  const tagged = useMemo(() => new Set(list.map((x) => x.entity_id).filter(Boolean)), [list]);
  const untagged = useMemo(() => entityList.filter((e) => !tagged.has(e.id)), [entityList, tagged]);
  const addClient = (id) => { if (id && !tagged.has(id)) setList((l) => [...l, { entity_id: id, label: '', minutes_default: '' }]); };

  const addSuggested = async () => {
    if (!form.assignee_id) { setErr('Pick the person first'); return; }
    setSuggesting(true);
    try {
      const s = await suggestClients(form.assignee_id, form.block_kind);
      setList((prev) => { const have = new Set(prev.map((x) => x.entity_id)); return [...prev, ...s.filter((x) => !have.has(x.entity_id)).map((x) => ({ entity_id: x.entity_id, label: '', minutes_default: '' }))]; });
      if (!s.length) setErr('No clients found for that person under this service');
    } catch (e) { setErr(e.message); }
    finally { setSuggesting(false); }
  };

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await callStandingBlocks({
        action: 'save_block',
        block: {
          id: block?.id || null, title: form.title, block_kind: form.block_kind, assignee_id: form.assignee_id || null,
          recurrence: form.cadence,
          weekdays: form.cadence === 'daily' ? 'mon,tue,wed,thu,fri' : form.weekdays.join(','),
          planned_date: form.planned_date, duration: Number(form.minutes), service: kind.service,
          span_days: form.cadence === 'monthly' && form.span_mode === 'days' ? Number(form.span_days) || 1 : null,
          span_end_day: form.cadence === 'monthly' && form.span_mode === 'until' ? Number(form.span_end_day) || null : null,
          until: form.until || null, carry_over: form.carry_over,
        },
        items: list.map((x) => ({ entity_id: x.entity_id || null, label: x.label || null, minutes_default: x.minutes_default === '' ? null : Number(x.minutes_default) })),
      });
      onSaved();
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  const del = async () => {
    if (!window.confirm(`Delete "${block.title}"? Past completions stay on the timesheet.`)) return;
    setBusy(true);
    try { await callStandingBlocks({ action: 'delete_block', id: block.id }); onDeleted(); }
    catch (e) { setErr(e.message); setBusy(false); }
  };

  const shown = list.map((it, i) => ({ it, i })).filter(({ it }) => !filter.trim() || (entityMap?.[it.entity_id]?.name || it.label || '').toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.2)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(2px)' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 18, width: 560, maxWidth: '94vw', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.1)', fontFamily: font }}>
        <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 17, fontWeight: 600, marginBottom: 4 }}>{isEdit ? 'Edit block' : 'New block'}</h3>
        <div style={{ fontSize: 12.5, color: '#64748b', marginBottom: 12 }}>A repeating block of time on the Planner that is not a BrightManager job. It counts against capacity and logs to the timesheet when completed.</div>

        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1, marginBottom: 10 }}>
            <label style={labelStyle}>Kind</label>
            <select style={inputStyle} value={form.block_kind} onChange={(e) => pickKind(e.target.value)}>
              {BLOCK_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
          </div>
          <div style={{ flex: 1, marginBottom: 10 }}>
            <label style={labelStyle}>Person</label>
            <select style={inputStyle} value={form.assignee_id} onChange={(e) => set('assignee_id', e.target.value)}>
              <option value="">&#8212;</option>
              {staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={labelStyle}>Title</label>
          <input style={inputStyle} value={form.title} onChange={(e) => set('title', e.target.value)} />
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={labelStyle}>Cadence</label>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {BLOCK_CADENCES.map((c) => (
              <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, cursor: 'pointer' }}>
                <input type="radio" name="cadence" checked={form.cadence === c.id} onChange={() => set('cadence', c.id)} style={{ accentColor: '#0e7fe0' }} />{c.label}
              </label>
            ))}
          </div>
          {(form.cadence === 'weekly' || form.cadence === 'fortnightly') && (
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              {DAYS.map((d) => {
                const on = form.weekdays.includes(d);
                return <button key={d} onClick={() => set('weekdays', on ? form.weekdays.filter((x) => x !== d) : [...form.weekdays, d])} style={{ ...(on ? BTN.primary.sm : BTN.secondary.sm), cursor: 'pointer', textTransform: 'capitalize' }}>{d}</button>;
              })}
              {form.cadence === 'fortnightly' && <span style={{ fontSize: 11.5, color: '#94a3b8', alignSelf: 'center' }}>counted from the week of the start date</span>}
            </div>
          )}
          {form.cadence === 'monthly' && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8, fontSize: 13, flexWrap: 'wrap' }}>
              <span style={{ color: '#64748b' }}>Starts on the {new Date(`${form.planned_date}T12:00:00`).getDate()}<sup>{ordinal(new Date(`${form.planned_date}T12:00:00`).getDate())}</sup> each month and runs</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}><input type="radio" checked={form.span_mode === 'days'} onChange={() => set('span_mode', 'days')} style={{ accentColor: '#0e7fe0' }} />for</label>
              <input type="number" min={1} max={23} disabled={form.span_mode !== 'days'} value={form.span_days} onChange={(e) => set('span_days', e.target.value)} style={{ ...inputStyle, width: 60 }} />
              <span style={{ color: '#64748b' }}>working days</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}><input type="radio" checked={form.span_mode === 'until'} onChange={() => set('span_mode', 'until')} style={{ accentColor: '#0e7fe0' }} />until the</label>
              <input type="number" min={1} max={31} disabled={form.span_mode !== 'until'} value={form.span_end_day} onChange={(e) => set('span_end_day', e.target.value)} placeholder="day" style={{ ...inputStyle, width: 64 }} />
              <span style={{ color: '#64748b' }}>of the month</span>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1, marginBottom: 10 }}>
            <label style={labelStyle}>{form.cadence === 'monthly' ? 'First start date (sets the day of month)' : 'Starts'}</label>
            <input type="date" style={inputStyle} value={form.planned_date} onChange={(e) => set('planned_date', e.target.value)} />
          </div>
          <div style={{ flex: 1, marginBottom: 10 }}>
            <label style={labelStyle}>Ends (optional)</label>
            <input type="date" style={inputStyle} value={form.until} onChange={(e) => set('until', e.target.value)} />
          </div>
          <div style={{ width: 130, marginBottom: 10 }}>
            <label style={labelStyle}>Minutes {form.cadence === 'monthly' ? 'per day' : 'each time'}</label>
            <input type="number" min={5} max={720} step={5} style={inputStyle} value={form.minutes} onChange={(e) => set('minutes', e.target.value)} />
          </div>
        </div>

        <div style={{ marginBottom: 12, padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#f8fafc' }}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.carry_over} onChange={(e) => set('carry_over', e.target.checked)} style={{ accentColor: '#0e7fe0', marginTop: 3 }} />
            <span>
              <b>Carry over if not completed</b>
              <div style={{ fontSize: 12, color: '#64748b' }}>{form.carry_over ? 'An unfinished day stays open under Incomplete until it is done.' : 'It either happens or it does not: an unfinished day is not carried forward, but the person says briefly why.'}</div>
            </span>
          </label>
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <label style={{ ...labelStyle, marginBottom: 0, flex: 1 }}>{kind.byClient ? `Clients in this block · ${tagged.size}` : `Sub-tasks (optional) · ${list.length}`}</label>
            {kind.byClient && <button onClick={addSuggested} disabled={suggesting} style={{ ...BTN.secondary.sm, cursor: 'pointer' }}>{suggesting ? 'Looking…' : `Add my ${kind.service.toLowerCase()} clients`}</button>}
            {!kind.byClient && <button onClick={() => setList((l) => [...l, { entity_id: '', label: '', minutes_default: '' }])} style={{ ...BTN.secondary.sm, cursor: 'pointer' }}>+ Sub-task</button>}
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <div style={{ flex: 1 }}><ClientTypeAhead entityList={untagged} value="" onChange={addClient} onAddNew={onAddEntity} /></div>
            {list.length > 6 && <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter the list" style={{ ...inputStyle, width: 160 }} />}
          </div>
          {list.length === 0 && <div style={{ fontSize: 12, color: '#94a3b8' }}>{kind.byClient ? 'Search above to tag clients, so time can be logged per client when the block is completed.' : 'None. Time is logged against the block as a whole.'}</div>}
          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
            {shown.map(({ it, i }) => (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                <div style={{ flex: 1, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {it.entity_id ? (entityMap?.[it.entity_id]?.name || 'Client') : (
                    <input style={inputStyle} placeholder="Sub-task" value={it.label} onChange={(e) => setList((l) => l.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                  )}
                </div>
                <input type="number" min={0} step={5} placeholder="mins" title="Usual minutes" style={{ ...inputStyle, width: 74 }} value={it.minutes_default} onChange={(e) => setList((l) => l.map((x, j) => (j === i ? { ...x, minutes_default: e.target.value } : x)))} />
                <button onClick={() => setList((l) => l.filter((_, j) => j !== i))} style={{ ...BTN.secondary.sm, cursor: 'pointer' }} title="Remove">×</button>
              </div>
            ))}
          </div>
        </div>

        {err && <div style={{ fontSize: 12.5, color: '#991b1b', marginBottom: 8 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 8 }}>
          {isEdit && <button onClick={del} disabled={busy} style={{ ...BTN.danger.sm, cursor: 'pointer', marginRight: 'auto' }}>Delete</button>}
          <button onClick={onClose} style={{ ...BTN.secondary.sm, cursor: 'pointer' }}>Cancel</button>
          <button onClick={save} disabled={busy || !form.title.trim()} style={{ ...BTN.primary.sm, cursor: 'pointer' }}>{busy ? 'Saving…' : isEdit ? 'Save' : 'Create'}</button>
        </div>
      </div>
    </div>
  );
}

function ordinal(n) { const s = ['th', 'st', 'nd', 'rd']; const v = n % 100; return s[(v - 20) % 10] || s[v] || s[0]; }
