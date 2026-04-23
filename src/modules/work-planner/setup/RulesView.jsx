import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Save, X, AlertTriangle, Play, ChevronDown, ChevronRight, UserPlus } from 'lucide-react';
import {
  listRules, createRule, updateRule, deleteRule,
  listStaffProfiles, listEntitiesAll, listDistinctBmTaskNames,
  listClientOverrides, upsertClientOverride, deleteClientOverride,
} from './queries';
import { runPlanner } from './planner';
import ClientTypeAhead from '../components/ClientTypeAhead';

const font = "'Outfit', sans-serif";

const PRIORITY_LEVELS = [
  { value: 200, label: 'High',   colour: '#dc2626', bg: '#fee2e2' },
  { value: 100, label: 'Medium', colour: '#b45309', bg: '#fef3c7' },
  { value: 50,  label: 'Low',    colour: '#475569', bg: '#f1f5f9' },
];
const priorityForValue = (n) => {
  if (n == null) return PRIORITY_LEVELS[1];
  if (n >= 150) return PRIORITY_LEVELS[0];
  if (n >= 75)  return PRIORITY_LEVELS[1];
  return PRIORITY_LEVELS[2];
};

const WEEK_OPTIONS = [
  { value: 1, label: '1st week' },
  { value: 2, label: '2nd week' },
  { value: 3, label: '3rd week' },
  { value: 4, label: '4th week' },
  { value: 5, label: 'Last week' },
];

const OFFSET_PRESETS = [
  { value: -12, label: '-12 months (1 year before)' },
  { value: -9,  label: '-9 months' },
  { value: -6,  label: '-6 months' },
  { value: -3,  label: '-3 months' },
  { value: -2,  label: '-2 months' },
  { value: -1,  label: '-1 month (month before)' },
  { value: 0,   label: '0 — same month as deadline' },
  { value: 1,   label: '+1 month (after)' },
  { value: 2,   label: '+2 months' },
  { value: 3,   label: '+3 months' },
];

const EMPTY_RULE = {
  name: '',
  task_name_prefix: '',
  service: '',
  bm_deadline_offset_months: 0,
  week_of_month: 2,
  target_hours: 1.0,
  assignee_source: 'bm_assignee',
  rule_assignee_id: null,
  match_priority: 100,
  active: true,
  notes: '',
  colour: null,
};

