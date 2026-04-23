import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Save, X, AlertTriangle } from 'lucide-react';
import { listDefaults, createDefault, updateDefault, deleteDefault } from '../lib/workflowQueries';

const font = "'Outfit', sans-serif";

const CADENCE_OPTIONS = [
  { value: 'monthly',          label: 'Monthly',          hint: 'Repeats every month' },
  { value: 'quarterly',        label: 'Quarterly',        hint: 'Once per quarter — pick which month of the quarter' },
  { value: 'annually',         label: 'Annually',         hint: 'Once per year' },
  { value: 'year_end_offset',  label: 'Year-end offset',  hint: 'N months after client\'s year-end (e.g. accounts = 3)' },
];

const WEEK_OPTIONS = [
  { value: 1, label: '1st week' },
  { value: 2, label: '2nd week' },
  { value: 3, label: '3rd week' },
  { value: 4, label: '4th week' },
  { value: 5, label: 'Last week' },
];

const QUARTER_MONTH_OPTIONS = [
  { value: 0, label: '1st month of quarter' },
  { value: 1, label: '2nd month of quarter' },
  { value: 2, label: '3rd month of quarter' },
];

const EMPTY_DEFAULT = {
  name: '',
  task_name_prefix: '',
  cadence: 'monthly',
  month_offset: null,
  week_of_month: 2,
  target_hours: 1.0,
  match_priority: 100,
  notes: '',
  is_active: true,
};

export default function DefaultsView() {
  const [defaults, setDefaults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      setDefaults(await listDefaults());
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
      const needsMonthOffset = draft.cadence === 'quarterly' || draft.cadence === 'year_end_offset';
      const patch = {
        name: draft.name?.trim() || '',
        task_name_prefix: draft.task_name_prefix?.trim() || '',
        cadence: draft.cadence || 'monthly',
        month_offset: needsMonthOffset
          ? (draft.month_offset === null || draft.month_offset === undefined || draft.month_offset === ''
              ? null
              : parseInt(draft.month_offset, 10))
          : null,
        week_of_month: parseInt(draft.week_of_month, 10) || 2,
        target_hours: parseFloat(draft.target_hours) || 0,
        match_priority: parseInt(draft.match_priority, 10) || 100,
        notes: draft.notes?.trim() || null,
        is_active: !!draft.is_active,
      };
      if (!patch.name) throw new Error('Name is required');
      if (!patch.task_name_prefix) throw new Error('Task name prefix is required');
      if (needsMonthOffset && patch.month_offset === null) {
        throw new Error('Pick a month offset for this cadence');
      }

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
            Prefix-match templates that tell the planner when work should happen. First match wins (higher <code>priority</code> beats lower). Week-of-month is the Mon–Fri block number within the calendar month. Client cadence preference shifts the slot ±1 week.
          </p>
        </div>
        <button onClick={startNew} disabled={!!editingId} style={btnPrimary}>
          <Plus size={14} /> New default
        </button>
      </div>

      {error && (
        <div style={banner}>
          <AlertTriangle size={14} /> {error}
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
                <th style={th}>Cadence</th>
                <th style={{ ...th, textAlign: 'right' }}>Mo offset</th>
                <th style={{ ...th, textAlign: 'right' }}>Week</th>
                <th style={{ ...th, textAlign: 'right' }}>Mins</th>
                <th style={{ ...th, textAlign: 'right' }}>Prio</th>
                <th style={th}>Active</th>
                <th style={{ ...th, width: 120 }}></th>
              </tr>
            </thead>
            <tbody>
              {editingId === 'new' && draft && (
                <EditRow draft={draft} setDraft={setDraft} saving={saving} onSave={save} onCancel={cancelEdit} />
              )}
              {defaults.map((d) => (
                editingId === d.id && draft
                  ? <EditRow key={d.id} draft={draft} setDraft={setDraft} saving={saving} onSave={save} onCancel={cancelEdit} />
                  : <Row key={d.id} row={d} onEdit={() => startEdit(d)} onDelete={() => remove(d)} disabled={!!editingId} />
              ))}
              {defaults.length === 0 && editingId !== 'new' && (
                <tr><td colSpan={9} style={{ padding: 20, textAlign: 'center', color: '#94a3b8' }}>No defaults yet. Click New default to add one.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Row({ row, onEdit, onDelete, disabled }) {
  const cadence = CADENCE_OPTIONS.find((o) => o.value === row.cadence);
  return (
    <tr style={{ borderTop: '1px solid #f1f5f9' }}>
      <td style={td}>
        <b>{row.name}</b>
        {row.notes && <div style={{ color: '#94a3b8', fontSize: 11 }}>{row.notes}</div>}
      </td>
      <td style={{ ...td, fontFamily: 'monospace', color: '#475569' }}>{row.task_name_prefix}</td>
      <td style={td}>{cadence?.label || row.cadence}</td>
      <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{row.month_offset ?? '—'}</td>
      <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{row.week_of_month === 5 ? 'last' : row.week_of_month}</td>
      <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{Math.round(Number(row.target_hours) * 60)}m</td>
      <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{row.match_priority}</td>
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

function EditRow({ draft, setDraft, saving, onSave, onCancel }) {
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const needsMonthOffset = draft.cadence === 'quarterly' || draft.cadence === 'year_end_offset';
  const monthOptions = draft.cadence === 'quarterly' ? QUARTER_MONTH_OPTIONS : null;

  return (
    <tr style={{ borderTop: '1px solid #f1f5f9', background: '#f0f9ff' }}>
      <td style={td}>
        <input value={draft.name || ''} onChange={(e) => set('name', e.target.value)} placeholder="VAT return" style={inp} />
        <input value={draft.notes || ''} onChange={(e) => set('notes', e.target.value)} placeholder="Notes (optional)" style={{ ...inp, marginTop: 4, fontSize: 11, color: '#94a3b8' }} />
      </td>
      <td style={td}>
        <input value={draft.task_name_prefix || ''} onChange={(e) => set('task_name_prefix', e.target.value)} placeholder="VAT Preparation" style={{ ...inp, fontFamily: 'monospace' }} />
      </td>
      <td style={td}>
        <select value={draft.cadence || 'monthly'} onChange={(e) => {
          const next = e.target.value;
          setDraft((d) => ({
            ...d,
            cadence: next,
            month_offset: (next === 'quarterly' || next === 'year_end_offset') ? (d.month_offset ?? 0) : null,
          }));
        }} style={inp} title={CADENCE_OPTIONS.find((o) => o.value === draft.cadence)?.hint}>
          {CADENCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </td>
      <td style={td}>
        {needsMonthOffset ? (
          monthOptions ? (
            <select value={draft.month_offset ?? 0} onChange={(e) => set('month_offset', parseInt(e.target.value, 10))} style={inp}>
              {monthOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : (
            <input
              type="number"
              min={0}
              value={draft.month_offset ?? 0}
              onChange={(e) => set('month_offset', e.target.value === '' ? null : parseInt(e.target.value, 10))}
              placeholder="e.g. 3"
              style={{ ...inp, textAlign: 'right', width: 70 }}
              title="Months after year-end"
            />
          )
        ) : (
          <span style={{ fontSize: 11, color: '#cbd5e1' }}>—</span>
        )}
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
        <input type="number" value={draft.match_priority ?? 100} onChange={(e) => set('match_priority', e.target.value)} style={{ ...inp, textAlign: 'right', width: 60 }} />
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
