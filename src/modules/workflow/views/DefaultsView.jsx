import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Save, X, AlertTriangle, Play } from 'lucide-react';
import { listDefaults, createDefault, updateDefault, deleteDefault, listDistinctBmTaskNames } from '../lib/workflowQueries';
import { runPlanner } from '../lib/planner';

// Map semantic priority levels to the int column used by the sort.
// Higher = more likely to win a prefix match.
const PRIORITY_LEVELS = [
  { value: 200, label: 'High',   colour: '#dc2626', bg: '#fee2e2' },
  { value: 100, label: 'Medium', colour: '#b45309', bg: '#fef3c7' },
  { value: 50,  label: 'Low',    colour: '#475569', bg: '#f1f5f9' },
];

function priorityLabel(n) {
  if (n == null) return PRIORITY_LEVELS[1];
  // Bucket anything close to a preset: >=150 high, >=75 medium, else low.
  if (n >= 150) return PRIORITY_LEVELS[0];
  if (n >= 75)  return PRIORITY_LEVELS[1];
  return PRIORITY_LEVELS[2];
}

const font = "'Outfit', sans-serif";

const WEEK_OPTIONS = [
  { value: 1, label: '1st week' },
  { value: 2, label: '2nd week' },
  { value: 3, label: '3rd week' },
  { value: 4, label: '4th week' },
  { value: 5, label: 'Last week' },
];

const EMPTY_DEFAULT = {
  name: '',
  task_name_prefix: '',
  bm_deadline_offset_months: 0,
  week_of_month: 2,
  target_hours: 1.0,
  match_priority: 100,  // Medium
  notes: '',
  is_active: true,
};

// Offsets beyond ±12 are unusual; a dropdown keeps the UX honest.
// Free-typed offsets outside this set are preserved on save — the
// menu just exposes the common choices.
const OFFSET_OPTIONS = [
  { value: -12, label: '−12 months (1 year before)' },
  { value: -9,  label: '−9 months' },
  { value: -6,  label: '−6 months' },
  { value: -3,  label: '−3 months' },
  { value: -2,  label: '−2 months' },
  { value: -1,  label: '−1 month (month before)' },
  { value: 0,   label: '0 — same month as deadline' },
  { value: 1,   label: '+1 month (month after)' },
  { value: 2,   label: '+2 months' },
  { value: 3,   label: '+3 months' },
];

