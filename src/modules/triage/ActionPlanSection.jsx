import React, { useState } from 'react';
import { X, ChevronDown, Plus, Wand2 } from 'lucide-react';
import { useAuth } from '../../shell/AppShell';
import {
  font, btn, smallInput, fieldLabel,
  ACTION_TYPES, ACTION_TYPE_MAP, ACTION_STATUS,
  addDaysStr, isOpenAction, isOverdueAction, fmtDate, fmtDateShort,
} from './triageShared';

/*
  Action plan for a triage case: typed actions (email / call / meeting / other)
  with an assignee, target date and status. Templates insert several planned
  actions at once with dates offset from today. Designed so future automation
  (email templates, diary invites) can pick actions up by type + template_id.
*/

const STATUS_CYCLE = { not_started: 'in_progress', in_progress: 'done', done: 'not_started', cancelled: 'not_started' };

export default function ActionPlanSection({ c, actions, staffList, staffMap, templates, onAddActions, onPatchAction, onPatchCase }) {
  const { profile } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dType, setDType] = useState('email');
  const [dTitle, setDTitle] = useState('');
  const [dAssignee, setDAssignee] = useState(profile?.id || '');
  const [dDate, setDDate] = useState('');

  const maxSort = actions.reduce((m, a) => Math.max(m, a.sort ?? 0), 0);

  function addManual() {
    const title = dTitle.trim();
    if (!title) return;
    onAddActions([{
      action_type: dType, title, assigned_to: dAssignee || null,
      target_date: dDate || null, sort: maxSort + 1,
    }]);
    setDTitle(''); setDDate('');
  }

  function applyTemplate(t) {
    setMenuOpen(false);
    const steps = [...(t.steps || [])].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
    if (!steps.length) { window.alert(`"${t.name}" has no steps yet — add some under Manage templates.`); return; }
    if (!window.confirm(`Add ${steps.length} planned action${steps.length === 1 ? '' : 's'} from "${t.name}"?`)) return;
    onAddActions(steps.map((s, i) => ({
      action_type: s.action_type, title: s.title,
      assigned_to: s.default_assignee_id || profile?.id || null,
      target_date: addDaysStr(s.offset_days || 0),
      template_id: t.id, sort: maxSort + (s.sort ?? i + 1),
    })));
  }

  function cycleStatus(a) {
    const next = STATUS_CYCLE[a.status] || 'not_started';
    const patch = { status: next };
    if (next === 'done') {
      patch.completed_at = new Date().toISOString();
      patch.completed_by = profile?.id || null;
    } else {
      patch.completed_at = null;
      patch.completed_by = null;
    }
    onPatchAction(a.id, patch);
  }

  function cancelAction(a) {
    onPatchAction(a.id, { status: 'cancelled', completed_at: null, completed_by: null });
  }

  function convertLegacy() {
    onAddActions([{
      action_type: 'other', title: c.next_action,
      assigned_to: profile?.id || null, target_date: c.target_date || null, sort: maxSort + 1,
    }]);
    onPatchCase({ next_action: null });
  }

  const doneCount = actions.filter((a) => a.status === 'done').length;
  const activeCount = actions.filter((a) => a.status !== 'cancelled').length;

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.4 }}>
          Action plan
        </span>
        {activeCount > 0 && (
          <span style={{ fontSize: 11, color: '#94a3b8' }}>{doneCount}/{activeCount} done</span>
        )}
        <div style={{ marginLeft: 'auto', position: 'relative' }}>
          <button onClick={() => setMenuOpen((v) => !v)} style={{ ...btn('ghost'), padding: '5px 9px', fontSize: 12 }}>
            <Wand2 size={12} color="#0e7fe0" /> Apply template <ChevronDown size={12} />
          </button>
          {menuOpen && (
            <>
              <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 20 }} />
              <div style={{
                position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 21, minWidth: 240,
                background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
                boxShadow: '0 12px 32px rgba(15,23,42,0.14)', padding: 4,
              }}>
                {templates.length === 0 && (
                  <div style={{ fontSize: 12, color: '#94a3b8', padding: '8px 10px' }}>No active templates.</div>
                )}
                {templates.map((t) => (
                  <button key={t.id} onClick={() => applyTemplate(t)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px',
                      background: 'none', border: 'none', borderRadius: 7, cursor: 'pointer', fontFamily: font,
                    }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: '#0f172a' }}>{t.name}</div>
                    <div style={{ fontSize: 11, color: '#94a3b8' }}>
                      {(t.steps || []).length} step{(t.steps || []).length === 1 ? '' : 's'}
                      {t.description ? ` · ${t.description}` : ''}
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {c.next_action && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', marginBottom: 8,
          background: '#f8fafc', border: '1px dashed #e2e8f0', borderRadius: 8,
        }}>
          <span style={{ fontSize: 12, color: '#94a3b8', flex: 1, minWidth: 0 }}>
            Legacy next action: <span style={{ color: '#64748b' }}>{c.next_action}</span>
          </span>
          <button onClick={convertLegacy} style={{
            background: 'none', border: 'none', color: '#0e7fe0', fontSize: 11.5, fontWeight: 600,
            fontFamily: font, cursor: 'pointer', padding: 0, whiteSpace: 'nowrap',
          }}>
            Convert to action
          </button>
        </div>
      )}

      {actions.length === 0 && !c.next_action && (
        <div style={{ fontSize: 12.5, color: '#94a3b8', marginBottom: 8 }}>
          No planned actions yet — add one below or apply a template.
        </div>
      )}

      {actions.map((a) => {
        const type = ACTION_TYPE_MAP[a.action_type] || ACTION_TYPE_MAP.other;
        const TIcon = type.icon;
        const sm = ACTION_STATUS[a.status] || ACTION_STATUS.not_started;
        const open = isOpenAction(a);
        const overdue = isOverdueAction(a);
        return (
          <div key={a.id} style={{
            border: `1px solid ${overdue ? '#fecaca' : '#f1f5f9'}`, borderRadius: 8, padding: '7px 9px', marginBottom: 6,
            background: a.status === 'cancelled' ? '#f8fafc' : '#fff',
            opacity: a.status === 'cancelled' ? 0.6 : 1,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span title={type.label} style={{ display: 'flex', flexShrink: 0 }}>
                <TIcon size={13} color={overdue ? '#dc2626' : '#64748b'} />
              </span>
              <span style={{
                fontSize: 12.5, fontWeight: 600, color: '#0f172a', flex: 1, minWidth: 0,
                textDecoration: a.status === 'cancelled' ? 'line-through' : 'none',
              }}>
                {a.title}
              </span>
              <button onClick={() => cycleStatus(a)} title="Click to change status" style={{
                fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, cursor: 'pointer',
                fontFamily: font, background: sm.bg, color: sm.fg, border: `1px solid ${sm.border}`,
                whiteSpace: 'nowrap', flexShrink: 0,
              }}>
                {sm.label}
              </button>
              {open && (
                <button onClick={() => cancelAction(a)} title="Cancel this action" style={{
                  background: 'none', border: 'none', color: '#cbd5e1', cursor: 'pointer', display: 'flex', padding: 0,
                }}>
                  <X size={13} />
                </button>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, paddingLeft: 20 }}>
              {open ? (
                <>
                  <select value={a.assigned_to || ''} onChange={(e) => onPatchAction(a.id, { assigned_to: e.target.value || null })}
                    style={{ ...smallInput, width: 122 }}>
                    <option value="">Unassigned</option>
                    {staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <input type="date" value={a.target_date || ''}
                    onChange={(e) => onPatchAction(a.id, { target_date: e.target.value || null })}
                    style={{ ...smallInput, width: 128, color: overdue ? '#dc2626' : '#0f172a', borderColor: overdue ? '#fecaca' : '#cbd5e1' }} />
                  {overdue && <span style={{ fontSize: 11, fontWeight: 600, color: '#dc2626' }}>overdue</span>}
                </>
              ) : (
                <span style={{ fontSize: 11.5, color: '#94a3b8' }}>
                  {a.assigned_to ? (staffMap[a.assigned_to] || 'staff') : 'Unassigned'}
                  {a.target_date ? ` · ${fmtDateShort(a.target_date)}` : ''}
                  {a.status === 'done' && a.completed_at
                    ? ` · done ${fmtDate(a.completed_at)}${a.completed_by ? ` by ${staffMap[a.completed_by] || 'staff'}` : ''}`
                    : ''}
                </span>
              )}
            </div>
          </div>
        );
      })}

      <div style={{ border: '1px dashed #e2e8f0', borderRadius: 8, padding: '8px 9px', marginTop: 8 }}>
        <label style={{ ...fieldLabel, fontSize: 11, color: '#94a3b8' }}>Add an action</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <select value={dType} onChange={(e) => setDType(e.target.value)} style={{ ...smallInput, width: 88 }}>
            {ACTION_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          <input value={dTitle} onChange={(e) => setDTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addManual(); }}
            placeholder="What needs doing?"
            style={{ ...smallInput, flex: 1, width: 'auto', minWidth: 0 }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
          <select value={dAssignee} onChange={(e) => setDAssignee(e.target.value)} style={{ ...smallInput, width: 122 }}>
            <option value="">Unassigned</option>
            {staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input type="date" value={dDate} onChange={(e) => setDDate(e.target.value)} style={{ ...smallInput, width: 128 }} />
          <button onClick={addManual} disabled={!dTitle.trim()}
            style={{ ...btn('primary'), padding: '5px 10px', fontSize: 12, marginLeft: 'auto', opacity: dTitle.trim() ? 1 : 0.5 }}>
            <Plus size={12} /> Add
          </button>
        </div>
      </div>
    </div>
  );
}