export default function RulesView() {
  const [rules, setRules] = useState([]);
  const [overridesByRule, setOverridesByRule] = useState({});
  const [staff, setStaff] = useState([]);
  const [entities, setEntities] = useState([]);
  const [taskNameSuggestions, setTaskNameSuggestions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [planning, setPlanning] = useState(false);
  const [plannerResult, setPlannerResult] = useState(null);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const [r, s, ents, names, allOverrides] = await Promise.all([
        listRules(), listStaffProfiles(), listEntitiesAll(),
        listDistinctBmTaskNames(), listClientOverrides(),
      ]);
      setRules(r);
      setStaff(s.filter((x) => x.is_active));
      setEntities(ents);
      setTaskNameSuggestions(names);
      const byRule = {};
      for (const o of allOverrides) (byRule[o.rule_id] ||= []).push(o);
      setOverridesByRule(byRule);
    } catch (e) {
      setError(e.message || String(e));
    } finally { setLoading(false); }
  };
  useEffect(() => { reload(); }, []);

  const startEdit = (rule) => { setEditingId(rule.id); setDraft({ ...rule }); };
  const startNew = () => { setEditingId('new'); setDraft({ ...EMPTY_RULE }); };
  const cancelEdit = () => { setEditingId(null); setDraft(null); };

  const save = async () => {
    if (!draft) return;
    setSaving(true); setError(null);
    try {
      const patch = {
        name: draft.name?.trim() || '',
        task_name_prefix: draft.task_name_prefix?.trim() || '',
        service: draft.service?.trim() || '',
        bm_deadline_offset_months: parseInt(draft.bm_deadline_offset_months, 10) || 0,
        week_of_month: parseInt(draft.week_of_month, 10) || 2,
        target_hours: parseFloat(draft.target_hours) || 0,
        assignee_source: draft.assignee_source || 'bm_assignee',
        rule_assignee_id: draft.assignee_source === 'rule_assignee' ? draft.rule_assignee_id : null,
        match_priority: parseInt(draft.match_priority, 10) || 100,
        active: !!draft.active,
        notes: draft.notes?.trim() || null,
        colour: draft.colour || null,
      };
      if (!patch.name) throw new Error('Name is required');
      if (!patch.task_name_prefix) throw new Error('Task name prefix is required');
      if (!patch.service) throw new Error('Service is required');
      if (patch.assignee_source === 'rule_assignee' && !patch.rule_assignee_id) {
        throw new Error('Pick a rule assignee or change Assignee source to BM');
      }
      if (editingId === 'new') await createRule(patch);
      else await updateRule(editingId, patch);
      await reload();
      cancelEdit();
    } catch (e) {
      setError(e.message || String(e));
    } finally { setSaving(false); }
  };

  const remove = async (rule) => {
    if (!confirm(`Delete rule "${rule.name}"? Any client exceptions under it will be removed too.`)) return;
    setError(null);
    try { await deleteRule(rule.id); await reload(); } catch (e) { setError(e.message || String(e)); }
  };

  const runPlan = async () => {
    if (!confirm('Run planner over the next 9 months? Every BM task that matches a rule will be re-placed as a draft. Existing scheduling is superseded.')) return;
    setPlanning(true); setError(null); setPlannerResult(null);
    try { setPlannerResult(await runPlanner({ horizonMonths: 9 })); }
    catch (e) { setError(e.message || String(e)); }
    finally { setPlanning(false); }
  };

  const saveOverride = async (ruleId, entityId, patch) => {
    await upsertClientOverride({ rule_id: ruleId, entity_id: entityId, ...patch });
    await reload();
  };
  const removeOverride = async (ruleId, entityId) => {
    if (!confirm('Remove this client exception? The rule default + cadence will apply again.')) return;
    await deleteClientOverride(ruleId, entityId);
    await reload();
  };

  return (
    <div style={{ padding: '20px 28px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <p style={{ fontSize: 13, color: '#475569', maxWidth: 820 }}>
            Rules define <b>when</b> each task type lands. Match is prefix on <code>bm_task_name</code>, highest priority first. <b>Offset</b> is months from <code>bm_deadline</code> (negative = before). Client cadence on the client record shifts ±1 week. A <b>Client exception</b> overrides both.
          </p>
        </div>
        <button onClick={runPlan} disabled={planning || !!editingId} style={{ ...btnSecondary, opacity: (planning || !!editingId) ? 0.6 : 1 }}>
          <Play size={13} /> {planning ? 'Planning…' : 'Plan 9 months'}
        </button>
        <button onClick={startNew} disabled={!!editingId} style={btnPrimary}>
          <Plus size={14} /> New rule
        </button>
      </div>

      {error && <div style={banner}><AlertTriangle size={14} /> {error}</div>}
      {plannerResult && (
        <div style={resultBanner}>
          Planner cycle <code>{plannerResult.cycleId.slice(0, 8)}</code> — scanned {plannerResult.total},
          drafted <b>{plannerResult.planned}</b> (<b>{plannerResult.overridden}</b> used exceptions),
          skipped {plannerResult.noMatch} (no rule), {plannerResult.noDeadline} (no deadline), {plannerResult.outOfHorizon} (beyond 9mo)
          {plannerResult.skippedNST > 0 ? `, ${plannerResult.skippedNST} NST` : ''}.
        </div>
      )}

      {loading ? <p style={{ fontSize: 13, color: '#94a3b8' }}>Loading…</p> : (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                <th style={{ ...th, width: 26 }}></th>
                <th style={th}>Name</th>
                <th style={{ ...th, width: 50 }}>Colour</th>
                <th style={th}>Service</th>
                <th style={th}>Prefix</th>
                <th style={{ ...th, textAlign: 'right' }}>Offset</th>
                <th style={{ ...th, textAlign: 'right' }}>Week</th>
                <th style={{ ...th, textAlign: 'right' }}>Mins</th>
                <th style={th}>Assignee</th>
                <th style={{ ...th, textAlign: 'right' }}>Priority</th>
                <th style={th}>Active</th>
                <th style={{ ...th, width: 120 }}></th>
              </tr>
            </thead>
            <tbody>
              {editingId === 'new' && draft && (
                <EditRow draft={draft} setDraft={setDraft} saving={saving} onSave={save} onCancel={cancelEdit} staff={staff} taskNameSuggestions={taskNameSuggestions} />
              )}
              {rules.map((rule) => {
                const overrides = overridesByRule[rule.id] || [];
                const isExpanded = expandedId === rule.id;
                if (editingId === rule.id && draft) {
                  return <EditRow key={rule.id} draft={draft} setDraft={setDraft} saving={saving} onSave={save} onCancel={cancelEdit} staff={staff} taskNameSuggestions={taskNameSuggestions} />;
                }
                return (
                  <React.Fragment key={rule.id}>
                    <Row rule={rule} overrideCount={overrides.length} expanded={isExpanded}
                      onToggle={() => setExpandedId(isExpanded ? null : rule.id)}
                      onEdit={() => startEdit(rule)} onDelete={() => remove(rule)} disabled={!!editingId} />
                    {isExpanded && (
                      <OverridesPanel rule={rule} overrides={overrides} entities={entities}
                        onSave={(entityId, patch) => saveOverride(rule.id, entityId, patch)}
                        onDelete={(entityId) => removeOverride(rule.id, entityId)} />
                    )}
                  </React.Fragment>
                );
              })}
              {rules.length === 0 && editingId !== 'new' && (
                <tr><td colSpan={12} style={{ padding: 20, textAlign: 'center', color: '#94a3b8' }}>No rules yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Row({ rule, overrideCount, expanded, onToggle, onEdit, onDelete, disabled }) {
  const p = priorityForValue(rule.match_priority);
  const offset = rule.bm_deadline_offset_months;
  return (
    <tr style={{ borderTop: '1px solid #f1f5f9' }}>
      <td style={{ ...td, textAlign: 'center', cursor: 'pointer' }} onClick={onToggle} title={expanded ? 'Hide exceptions' : 'Show exceptions'}>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </td>
      <td style={td}>
        <b>{rule.name}</b>
        {overrideCount > 0 && (
          <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 7px', borderRadius: 999, background: '#eff6ff', color: '#1e3a8a' }}>
            {overrideCount} exception{overrideCount === 1 ? '' : 's'}
          </span>
        )}
        {rule.notes && <div style={{ color: '#94a3b8', fontSize: 11 }}>{rule.notes}</div>}
      </td>
      <td style={{ ...td, textAlign: 'center' }}>
        <div style={{
          display: 'inline-block', width: 22, height: 22, borderRadius: 6,
          background: rule.colour || '#e5e7eb',
          border: rule.colour ? 'none' : '1px dashed #cbd5e1',
        }} title={rule.colour || 'No colour set'} />
      </td>
      <td style={td}>{rule.service}</td>
      <td style={{ ...td, fontFamily: 'monospace', color: '#475569' }}>{rule.task_name_prefix}</td>
      <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{offset > 0 ? `+${offset}` : offset}m</td>
      <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{rule.week_of_month === 5 ? 'last' : rule.week_of_month}</td>
      <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{Math.round(Number(rule.target_hours) * 60)}m</td>
      <td style={td}>{rule.assignee_source === 'rule_assignee' ? 'Rule-pinned' : 'BM'}</td>
      <td style={{ ...td, textAlign: 'right' }}>
        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: p.bg, color: p.colour, fontWeight: 600 }}>{p.label}</span>
      </td>
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

function EditRow({ draft, setDraft, saving, onSave, onCancel, staff, taskNameSuggestions }) {
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const offsetHasPreset = OFFSET_PRESETS.some((o) => o.value === draft.bm_deadline_offset_months);
  const p = priorityForValue(draft.match_priority);
  return (
    <tr style={{ borderTop: '1px solid #f1f5f9', background: '#f0f9ff' }}>
      <td style={td}></td>
      <td style={td}>
        <input value={draft.name || ''} onChange={(e) => set('name', e.target.value)} placeholder="VAT return" style={inp} />
        <input value={draft.notes || ''} onChange={(e) => set('notes', e.target.value)} placeholder="Notes (optional)" style={{ ...inp, marginTop: 4, fontSize: 11, color: '#94a3b8' }} />
      </td>
      <td style={{ ...td, textAlign: 'center' }}>
        <input
          type="color"
          value={draft.colour || '#e5e7eb'}
          onChange={(e) => set('colour', e.target.value)}
          style={{ width: 28, height: 28, border: '1px solid #cbd5e1', borderRadius: 6, padding: 0, cursor: 'pointer', background: 'none' }}
          title="Task type colour for Waiting bars"
        />
        {draft.colour && (
          <div>
            <button
              type="button"
              onClick={() => set('colour', null)}
              style={{ ...btnGhost, fontSize: 9, padding: '1px 4px' }}
              title="Clear colour"
            >clear</button>
          </div>
        )}
      </td>
      <td style={td}>
        <input value={draft.service || ''} onChange={(e) => set('service', e.target.value)} placeholder="VAT" style={inp} />
      </td>
      <td style={td}>
        <input list="rulesview-bmtask-suggestions" value={draft.task_name_prefix || ''}
          onChange={(e) => set('task_name_prefix', e.target.value)}
          placeholder="Start typing…" style={{ ...inp, fontFamily: 'monospace' }} />
        <datalist id="rulesview-bmtask-suggestions">
          {taskNameSuggestions.map((n) => <option key={n} value={n} />)}
        </datalist>
      </td>
      <td style={td}>
        <select value={offsetHasPreset ? String(draft.bm_deadline_offset_months) : '__custom'}
          onChange={(e) => { if (e.target.value !== '__custom') set('bm_deadline_offset_months', parseInt(e.target.value, 10)); }}
          style={inp}>
          {OFFSET_PRESETS.map((o) => <option key={o.value} value={String(o.value)}>{o.label}</option>)}
          {!offsetHasPreset && <option value="__custom">Custom: {draft.bm_deadline_offset_months}m</option>}
        </select>
      </td>
      <td style={td}>
        <select value={draft.week_of_month || 2} onChange={(e) => set('week_of_month', parseInt(e.target.value, 10))} style={inp}>
          {WEEK_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </td>
      <td style={td}>
        <input type="number" step="5" min={0}
          value={Math.round((Number(draft.target_hours) || 0) * 60)}
          onChange={(e) => set('target_hours', (parseInt(e.target.value, 10) || 0) / 60)}
          style={{ ...inp, textAlign: 'right', width: 70 }} />
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
        <select value={p.value} onChange={(e) => set('match_priority', parseInt(e.target.value, 10))}
          style={{ ...inp, fontWeight: 600, color: p.colour, background: p.bg }}>
          {PRIORITY_LEVELS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
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

function OverridesPanel({ rule, overrides, entities, onSave, onDelete }) {
  const [adding, setAdding] = useState(false);
  const [newEntityId, setNewEntityId] = useState('');
  const [draft, setDraft] = useState({ bm_deadline_offset_months: null, week_of_month: null, target_hours: null, notes: '' });

  const save = async () => {
    if (!newEntityId) return;
    await onSave(newEntityId, draft);
    setAdding(false); setNewEntityId('');
    setDraft({ bm_deadline_offset_months: null, week_of_month: null, target_hours: null, notes: '' });
  };

  return (
    <tr style={{ background: '#fafafa' }}>
      <td></td>
      <td colSpan={11} style={{ padding: '10px 14px', borderTop: '1px dashed #e5e7eb' }}>
        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 8 }}>
          Client exceptions — override the rule for specific clients. Blank fields inherit from the rule.
        </div>
        {overrides.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 8 }}>
            <thead>
              <tr>
                <th style={ovTh}>Client</th>
                <th style={{ ...ovTh, textAlign: 'right' }}>Offset</th>
                <th style={{ ...ovTh, textAlign: 'right' }}>Week</th>
                <th style={{ ...ovTh, textAlign: 'right' }}>Mins</th>
                <th style={ovTh}>Notes</th>
                <th style={{ ...ovTh, width: 60 }}></th>
              </tr>
            </thead>
            <tbody>
              {overrides.map((o) => (
                <tr key={o.entity_id} style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={ovTd}>{o.entities?.name || o.entity_id.slice(0,8)}</td>
                  <td style={{ ...ovTd, textAlign: 'right', fontFamily: 'monospace' }}>{o.bm_deadline_offset_months ?? <span style={{ color: '#cbd5e1' }}>—</span>}</td>
                  <td style={{ ...ovTd, textAlign: 'right', fontFamily: 'monospace' }}>{o.week_of_month ?? <span style={{ color: '#cbd5e1' }}>—</span>}</td>
                  <td style={{ ...ovTd, textAlign: 'right', fontFamily: 'monospace' }}>{o.target_hours != null ? Math.round(Number(o.target_hours) * 60) + 'm' : <span style={{ color: '#cbd5e1' }}>—</span>}</td>
                  <td style={{ ...ovTd, color: '#64748b' }}>{o.notes}</td>
                  <td style={{ ...ovTd, textAlign: 'right' }}>
                    <button onClick={() => onDelete(o.entity_id)} style={{ ...btnGhost, fontSize: 11, color: '#991b1b' }}>
                      <Trash2 size={11} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {adding ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 220 }}>
              <ClientTypeAhead entityList={entities} value={newEntityId} onChange={setNewEntityId} onAddNew={() => Promise.resolve(null)} />
            </div>
            <input type="number" step={1} placeholder={`Inherit (${rule.bm_deadline_offset_months}m)`}
              value={draft.bm_deadline_offset_months ?? ''}
              onChange={(e) => setDraft({ ...draft, bm_deadline_offset_months: e.target.value === '' ? null : parseInt(e.target.value, 10) })}
              style={{ ...inp, width: 130, textAlign: 'right' }} />
            <select value={draft.week_of_month ?? ''}
              onChange={(e) => setDraft({ ...draft, week_of_month: e.target.value === '' ? null : parseInt(e.target.value, 10) })}
              style={{ ...inp, width: 130 }}>
              <option value="">— inherit week —</option>
              {WEEK_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <input type="number" step={5} placeholder="Mins"
              value={draft.target_hours != null ? Math.round(Number(draft.target_hours) * 60) : ''}
              onChange={(e) => setDraft({ ...draft, target_hours: e.target.value === '' ? null : (parseInt(e.target.value, 10) || 0) / 60 })}
              style={{ ...inp, width: 80, textAlign: 'right' }} />
            <input placeholder="Notes" value={draft.notes || ''}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              style={{ ...inp, flex: 1, minWidth: 120 }} />
            <button onClick={save} disabled={!newEntityId} style={{ ...btnPrimary, fontSize: 11, padding: '4px 10px' }}>Save</button>
            <button onClick={() => { setAdding(false); setNewEntityId(''); }} style={{ ...btnGhost, fontSize: 11 }}>Cancel</button>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} style={{ ...btnGhost, fontSize: 11 }}>
            <UserPlus size={12} /> Add client exception
          </button>
        )}
      </td>
    </tr>
  );
}

const th = { textAlign: 'left', padding: '10px 12px', fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' };
const td = { padding: '10px 12px', fontSize: 12, verticalAlign: 'top', color: '#1e293b' };
const ovTh = { textAlign: 'left', padding: '4px 8px', fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' };
const ovTd = { padding: '5px 8px', fontSize: 12, color: '#1e293b' };
const inp = { padding: '4px 6px', border: '1px solid #cbd5e1', borderRadius: 4, fontSize: 12, fontFamily: font, background: '#fff' };

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
  color: '#0f172a', cursor: 'pointer', fontFamily: font,
};
const btnGhost = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '4px 8px', background: 'none', border: 'none',
  color: '#64748b', cursor: 'pointer', fontFamily: font,
};
const banner = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '10px 14px', borderRadius: 8,
  background: '#fee2e2', border: '1px solid #fca5a5',
  color: '#991b1b', fontSize: 13, marginBottom: 14,
};
const resultBanner = {
  padding: '10px 14px', borderRadius: 8,
  background: '#eff6ff', border: '1px solid #bfdbfe',
  color: '#1e3a8a', fontSize: 13, marginBottom: 14,
};
