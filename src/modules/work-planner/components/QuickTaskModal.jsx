import React, { useState } from 'react';
import { SERVICES } from '../lib/constants';
import { formatISO } from '../lib/helpers';
import ClientTypeAhead from './ClientTypeAhead';

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
const btnBase = {
  padding: '5px 12px', fontSize: 11, fontWeight: 500,
  fontFamily: "'Outfit', sans-serif", borderRadius: 8, cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
};

export default function QuickTaskModal({ task, staffList, entityList, onSave, onDelete, onClose, onAddEntity }) {
  const [form, setForm] = useState({
    title: task.title || '',
    entity_id: task.entity_id || '',
    service: task.service || 'Admin',
    assignee_id: task.assignee_id || '',
    due_date: task.due_date ? formatISO(new Date(task.due_date)) : '',
    duration: task.duration || 15,
    notes: task.notes || '',
  });

  function set(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleSave() {
    if (!form.title.trim()) return;
    onSave(task.id, {
      title: form.title.trim(),
      entity_id: form.entity_id || null,
      service: form.service,
      assignee_id: form.assignee_id || null,
      due_date: form.due_date ? new Date(form.due_date + 'T00:00:00').toISOString() : null,
      duration: Number(form.duration) || 15,
      notes: form.notes,
    });
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
          padding: 18, width: 400, maxWidth: '92vw', maxHeight: '85vh',
          overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
          fontFamily: "'Outfit', sans-serif",
        }}
      >
        <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 17, fontWeight: 600, marginBottom: 12 }}>
          Edit Quick Task
        </h3>

        <div style={{ marginBottom: 10 }}>
          <label style={labelStyle}>Title</label>
          <input style={inputStyle} value={form.title} onChange={(e) => set('title', e.target.value)} autoFocus />
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1, marginBottom: 10 }}>
            <label style={labelStyle}>Client</label>
            <ClientTypeAhead
              entityList={entityList}
              value={form.entity_id}
              onChange={(id) => set('entity_id', id)}
              onAddNew={onAddEntity}
            />
          </div>
          <div style={{ flex: 1, marginBottom: 10 }}>
            <label style={labelStyle}>Service</label>
            <select style={selectStyle} value={form.service} onChange={(e) => set('service', e.target.value)}>
              {SERVICES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1, marginBottom: 10 }}>
            <label style={labelStyle}>Assignee</label>
            <select style={selectStyle} value={form.assignee_id} onChange={(e) => set('assignee_id', e.target.value)}>
              <option value="">&#8212;</option>
              {staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div style={{ flex: 1, marginBottom: 10 }}>
            <label style={labelStyle}>Due Date</label>
            <input type="date" style={inputStyle} value={form.due_date} onChange={(e) => set('due_date', e.target.value)} />
          </div>
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={labelStyle}>Duration (min)</label>
          <input type="number" style={{ ...inputStyle, width: 100 }} min={5} max={480} step={5} value={form.duration} onChange={(e) => set('duration', e.target.value)} />
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={labelStyle}>Notes</label>
          <textarea
            style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }}
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
          />
        </div>

        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 14 }}>
          <button
            onClick={() => onDelete(task.id)}
            style={{ ...btnBase, color: '#dc2626', marginRight: 'auto', border: '1px solid #e5e7eb', background: '#fff' }}
          >
            Delete
          </button>
          <button onClick={onClose} style={{ ...btnBase, border: '1px solid #e5e7eb', background: '#fff', color: '#1e293b' }}>
            Cancel
          </button>
          <button onClick={handleSave} style={{ ...btnBase, background: '#0f172a', color: '#fff', border: '1px solid #0f172a' }}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