export default function DefaultsView() {
  const [defaults, setDefaults] = useState([]);
  const [taskNameSuggestions, setTaskNameSuggestions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [plannerResult, setPlannerResult] = useState(null);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const [rows, names] = await Promise.all([listDefaults(), listDistinctBmTaskNames()]);
      setDefaults(rows);
      setTaskNameSuggestions(names);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, []);

  const startEdit = (d) => { setEditingId(d.id); setDraft({ ...d }); };
  const startNew = () => { setEditingId('new'); setDraft({ ...EMPTY_DEFAULT }); };
  const cancelEdit = () => { setEditingId(null); setDraft(null); };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const patch = {
        name: draft.name?.trim() || '',
        task_name_prefix: draft.task_name_prefix?.trim() || '',
        bm_deadline_offset_months: parseInt(draft.bm_deadline_offset_months, 10) || 0,
        week_of_month: parseInt(draft.week_of_month, 10) || 2,
        target_hours: parseFloat(draft.target_hours) || 0,
        match_priority: parseInt(draft.match_priority, 10) || 100,
        notes: draft.notes?.trim() || null,
        is_active: !!draft.is_active,
      };
      if (!patch.name) throw new Error('Name is required');
      if (!patch.task_name_prefix) throw new Error('Task name prefix is required');

      if (editingId === 'new') await createDefault(patch);
      else await updateDefault(editingId, patch);
      await reload();
      cancelEdit();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const runPlan = async () => {
    if (!confirm('Run planner over the next 9 months? Every BM task that matches a default will be re-placed as a draft. Existing scheduling is superseded.')) return;
    setPlanning(true);
    setError(null);
    setPlannerResult(null);
    try {
      const res = await runPlanner({ horizonMonths: 9 });
      setPlannerResult(res);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setPlanning(false);
    }
  };

  const remove = async (d) => {
    if (!confirm(`Delete default "${d.name}"? Any future planner runs will fall back to the next matching default (or none).`)) return;
    setError(null);
    try {
      await deleteDefault(d.id);
      await reload();
    } catch (e) {
      setError(e.message || String(e));
    }
  };

  return (
    <div style={{ padding: '20px 28px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <p style={{ fontSize: 13, color: '#475569', maxWidth: 760 }}>
            Prefix-match templates that tell the planner when to schedule work. First match wins (higher <code>priority</code> beats lower). <b>Deadline offset</b> is how far from <code>bm_deadline</code> the work should land — negative = before (e.g. accounts due 31/12 with offset <code>-6</code> schedules work in the 6th month before, i.e. June). <b>Week</b> picks the Mon–Fri block within that month. Client cadence preference shifts the slot ±1 week.
          </p>
        </div>
        <button onClick={runPlan} disabled={planning || !!editingId} style={{ ...btnSecondary, opacity: (planning || !!editingId) ? 0.6 : 1 }}>
          <Play size={13} /> {planning ? 'Planning…' : 'Plan 9 months'}
        </button>
        <button onClick={startNew} disabled={!!editingId} style={btnPrimary}>
          <Plus size={14} /> New default
        </button>
      </div>

      {error && (
        <div style={banner}>
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {plannerResult && (
        <div style={resultBanner}>
          Planner cycle <code>{plannerResult.cycleId.slice(0, 8)}</code> — scanned {plannerResult.total},
          drafted <b>{plannerResult.planned}</b>,
          skipped {plannerResult.noMatch} (no rule), {plannerResult.noDeadline} (no deadline), {plannerResult.outOfHorizon} (beyond 9mo)
          {plannerResult.skippedNST > 0 ? `, ${plannerResult.skippedNST} (NST — held as quick tasks)` : ''}.
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 13, color: '#94a3b8' }}>Loading…</p>
      ) : (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                <th style={th}>Name</th>
                <th style={th}>Prefix</th>
                <th style={{ ...th, textAlign: 'right' }}>Offset (mo)</th>
                <th style={{ ...th, textAlign: 'right' }}>Week</th>
                <th style={{ ...th, textAlign: 'right' }}>Mins</th>
                <th style={{ ...th, textAlign: 'right' }}>Priority</th>
                <th style={th}>Active</th>
                <th style={{ ...th, width: 120 }}></th>
              </tr>
            </thead>
            <tbody>
              {editingId === 'new' && draft && (
                <EditRow draft={draft} setDraft={setDraft} saving={saving} onSave={save} onCancel={cancelEdit} taskNameSuggestions={taskNameSuggestions} />
              )}
              {defaults.map((d) => (
                editingId === d.id && draft
                  ? <EditRow key={d.id} draft={draft} setDraft={setDraft} saving={saving} onSave={save} onCancel={cancelEdit} taskNameSuggestions={taskNameSuggestions} />
                  : <Row key={d.id} row={d} onEdit={() => startEdit(d)} onDelete={() => remove(d)} disabled={!!editingId} />
              ))}
              {defaults.length === 0 && editingId !== 'new' && (
                <tr><td colSpan={8} style={{ padding: 20, textAlign: 'center', color: '#94a3b8' }}>No defaults yet. Click New default to add one.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Row({ row, onEdit, onDelete, disabled }) {
  return (
    <tr style={{ borderTop: '1px solid #f1f5f9' }}>
      <td style={td}>
        <b>{row.name}</b>
        {row.notes && <div style={{ color: '#94a3b8', fontSize: 11 }}>{row.notes}</div>}
      </td>
      <td style={{ ...td, fontFamily: 'monospace', color: '#475569' }}>{row.task_name_prefix}</td>
      <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }} title="Months from bm_deadline. Negative = before deadline.">
        {row.bm_deadline_offset_months > 0 ? `+${row.bm_deadline_offset_months}` : row.bm_deadline_offset_months}
      </td>
      <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{row.week_of_month === 5 ? 'last' : row.week_of_month}</td>
      <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{Math.round(Number(row.target_hours) * 60)}m</td>
      <td style={{ ...td, textAlign: 'right' }}>
        {(() => {
          const p = priorityLabel(row.match_priority);
          return (
            <span style={{
              fontSize: 11, padding: '2px 8px', borderRadius: 999,
              background: p.bg, color: p.colour, fontWeight: 600,
            }}>{p.label}</span>
          );
        })()}
      </td>
      <td style={td}>
        <span style={{
          fontSize: 11, padding: '2px 8px', borderRadius: 999,
          background: row.is_active ? '#dcfce7' : '#fee2e2',
          color: row.is_active ? '#15803d' : '#991b1b',
        }}>{row.is_active ? 'Active' : 'Off'}</span>
      </td>
      <td style={{ ...td, textAlign: 'right' }}>
        <button onClick={onEdit} disabled={disabled} style={{ ...btnGhost, fontSize: 11, marginRight: 4, opacity: disabled ? 0.5 : 1 }}>Edit</button>
        <button onClick={onDelete} disabled={disabled} style={{ ...btnGhost, fontSize: 11, color: '#991b1b', opacity: disabled ? 0.5 : 1 }}>
          <Trash2 size={11} />
        </button>
      </td>
    </tr>
  );
}

function EditRow({ draft, setDraft, saving, onSave, onCancel, taskNameSuggestions }) {
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));

  const offsetHasPreset = OFFSET_OPTIONS.some((o) => o.value === draft.bm_deadline_offset_months);
  const priorityLevel = priorityLabel(draft.match_priority);

  return (
    <tr style={{ borderTop: '1px solid #f1f5f9', background: '#f0f9ff' }}>
      <td style={td}>
        <input value={draft.name || ''} onChange={(e) => set('name', e.target.value)} placeholder="VAT return" style={inp} />
        <input value={draft.notes || ''} onChange={(e) => set('notes', e.target.value)} placeholder="Notes (optional)" style={{ ...inp, marginTop: 4, fontSize: 11, color: '#94a3b8' }} />
      </td>
      <td style={td}>
        <input
          list="bm-task-name-suggestions"
          value={draft.task_name_prefix || ''}
          onChange={(e) => set('task_name_prefix', e.target.value)}
          placeholder="Start typing — suggestions from BM"
          style={{ ...inp, fontFamily: 'monospace' }}
        />
        <datalist id="bm-task-name-suggestions">
          {taskNameSuggestions.map((n) => <option key={n} value={n} />)}
        </datalist>
      </td>
      <td style={td}>
        <select
          value={offsetHasPreset ? String(draft.bm_deadline_offset_months) : '__custom'}
          onChange={(e) => {
            if (e.target.value === '__custom') return;
            set('bm_deadline_offset_months', parseInt(e.target.value, 10));
          }}
          style={inp}
          title="When to schedule relative to bm_deadline. Negative = before deadline."
        >
          {OFFSET_OPTIONS.map((o) => <option key={o.value} value={String(o.value)}>{o.label}</option>)}
          {!offsetHasPreset && (
            <option value="__custom">Custom: {draft.bm_deadline_offset_months} months</option>
          )}
        </select>
      </td>
      <td style={td}>
        <select value={draft.week_of_month || 2} onChange={(e) => set('week_of_month', parseInt(e.target.value, 10))} style={inp}>
          {WEEK_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </td>
      <td style={td}>
        <input
          type="number"
          step="5"
          min={0}
          value={Math.round((Number(draft.target_hours) || 0) * 60)}
          onChange={(e) => set('target_hours', (parseInt(e.target.value, 10) || 0) / 60)}
          style={{ ...inp, textAlign: 'right', width: 70 }}
          title="Target minutes per instance"
        />
      </td>
      <td style={td}>
        <select
          value={priorityLevel.value}
          onChange={(e) => set('match_priority', parseInt(e.target.value, 10))}
          style={{
            ...inp, fontWeight: 600,
            color: priorityLevel.colour, background: priorityLevel.bg,
          }}
          title="Higher priority defaults match first when multiple prefixes overlap."
        >
          {PRIORITY_LEVELS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
      </td>
      <td style={td}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!draft.is_active} onChange={(e) => set('is_active', e.target.checked)} />
          {draft.is_active ? 'Active' : 'Off'}
        </label>
      </td>
      <td style={{ ...td, textAlign: 'right' }}>
        <button onClick={onSave} disabled={saving} style={{ ...btnPrimary, fontSize: 11, padding: '4px 10px', marginRight: 4, opacity: saving ? 0.5 : 1 }}>
          <Save size={11} /> {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={onCancel} disabled={saving} style={{ ...btnGhost, fontSize: 11 }}>
          <X size={11} />
        </button>
      </td>
    </tr>
  );
}

const th = { textAlign: 'left', padding: '10px 12px', fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' };
const td = { padding: '10px 12px', fontSize: 12, verticalAlign: 'top', color: '#1e293b' };
const inp = { width: '100%', padding: '4px 6px', border: '1px solid #cbd5e1', borderRadius: 4, fontSize: 12, fontFamily: font, background: '#fff' };

const btnPrimary = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  fontSize: 13, fontWeight: 600, padding: '8px 14px',
  background: '#0f172a', border: 'none', borderRadius: 8,
  color: '#fff', cursor: 'pointer', fontFamily: font,
};
const btnSecondary = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  fontSize: 13, fontWeight: 600, padding: '8px 14px',
  background: '#fff', border: '1px solid #cbd5e1', borderRadius: 8,
  color: '#0f172a', cursor: 'pointer', fontFamily: font, marginRight: 8,
};
const resultBanner = {
  padding: '10px 14px', borderRadius: 8,
  background: '#eff6ff', border: '1px solid #bfdbfe',
  color: '#1e3a8a', fontSize: 13, marginBottom: 14,
};
const btnGhost = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '6px 10px', background: 'none', border: 'none',
  color: '#64748b', cursor: 'pointer', fontFamily: font,
};
const banner = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '10px 14px', borderRadius: 8,
  background: '#fee2e2', border: '1px solid #fca5a5',
  color: '#991b1b', fontSize: 13, marginBottom: 14,
};
