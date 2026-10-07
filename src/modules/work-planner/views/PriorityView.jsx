import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DndContext, DragOverlay, useDraggable, useDroppable, PointerSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core';
import { callJobPlan } from '../plan/planQueries';
import { useWorkPlanner } from '../WorkPlannerModule';
import ProgressUpdateModal, { CONFIDENCE } from '../components/ProgressUpdateModal';
import { BTN } from '../../../lib/buttonStyles';
import { useAuth } from '../../../shell/AppShell';

// Priority (Bobby, 2026-10-06; sql/349). One column per submitter (the owner of
// the job's Submission task, who does the review; else the preparer), one tile per
// job with a filing in the six months the Overview counts. Drag a tile up or
// down to set the order the person works their column; the capacity queue in
// the job-plan function then dates each job's internal review — the job's
// internal deadline — from that person's hours a week on this work, never
// later than the statutory date less the buffer. Dropping writes the dates to
// the workflows (a job with no workflow gets a draft). Tiles open the task
// modal for the job, where Progress update and Create / Manage workflow live.

const font = "'Outfit', sans-serif";
const SERVICES = [
  { id: 'annual_accounts', label: 'Accounts' },
  { id: 'self_assessment', label: 'Self assessment' },
];
const fmt = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—');
const fmtY = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');
const first = (n) => String(n || '').split(' ')[0] || 'Someone';

