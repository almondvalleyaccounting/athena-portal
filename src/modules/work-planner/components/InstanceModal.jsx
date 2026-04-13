import React, { useState } from 'react';
import { STATUSES, TIME_OPTIONS } from '../lib/constants';
import { formatDateFull } from '../lib/helpers';

const labelStyle = {
  display: 'block', fontSize: 9, fontWeight: 600, color: '#94a3b8',
  textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 3,
  fontFamily: "'Outfit', sans-serif",
};
const selectStyle = {
  padding: '7px 10px', fontSize: 12, fontFamily: "'Outfit', sans-serif",
  border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff',
  color: '#0f172a', outline: 'none', width: '100%',
};
const btnBase = {
  padding: '5px 12px', fontSize: 11, fontWeight: 500,
  fontFamily: "'Outfit', sans-serif", borderRadius: 8, cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
};

export default function InstanceModal({ instance, master, staffList, onSave, onReset, onClose }) {
  const [assigneeId, setAssigneeId] = useState(instance.assignee_id || '');
  const [status, setStatus] = useState(instance.status || 'not_started');
  const [hour, setHour] = useState(instance.planned_hour);
  const [min, setMin] = useState(instance.planned_min || 0);

  function handleSave() {
    const override = {};
    if (assigneeId !== (master.assignee_id || '')) override.assignee_id = assigneeId || null;
    if (status !== master.status) override.status = status;
    if (hour !== master.planned_hour || min !== (master.planned_min || 0)) {
      override.planned_hour = hour;
      override.planned_min = min;
    }
    onSave(instance._key, Object.keys(override).length ? override : null);
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
          padding: 18, width: 360, maxWidth: '92vw', maxHeight: '85vh',
          overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
          fontFamily: "'Outfit', sans-serif",
        }}
      >
        <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
          Edit Instance
        </h3>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
          {instance.title} &#8212; {formatDateFull(instance._date)}
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={labelStyle}>Owner</label>
          <select style={selectStyle} value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
            <option value="">&#8212;</option>
            {staffList.map((s) => (
              <option key={s.id} value={s.id}>{s.full_name || s.name}</option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={labelStyle}>Status</label>
          <select style={selectStyle} value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={labelStyle}>Time</label>
          <select
            style={selectStyle}
            value={hour != null ? `${hour}:${String(min).padStart(2, '0')}` : ''}
            onChange={(e) => {
              if (!e.target.value) return;
              const [h, m] = e.target.value.split(':');
              setHour(Number(h));
              setMin(Number(m));
            }}
          >
            {TIME_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>

        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 14 }}>
          {instance._hasOverride && (
            <button
              onClick={() => onReset(instance)}
              style={{ ...btnBase, color: '#0e7fe0', marginRight: 'auto', border: '1px solid #e5e7eb', background: '#fff' }}
            >
              Reset to master
            </button>
          )}
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
