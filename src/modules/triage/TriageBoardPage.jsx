import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  LifeBuoy, Plus, X, AlertTriangle, PauseCircle, ClipboardList, Send,
  CheckCircle2, CalendarDays, ExternalLink,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import ClientTypeAhead from '../work-planner/components/ClientTypeAhead';
import ActionPlanSection from './ActionPlanSection';
import TemplateManagerModal from './TemplateManagerModal';
import {
  font, card, btn, iconBtn, backdrop, modal, fieldLabel, input, fmtDate, fmtDateShort,
  ACTION_TYPE_MAP, sortActions, nextOpenAction, isOverdueAction,
} from './triageShared';

/*
  Triage Board — clients with an active problem, in three lanes:
  strike-off watch (auto-fed by nightly Companies House status changes),
  on hold (do no work for this client), and general. Tiles open a case
  drawer with timestamped notes, a typed action plan (email / call / meeting,
  who and when — template-driven or manual) and a target date. Automation
  of the actions themselves (email sends, diary invites) comes later.
*/

const CATEGORIES = [
  {
    key: 'strike_off', label: 'Strike-off watch', icon: AlertTriangle,
    tone: { fg: '#b91c1c', bg: '#fef2f2', border: '#fecaca' },
    hint: 'Status changed at Companies House — fed automatically by the nightly refresh.',
  },
  {
    key: 'on_hold', label: 'On hold', icon: PauseCircle,
    tone: { fg: '#b45309', bg: '#fffbeb', border: '#fde68a' },
    hint: 'Do not carry out any work for these clients while the case is open.',
  },
  {
    key: 'general', label: 'General', icon: ClipboardList,
    tone: { fg: '#0369a1', bg: '#f0f9ff', border: '#bae6fd' },
    hint: 'Anything else that needs eyes on it.',
  },
];

function fmtNoteTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function daysOpen(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

export default function TriageBoardPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [cases, setCases] = useState(null);
  const [notesByCase, setNotesByCase] = useState({});
  const [actionsByCase, setActionsByCase] = useState({});
  const [staffMap, setStaffMap] = useState({});
  const [staffList, setStaffList] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [allEntities, setAllEntities] = useState([]);
  const [error, setError] = useState(null);
  const [showResolved, setShowResolved] = useState(false);
  const [openCaseId, setOpenCaseId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [managingTemplates, setManagingTemplates] = useState(false);

  const load = useCallback(async () => {
    try {
      const [{ data: cs, error: e1 }, { data: st }, { data: ents }] = await Promise.all([
        supabase.from('triage_cases')
          .select('*, entity:entities(id, name, company_status, company_status_detail)')
          .order('created_at', { ascending: false }),
        supabase.from('staff_profiles').select('id, name, is_active'),
        supabase.from('entities').select('id, name').order('name'),
      ]);
      if (e1) throw e1;
      setCases(cs || []);
      setStaffMap(Object.fromEntries((st || []).map((s) => [s.id, s.name])));
      setStaffList((st || []).filter((s) => s.is_active).sort((a, b) => (a.name || '').localeCompare(b.name || '')));
      setAllEntities(ents || []);

      const ids = (cs || []).map((c) => c.id);
      if (ids.length) {
        const [{ data: notes }, { data: acts }] = await Promise.all([
          supabase.from('triage_case_notes')
            .select('*').in('case_id', ids).order('created_at', { ascending: true }),
          supabase.from('triage_actions').select('*').in('case_id', ids),
        ]);
        const grouped = {};
        for (const n of notes || []) (grouped[n.case_id] ||= []).push(n);
        setNotesByCase(grouped);
        const acted = {};
        for (const a of acts || []) (acted[a.case_id] ||= []).push(a);
        for (const k of Object.keys(acted)) acted[k] = sortActions(acted[k]);
        setActionsByCase(acted);
      } else {
        setNotesByCase({});
        setActionsByCase({});
      }
    } catch (e) { setError(e.message); }
  }, []);

  const loadTemplates = useCallback(async () => {
    const { data, error: err } = await supabase.from('triage_action_templates')
      .select('*, steps:triage_action_template_steps(*)')
      .order('name');
    if (err) { setError(err.message); return; }
    setTemplates((data || []).map((t) => ({
      ...t, steps: [...(t.steps || [])].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)),
    })));
  }, []);

  useEffect(() => { load(); loadTemplates(); }, [load, loadTemplates]);

  async function addCase({ entityId, category, description }) {
    const { data, error: err } = await supabase.from('triage_cases').insert({
      entity_id: entityId, category, description, created_by: profile?.id || null,
    }).select('*, entity:entities(id, name, company_status, company_status_detail)').single();
    if (err) { setError(err.message); return false; }
    setCases((prev) => [data, ...(prev || [])]);
    setAdding(false);
    setOpenCaseId(data.id);
    return true;
  }

  async function patchCase(id, patch) {
    setCases((prev) => (prev || []).map((c) => (c.id === id ? { ...c, ...patch } : c)));
    const { error: err } = await supabase.from('triage_cases').update(patch).eq('id', id);
    if (err) { setError(err.message); load(); }
  }

  async function resolveCase(c) {
    if (!window.confirm(`Resolve the ${c.category === 'on_hold' ? 'on-hold' : 'triage'} case for "${c.entity?.name}"?`)) return;
    await patchCase(c.id, {
      status: 'resolved', resolved_at: new Date().toISOString(), resolved_by: profile?.id || null,
    });
    setOpenCaseId(null);
  }

  async function reopenCase(c) {
    await patchCase(c.id, { status: 'open', resolved_at: null, resolved_by: null });
  }

  async function addNote(caseId, body) {
    const text = (body || '').trim();
    if (!text) return;
    const { data, error: err } = await supabase.from('triage_case_notes')
      .insert({ case_id: caseId, author_id: profile?.id || null, body: text })
      .select('*').single();
    if (err) { setError(err.message); return; }
    setNotesByCase((prev) => ({ ...prev, [caseId]: [...(prev[caseId] || []), data] }));
  }

  async function addActions(caseId, rows) {
    const payload = rows.map((r) => ({ ...r, case_id: caseId, created_by: profile?.id || null }));
    const { data, error: err } = await supabase.from('triage_actions').insert(payload).select('*');
    if (err) { setError(err.message); return; }
    setActionsByCase((prev) => ({ ...prev, [caseId]: sortActions([...(prev[caseId] || []), ...(data || [])]) }));
  }

  async function patchAction(caseId, actionId, patch) {
    setActionsByCase((prev) => ({
      ...prev,
      [caseId]: sortActions((prev[caseId] || []).map((a) => (a.id === actionId ? { ...a, ...patch } : a))),
    }));
    const { error: err } = await supabase.from('triage_actions').update(patch).eq('id', actionId);
    if (err) { setError(err.message); load(); }
  }

  const visible = useMemo(() => {
    const list = cases || [];
    return list.filter((c) => (showResolved ? true : c.status === 'open'));
  }, [cases, showResolved]);

  const byCategory = useMemo(() => {
    const buckets = { strike_off: [], on_hold: [], general: [] };
    for (const c of visible) (buckets[c.category] || buckets.general).push(c);
    return buckets;
  }, [visible]);

  const openCase = (cases || []).find((c) => c.id === openCaseId) || null;
  const openCount = (cases || []).filter((c) => c.status === 'open').length;

  return (
    <div style={{ maxWidth: 1240, margin: '0 auto', padding: '28px 32px 48px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <LifeBuoy size={20} color="#0e7fe0" />
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a' }}>Triage Board</h1>
        <span style={{ fontSize: 13, color: '#64748b' }}>{openCount} open case{openCount === 1 ? '' : 's'}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={() => setManagingTemplates(true)}
            style={{
              background: 'none', border: 'none', color: '#0e7fe0', fontSize: 12.5, fontWeight: 600,
              fontFamily: font, cursor: 'pointer', padding: '0 4px',
            }}>
            Manage templates
          </button>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#64748b', cursor: 'pointer' }}>
            <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)}
              style={{ width: 13, height: 13, accentColor: '#0e7fe0' }} />
            Show resolved
          </label>
          <button onClick={() => setAdding(true)} style={btn('primary')}><Plus size={13} /> Add to triage</button>
        </div>
      </div>
      <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 20px' }}>
        Clients with an active problem. Strike-off cases are raised automatically when the nightly
        Companies House refresh sees a status change; on-hold means no work should be done for the client.
      </p>
      {error && <div style={{ fontSize: 13, color: '#b91c1c', marginBottom: 12 }}>{error}</div>}

      {cases === null && <div style={{ ...card, padding: 18, textAlign: 'center', fontSize: 13, color: '#94a3b8' }}>Loading…</div>}

      {cases !== null && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, alignItems: 'start' }}>
          {CATEGORIES.map((cat) => {
            const items = byCategory[cat.key] || [];
            const Icon = cat.icon;
            return (
              <div key={cat.key} style={{ ...card, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 14px', background: cat.tone.bg, borderBottom: `1px solid ${cat.tone.border}` }}>
                  <Icon size={15} color={cat.tone.fg} />
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: cat.tone.fg, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    {cat.label} ({items.length})
                  </span>
                </div>
                <div style={{ padding: '10px 10px 6px', fontSize: 11.5, color: '#94a3b8' }}>{cat.hint}</div>
                <div style={{ padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {items.length === 0 && (
                    <div style={{ fontSize: 12.5, color: '#cbd5e1', textAlign: 'center', padding: '14px 0' }}>Nothing here. 🎉</div>
                  )}
                  {items.map((c) => {
                    const notes = notesByCase[c.id] || [];
                    const overdue = c.target_date && c.target_date < new Date().toISOString().slice(0, 10);
                    const acts = actionsByCase[c.id] || [];
                    const activeActs = acts.filter((a) => a.status !== 'cancelled');
                    const doneActs = activeActs.filter((a) => a.status === 'done').length;
                    const nextAct = nextOpenAction(acts);
                    const NextIcon = nextAct ? (ACTION_TYPE_MAP[nextAct.action_type] || ACTION_TYPE_MAP.other).icon : null;
                    return (
                      <div key={c.id} onClick={() => setOpenCaseId(c.id)}
                        style={{
                          border: `1px solid ${c.status === 'resolved' ? '#e5e7eb' : cat.tone.border}`,
                          borderLeft: `3px solid ${c.status === 'resolved' ? '#cbd5e1' : cat.tone.fg}`,
                          borderRadius: 10, padding: '10px 12px', cursor: 'pointer',
                          background: c.status === 'resolved' ? '#f8fafc' : '#fff',
                          opacity: c.status === 'resolved' ? 0.75 : 1,
                        }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 13.5, fontWeight: 600, color: '#0f172a', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {c.entity?.name || 'Client'}
                          </span>
                          {c.status === 'resolved' && <CheckCircle2 size={13} color="#16a34a" />}
                          <span style={{ fontSize: 10.5, color: '#94a3b8', whiteSpace: 'nowrap' }}>{daysOpen(c.created_at)}d</span>
                        </div>
                        <div style={{ fontSize: 12, color: '#64748b', marginTop: 3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                          {c.description}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 11, color: '#94a3b8', flexWrap: 'wrap' }}>
                          {nextAct ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#475569', minWidth: 0 }}>
                              <NextIcon size={11} style={{ flexShrink: 0 }} />
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 }}>
                                Next: {nextAct.title}
                              </span>
                              {nextAct.target_date && (
                                <span style={{ color: isOverdueAction(nextAct) ? '#dc2626' : '#94a3b8', whiteSpace: 'nowrap' }}>
                                  · {fmtDateShort(nextAct.target_date)}
                                </span>
                              )}
                              {nextAct.assigned_to && staffMap[nextAct.assigned_to] && (
                                <span style={{ whiteSpace: 'nowrap' }}>· {staffMap[nextAct.assigned_to].split(' ')[0]}</span>
                              )}
                            </span>
                          ) : acts.length === 0 && c.next_action ? (
                            <span style={{ color: '#475569' }}>Next: {c.next_action}</span>
                          ) : null}
                          {activeActs.length > 0 && (
                            <span>{doneActs}/{activeActs.length} action{activeActs.length === 1 ? '' : 's'} done</span>
                          )}
                          {c.target_date && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: overdue ? '#dc2626' : '#94a3b8' }}>
                              <CalendarDays size={11} /> {fmtDate(c.target_date)}
                            </span>
                          )}
                          {notes.length > 0 && <span>{notes.length} note{notes.length === 1 ? '' : 's'}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {adding && (
        <AddCaseModal
          entityList={allEntities}
          onClose={() => setAdding(false)}
          onAdd={addCase}
        />
      )}

      {openCase && (
        <CaseDrawer
          c={openCase}
          notes={notesByCase[openCase.id] || []}
          actions={actionsByCase[openCase.id] || []}
          staffMap={staffMap}
          staffList={staffList}
          templates={templates.filter((t) => t.active)}
          onClose={() => setOpenCaseId(null)}
          onPatch={(patch) => patchCase(openCase.id, patch)}
          onResolve={() => resolveCase(openCase)}
          onReopen={() => reopenCase(openCase)}
          onAddNote={(body) => addNote(openCase.id, body)}
          onAddActions={(rows) => addActions(openCase.id, rows)}
          onPatchAction={(actionId, patch) => patchAction(openCase.id, actionId, patch)}
          onOpenClient={() => navigate(`/clients/${openCase.entity_id}`)}
        />
      )}

      {managingTemplates && (
        <TemplateManagerModal
          templates={templates}
          staffList={staffList}
          onClose={() => setManagingTemplates(false)}
          onReload={loadTemplates}
        />
      )}
    </div>
  );
}

function AddCaseModal({ entityList, onClose, onAdd }) {
  const [entityId, setEntityId] = useState('');
  const [category, setCategory] = useState('general');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!entityId || !description.trim() || saving) return;
    setSaving(true);
    await onAdd({ entityId, category, description: description.trim() });
    setSaving(false);
  }

  return (
    <div onClick={onClose} style={backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modal, width: 460 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <LifeBuoy size={16} color="#0e7fe0" /> Add a client to triage
        </div>

        <label style={fieldLabel}>Client</label>
        <ClientTypeAhead entityList={entityList} value={entityId} onChange={setEntityId} />

        <label style={{ ...fieldLabel, marginTop: 12 }}>Category</label>
        <div style={{ display: 'flex', gap: 6 }}>
          {CATEGORIES.map((cat) => (
            <button key={cat.key} onClick={() => setCategory(cat.key)}
              style={{
                flex: 1, padding: '7px 8px', fontSize: 12, fontWeight: 600, fontFamily: font, borderRadius: 8, cursor: 'pointer',
                background: category === cat.key ? cat.tone.bg : '#fff',
                color: category === cat.key ? cat.tone.fg : '#64748b',
                border: `1px solid ${category === cat.key ? cat.tone.border : '#e5e7eb'}`,
              }}>{cat.label}</button>
          ))}
        </div>

        <label style={{ ...fieldLabel, marginTop: 12 }}>Brief description</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
          placeholder="What's the issue?"
          style={{ ...input, resize: 'vertical' }} />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button onClick={onClose} style={btn('ghost')}>Cancel</button>
          <button onClick={submit} disabled={!entityId || !description.trim() || saving}
            style={{ ...btn('primary'), opacity: (!entityId || !description.trim() || saving) ? 0.6 : 1 }}>
            {saving ? 'Adding…' : 'Add case'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CaseDrawer({ c, notes, actions, staffMap, staffList, templates, onClose, onPatch, onResolve, onReopen, onAddNote, onAddActions, onPatchAction, onOpenClient }) {
  const [noteDraft, setNoteDraft] = useState('');
  const cat = CATEGORIES.find((x) => x.key === c.category) || CATEGORIES[2];

  function submitNote() {
    if (!noteDraft.trim()) return;
    onAddNote(noteDraft);
    setNoteDraft('');
  }

  return (
    <div onClick={onClose} style={backdrop}>
      <div onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, width: 480, maxWidth: '92vw',
          background: '#fff', boxShadow: '-16px 0 48px rgba(15,23,42,0.18)',
          display: 'flex', flexDirection: 'column', fontFamily: font,
        }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            fontSize: 10.5, fontWeight: 700, padding: '2px 9px', borderRadius: 999,
            background: cat.tone.bg, color: cat.tone.fg, border: `1px solid ${cat.tone.border}`,
            textTransform: 'uppercase', letterSpacing: 0.4,
          }}>{cat.label}</span>
          <span style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {c.entity?.name || 'Client'}
          </span>
          <button onClick={onOpenClient} title="Open the client record" style={{ ...iconBtn, color: '#0e7fe0', borderColor: '#bae6fd' }}>
            <ExternalLink size={13} />
          </button>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', display: 'flex' }}>
            <X size={17} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
          {c.entity?.company_status && (
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 10 }}>
              Companies House status:{' '}
              <strong style={{ color: /(strike|liquidat|administrat|dissolv)/i.test(`${c.entity.company_status} ${c.entity.company_status_detail || ''}`) ? '#b91c1c' : '#166534' }}>
                {c.entity.company_status.replace(/-/g, ' ')}{c.entity.company_status_detail ? ` (${c.entity.company_status_detail.replace(/-/g, ' ')})` : ''}
              </strong>
            </div>
          )}

          <div style={{ fontSize: 13.5, color: '#334155', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{c.description}</div>
          <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 6 }}>
            Opened {fmtDate(c.created_at)} ({daysOpen(c.created_at)} days ago)
            {c.created_by ? ` by ${staffMap[c.created_by] || 'staff'}` : c.source === 'ch_status' ? ' automatically from Companies House' : ''}
            {c.status === 'resolved' && ` · resolved ${fmtDate(c.resolved_at)}`}
          </div>

          <div style={{ marginTop: 16, width: 170 }}>
            <label style={fieldLabel}>Case target date</label>
            <input type="date" value={c.target_date || ''} onChange={(e) => onPatch({ target_date: e.target.value || null })}
              style={input} />
          </div>

          <ActionPlanSection
            c={c}
            actions={actions}
            staffList={staffList}
            staffMap={staffMap}
            templates={templates}
            onAddActions={onAddActions}
            onPatchAction={onPatchAction}
            onPatchCase={onPatch}
          />

          <div style={{ marginTop: 18 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
              Notes
            </div>
            {notes.length === 0 && <div style={{ fontSize: 12.5, color: '#94a3b8' }}>No notes yet.</div>}
            {notes.map((n) => (
              <div key={n.id} style={{ padding: '7px 0', borderBottom: '1px solid #f8fafc', fontSize: 12.5, color: '#334155' }}>
                <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
                  {n.author_id ? (staffMap[n.author_id] || 'staff') : 'Athena'} · {fmtNoteTime(n.created_at)}
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
              <input
                value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submitNote(); }}
                placeholder="Add a timestamped note…"
                style={{ ...input, flex: 1 }} />
              <button onClick={submitNote} disabled={!noteDraft.trim()} style={{ ...btn('primary'), padding: '7px 12px' }}>
                <Send size={12} />
              </button>
            </div>
          </div>
        </div>

        <div style={{ padding: '12px 20px', borderTop: '1px solid #f1f5f9', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {c.status === 'open'
            ? <button onClick={onResolve} style={{ ...btn('ghost'), color: '#166534', borderColor: '#bbf7d0' }}><CheckCircle2 size={13} /> Resolve case</button>
            : <button onClick={onReopen} style={btn('ghost')}>Reopen case</button>}
        </div>
      </div>
    </div>
  );
}