function Tile({ job, colour, dragging, onOpen, report }) {
  const { attributes, listeners, setNodeRef: dragRef } = useDraggable({ id: job.key, disabled: job.review_done });
  const { setNodeRef: dropRef, isOver } = useDroppable({ id: job.key });
  const conf = job.last_update ? CONFIDENCE[job.last_update.confidence] : null;
  const shown = job.review_saved || job.review_computed;
  const red = job.capped || job.overdue;
  return (
    <div ref={dropRef} style={{ borderTop: isOver && !dragging ? '3px solid #0e7fe0' : '3px solid transparent' }}>
      <div ref={dragRef} {...attributes} {...listeners} onClick={() => onOpen(job)}
        style={{
          background: job.review_done ? '#f8fafc' : '#fff', opacity: dragging ? 0.35 : job.review_done ? 0.6 : 1,
          border: `1px solid ${red ? '#fca5a5' : '#e5e7eb'}`, borderLeft: `4px solid ${red ? '#dc2626' : colour || '#94a3b8'}`,
          borderRadius: 7, padding: '6px 8px', cursor: job.review_done ? 'pointer' : 'grab', fontSize: 12.5, userSelect: 'none',
        }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', minWidth: 18 }}>{job.review_done ? '✓' : job.position}</span>
          <span title={job.client} style={{ flex: 1, minWidth: 0, fontWeight: 600, color: '#0f172a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{job.client}</span>
          {conf && <span title={`Last update ${fmtY(job.last_update.created_at)}: ${conf.label}`} style={{ width: 9, height: 9, borderRadius: 5, background: conf.dot, flex: 'none' }} />}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 3, color: '#475569', flexWrap: 'wrap' }}>
          {job.review_done
            ? <span>Reviewed · {job.template_key === 'self_assessment' ? 'HMRC' : 'CH'} {fmtY(job.ch_deadline)}</span>
            : <>
                <span title="Internal review — the internal deadline">Review <b style={{ color: red ? '#991b1b' : '#0f172a', fontStyle: job.review_saved ? 'normal' : 'italic' }}>{fmt(shown)}</b></span>
                {job.out_of_date && job.review_saved && <span title="The queue now gives this date; set the column's dates to apply it" style={{ color: '#0e7fe0' }}>→ {fmt(job.review_computed)}</span>}
                <span style={{ color: '#94a3b8' }}>· {job.template_key === 'self_assessment' ? 'HMRC' : 'CH'} {fmtY(job.ch_deadline)}</span>
              </>}
        </div>
        {!job.review_done && (
          <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            {job.capped && <span title={`The queue can't reach it before ${fmt(job.limit)} (statutory less the buffer). Move it up, add hours or reassign.`} style={chip('#fee2e2', '#991b1b')}>{job.overdue ? 'Past safe date' : "Won't make it"}</span>}
            {!job.plan_id && <span title="No workflow yet: setting the dates creates a draft" style={chip('#f1f5f9', '#64748b')}>No workflow</span>}
            {job.plan_status === 'draft' && <span style={chip('#eff6ff', '#0e7fe0')}>Draft</span>}
            {job.prep_done && <span style={chip('#ede9fe', '#6d28d9')}>Prepared</span>}
            {report && <span title={[report.note, `reported ${fmtY(report.created_at)}`].filter(Boolean).join(' · ')} style={report.confidence === 'red' ? chip('#fee2e2', '#991b1b') : chip('#fef3c7', '#92400e')}>{report.confidence === 'red' ? 'Stuck' : 'Delayed'}</span>}
            <span style={{ marginLeft: 'auto', color: '#94a3b8', fontSize: 11 }}>{job.prep_done ? '' : `${Number(job.prep_hours)}h`}</span>
          </div>
        )}
      </div>
    </div>
  );
}
const chip = (bg, fg) => ({ fontSize: 10.5, fontWeight: 600, padding: '0 6px', borderRadius: 8, background: bg, color: fg, lineHeight: '17px' });

function ColumnEnd({ id }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return <div ref={setNodeRef} style={{ minHeight: 40, borderTop: isOver ? '3px solid #0e7fe0' : '3px solid transparent' }} />;
}

function HoursEdit({ col, onSave }) {
  const [v, setV] = useState(String(col.weekly_hours));
  const [editing, setEditing] = useState(false);
  useEffect(() => { setV(String(col.weekly_hours)); }, [col.weekly_hours]);
  if (!editing) {
    return (
      <button onClick={() => setEditing(true)} title="Hours a week this person gives to this work. The queue dates their column from it." style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontFamily: font, fontSize: 12, color: '#475569' }}>
        <b>{Number(col.weekly_hours)}h</b>/wk{!col.hours_set && <span style={{ color: '#94a3b8' }}> (½ capacity)</span>} ✎
      </button>
    );
  }
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <input type="number" min={0} max={80} step={0.5} value={v} onChange={(e) => setV(e.target.value)} style={{ width: 56, padding: '2px 4px', fontSize: 12, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 5 }} />
      <button onClick={() => { setEditing(false); onSave(Number(v)); }} style={{ ...BTN.primary.sm, padding: '1px 8px', fontSize: 11.5 }}>Save</button>
      <button onClick={() => { setEditing(false); setV(String(col.weekly_hours)); }} style={{ ...BTN.secondary.sm, padding: '1px 8px', fontSize: 11.5 }}>×</button>
    </span>
  );
}

