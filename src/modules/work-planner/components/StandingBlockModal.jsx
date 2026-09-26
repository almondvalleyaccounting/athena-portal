import React, { useEffect, useState } from 'react';
import { formatISO } from '../lib/helpers';
import { BLOCK_KINDS, BLOCK_CADENCES, kindOf, callStandingBlocks, suggestClients } from '../lib/blocksApi';
import ClientTypeAhead from './ClientTypeAhead';
import { BTN } from '../../../lib/buttonStyles';

// A standing block: a repeating block of time BrightManager knows nothing
// about (sql/312). Kind, person, cadence, hours; for payroll a client list
// that becomes sub-tasks when the block is completed.

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
        cadence: block.recurrence === 'monthly' ? 'monthly' : ((block.weekdays || 'mon,tue,wed,thu,fri') === 'mon,tue,wed,thu,fri' ? 'daily' : 'days'),
        weekdays: (block.weekdays || 'mon,tue,wed,thu,fri').split(',').filter(Boolean),
        planned_date: block.planned_date ? formatISO(new Date(block.planned_date)) : formatISO(new Date()),
        hours: String((block.duration || k.hours * 60) / 60),
      };
    }
    return { title: 'Mail handling', block_kind: 'mail', assignee_id: profile?.id || '', cadence: 'daily', weekdays: [...DAYS], planned_date: formatISO(new Date()), hours: '1' };
  });
  const [list, setList] = useState(() => items.map((it) => ({ entity_id: it.entity_id, label: it.label || '', minutes_default: it.minutes_default ?? '' })));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [suggesting, setSuggesting] = useState(false);
  const kind = kindOf(form.block_kind);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => { setErr(null); }, [form]);

  const pickKind = (id) => {
    const k = kindOf(id);
    setForm((f) => ({ ...f, block_kind: id, title: (!f.title || BLOCK_KINDS.some((x) => x.label === f.title)) ? k.label : f.title, hours: String(k.hours), cadence: id === 'payroll_monthly' ? 'monthly' : id === 'payroll_weekly' ? 'days' : f.cadence }));
  };

  const addSuggested = async () => {
    if (!form.assignee_id) { setErr('Pick the person first'); return; }
    setSuggesting(true);
    try {
      const s = await suggestClients(form.assignee_id, form.block_kind);
      setList((prev) => {
        const have = new Set(prev.map((x) => x.entity_id));
        return [...prev, ...s.filter((x) => !have.has(x.entity_id)).map((x) => ({ entity_id: x.entity_id, label: '', minutes_default: '' }))];
      });
      if (!s.length) setErr('No clients found for that person under this service');
    } catch (e) { setErr(e.message); }
    finally { setSuggesting(false); }
  };

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const mins = Math.round(Number(form.hours) * 60);
      await callStandingBlocks({
        action: 'save_block',
        block: {
          id: block?.id || null, title: form.title, block_kind: form.block_kind, assignee_id: form.assignee_id || null,
          recurrence: form.cadence === 'monthly' ? 'monthly' : 'daily',
          weekdays: form.cadence === 'daily' ? 'mon,tue,wed,thu,fri' : form.weekdays.join(','),
          planned_date: form.planned_date, duration: mins, service: kind.service,
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

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.2)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(2px)' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 18, width: 520, maxWidth: '94vw', maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.1)', fontFamily: font }}>
        <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 17, fontWeight: 600, marginBottom: 4 }}>{isEdit ? 'Edit standing block' : 'New standing block'}</h3>
        <div style={{ fontSize: 12.5, color: '#64748b', marginBottom: 12 }}>A repeating block of time on the Calendar that is not a BrightManager job. It counts against capacity and logs to the timesheet when completed.</div>

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
          {form.cadence === 'days' && (
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              {DAYS.map((d) => {
                const on = form.weekdays.includes(d);
                return (
                  <button key={d} onClick={() => set('weekdays', on ? form.weekdays.filter((x) => x !== d) : [...form.weekdays, d])}
                    style={{ ...(on ? BTN.primary.sm : BTN.secondary.sm), cursor: 'pointer', textTransform: 'capitalize' }}>{d}</button>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1, marginBottom: 10 }}>
            <label style={labelStyle}>{form.cadence === 'monthly' ? 'First occurrence (sets the day of month)' : 'Starts'}</label>
            <input type="date" style={inputStyle} value={form.planned_date} onChange={(e) => set('planned_date', e.target.value)} />
          </div>
          <div style={{ width: 140, marginBottom: 10 }}>
            <label style={labelStyle}>Hours each time</label>
            <input type="number" min={0.25} max={12} step={0.25} style={inputStyle} value={form.hours} onChange={(e) => set('hours', e.target.value)} />
          </div>
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <label style={{ ...labelStyle, marginBottom: 0, flex: 1 }}>{kind.byClient ? 'Clients in this block (sub-tasks)' : 'Sub-tasks (optional)'}</label>
            {kind.byClient && <button onClick={addSuggested} disabled={suggesting} style={{ ...BTN.secondary.sm, cursor: 'pointer' }}>{suggesting ? 'Looking…' : `Add ${kind.service.toLowerCase()} clients`}</button>}
            <button onClick={() => setList((l) => [...l, { entity_id: '', label: '', minutes_default: '' }])} style={{ ...BTN.secondary.sm, cursor: 'pointer' }}>+ Add</button>
          </div>
          {list.length === 0 && <div style={{ fontSize: 12, color: '#94a3b8' }}>{kind.byClient ? 'Add the clients so time can be logged per client when the block is completed.' : 'None. Time is logged against the block as a whole.'}</div>}
          {list.map((it, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
              <div style={{ flex: 1 }}>
                {kind.byClient || it.entity_id ? (
                  <ClientTypeAhead entityList={entityList} value={it.entity_id} onChange={(id) => setList((l) => l.map((x, j) => (j === i ? { ...x, entity_id: id } : x)))} onAddNew={onAddEntity} />
                ) : (
                  <input style={inputStyle} placeholder="Sub-task" value={it.label} onChange={(e) => setList((l) => l.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                )}
              </div>
              <input type="number" min={0} step={5} placeholder="mins" title="Usual minutes" style={{ ...inputStyle, width: 74 }} value={it.minutes_default} onChange={(e) => setList((l) => l.map((x, j) => (j === i ? { ...x, minutes_default: e.target.value } : x)))} />
              <button onClick={() => setList((l) => l.filter((_, j) => j !== i))} style={{ ...BTN.secondary.sm, cursor: 'pointer' }} title="Remove">×</button>
            </div>
          ))}
          {list.length > 0 && kind.byClient && <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 2 }}>{list.filter((x) => x.entity_id).map((x) => entityMap?.[x.entity_id]?.name).filter(Boolean).length} clients</div>}
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
