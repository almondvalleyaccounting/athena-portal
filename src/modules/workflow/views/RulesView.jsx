import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Save, X, AlertTriangle } from 'lucide-react';
import { listRules, createRule, updateRule, deleteRule, listStaffProfiles } from '../lib/workflowQueries';

const font = "'Outfit', sans-serif";

const DOW_OPTIONS = [
  { value: '', label: 'Any' },
  { value: 'mon', label: 'Mon' },
  { value: 'tue', label: 'Tue' },
  { value: 'wed', label: 'Wed' },
  { value: 'thu', label: 'Thu' },
  { value: 'fri', label: 'Fri' },
];

const WEEK_OPTIONS = [
  { value: '', label: 'Any' },
  { value: '1', label: '1st' },
  { value: '2', label: '2nd' },
  { value: '3', label: '3rd' },
  { value: '4', label: '4th' },
  { value: '5', label: 'Last' },
];

const EMPTY_RULE = {
  name: '',
  task_name_prefix: '',
  service: '',
  lead_time_days: 14,
  standard_hours: 1.0,
  preferred_dow: null,
  preferred_week_of_month: null,
  assignee_source: 'bm_assignee',
  rule_assignee_id: null,
  match_priority: 100,
  active: true,
  notes: '',
};

export default function RulesView() {
  const [rules, setRules] = useState([]);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const [r, s] = await Promise.all([listRules(), listStaffProfiles()]);
      setRules(r);
      setStaff(s.filter((x) => x.is_active));
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  const startEdit = (rule) => {
    setEditingId(rule.id);
    setDraft({ ...rule });
  };

  const startNew = () => {
    setEditingId('new');
    setDraft({ ...EMPTY_RULE });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft(null);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const patch = {
        name: draft.name?.trim() || '',
        task_name_prefix: draft.task_name_prefix?.trim() || '',
        service: draft.service?.trim() || '',
        lead_time_days: parseInt(draft.lead_time_days, 10) || 0,
        standard_hours: parseFloat(draft.standard_hours) || 0,
        preferred_dow: draft.preferred_dow || null,
        preferred_week_of_month: draft.preferred_week_of_month ? parseInt(draft.preferred_week_of_month, 10) : null,
        assignee_source: draft.assignee_source || 'bm_assignee',
        rule_assignee_id: draft.assignee_source === 'rule_assignee' ? draft.rule_assignee_id : null,
        match_priority: parseInt(draft.match_priority, 10) || 100,
        active: !!draft.active,
        notes: draft.notes || null,
      };
      if (!patch.name) throw new Error('Name is required');
      if (!patch.task_name_prefix) throw new Error('Task name prefix is required');
      if (!patch.service) throw new Error('Service is required');
      if (patch.assignee_source === 'rule_assignee' && !patch.rule_assignee_id) {
        throw new Error('Pick a rule assignee or change Assignee source to "BM"');
      }

      if (editingId === 'new') {
        await createRule(patch);
      } else {
        await updateRule(editingId, patch);
      }
      await reload();
      cancelEdit();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (rule) => {
    if (!confirm(`Delete rule "${rule.name}"? This will unlink ${rule.bm_task_count ?? 'any'} scheduled tasks from this rule (tasks remain, but will need re-matching on next import).`)) return;
    setError(null);
    try {
      await deleteRule(rule.id);
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
            Prefix-match rules that classify BM tasks on import. First match wins (higher <code>priority</code> beats lower; ties broken by longer prefix). Tasks with no matching rule surface in the Reconciliation inbox as <code>no_rule_match</code>.
          </p>
        </div>
        <button onClick={startNew} disabled={!!editingId} style={btnPrimary}>
          <Plus size={14} /> New rule
        </button>
      </div>

      {error && (
        <div style={banner('red')}>
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
                <th style={th}>Service</th>
                <th style={{ ...th, textAlign: 'right' }}>Lead (d)</th>
                <th style={{ ...th, textAlign: 'right' }}>Hrs</th>
                <th style={th}>DOW</th>
                <th style={th}>Wk</th>
                <th style={th}>Assignee</th>
                <th style={{ ...th, textAlign: 'right' }}>Prio</th>
                <th style={th}>Active</th>
                <th style={{ ...th, width: 120 }}></th>
              </tr>
            </thead>
            <tbody>
              {editingId === 'new' && draft && (
                <RuleEditRow
                  draft={draft}
                  setDraft={setDraft}
                  staff={staff}
                  saving={saving}
                  onSave={save}
                  onCancel={cancelEdit}
                />
              )}
              {rules.map((rule) => (
                editingId === rule.id && draft
                  ? <RuleEditRow
                      key={rule.id}
                      draft={draft}
                      setDraft={setDraft}
                      staff={staff}
                      saving={saving}
                      onSave={save}
                      onCancel={cancelEdit}
                    />
                  : <RuleRow
                      key={rule.id}
                      rule={rule}
                      onEdit={() => startEdit(rule)}
                      onDelete={() => remove(rule)}
                      disabled={!!editingId}
                    />
              ))}
              {rules.length === 0 && editingId !== 'new' && (
                <tr><td colSpan={11} style={{ padding: 20, textAlign: 'center', color: '#94a3b8' }}>No rules yet. Click New rule to add one.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RuleRow({ rule, onEdit, onDelete, disabled }) {
  return (
    <tr style={{ borderTop: '1px solid #f1f5f9' }}>
      <td style={td}><b>{rule.name}</b>{rule.notes && <div style={{ color: '#94a3b8', fontSize: 11 }}>{rule.notes}</div>}</td>
      <td style={{ ...td, fontFamily: 'monospace', color: '#475569' }}>{rule.task_name_prefix}</td>
      <td style={td}>{rule.service}</td>
      <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{rule.lead_time_days}</td>
      <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{Number(rule.standard_hours).toFixed(2)}</td>
      <td style={td}>{rule.preferred_dow ? rule.preferred_dow.toUpperCase() : '—'}</td>
      <td style={td}>{rule.preferred_week_of_month || '—'}</td>
      <td style={td}>{rule.assignee_source === 'rule_assignee' ? 'Rule-pinned' : 'BM'}</td>
      <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{rule.match_priority}</td>
      <td style={td}>
        <span style={{
          fontSize: 11, padding: '2px 8px', borderRadius: 999,
          background: rule.active ? '#dcfce7' : '#fee2e2',
          color: rule.active ? '#15803d' : '#991b1b',
        }}>{rule.active ? 'Active' : 'Off'}</span>
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

function RuleEditRow({ draft, setDraft, staff, saving, onSave, onCancel }) {
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  return (
    <tr style={{ borderTop: '1px solid #f1f5f9', background: '#f0f9ff' }}>
      <td style={td}>
        <input value={draft.name || ''} onChange={(e) => set('name', e.target.value)} placeholder="VAT Preparation" style={inp} />
        <input value={draft.notes || ''} onChange={(e) => set('notes', e.target.value)} placeholder="Notes (optional)" style={{ ...inp, marginTop: 4, fontSize: 11, color: '#94a3b8' }} />
      </td>
      <td style={td}>
        <input value={draft.task_name_prefix || ''} onChange={(e) => set('task_name_prefix', e.target.value)} placeholder="VAT Preparation" style={{ ...inp, fontFamily: 'monospace' }} />
      </td>
      <td style={td}>
        <input value={draft.service || ''} onChange={(e) => set('service', e.target.value)} placeholder="VAT" style={inp} />
      </td>
      <td style={td}>
        <input type="number" value={draft.lead_time_days ?? 0} onChange={(e) => set('lead_time_days', e.target.value)} style={{ ...inp, textAlign: 'right', width: 60 }} />
      </td>
      <td style={td}>
        <input type="number" step="0.25" value={draft.standard_hours ?? 0} onChange={(e) => set('standard_hours', e.target.value)} style={{ ...inp, textAlign: 'right', width: 60 }} />
      </td>
      <td style={td}>
        <select value={draft.preferred_dow || ''} onChange={(e) => set('preferred_dow', e.target.value || null)} style={inp}>
          {DOW_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </td>
      <td style={td}>
        <select value={draft.preferred_week_of_month || ''} onChange={(e) => set('preferred_week_of_month', e.target.value || null)} style={inp}>
          {WEEK_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </td>
      <td style={td}>
        <select value={draft.assignee_source || 'bm_assignee'} onChange={(e) => set('assignee_source', e.target.value)} style={inp}>
          <option value="bm_assignee">BM</option>
          <option value="rule_assignee">Rule-pinned</option>
        </select>
        {draft.assignee_source === 'rule_assignee' && (
          <select value={draft.rule_assignee_id || ''} onChange={(e) => set('rule_assignee_id', e.target.value || null)} style={{ ...inp, marginTop: 4 }}>
            <option value="">— pick —</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
      </td>
      <td style={td}>
        <input type="number" value={draft.match_priority ?? 100} onChange={(e) => set('match_priority', e.target.value)} style={{ ...inp, textAlign: 'right', width: 60 }} />
      </td>
      <td style={td}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!draft.active} onChange={(e) => set('active', e.target.checked)} />
          {draft.active ? 'Active' : 'Off'}
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
function banner(tone) {
  const tones = {
    red: { bg: '#fee2e2', border: '#fca5a5', color: '#991b1b' },
  };
  const t = tones[tone] || tones.red;
  return {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '10px 14px', borderRadius: 8,
    background: t.bg, border: `1px solid ${t.border}`,
    color: t.color, fontSize: 13, marginBottom: 14,
  };
}
