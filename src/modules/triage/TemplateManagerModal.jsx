import React, { useState } from 'react';
import { X, Plus, ChevronDown, ChevronRight, Trash2, ListChecks } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import { font, btn, backdrop, modal, fieldLabel, input, smallInput, ACTION_TYPES } from './triageShared';

/*
  Admin-ish editor for triage action-plan templates. A template is a named
  list of steps (type, title, offset in days, default assignee); applying it
  to a case creates one planned action per step.
*/

export default function TemplateManagerModal({ templates, staffList, onClose, onReload }) {
  const { profile } = useAuth();
  const [expandedId, setExpandedId] = useState(null);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function run(fn) {
    setError(null);
    try {
      await fn();
      await onReload();
    } catch (e) { setError(e.message); }
  }

  async function createTemplate() {
    const name = newName.trim();
    if (!name || saving) return;
    setSaving(true);
    await run(async () => {
      const { data, error: err } = await supabase.from('triage_action_templates')
        .insert({ name, description: newDesc.trim() || null, active: true, created_by: profile?.id || null })
        .select('id').single();
      if (err) throw err;
      setNewName(''); setNewDesc('');
      if (data) setExpandedId(data.id);
    });
    setSaving(false);
  }

  async function patchTemplate(id, patch) {
    await run(async () => {
      const { error: err } = await supabase.from('triage_action_templates').update(patch).eq('id', id);
      if (err) throw err;
    });
  }

  async function addStep(t) {
    const maxSort = (t.steps || []).reduce((m, s) => Math.max(m, s.sort ?? 0), 0);
    await run(async () => {
      const { error: err } = await supabase.from('triage_action_template_steps').insert({
        template_id: t.id, sort: maxSort + 1, action_type: 'email', title: 'New step', offset_days: 0,
      });
      if (err) throw err;
    });
  }

  async function patchStep(id, patch) {
    await run(async () => {
      const { error: err } = await supabase.from('triage_action_template_steps').update(patch).eq('id', id);
      if (err) throw err;
    });
  }

  async function deleteStep(id) {
    await run(async () => {
      const { error: err } = await supabase.from('triage_action_template_steps').delete().eq('id', id);
      if (err) throw err;
    });
  }

  return (
    <div onClick={onClose} style={backdrop}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ ...modal, width: 660, maxWidth: '94vw', maxHeight: '84vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <ListChecks size={16} color="#0e7fe0" />
          <span style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', flex: 1 }}>Action plan templates</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', display: 'flex' }}>
            <X size={17} />
          </button>
        </div>
        <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 12px' }}>
          Applying a template to a case adds one planned action per step, with the target date
          offset from the day it's applied and the step's default assignee (or whoever applies it).
        </p>
        {error && <div style={{ fontSize: 12.5, color: '#b91c1c', marginBottom: 8 }}>{error}</div>}

        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {templates.length === 0 && (
            <div style={{ fontSize: 12.5, color: '#94a3b8', padding: '10px 0' }}>No templates yet — create one below.</div>
          )}
          {templates.map((t) => {
            const expanded = expandedId === t.id;
            const steps = [...(t.steps || [])].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
            return (
              <div key={t.id} style={{
                border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 8,
                opacity: t.active ? 1 : 0.6, background: t.active ? '#fff' : '#f8fafc',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px' }}>
                  <button onClick={() => setExpandedId(expanded ? null : t.id)}
                    style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', display: 'flex', padding: 0 }}>
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <input defaultValue={t.name}
                      onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== t.name) patchTemplate(t.id, { name: v }); }}
                      style={{
                        border: 'none', outline: 'none', background: 'transparent', fontFamily: font,
                        fontSize: 13.5, fontWeight: 600, color: '#0f172a', width: '100%', padding: 0,
                      }} />
                    <input defaultValue={t.description || ''} placeholder="Description (optional)"
                      onBlur={(e) => { const v = e.target.value.trim(); if (v !== (t.description || '')) patchTemplate(t.id, { description: v || null }); }}
                      style={{
                        border: 'none', outline: 'none', background: 'transparent', fontFamily: font,
                        fontSize: 11.5, color: '#94a3b8', width: '100%', padding: 0,
                      }} />
                  </div>
                  <span style={{ fontSize: 11, color: '#94a3b8', whiteSpace: 'nowrap' }}>
                    {steps.length} step{steps.length === 1 ? '' : 's'}
                  </span>
                  <button onClick={() => patchTemplate(t.id, { active: !t.active })}
                    style={{
                      fontSize: 10.5, fontWeight: 700, padding: '2px 9px', borderRadius: 999, cursor: 'pointer', fontFamily: font,
                      background: t.active ? '#f0fdf4' : '#f1f5f9', color: t.active ? '#166534' : '#64748b',
                      border: `1px solid ${t.active ? '#bbf7d0' : '#e2e8f0'}`, whiteSpace: 'nowrap',
                    }}>
                    {t.active ? 'Active' : 'Inactive'}
                  </button>
                </div>

                {expanded && (
                  <div style={{ padding: '0 12px 10px 34px' }}>
                    {steps.length > 0 && (
                      <div style={{ display: 'flex', gap: 6, fontSize: 10.5, fontWeight: 600, color: '#94a3b8', marginBottom: 4 }}>
                        <span style={{ width: 44 }}>Sort</span>
                        <span style={{ width: 88 }}>Type</span>
                        <span style={{ flex: 1 }}>Title</span>
                        <span style={{ width: 56 }} title="Days after the template is applied">+Days</span>
                        <span style={{ width: 128 }}>Default assignee</span>
                        <span style={{ width: 18 }} />
                      </div>
                    )}
                    {steps.map((s) => (
                      <div key={s.id} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 5 }}>
                        <input type="number" defaultValue={s.sort ?? 0}
                          onBlur={(e) => { const v = parseInt(e.target.value, 10) || 0; if (v !== (s.sort ?? 0)) patchStep(s.id, { sort: v }); }}
                          style={{ ...smallInput, width: 44 }} />
                        <select value={s.action_type} onChange={(e) => patchStep(s.id, { action_type: e.target.value })}
                          style={{ ...smallInput, width: 88 }}>
                          {ACTION_TYPES.map((at) => <option key={at.key} value={at.key}>{at.label}</option>)}
                        </select>
                        <input defaultValue={s.title || ''}
                          onBlur={(e) => { const v = e.target.value.trim(); if (v !== (s.title || '')) patchStep(s.id, { title: v }); }}
                          style={{ ...smallInput, flex: 1, width: 'auto', minWidth: 0 }} />
                        <input type="number" defaultValue={s.offset_days ?? 0} title="Days after the template is applied"
                          onBlur={(e) => { const v = parseInt(e.target.value, 10) || 0; if (v !== (s.offset_days ?? 0)) patchStep(s.id, { offset_days: v }); }}
                          style={{ ...smallInput, width: 56 }} />
                        <select value={s.default_assignee_id || ''} onChange={(e) => patchStep(s.id, { default_assignee_id: e.target.value || null })}
                          style={{ ...smallInput, width: 128 }}>
                          <option value="">Whoever applies</option>
                          {staffList.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
                        </select>
                        <button onClick={() => deleteStep(s.id)} title="Remove this step"
                          style={{ background: 'none', border: 'none', color: '#cbd5e1', cursor: 'pointer', display: 'flex', padding: 0 }}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                    <button onClick={() => addStep(t)} style={{ ...btn('ghost'), padding: '4px 9px', fontSize: 11.5, marginTop: 2 }}>
                      <Plus size={11} /> Add step
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 12, marginTop: 10 }}>
          <label style={fieldLabel}>New template</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={newName} onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createTemplate(); }}
              placeholder="Template name" style={{ ...input, flex: 1 }} />
            <input value={newDesc} onChange={(e) => setNewDesc(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createTemplate(); }}
              placeholder="Description (optional)" style={{ ...input, flex: 1.4 }} />
            <button onClick={createTemplate} disabled={!newName.trim() || saving}
              style={{ ...btn('primary'), opacity: !newName.trim() || saving ? 0.6 : 1 }}>
              <Plus size={13} /> Create
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