export default function PriorityView({ onOpenTask, refreshTick }) {
  const { filters, staffMap, staffColours } = useWorkPlanner();
  const [params, setParams] = useSearchParams();
  const template = SERVICES.some((s) => s.id === params.get('template')) ? params.get('template') : 'annual_accounts';
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState({}); // staff_id -> message
  const [notice, setNotice] = useState(null);
  const [active, setActive] = useState(null);
  const [progress, setProgress] = useState(null);
  const { profile } = useAuth();
  // Delay and stuck reports still open (sql/350): a panel above the columns
  // and a chip on the tile, until someone marks them dealt with.
  const [reports, setReports] = useState([]);
  const [reportsOpen, setReportsOpen] = useState(false);
  const [busyReport, setBusyReport] = useState(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const loadReports = useCallback(async () => {
    try { setReports((await callJobPlan({ action: 'progress_reports' })).reports || []); } catch { /* panel just stays empty */ }
  }, []);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setBoard(await callJobPlan({ action: 'priority_board', template })); }
    catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
    loadReports();
  }, [template, loadReports]);
  useEffect(() => { load(); }, [load, refreshTick]);

  // Links in: ?job=entity|period_end&report=new (the Monday email's "Report a
  // delay or I'm stuck") opens that job's update set to Delayed; ?report=<id>
  // (the email to the manager, the bell) opens the reports panel.
  useEffect(() => {
    const k = params.get('job');
    if (!k || !board) return;
    const j = board.columns.flatMap((c) => c.jobs).find((x) => x.key === k);
    if (j) setProgress({ ...j, as: params.get('report') === 'new' ? 'amber' : null });
  }, [board, params]);
  useEffect(() => { const r = params.get('report'); if (r && r !== 'new') setReportsOpen(true); }, [params]);
  const reportOf = useMemo(() => {
    const m = {};
    reports.forEach((r) => { const k = `${r.template_key}:${r.entity_id}|${r.period_end}`; if (!m[k]) m[k] = r; });
    return m;
  }, [reports]);
  const dealtWith = async (r) => {
    const note = window.prompt(`Mark the report on ${r.entities?.name || 'this job'} as dealt with. A note on what was done (optional):`, '');
    if (note === null) return;
    setBusyReport(r.id); setError(null);
    try { await callJobPlan({ action: 'report_dealt_with', id: r.id, note: note.trim() || null }); await loadReports(); }
    catch (e) { setError(e.message || String(e)); }
    finally { setBusyReport(null); }
  };

  const columns = useMemo(() => {
    const cs = board?.columns || [];
    return filters.teamFilter ? cs.filter((c) => c.staff_id === filters.teamFilter) : cs;
  }, [board, filters.teamFilter]);
  const totals = useMemo(() => {
    const all = (board?.columns || []).flatMap((c) => c.jobs);
    return { jobs: all.length, wont: all.filter((j) => j.capped && !j.review_done).length };
  }, [board]);

  const replaceColumn = (col) => setBoard((b) => ({ ...b, columns: b.columns.map((c) => (c.staff_id === col.staff_id ? col : c)) }));
  const report = (name, applied) => {
    if (!applied) return;
    const bits = [];
    bits.push(applied.moved ? `${applied.moved} review date${applied.moved === 1 ? '' : 's'} moved` : 'no dates needed moving');
    if (applied.created) bits.push(`${applied.created} draft workflow${applied.created === 1 ? '' : 's'} created`);
    setNotice({ text: `${first(name)}: ${bits.join(', ')}.`, failed: applied.failed || [] });
  };
  const run = async (col, payload) => {
    setSaving((s) => ({ ...s, [col.staff_id]: 'Re-dating…' })); setError(null);
    try {
      const res = await callJobPlan({ template, staff_id: col.staff_id, ...payload });
      if (res.column) replaceColumn(res.column);
      report(col.name, res.applied);
    } catch (e) { setError(e.message || String(e)); await load(); }
    finally { setSaving((s) => { const n = { ...s }; delete n[col.staff_id]; return n; }); }
  };

  const onDragEnd = ({ active: a, over }) => {
    setActive(null);
    if (!over || a.id === over.id) return;
    const col = board.columns.find((c) => c.jobs.some((j) => j.key === a.id));
    if (!col) return;
    const keys = col.jobs.map((j) => j.key);
    const from = keys.indexOf(a.id);
    let to = String(over.id).startsWith('end:') ? (over.id === `end:${col.staff_id}` ? keys.length : -1) : keys.indexOf(over.id);
    if (to < 0) { setNotice({ text: 'A job stays in its submitter\'s column. To move it, reassign its Submission task.', failed: [] }); return; }
    keys.splice(from, 1);
    if (to > from) to -= 1;
    keys.splice(to, 0, a.id);
    // Optimistic: reorder now, dates follow from the server.
    const byKey = Object.fromEntries(col.jobs.map((j) => [j.key, j]));
    replaceColumn({ ...col, jobs: keys.map((k, i) => ({ ...byKey[k], position: i + 1 })) });
    run(col, { action: 'priority_reorder', keys });
  };

  const openJob = (j) => {
    const id = j.prep_job_id || j.ch_job_id;
    if (id && onOpenTask) onOpenTask({ type: 'bm', id });
  };
  const activeJob = active ? board?.columns.flatMap((c) => c.jobs).find((j) => j.key === active) : null;

  return (
    <div style={{ padding: '14px 20px', fontFamily: font, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, height: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', border: '1px solid #cbd5e1', borderRadius: 6, overflow: 'hidden' }}>
          {SERVICES.map((s) => (
            <button key={s.id} onClick={() => setParams((p) => { const n = new URLSearchParams(p); n.set('template', s.id); n.delete('job'); return n; })}
              style={{ ...BTN.secondary.sm, border: 'none', borderRadius: 0, padding: '4px 12px', background: template === s.id ? '#dbeafe' : '#fff', color: template === s.id ? '#0e7fe0' : '#334155', fontWeight: template === s.id ? 600 : 500 }}>{s.label}</button>
          ))}
        </span>
        {board && <span style={{ fontSize: 12.5, color: '#64748b' }}>
          {totals.jobs} jobs with a filing before {fmtY(board.window_end)} · buffer {board.settings.buffer_wd} working days
          {totals.wont > 0 && <> · <b style={{ color: '#991b1b' }}>{totals.wont} won't make it</b></>}
          {reports.length > 0 && <> · <button onClick={() => setReportsOpen((o) => !o)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: font, fontSize: 12.5, fontWeight: 700, color: '#92400e', textDecoration: 'underline' }}>{reports.length} delay{reports.length === 1 ? '' : 's'} / stuck reported</button></>}
          {loading && ' · loading…'}
        </span>}
        <button onClick={load} style={{ ...BTN.secondary.sm, marginLeft: 'auto' }}>Refresh</button>
      </div>
      <div style={{ fontSize: 12, color: '#94a3b8' }}>
        Drag a tile up or down to change the order. Review dates are worked out from that order, the person's hours a week on this work and their days off, never later than the statutory date less the buffer. <i>Italic</i> = not yet set on the workflow; <span style={{ color: '#0e7fe0' }}>→</span> = the queue now gives a different date.
      </div>
      {error && <div style={{ padding: '8px 12px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13 }}>{error}</div>}
      {reportsOpen && (
        <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 10, padding: '8px 12px', maxHeight: 260, overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: '#92400e', flex: 1 }}>Delays and stuck jobs reported · {reports.length}</span>
            <button onClick={() => setReportsOpen(false)} style={{ ...BTN.secondary.sm, padding: '0 8px' }}>×</button>
          </div>
          {reports.length === 0 && <div style={{ fontSize: 12.5, color: '#a16207' }}>Nothing open.</div>}
          {reports.map((r) => (
            <div key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '5px 0', borderTop: '1px solid #fde68a', fontSize: 13, background: params.get('report') === r.id ? '#fef3c7' : 'transparent' }}>
              <span style={r.confidence === 'red' ? chip('#fee2e2', '#991b1b') : chip('#fef3c7', '#92400e')}>{r.confidence === 'red' ? 'Stuck' : 'Delayed'}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <b>{r.entities?.name || 'Client'}</b>
                <span style={{ color: '#64748b' }}> · {r.template_key === 'self_assessment' ? 'Self assessment' : 'Accounts'} · {first(staffMap?.[r.author_id]?.name)} · {fmtY(r.created_at)}</span>
                {r.review_date_requested && <span style={{ color: '#64748b' }}> · review {fmt(r.review_date_before)} → {fmt(r.review_date_after)}</span>}
                {r.note && <div style={{ color: '#475569', whiteSpace: 'pre-wrap' }}>{r.note}</div>}
              </span>
              {profile?.can_manage_portal && <button disabled={busyReport === r.id} onClick={() => dealtWith(r)} style={BTN.secondary.sm}>{busyReport === r.id ? 'Saving…' : 'Dealt with'}</button>}
            </div>
          ))}
        </div>
      )}
      {notice && (
        <div style={{ padding: '8px 12px', borderRadius: 8, background: '#f0f9ff', border: '1px solid #bae6fd', color: '#075985', fontSize: 13, display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>{notice.text}{notice.failed.length > 0 && <div style={{ color: '#991b1b', marginTop: 4 }}>Couldn't date: {notice.failed.join('; ')}</div>}</div>
          <button onClick={() => setNotice(null)} style={{ ...BTN.secondary.sm, padding: '0 8px' }}>×</button>
        </div>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={(e) => setActive(e.active.id)} onDragEnd={onDragEnd} onDragCancel={() => setActive(null)}>
        <div style={{ display: 'flex', gap: 12, overflowX: 'auto', flex: 1, minHeight: 0, alignItems: 'flex-start', paddingBottom: 8 }}>
          {!loading && columns.length === 0 && <div style={{ padding: 30, color: '#94a3b8', fontSize: 13 }}>No jobs in the window{filters.teamFilter ? ' for this person' : ''}.</div>}
          {columns.map((col) => {
            const outOfDate = col.jobs.filter((j) => j.out_of_date).length;
            const wont = col.jobs.filter((j) => j.capped && !j.review_done).length;
            const hours = col.jobs.filter((j) => !j.review_done && !j.prep_done).reduce((s, j) => s + Number(j.prep_hours || 0), 0);
            return (
              <div key={col.staff_id} style={{ width: 268, flex: 'none', background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 10, display: 'flex', flexDirection: 'column', maxHeight: '100%' }}>
                <div style={{ padding: '10px 10px 8px', borderBottom: '1px solid #e5e7eb', background: '#fff', borderRadius: '10px 10px 0 0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 5, background: staffColours?.[col.staff_id] || '#94a3b8' }} />
                    <span style={{ fontWeight: 700, fontSize: 14, color: '#0f172a' }}>{col.name}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: '#64748b' }}>{col.jobs.length}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                    <HoursEdit col={col} onSave={(h) => run(col, { action: 'priority_set_hours', weekly_hours: h })} />
                    <span style={{ fontSize: 12, color: '#94a3b8' }}>· {Math.round(hours)}h to prepare</span>
                  </div>
                  {wont > 0 && <div style={{ fontSize: 11.5, color: '#991b1b', marginTop: 3 }}>{wont} can't be reached before the safe date</div>}
                  {saving[col.staff_id]
                    ? <div style={{ fontSize: 11.5, color: '#0e7fe0', marginTop: 4 }}>{saving[col.staff_id]}</div>
                    : outOfDate > 0 && <button onClick={() => run(col, { action: 'priority_apply' })} title="Write the queue's dates to the workflows; jobs with no workflow get a draft" style={{ ...BTN.secondary.sm, marginTop: 5, padding: '1px 8px', fontSize: 11.5 }}>Set {outOfDate} date{outOfDate === 1 ? '' : 's'}</button>}
                </div>
                <div style={{ padding: 8, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {col.jobs.map((j) => <Tile key={j.key} job={j} colour={staffColours?.[col.staff_id]} dragging={active === j.key} onOpen={openJob} report={reportOf[`${template}:${j.key}`]} />)}
                  <ColumnEnd id={`end:${col.staff_id}`} />
                </div>
              </div>
            );
          })}
        </div>
        <DragOverlay>{activeJob ? <div style={{ width: 250, padding: '6px 8px', background: '#fff', border: '1px solid #0e7fe0', borderRadius: 7, boxShadow: '0 6px 16px rgba(0,0,0,0.15)', fontSize: 12.5, fontWeight: 600, fontFamily: font }}>{activeJob.client}</div> : null}</DragOverlay>
      </DndContext>

      {progress && (
        <ProgressUpdateModal
          job={{ template_key: progress.template_key, entity_id: progress.entity_id, period_end: progress.period_end, client: progress.client, review_date: progress.review_saved || progress.review_computed, limit: progress.limit }}
          initialConfidence={progress.as}
          staffMap={staffMap}
          onClose={() => { setProgress(null); if (params.get('job')) setParams((p) => { const n = new URLSearchParams(p); n.delete('job'); n.delete('report'); return n; }); }}
          onSaved={() => load()}
        />
      )}
    </div>
  );
}
