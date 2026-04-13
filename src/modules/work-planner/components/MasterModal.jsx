import React, { useState } from 'react';
import { SERVICES, STATUSES, TASK_TYPES, RECURRENCE_OPTIONS, TIME_OPTIONS } from '../lib/constants';
import { defaultDuration } from '../lib/constants';
import { countOverrides } from '../lib/instanceEngine';
import { formatISO } from '../lib/helpers';

const labelStyle = {
  display: 'block', fontSize: 9, fontWeight: 600, color: '#94a3b8',
  textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 3,
  fontFamily: "'Outfit', sans-serif",
};
const inputStyle = {
  padding: '7px 10px', fontSize: 12, fontFamily: "'Outfit', sans-serif",
  border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff',
  color: '#0f172a', outline: 'none', width: '100%',
};
const selectStyle = { ...inputStyle };
const rowStyle = { display: 'flex', gap: 10 };
const fieldStyle = { marginBottom: 10 };

export default function MasterModal({
  master,
  overridesMap,
  staffList,
  entityList,
  onSave,
  onDelete,
  onClose,
}) {
  const isEdit = !!master;
  const [form, setForm] = useState(() => {
    if (master) {
      return {
        ...master,
        planned_date: master.planned_date ? formatISO(new Date(master.planned_date)) : '',
      };
    }
    return {
      title: '', task_type: 'client_work', entity_id: '', service: '',
      assignee_id: '', recurring: false, recurrence: '', status: 'not_started',
      source: 'manual', planned_date: '', planned_hour: '', planned_min: 0,
      duration: 30,
    };
  });

  function set(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const overrideCount = isEdit ? countOverrides(master.id, overridesMap) : 0;

  function handleSave() {
    if (!form.title.trim()) return;
    const payload = {
      ...form,
      planned_date: form.planned_date
        ? new Date(form.planned_date + 'T00:00:00').toISOString()
        : null,
      planned_hour: form.planned_hour !== '' && form.planned_hour != null
        ? Number(form.planned_hour) : null,
      planned_min: Number(form.planned_min) || 0,
      duration: Number(form.duration) || 30,
      entity_id: form.entity_id || null,
      assignee_id: form.assignee_id || null,
      recurrence: form.recurring ? form.recurrence : null,
    };
    onSave(payload);
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.2)',
        zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center',
        backdropFilter: 'blur(2px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
          padding: 18, width: 420, maxWidth: '92vw', maxHeight: '85vh',
          overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
          fontFamily: "'Outfit', sans-serif",
        }}
      >
        <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 17, fontWeight: 600, marginBottom: 12 }}>
          {isEdit ? 'Edit Master' : 'New Scheduled Task'}
        </h3>

        {overrideCount > 0 && (
          <div style={{
            padding: '8px 10px', borderRadius: 6, background: '#fefce8',
            border: '1px solid #fde68a', fontSize: 11, color: '#92400e', marginBottom: 12,
          }}>
            &#9888; {overrideCount} future instance{overrideCount > 1 ? 's' : ''} with overrides.
            Master changes apply to un-overridden instances only.
          </div>
        )}

        <div style={fieldStyle}>
          <label style={labelStyle}>Title</label>
          <input
            style={inputStyle}
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            autoFocus
            placeholder="e.g. VAT Return, Payroll, Annual Accounts"
          />
        </div>

        <div style={rowStyle}>
          <div style={{ ...fieldStyle, flex: 1 }}>
            <label style={labelStyle}>Task Type</label>
            <select style={selectStyle} value={form.task_type} onChange={(e) => set('task_type', e.target.value)}>
              {TASK_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
          <div style={{ ...fieldStyle, flex: 1 }}>
            <label style={labelStyle}>Source</label>
            <select style={selectStyle} value={form.source} onChange={(e) => set('source', e.target.value)}>
              <option value="manual">Manual</option>
              <option value="brightmanager">BrightManager</option>
              <option value="payroll_checklist">Payroll Checklist</option>
            </select>
          </div>
        </div>

        <div style={rowStyle}>
          <div style={{ ...fieldStyle, flex: 1 }}>
            <label style={labelStyle}>Client</label>
            <select style={selectStyle} value={form.entity_id || ''} onChange={(e) => set('entity_id', e.target.value || null)}>
              <option value="">&#8212;</option>
              {entityList.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
          <div style={{ ...fieldStyle, flex: 1 }}>
            <label style={labelStyle}>Service</label>
            <select
              style={selectStyle}
              value={form.service || ''}
              onChange={(e) => {
                const svc = e.target.value;
                set('service', svc);
                set('duration', defaultDuration(svc, form.source));
              }}
            >
              <option value="">&#8212;</option>
              {SERVICES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        <div style={rowStyle}>
          <div style={{ ...fieldStyle, flex: 1 }}>
            <label style={labelStyle}>Default Owner</label>
            <select style={selectStyle} value={form.assignee_id || ''} onChange={(e) => set('assignee_id', e.target.value || null)}>
              <option value="">&#8212;</option>
              {staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div style={{ ...fieldStyle, flex: 1 }}>
            <label style={labelStyle}>Status</label>
            <select style={selectStyle} value={form.status} onChange={(e) => set('status', e.target.value)}>
              {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>
        </div>

        <div style={rowStyle}>
          <div style={{ ...fieldStyle, flex: 1 }}>
            <label style={labelStyle}>Start Date</label>
            <input
              type="date"
              style={inputStyle}
              value={form.planned_date || ''}
              onChange={(e) => set('planned_date', e.target.value)}
            />
          </div>
          <div style={{ ...fieldStyle, flex: 1 }}>
            <label style={labelStyle}>Time</label>
            <select
              style={selectStyle}
              value={
                form.planned_hour != null && form.planned_hour !== ''
                  ? `${form.planned_hour}:${String(form.planned_min || 0).padStart(2, '0')}`
                  : ''
              }
              onChange={(e) => {
                if (!e.target.value) { set('planned_hour', ''); return; }
                const [h, m] = e.target.value.split(':');
                set('planned_hour', Number(h));
                set('planned_min', Number(m));
              }}
            >
              <option value="">&#8212;</option>
              {TIME_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div style={{ ...fieldStyle, flex: 1 }}>
            <label style={labelStyle}>Duration (min)</label>
            <input
              type="number"
              style={inputStyle}
              min={15}
              max={480}
              step={15}
              value={form.duration}
              onChange={(e) => set('duration', e.target.value)}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer' }}>
            <input
              type="checkbox"
              style={{ accentColor: '#0e7fe0' }}
              checked={form.recurring}
              onChange={(e) => set('recurring', e.target.checked)}
            />
            Recurring
          </label>
          {form.recurring && (
            <select
              style={{ ...selectStyle, width: 'auto', flex: 1 }}
              value={form.recurrence || ''}
              onChange={(e) => set('recurrence', e.target.value)}
            >
              <option value="">&#8212;</option>
              {RECURRENCE_OPTIONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          )}
        </div>

        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 14 }}>
          {isEdit && (
            <button
              onClick={() => onDelete(master.id)}
              style={{
                ...btnBase, color: '#dc2626', marginRight: 'auto',
                border: '1px solid #e5e7eb', background: '#fff',
              }}
            >
              Delete
            </button>
          )}
          <button onClick={onClose} style={{ ...btnBase, border: '1px solid #e5e7eb', background: '#fff', color: '#1e293b' }}>
            Cancel
          </button>
          <button onClick={handleSave} style={{ ...btnBase, background: '#0f172a', color: '#fff', border: '1px solid #0f172a' }}>
            {isEdit ? 'Update' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

const btnBase = {
  padding: '5px 12px', fontSize: 11, fontWeight: 500,
  fontFamily: "'Outfit', sans-serif", borderRadius: 8, cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
};
