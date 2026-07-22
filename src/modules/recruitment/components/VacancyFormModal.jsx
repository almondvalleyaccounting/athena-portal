import React, { useState } from 'react';
import { Briefcase } from 'lucide-react';
import {
  backdrop, modal, fieldLabel, input, btn,
  EMPLOYMENT_TYPES, WORK_MODES, SALARY_PERIODS, VACANCY_STATUSES,
} from '../recruitmentShared';

// Create or edit a vacancy. `initial` present = edit mode.
export default function VacancyFormModal({ initial, staffList, onClose, onSave }) {
  const [f, setF] = useState({
    title: initial?.title || '',
    department: initial?.department || '',
    employment_type: initial?.employment_type || 'full_time',
    work_mode: initial?.work_mode || 'on_site',
    location: initial?.location || '',
    salary_min: initial?.salary_min ?? '',
    salary_max: initial?.salary_max ?? '',
    salary_period: initial?.salary_period || 'year',
    status: initial?.status || 'draft',
    hiring_manager_id: initial?.hiring_manager_id || '',
    description: initial?.description || '',
    requirements: initial?.requirements || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF((prev) => ({ ...prev, [k]: e.target.value }));

  async function submit() {
    if (!f.title.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        title: f.title.trim(),
        department: f.department.trim() || null,
        employment_type: f.employment_type,
        work_mode: f.work_mode,
        location: f.location.trim() || null,
        salary_min: f.salary_min === '' ? null : Number(f.salary_min),
        salary_max: f.salary_max === '' ? null : Number(f.salary_max),
        salary_period: f.salary_period,
        status: f.status,
        hiring_manager_id: f.hiring_manager_id || null,
        description: f.description.trim() || null,
        requirements: f.requirements.trim() || null,
      });
    } catch (e) {
      setError(e.message || 'Could not save');
      setSaving(false);
    }
  }

  const row = { display: 'flex', gap: 10 };
  const col = { flex: 1, minWidth: 0 };

  return (
    <div onClick={onClose} style={backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modal, width: 560, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Briefcase size={16} color="#0e7fe0" /> {initial ? 'Edit vacancy' : 'New vacancy'}
        </div>

        <label style={fieldLabel}>Job title *</label>
        <input value={f.title} onChange={set('title')} style={input} placeholder="Bookkeeper" autoFocus />

        <div style={{ ...row, marginTop: 12 }}>
          <div style={col}>
            <label style={fieldLabel}>Department</label>
            <input value={f.department} onChange={set('department')} style={input} placeholder="Accounts" />
          </div>
          <div style={col}>
            <label style={fieldLabel}>Location</label>
            <input value={f.location} onChange={set('location')} style={input} placeholder="Livingston" />
          </div>
        </div>

        <div style={{ ...row, marginTop: 12 }}>
          <div style={col}>
            <label style={fieldLabel}>Employment type</label>
            <select value={f.employment_type} onChange={set('employment_type')} style={input}>
              {EMPLOYMENT_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </div>
          <div style={col}>
            <label style={fieldLabel}>Work mode</label>
            <select value={f.work_mode} onChange={set('work_mode')} style={input}>
              {WORK_MODES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </div>
        </div>

        <div style={{ ...row, marginTop: 12, alignItems: 'flex-end' }}>
          <div style={col}>
            <label style={fieldLabel}>Salary min (£)</label>
            <input type="number" value={f.salary_min} onChange={set('salary_min')} style={input} placeholder="28000" />
          </div>
          <div style={col}>
            <label style={fieldLabel}>Salary max (£)</label>
            <input type="number" value={f.salary_max} onChange={set('salary_max')} style={input} placeholder="34000" />
          </div>
          <div style={col}>
            <label style={fieldLabel}>Per</label>
            <select value={f.salary_period} onChange={set('salary_period')} style={input}>
              {SALARY_PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label.replace('per ', '')}</option>)}
            </select>
          </div>
        </div>

        <div style={{ ...row, marginTop: 12 }}>
          <div style={col}>
            <label style={fieldLabel}>Status</label>
            <select value={f.status} onChange={set('status')} style={input}>
              {VACANCY_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </div>
          <div style={col}>
            <label style={fieldLabel}>Hiring manager</label>
            <select value={f.hiring_manager_id} onChange={set('hiring_manager_id')} style={input}>
              <option value="">—</option>
              {staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </div>

        <label style={{ ...fieldLabel, marginTop: 12 }}>Description</label>
        <textarea value={f.description} onChange={set('description')} rows={4} style={{ ...input, resize: 'vertical' }} placeholder="Role summary, responsibilities…" />

        <label style={{ ...fieldLabel, marginTop: 12 }}>Requirements</label>
        <textarea value={f.requirements} onChange={set('requirements')} rows={3} style={{ ...input, resize: 'vertical' }} placeholder="Essential / desirable…" />

        {error && <div style={{ fontSize: 12.5, color: '#b91c1c', marginTop: 10 }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btn('ghost')}>Cancel</button>
          <button onClick={submit} disabled={!f.title.trim() || saving} style={{ ...btn('primary'), opacity: (!f.title.trim() || saving) ? 0.6 : 1 }}>
            {saving ? 'Saving…' : (initial ? 'Save changes' : 'Create vacancy')}
          </button>
        </div>
      </div>
    </div>
  );
}
