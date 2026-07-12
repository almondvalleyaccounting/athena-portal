import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, ClipboardList, Copy, Download, Plus, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../shell/AppShell';

const font = "'Outfit', sans-serif";
const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 };

/*
  Sophie's single admin to-do list — the one place for everything Athena
  captures that must be keyed into BrightManager, plus manual actions.

  - bm_code tasks are auto-created (AI document extraction spotting UTR /
    VAT / PAYE / CH auth code letters) or added by hand.
  - "Done" = entered in BM, awaiting confirmation.
  - Every page load (and every BM client import) runs
    admin_tasks_confirm_from_bm(): once the BM upload lands the value on the
    entity record the task is confirmed and drops off the list — so Athena
    and BM can't drift apart silently.
  - Reallocation proposals from the Work Capacity planner appear here too
    (managed in the planner; this is the single view of ALL admin actions).
*/

const FIELD_LABELS = {
  ch_auth_code: 'CH auth code',
  utr: 'UTR',
  vat_number: 'VAT number',
  paye_ref: 'PAYE ref',
};

export default function AdminTasksPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [tasks, setTasks] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [entities, setEntities] = useState({});
  const [staff, setStaff] = useState({});
  const [confirmedNow, setConfirmedNow] = useState(0);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [copied, setCopied] = useState(null);

  const load = useCallback(async () => {
    try {
      // Confirm-and-clear first: BM data may have landed since last visit.
      const { data: confirmed } = await supabase.rpc('admin_tasks_confirm_from_bm');
      if (confirmed > 0) setConfirmedNow(confirmed);

      const [{ data: t, error: e1 }, { data: d }, { data: st }] = await Promise.all([
        supabase.from('admin_tasks')
          .select('*, entity:entities(id, name)')
          .is('confirmed_at', null).is('dismissed_at', null)
          .order('created_at', { ascending: false }),
        supabase.from('allocation_drafts')
          .select('*')
          .eq('status', 'draft'),
        supabase.from('staff_profiles').select('id, name'),
      ]);
      if (e1) throw e1;
      setTasks(t || []);
      setDrafts(d || []);
      setStaff(Object.fromEntries((st || []).map((s) => [s.id, s.name])));
      const entIds = [...new Set((d || []).map((x) => x.entity_id).filter(Boolean))];
      if (entIds.length) {
        const { data: ents } = await supabase.from('entities').select('id, name').in('id', entIds);
        setEntities(Object.fromEntries((ents || []).map((e) => [e.id, e.name])));
      }
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function toggleDone(task) {
    const nowDone = !task.done_at;
    // No entity field to verify against → the tick completes it outright.
    const patch = nowDone
      ? { done_at: new Date().toISOString(), ...(task.field ? {} : { confirmed_at: new Date().toISOString() }) }
      : { done_at: null };
    setTasks((prev) => prev
      .map((t) => (t.id === task.id ? { ...t, ...patch } : t))
      .filter((t) => !t.confirmed_at));
    const { error: err } = await supabase.from('admin_tasks').update(patch).eq('id', task.id);
    if (err) { setError(err.message); load(); }
  }

  async function dismiss(task) {
    if (!window.confirm(`Remove "${task.title}" from the list?`)) return;
    setTasks((prev) => prev.filter((t) => t.id !== task.id));
    const { error: err } = await supabase.from('admin_tasks')
      .update({ dismissed_at: new Date().toISOString() }).eq('id', task.id);
    if (err) { setError(err.message); load(); }
  }

  async function addManual() {
    if (!newTitle.trim()) return;
    const { error: err } = await supabase.from('admin_tasks').insert({
      kind: 'manual', title: newTitle.trim(), source: 'Added manually', created_by: profile?.id || null,
    });
    if (err) { setError(err.message); return; }
    setNewTitle(''); setAdding(false); load();
  }

  function copyValue(task) {
    navigator.clipboard?.writeText(task.value || '');
    setCopied(task.id);
    setTimeout(() => setCopied(null), 1500);
  }

  function exportCsv() {
    const rows = (tasks || []).map((t) => ({
      Client: t.entity?.name || '', Task: t.title, Field: FIELD_LABELS[t.field] || t.field || '',
      Value: t.value || '', Source: t.source || '', Added: new Date(t.created_at).toLocaleDateString('en-GB'),
      Status: t.done_at ? 'done — awaiting BM confirmation' : 'open',
    }));
    const headers = ['Client', 'Task', 'Field', 'Value', 'Source', 'Added', 'Status'];
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => cell(r[h])).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url; a.download = `admin-tasks-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  const open = useMemo(() => (tasks || []).filter((t) => !t.confirmed_at), [tasks]);

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '26px 24px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <ClipboardList size={18} color="#0e7fe0" />
        <h1 style={{ margin: 0, fontSize: 21, fontWeight: 700, color: '#0f172a' }}>Admin task list</h1>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={exportCsv} disabled={!open.length} style={btn('ghost')}>
            <Download size={13} /> Export CSV
          </button>
          <button onClick={() => setAdding((v) => !v)} style={btn('primary')}>
            <Plus size={13} /> Add task
          </button>
        </div>
      </div>
      <p style={{ margin: '2px 0 18px', fontSize: 13, color: '#64748b' }}>
        Everything captured in Athena that needs keying into BrightManager, in one place.
        Tick when entered — the next BM upload confirms it and clears it off the list automatically.
      </p>

      {confirmedNow > 0 && (
        <div style={{ ...card, borderColor: '#bbf7d0', background: '#f0fdf4', padding: '10px 14px', marginBottom: 14, fontSize: 13, color: '#166534' }}>
          ✓ {confirmedNow} task{confirmedNow === 1 ? '' : 's'} confirmed complete by the latest BrightManager data and removed.
        </div>
      )}
      {error && <div style={{ fontSize: 13, color: '#b91c1c', marginBottom: 12 }}>{error}</div>}

      {adding && (
        <div style={{ ...card, padding: '12px 14px', marginBottom: 14, display: 'flex', gap: 8 }}>
          <input
            autoFocus value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addManual(); if (e.key === 'Escape') setAdding(false); }}
            placeholder="e.g. Update year-end date on BM for Smith Ltd"
            style={{ flex: 1, padding: '8px 12px', fontSize: 13, border: '1px solid #cbd5e1', borderRadius: 8, fontFamily: font, outline: 'none' }}
          />
          <button onClick={addManual} disabled={!newTitle.trim()} style={btn('primary')}>Add</button>
        </div>
      )}

      {/* BM data-entry + manual tasks */}
      <div style={{ ...card, overflow: 'hidden', marginBottom: 20 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #f1f5f9', fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          To key into BrightManager ({open.length})
        </div>
        {tasks === null && <div style={{ padding: 16, fontSize: 13, color: '#94a3b8' }}>Loading…</div>}
        {tasks !== null && open.length === 0 && (
          <div style={{ padding: '22px 16px', fontSize: 13.5, color: '#94a3b8', textAlign: 'center' }}>
            Nothing outstanding — Athena and BrightManager are in step. 🎉
          </div>
        )}
        {open.map((t) => (
          <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', borderTop: '1px solid #f8fafc', opacity: t.done_at ? 0.65 : 1 }}>
            <button
              onClick={() => toggleDone(t)}
              title={t.done_at ? 'Entered in BM — waiting for the next upload to confirm. Click to un-tick.' : 'Tick when entered in BM'}
              style={{
                width: 22, height: 22, borderRadius: 7, flexShrink: 0, cursor: 'pointer',
                border: `2px solid ${t.done_at ? '#059669' : '#cbd5e1'}`,
                background: t.done_at ? '#059669' : '#fff',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff', padding: 0,
              }}
            >
              {t.done_at && <CheckCircle2 size={14} />}
            </button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: '#0f172a', textDecoration: t.done_at ? 'line-through' : 'none' }}>
                {t.entity?.id ? (
                  <span
                    onClick={() => navigate(`/clients/${t.entity.id}`)}
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
                  >
                    {t.title}
                  </span>
                ) : t.title}
              </div>
              <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 1 }}>
                {t.source || t.kind}{t.done_at ? ' · entered — awaiting BM upload confirmation' : ''}
                {' · '}{new Date(t.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
              </div>
            </div>
            {t.value && (
              <button onClick={() => copyValue(t)} title="Copy the value to paste into BM" style={{ ...btn('ghost'), fontFamily: 'monospace', fontSize: 12 }}>
                {copied === t.id ? '✓ copied' : <>{t.value} <Copy size={11} /></>}
              </button>
            )}
            <button onClick={() => dismiss(t)} title="Remove without completing" style={{ background: 'none', border: 'none', color: '#cbd5e1', cursor: 'pointer', padding: 4, display: 'flex' }}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>

      {/* Reallocation proposals from the capacity planner */}
      <div style={{ ...card, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid #f1f5f9' }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5, flex: 1 }}>
            Task reallocations to apply in BM ({drafts.length})
          </span>
          <button onClick={() => navigate('/planner/allocations')} style={btn('ghost')}>
            Open capacity planner →
          </button>
        </div>
        {drafts.length === 0 && (
          <div style={{ padding: '18px 16px', fontSize: 13, color: '#94a3b8', textAlign: 'center' }}>
            No reallocation proposals waiting.
          </div>
        )}
        {drafts.map((d) => (
          <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderTop: '1px solid #f8fafc', fontSize: 13 }}>
            <span style={{ fontWeight: 600, color: '#0f172a', flex: '0 0 auto' }}>{entities[d.entity_id] || 'Client'}</span>
            <span style={{ color: '#64748b', flex: 1 }}>{String(d.canonical_service_id || '').replace(/_/g, ' ')}</span>
            <span style={{ color: '#475569', whiteSpace: 'nowrap' }}>
              → {staff[d.proposed_fee_earner_id] || 'unassigned'}
            </span>
          </div>
        ))}
        {drafts.length > 0 && (
          <div style={{ padding: '10px 16px', borderTop: '1px solid #f1f5f9', fontSize: 11.5, color: '#94a3b8' }}>
            These clear automatically once a BM upload shows the new assignee (managed in the capacity planner — the CSV export lives there too).
          </div>
        )}
      </div>
    </div>
  );
}

function btn(kind) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '7px 12px', fontSize: 12.5, fontWeight: 600, fontFamily: font,
    borderRadius: 8, cursor: 'pointer',
    background: kind === 'primary' ? '#0f172a' : '#fff',
    color: kind === 'primary' ? '#fff' : '#475569',
    border: kind === 'primary' ? 'none' : '1px solid #e5e7eb',
  };
}
