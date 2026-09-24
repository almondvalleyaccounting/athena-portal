import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { LifeBuoy, Plus, X, Send, CheckCircle2, ExternalLink, Rows3, Rows2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import ClientTypeAhead from '../work-planner/components/ClientTypeAhead';
import ActionPlanSection from './ActionPlanSection';
import TemplateManagerModal from './TemplateManagerModal';
import CaseCard from './CaseCard';
import KanbanView from './KanbanView';
import ListView from './ListView';
import {
  font, card, btn, iconBtn, backdrop, modal, fieldLabel, input, fmtDate,
  sortActions, CATEGORIES, CATEGORY_MAP, STAGES, PRIORITIES, daysOpen,
} from './triageShared';

/*
  Triage — clients with an active problem. Since sql/293 it also holds what
  used to be the Issues Log, and every case has a stage as well as a type.
  Three views of the same cases:
    /triage         Board — lanes by type (strike-off, on hold, issues, general)
    /triage/kanban  Kanban — columns by stage; drag to move
    /triage/list    List — one sortable, filterable table
  Board and Kanban each have a compact / expanded toggle. Tiles open a case
  drawer with notes, a typed action plan and a target date.
*/

const VIEWS = [
  { key: 'board', label: 'Board', path: '/triage', hint: 'By type' },
  { key: 'kanban', label: 'Kanban', path: '/triage/kanban', hint: 'By stage' },
  { key: 'list', label: 'List', path: '/triage/list', hint: 'Every case' },
];

// Completed cases stay on the Kanban for a month so a drop can be undone;
// the checkbox brings back the rest.
const RECENT_COMPLETED_DAYS = 30;

function readDensity(view) {
  try { return localStorage.getItem(`triage_density_${view}`) === 'compact'; } catch { return false; }
}
function writeDensity(view, compact) {
  try { localStorage.setItem(`triage_density_${view}`, compact ? 'compact' : 'expanded'); } catch { /* per-viewer nicety only */ }
}

function fmtNoteTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
// Closing a case is "resolve" everywhere, but on the on-hold lane what people
// are actually doing is releasing the client back to work — say that instead.
function resolveLabel(category) {
  return category === 'on_hold' ? 'Take off hold' : 'Resolve case';
}

export default function TriageBoardPage() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const view = pathname.startsWith('/triage/kanban') ? 'kanban' : pathname.startsWith('/triage/list') ? 'list' : 'board';
  const [compactByView, setCompactByView] = useState(() => ({ board: readDensity('board'), kanban: readDensity('kanban') }));
  const compact = !!compactByView[view];
  function setCompact(v) {
    setCompactByView((prev) => ({ ...prev, [view]: v }));
    writeDensity(view, v);
  }
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
          .select('*, entity:entities(id, name, company_status, company_status_detail, entity_status)')
          .order('created_at', { ascending: false }),
        supabase.from('staff_profiles').select('id, name, is_active'),
        supabase.from('entities').select('id, name, entity_status').order('name'),
      ]);
      if (e1) throw e1;
      // Former clients (nlac/archived) never appear on the board — we do no
      // work for them. Any case left over is self-healed to resolved (sql/134).
      setCases((cs || []).filter((c) => !['nlac', 'archived'].includes(c.entity?.entity_status)));
      setStaffMap(Object.fromEntries((st || []).map((s) => [s.id, s.name])));
      setStaffList((st || []).filter((s) => s.is_active).sort((a, b) => (a.name || '').localeCompare(b.name || '')));
      setAllEntities((ents || []).filter((e) => !['nlac', 'archived'].includes(e.entity_status)));

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

  async function addCase({ entityId, category, description, title, priority, assigneeId }) {
    const { data, error: err } = await supabase.from('triage_cases').insert({
      entity_id: entityId, category, description, created_by: profile?.id || null,
      title: title || null, priority: priority || null, assignee_id: assigneeId || null,
      stage: category === 'on_hold' ? 'on_hold' : 'not_started',
    }).select('*, entity:entities(id, name, company_status, company_status_detail)').single();
    if (err) { setError(err.message); return false; }
    notifyAssignee(assigneeId, data);
    setCases((prev) => [data, ...(prev || [])]);
    setAdding(false);
    setOpenCaseId(data.id);
    return true;
  }

  // Ownership is only real if the owner finds out (carried over from the
  // Issues Log).
  function notifyAssignee(assigneeId, c) {
    if (!assigneeId || assigneeId === profile?.id) return;
    supabase.rpc('notify_staff', {
      p_recipient: assigneeId, p_kind: 'issue_assigned',
      p_title: `Triage case assigned to you: ${c?.title || c?.entity?.name || 'a client'}`, p_link: '/triage/list',
    }).then(({ error: nErr }) => { if (nErr) console.error('[Triage] notify', nErr); });
  }

  // Mirror what the sql/293 trigger does, so the screen agrees with the
  // database before the round trip comes back.
  function withStatusSync(c, patch) {
    const next = { ...patch };
    if (patch.stage && patch.stage !== c.stage) {
      if (patch.stage === 'completed') {
        next.status = 'resolved';
        next.resolved_at = c.resolved_at || new Date().toISOString();
        next.resolved_by = profile?.id || null;
      } else if (c.stage === 'completed') {
        next.status = 'open'; next.resolved_at = null; next.resolved_by = null;
      }
    }
    return next;
  }

  async function moveStage(c, stage) {
    await patchCase(c.id, withStatusSync(c, { stage }));
  }

  async function patchCase(id, patch) {
    setCases((prev) => (prev || []).map((c) => (c.id === id ? { ...c, ...patch } : c)));
    const { error: err } = await supabase.from('triage_cases').update(patch).eq('id', id);
    if (err) { setError(err.message); load(); }
  }

  async function resolveCase(c) {
    const prompt = c.category === 'on_hold'
      ? `Take "${c.entity?.name}" off hold? Work can resume for this client.`
      : `Resolve the triage case for "${c.entity?.name}"?`;
    if (!window.confirm(prompt)) return;
    await patchCase(c.id, {
      status: 'resolved', stage: 'completed', resolved_at: new Date().toISOString(), resolved_by: profile?.id || null,
    });
    setOpenCaseId(null);
  }

  async function reopenCase(c) {
    await patchCase(c.id, { status: 'open', stage: 'not_started', resolved_at: null, resolved_by: null });
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
    if (showResolved) return list;
    if (view === 'kanban') {
      const cutoff = Date.now() - RECENT_COMPLETED_DAYS * 86400000;
      return list.filter((c) => c.status === 'open' || new Date(c.resolved_at || c.created_at).getTime() >= cutoff);
    }
    return list.filter((c) => c.status === 'open');
  }, [cases, showResolved, view]);

  const byCategory = useMemo(() => {
    const buckets = Object.fromEntries(CATEGORIES.map((c) => [c.key, []]));
    for (const c of visible) (buckets[c.category] || buckets.general).push(c);
    return buckets;
  }, [visible]);

  const openCase = (cases || []).find((c) => c.id === openCaseId) || null;
  const openCount = (cases || []).filter((c) => c.status === 'open').length;

  return (
    <div style={{ margin: '0 auto', padding: '24px 32px 48px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <LifeBuoy size={20} color="#0e7fe0" />
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a' }}>Triage</h1>
        <span style={{ fontSize: 14, color: '#64748b' }}>{openCount} open case{openCount === 1 ? '' : 's'}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={() => setManagingTemplates(true)}
            style={{
              background: 'none', border: 'none', color: '#0e7fe0', fontSize: 13.5, fontWeight: 600,
              fontFamily: font, cursor: 'pointer', padding: '0 4px',
            }}>
            Manage templates
          </button>
          <button onClick={() => setAdding(true)} style={btn('primary')}><Plus size={13} /> Add to triage</button>
        </div>
      </div>
      <p style={{ fontSize: 14, color: '#64748b', margin: '0 0 14px' }}>
        Clients with an active problem — strike-off risks, clients on hold, and client issues.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'inline-flex', background: '#f1f5f9', borderRadius: 9, padding: 3 }}>
          {VIEWS.map((v) => (
            <Link key={v.key} to={v.path} title={v.hint}
              style={{
                padding: '6px 14px', fontSize: 13.5, fontWeight: 600, borderRadius: 7, textDecoration: 'none',
                background: view === v.key ? '#fff' : 'transparent',
                color: view === v.key ? '#0f172a' : '#64748b',
                boxShadow: view === v.key ? '0 1px 2px rgba(15,23,42,0.08)' : 'none',
              }}>
              {v.label}
            </Link>
          ))}
        </div>
        {view !== 'list' && (
          <div style={{ display: 'inline-flex', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
            {[{ v: false, label: 'Expanded', Icon: Rows2 }, { v: true, label: 'Compact', Icon: Rows3 }].map(({ v, label, Icon }) => (
              <button key={label} onClick={() => setCompact(v)} aria-pressed={compact === v}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', fontSize: 13, fontWeight: 600,
                  fontFamily: font, border: 'none', cursor: 'pointer',
                  background: compact === v ? '#1E4560' : '#fff', color: compact === v ? '#fff' : '#475569',
                }}>
                <Icon size={13} /> {label}
              </button>
            ))}
          </div>
        )}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13.5, color: '#64748b', cursor: 'pointer', marginLeft: 'auto' }}>
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)}
            style={{ width: 13, height: 13, accentColor: '#0e7fe0' }} />
          {view === 'kanban' ? `Show all completed (not just the last ${RECENT_COMPLETED_DAYS} days)` : 'Show resolved'}
        </label>
      </div>

      {error && <div style={{ fontSize: 14, color: '#b91c1c', marginBottom: 12 }}>{error}</div>}

      {cases === null && <div style={{ ...card, padding: 18, textAlign: 'center', fontSize: 14, color: '#94a3b8' }}>Loading…</div>}

      {cases !== null && view === 'board' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(255px, 1fr))', gap: 14, alignItems: 'start' }}>
          {CATEGORIES.map((cat) => {
            const items = byCategory[cat.key] || [];
            const Icon = cat.icon;
            return (
              <div key={cat.key} style={{ ...card, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 14px', background: cat.tone.bg, borderBottom: `1px solid ${cat.tone.border}` }}>
                  <Icon size={15} color={cat.tone.fg} />
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: cat.tone.fg }}>
                    {cat.label} ({items.length})
                  </span>
                </div>
                {!compact && <div style={{ padding: '10px 10px 6px', fontSize: 12.5, color: '#94a3b8' }}>{cat.hint}</div>}
                <div style={{ padding: compact ? 8 : '0 10px 10px', display: 'flex', flexDirection: 'column', gap: compact ? 5 : 8 }}>
                  {items.length === 0 && (
                    <div style={{ fontSize: 13.5, color: '#cbd5e1', textAlign: 'center', padding: '14px 0' }}>Nothing here</div>
                  )}
                  {items.map((c) => (
                    <CaseCard
                      key={c.id}
                      c={c}
                      notes={notesByCase[c.id] || []}
                      actions={actionsByCase[c.id] || []}
                      staffMap={staffMap}
                      compact={compact}
                      badge="stage"
                      onOpen={(x) => setOpenCaseId(x.id)}
                      onResolve={resolveCase}
                      resolveLabel={resolveLabel(c.category)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {cases !== null && view === 'kanban' && (
        <KanbanView
          cases={visible}
          notesByCase={notesByCase}
          actionsByCase={actionsByCase}
          staffMap={staffMap}
          compact={compact}
          onOpen={(x) => setOpenCaseId(x.id)}
          onMove={moveStage}
        />
      )}

      {cases !== null && view === 'list' && (
        <ListView
          cases={visible}
          actionsByCase={actionsByCase}
          staffMap={staffMap}
          staffList={staffList}
          onOpen={(x) => setOpenCaseId(x.id)}
        />
      )}

      {adding && (
        <AddCaseModal
          entityList={allEntities}
          staffList={staffList}
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
          onPatch={(patch) => {
            if (patch.assignee_id && patch.assignee_id !== openCase.assignee_id) notifyAssignee(patch.assignee_id, openCase);
            patchCase(openCase.id, withStatusSync(openCase, patch));
          }}
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

function AddCaseModal({ entityList, staffList, onClose, onAdd }) {
  const [entityId, setEntityId] = useState('');
  const [category, setCategory] = useState('general');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [priority, setPriority] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!entityId || !description.trim() || saving) return;
    setSaving(true);
    await onAdd({
      entityId, category, description: description.trim(),
      title: category === 'issue' ? title.trim() : '', assigneeId, priority,
    });
    setSaving(false);
  }

  return (
    <div onClick={onClose} style={backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modal, width: 520 }}>
        <div style={{ fontSize: 15.5, fontWeight: 700, color: '#0f172a', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <LifeBuoy size={16} color="#0e7fe0" /> Add a client to triage
        </div>

        <label style={fieldLabel}>Client</label>
        <ClientTypeAhead entityList={entityList} value={entityId} onChange={setEntityId} />

        <label style={{ ...fieldLabel, marginTop: 12 }}>Category</label>
        <div style={{ display: 'flex', gap: 6 }}>
          {CATEGORIES.map((cat) => (
            <button key={cat.key} onClick={() => setCategory(cat.key)}
              style={{
                flex: 1, padding: '7px 8px', fontSize: 13, fontWeight: 600, fontFamily: font, borderRadius: 8, cursor: 'pointer',
                background: category === cat.key ? cat.tone.bg : '#fff',
                color: category === cat.key ? cat.tone.fg : '#64748b',
                border: `1px solid ${category === cat.key ? cat.tone.border : '#e5e7eb'}`,
              }}>{cat.label}</button>
          ))}
        </div>

        {category === 'issue' && (
          <>
            <label style={{ ...fieldLabel, marginTop: 12 }}>Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="One line — what's wrong?" style={input} />
          </>
        )}

        <label style={{ ...fieldLabel, marginTop: 12 }}>{category === 'issue' ? 'Details' : 'Brief description'}</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
          placeholder="What's the issue?"
          style={{ ...input, resize: 'vertical' }} />

        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={fieldLabel}>Owner</label>
            <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} style={input}>
              <option value="">Nobody yet</option>
              {staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div style={{ width: 150 }}>
            <label style={fieldLabel}>Priority</label>
            <select value={priority} onChange={(e) => setPriority(e.target.value)} style={input}>
              <option value="">—</option>
              {PRIORITIES.map((pr) => <option key={pr.key} value={pr.key}>{pr.label}</option>)}
            </select>
          </div>
        </div>

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
  const cat = CATEGORY_MAP[c.category] || CATEGORY_MAP.general;

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
            fontSize: 11.5, fontWeight: 700, padding: '2px 9px', borderRadius: 999,
            background: cat.tone.bg, color: cat.tone.fg, border: `1px solid ${cat.tone.border}`,
            textTransform: 'uppercase', letterSpacing: 0.4,
          }}>{cat.label}</span>
          <span style={{ fontSize: 15.5, fontWeight: 700, color: '#0f172a', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
            <div style={{ fontSize: 13, color: '#64748b', marginBottom: 10 }}>
              Companies House status:{' '}
              <strong style={{ color: /(strike|liquidat|administrat|dissolv)/i.test(`${c.entity.company_status} ${c.entity.company_status_detail || ''}`) ? '#b91c1c' : '#166534' }}>
                {c.entity.company_status.replace(/-/g, ' ')}{c.entity.company_status_detail ? ` (${c.entity.company_status_detail.replace(/-/g, ' ')})` : ''}
              </strong>
            </div>
          )}

          <div style={{ fontSize: 14.5, color: '#334155', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{c.description}</div>
          <div style={{ fontSize: 12.5, color: '#94a3b8', marginTop: 6 }}>
            Opened {fmtDate(c.created_at)} ({daysOpen(c.created_at)} days ago)
            {c.created_by ? ` by ${staffMap[c.created_by] || 'staff'}` : c.source === 'ch_status' ? ' automatically from Companies House' : ''}
            {c.status === 'resolved' && ` · resolved ${fmtDate(c.resolved_at)}`}
          </div>

          {c.category === 'issue' && (
            <div style={{ marginTop: 14 }}>
              <label style={fieldLabel}>Title</label>
              <input defaultValue={c.title || ''} key={c.id}
                onBlur={(e) => { const v = e.target.value.trim(); if (v !== (c.title || '')) onPatch({ title: v || null }); }}
                style={input} />
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 14 }}>
            <div>
              <label style={fieldLabel}>Stage</label>
              <select value={c.stage || 'not_started'} onChange={(e) => onPatch({ stage: e.target.value })} style={input}>
                {STAGES.map((st) => <option key={st.key} value={st.key}>{st.label}</option>)}
              </select>
            </div>
            <div>
              <label style={fieldLabel}>Owner</label>
              <select value={c.assignee_id || ''} onChange={(e) => onPatch({ assignee_id: e.target.value || null })} style={input}>
                <option value="">Nobody yet</option>
                {staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                {c.assignee_id && !staffList.some((s) => s.id === c.assignee_id) && (
                  <option value={c.assignee_id}>{staffMap[c.assignee_id] || 'Former staff'}</option>
                )}
              </select>
            </div>
            <div>
              <label style={fieldLabel}>Priority</label>
              <select value={c.priority || ''} onChange={(e) => onPatch({ priority: e.target.value || null })} style={input}>
                <option value="">—</option>
                {PRIORITIES.map((pr) => <option key={pr.key} value={pr.key}>{pr.label}</option>)}
              </select>
            </div>
            <div>
              <label style={fieldLabel}>Case target date</label>
              <input type="date" value={c.target_date || ''} onChange={(e) => onPatch({ target_date: e.target.value || null })}
                style={input} />
            </div>
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
            <div style={{ fontSize: 13, fontWeight: 700, color: '#475569', marginBottom: 8 }}>
              Notes
            </div>
            {notes.length === 0 && <div style={{ fontSize: 13.5, color: '#94a3b8' }}>No notes yet.</div>}
            {notes.map((n) => (
              <div key={n.id} style={{ padding: '7px 0', borderBottom: '1px solid #f8fafc', fontSize: 13.5, color: '#334155' }}>
                <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
                <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
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
            ? (
              <button onClick={onResolve} style={{ ...btn('ghost'), color: '#166534', borderColor: '#bbf7d0' }}>
                <CheckCircle2 size={13} /> {resolveLabel(c.category)}
              </button>
            )
            : <button onClick={onReopen} style={btn('ghost')}>{c.category === 'on_hold' ? 'Put back on hold' : 'Reopen case'}</button>}
        </div>
      </div>
    </div>
  );
}

