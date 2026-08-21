import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Check, AlertCircle, RefreshCw, Play } from 'lucide-react';
import {
  listScheduleInRange, listStaffProfiles, listEntitiesAll,
  approveMyDrafts, rescheduleTask, listRules,
} from '../setup/queries';
import { runPlanner } from '../setup/planner';
import ClientTypeAhead from '../components/ClientTypeAhead';
import { useAuth } from '../../../shell/AppShell';

const font = "'Outfit', sans-serif";

// Fallback hours per working day, used only when a staff member has no
// configured weekly_capacity_hours. The configured number is the single
// capacity truth everywhere (the Capacity heatmap uses it too) — two
// different denominators used to give contradictory overload verdicts.
const FALLBACK_HOURS_PER_WORKING_DAY = 7.5;

// ── Zoom configurations ───────────────────────────────────────────
const ZOOMS = [
  { id: 'week',    label: 'Week',     columns: 5,  bucket: 'day',   weeks: 1 },
  { id: 'month',   label: '4 weeks',  columns: 4,  bucket: 'week',  weeks: 4 },
  { id: 'quarter', label: 'Quarter',  columns: 13, bucket: 'week',  weeks: 13 },
];

// ── Date helpers (UTC-stable) ─────────────────────────────────────
function startOfWeek(d) {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  const dow = out.getUTCDay(); // 0=Sun .. 6=Sat
  const delta = (dow === 0 ? -6 : 1 - dow); // roll to Monday
  out.setUTCDate(out.getUTCDate() + delta);
  return out;
}
function addDays(d, n) { const o = new Date(d); o.setUTCDate(o.getUTCDate() + n); return o; }
function isoDate(d) { return d.toISOString().slice(0, 10); }
function fmt(d, opts = { day: 'numeric', month: 'short' }) {
  return new Date(d.getTime() + d.getTimezoneOffset() * 60000).toLocaleDateString('en-GB', opts);
}

// Split a working_days string like "mon,tue,wed,thu,fri" into a Set of ISO day numbers (1..7, Mon=1).
function workingDaysToSet(wd) {
  const map = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };
  const s = new Set();
  (wd || '').split(',').map((x) => x.trim().toLowerCase()).forEach((d) => {
    if (map[d]) s.add(map[d]);
  });
  return s;
}
// How many working days fall inside [start, end] given the staff's days.
function countWorkingDays(startISO, endISO, workingSet) {
  const start = new Date(startISO + 'T00:00:00Z');
  const end = new Date(endISO + 'T00:00:00Z');
  let count = 0;
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    const dow = d.getUTCDay() || 7; // Sunday → 7
    if (workingSet.has(dow)) count++;
  }
  return count;
}

export default function WaitingView() {
  const { profile } = useAuth();
  const [zoom, setZoom] = useState('month');
  const [anchor, setAnchor] = useState(() => startOfWeek(new Date()));
  const [tasks, setTasks] = useState([]);
  const [staff, setStaff] = useState([]);
  const [entities, setEntities] = useState([]);
  const [ruleMap, setRuleMap] = useState({}); // { rule_id -> rule row }
  const [staffFilter, setStaffFilter] = useState([]);   // [] = all
  const [entityFilter, setEntityFilter] = useState(''); // '' = all
  const [serviceFilter, setServiceFilter] = useState('');
  // Default: show everything so the committed schedule is visible on
  // first load. Staff can flip to 'waiting' to zero in on pre-commit work.
  const [statusFilter, setStatusFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [approving, setApproving] = useState(null);
  const [draggingId, setDraggingId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null); // { assigneeId, colIndex }
  const [planning, setPlanning] = useState(false);
  const [plannerResult, setPlannerResult] = useState(null);

  const canPlan = profile?.is_portal_admin === true || profile?.can_import_data === true;

  const zoomCfg = ZOOMS.find((z) => z.id === zoom);
  const rangeStart = useMemo(() => anchor, [anchor]);
  const rangeEnd = useMemo(() => addDays(anchor, zoomCfg.weeks * 7 - 1), [anchor, zoomCfg]);

  const reload = async () => {
    setLoading(true); setError(null);
    try {
      const [ts, s, ents, rs] = await Promise.all([
        listScheduleInRange({
          startISO: isoDate(rangeStart),
          endISO: isoDate(rangeEnd),
          staffIds: staffFilter.length ? staffFilter : null,
          entityIds: entityFilter ? [entityFilter] : null,
          services: serviceFilter ? [serviceFilter] : null,
          statuses:
            statusFilter === 'all'     ? null :
            statusFilter === 'waiting' ? ['draft', 'approved'] :
                                         [statusFilter],
        }),
        listStaffProfiles(),
        listEntitiesAll(),
        listRules(),
      ]);
      setTasks(ts);
      setStaff(s.filter((x) => x.is_active));
      setEntities(ents);
      const rmap = {};
      for (const r of rs || []) rmap[r.id] = r;
      setRuleMap(rmap);
    } catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [zoom, anchor, staffFilter, entityFilter, serviceFilter, statusFilter]);

  // ── Derived: distinct services (for filter chip) ─────────────
  const services = useMemo(() => {
    const s = new Set();
    for (const t of tasks) if (t.service) s.add(t.service);
    for (const x of staff) { /* noop */ }
    return [...s].sort();
  }, [tasks]);

  // ── Derived: assignees present in current window (for rows) ──
  const assigneesShown = useMemo(() => {
    if (staffFilter.length) {
      return staff.filter((s) => staffFilter.includes(s.id));
    }
    // Otherwise show all assignees who have rows in this range + always show "unassigned" if any
    const ids = new Set(tasks.map((t) => t.assignee_id).filter(Boolean));
    const list = staff.filter((s) => ids.has(s.id));
    if (tasks.some((t) => !t.assignee_id)) list.push({ id: null, name: 'Unassigned', working_days: '' });
    return list;
  }, [tasks, staff, staffFilter]);

  // ── Bucket tasks per (assignee, column) ─────────────────────
  const columns = useMemo(() => buildColumns(rangeStart, zoomCfg), [rangeStart, zoomCfg]);
  const grid = useMemo(() => {
    const byAssignee = {};
    for (const a of assigneesShown) byAssignee[a.id || 'unassigned'] = columns.map(() => []);
    for (const t of tasks) {
      const aKey = t.assignee_id || 'unassigned';
      if (!(aKey in byAssignee)) continue;
      const col = findColumn(t.scheduled_for_date, columns);
      if (col < 0) continue;
      byAssignee[aKey][col].push(t);
    }
    return byAssignee;
  }, [tasks, assigneesShown, columns]);

  const entityMap = useMemo(() => {
    const m = {};
    for (const e of entities) m[e.id] = e.name;
    return m;
  }, [entities]);

  // Cycle id detection for the Approve action: all draft rows for a given
  // assignee should share the same draft_cycle_id. If mixed (edge case),
  // we take the most common one.
  const approveForAssignee = async (assigneeId) => {
    const mine = tasks.filter((t) => t.assignee_id === assigneeId && t.status === 'draft');
    if (mine.length === 0) return;
    const counts = {};
    for (const t of mine) counts[t.draft_cycle_id] = (counts[t.draft_cycle_id] || 0) + 1;
    const cycleId = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    if (!confirm(`Approve ${mine.length} draft row${mine.length === 1 ? '' : 's'} for this person? Once everyone in the cycle approves, they auto-commit to the work plan.`)) return;
    setApproving(assigneeId); setError(null);
    try {
      await approveMyDrafts(assigneeId, cycleId);
      await reload();
    } catch (e) { setError(e.message || String(e)); }
    finally { setApproving(null); }
  };

  const nav = (dir) => {
    const step = zoomCfg.weeks * 7;
    setAnchor((prev) => addDays(prev, dir * step));
  };

  const runPlan = async () => {
    if (!confirm('Run planner over the next 9 months? Every BM task that matches a rule will be re-placed as a draft. Existing scheduling is superseded.')) return;
    setPlanning(true); setError(null); setPlannerResult(null);
    try {
      const res = await runPlanner({ horizonMonths: 9 });
      setPlannerResult(res);
      await reload();
    } catch (e) { setError(e.message || String(e)); }
    finally { setPlanning(false); }
  };

  // ── Drag-drop rescheduling ───────────────────────────────────
  // Dropping a task on a cell pins it to the first day of that cell
  // and stamps manually_overridden_at — so future planner runs leave
  // it alone. Committed rows can still be dragged; the override stamp
  // makes the change stick across re-imports.
  const handleTaskDrop = async (taskId, targetColStart) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (task.scheduled_for_date === targetColStart) return; // no-op

    // Optimistic update
    setTasks((prev) => prev.map((t) => t.id === taskId
      ? { ...t, scheduled_for_date: targetColStart, manually_overridden_at: new Date().toISOString() }
      : t));
    try {
      await rescheduleTask(taskId, targetColStart);
    } catch (e) {
      setError(e.message || String(e));
      await reload();
    }
  };

  return (
    <div style={{ padding: '16px 20px', fontFamily: font, height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Top bar */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        {/* Zoom */}
        <div style={{ display: 'flex', background: '#f1f5f9', borderRadius: 8, padding: 2 }}>
          {ZOOMS.map((z) => (
            <button key={z.id} onClick={() => setZoom(z.id)}
              style={{
                padding: '6px 14px', fontSize: 12, fontWeight: 600,
                border: 'none', borderRadius: 6, cursor: 'pointer',
                background: zoom === z.id ? '#fff' : 'transparent',
                color: zoom === z.id ? '#0f172a' : '#64748b',
                boxShadow: zoom === z.id ? '0 1px 2px rgba(15,23,42,0.08)' : 'none',
                fontFamily: font,
              }}>{z.label}</button>
          ))}
        </div>

        {/* Nav */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button onClick={() => nav(-1)} style={navBtn}><ChevronLeft size={14} /></button>
          <button onClick={() => setAnchor(startOfWeek(new Date()))} style={todayBtn}>Today</button>
          <button onClick={() => nav(1)} style={navBtn}><ChevronRight size={14} /></button>
          <span style={{ fontSize: 13, fontWeight: 500, color: '#475569', marginLeft: 6 }}>
            {fmt(rangeStart)} — {fmt(rangeEnd)}
          </span>
        </div>

        <div style={{ flex: 1 }} />

        {/* Filters */}
        <StaffFilter staff={staff} value={staffFilter} onChange={setStaffFilter} profileId={profile?.id} />
        <div style={{ minWidth: 180 }}>
          <ClientTypeAhead entityList={entities} value={entityFilter} onChange={setEntityFilter} size="small" />
        </div>
        <select value={serviceFilter} onChange={(e) => setServiceFilter(e.target.value)} style={selStyle}>
          <option value="">All services</option>
          {services.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selStyle}>
          <option value="waiting">Waiting (draft + approved)</option>
          <option value="draft">Draft only</option>
          <option value="approved">Approved (pending commit)</option>
          <option value="committed">Committed (live)</option>
          <option value="all">All</option>
        </select>
        <button onClick={reload} style={navBtn} title="Refresh"><RefreshCw size={13} /></button>
        {canPlan && (
          <button
            onClick={runPlan}
            disabled={planning}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '6px 12px', fontSize: 12, fontWeight: 600,
              border: 'none', borderRadius: 6,
              background: '#0f172a', color: '#fff',
              cursor: planning ? 'wait' : 'pointer', fontFamily: font,
              opacity: planning ? 0.6 : 1,
            }}
            title="Re-draft the next 9 months from BM tasks using current rules"
          >
            <Play size={12} /> {planning ? 'Planning…' : 'Plan 9 months'}
          </button>
        )}
      </div>

      {plannerResult && (
        <div style={{
          padding: '8px 12px', borderRadius: 8, marginBottom: 10,
          background: '#eff6ff', border: '1px solid #bfdbfe',
          color: '#1e3a8a', fontSize: 12,
        }}>
          Planner cycle <code>{plannerResult.cycleId.slice(0, 8)}</code> — scanned {plannerResult.total},
          drafted <b>{plannerResult.planned}</b>, skipped {plannerResult.noMatch} (no rule),
          {plannerResult.noDeadline} (no deadline), {plannerResult.outOfHorizon} (beyond 9mo)
          {plannerResult.skippedNST > 0 ? `, ${plannerResult.skippedNST} NST` : ''}.
        </div>
      )}

      {error && (
        <div style={{ ...banner, marginBottom: 10 }}>
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {/* Grid */}
      <div style={{ flex: 1, overflow: 'auto', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10 }}>
        {loading ? (
          <div style={{ padding: 30, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>Loading…</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ background: '#f8fafc', position: 'sticky', top: 0, zIndex: 2 }}>
                <th style={{ ...gridTh, width: 180, textAlign: 'left' }}>Assignee</th>
                {columns.map((c, i) => (
                  <th key={i} style={gridTh}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {assigneesShown.length === 0 ? (
                <tr>
                  <td colSpan={columns.length + 1} style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 4 }}>
                      No {statusFilter === 'all' ? '' : statusFilter + ' '}tasks in this range.
                    </div>
                    <div style={{ fontSize: 12 }}>
                      {statusFilter !== 'all' && (
                        <>Try <button onClick={() => setStatusFilter('all')} style={{ ...btnLink }}>show all</button> · </>
                      )}
                      {canPlan && (
                        <>Or <button onClick={runPlan} style={{ ...btnLink }}>plan the next 9 months</button> to generate drafts.</>
                      )}
                    </div>
                  </td>
                </tr>
              ) : assigneesShown.map((a) => {
                const aKey = a.id || 'unassigned';
                const rowTasks = grid[aKey] || columns.map(() => []);
                const totalHours = rowTasks.flat().reduce((s, t) => s + (Number(t.scheduled_hours) || 0), 0);
                const draftCount = rowTasks.flat().filter((t) => t.status === 'draft').length;
                const wdSet = workingDaysToSet(a.working_days || 'mon,tue,wed,thu,fri');
                const wdCount = countWorkingDays(isoDate(rangeStart), isoDate(rangeEnd), wdSet);
                // Per-working-day rate derived from the person's configured
                // weekly hours (÷ their working days per week), so capacity
                // means the same thing here as on the Capacity heatmap.
                const hoursPerDay = a.weekly_capacity_hours && wdSet.size > 0
                  ? Number(a.weekly_capacity_hours) / wdSet.size
                  : FALLBACK_HOURS_PER_WORKING_DAY;
                const capHours = wdCount * hoursPerDay;
                const overCap = totalHours > capHours && capHours > 0;
                return (
                  <tr key={aKey} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '8px 10px', verticalAlign: 'top' }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#0f172a' }}>{a.name}</div>
                      <div style={{ fontSize: 10, color: overCap ? '#dc2626' : '#94a3b8', marginTop: 2 }}>
                        {totalHours.toFixed(1)}h / {capHours.toFixed(0)}h cap
                      </div>
                      {draftCount > 0 && a.id && (
                        <button
                          onClick={() => approveForAssignee(a.id)}
                          disabled={approving === a.id}
                          style={{
                            marginTop: 4,
                            display: 'inline-flex', alignItems: 'center', gap: 3,
                            fontSize: 10, padding: '2px 8px', borderRadius: 6,
                            background: '#dbeafe', color: '#0e7fe0', border: '1px solid #bfdbfe',
                            cursor: approving === a.id ? 'wait' : 'pointer', fontFamily: font,
                          }}>
                          <Check size={10} /> {approving === a.id ? 'Approving…' : `Approve ${draftCount}`}
                        </button>
                      )}
                    </td>
                    {columns.map((c, i) => {
                      const cellTasks = rowTasks[i] || [];
                      const isDropTarget = dropTarget && dropTarget.assigneeId === aKey && dropTarget.colIndex === i;
                      return (
                        <td
                          key={i}
                          onDragOver={(e) => {
                            if (!draggingId) return;
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'move';
                            if (!isDropTarget) setDropTarget({ assigneeId: aKey, colIndex: i });
                          }}
                          onDragLeave={() => { if (isDropTarget) setDropTarget(null); }}
                          onDrop={(e) => {
                            e.preventDefault();
                            const id = e.dataTransfer.getData('text/plain') || draggingId;
                            setDropTarget(null);
                            setDraggingId(null);
                            if (id) handleTaskDrop(id, c.start);
                          }}
                          style={{
                            padding: 3, verticalAlign: 'top',
                            borderLeft: '1px solid #f1f5f9',
                            minWidth: zoom === 'week' ? 140 : 90,
                            background: isDropTarget ? '#eff6ff' : undefined,
                            outline: isDropTarget ? '2px dashed #0e7fe0' : undefined,
                            outlineOffset: -2,
                          }}>
                          {cellTasks.map((t) => (
                            <TaskCard
                              key={t.id}
                              task={t}
                              entityName={entityMap[t.entity_id]}
                              ruleColour={t.rule_id ? ruleMap[t.rule_id]?.colour : null}
                              compact={zoom !== 'week'}
                              onDragStart={(e) => { e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; setDraggingId(t.id); }}
                              onDragEnd={() => { setDraggingId(null); setDropTarget(null); }}
                              dragging={draggingId === t.id}
                            />
                          ))}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function TaskCard({ task, entityName, ruleColour, compact, onDragStart, onDragEnd, dragging }) {
  const isDraft = task.status === 'draft';
  const isApproved = task.status === 'approved';
  const isCommitted = task.status === 'committed';
  const hasOverride = !!task.manually_overridden_at;

  // Whole-bar bg = task type colour (from rule). Fallback neutral grey.
  const rawBg = ruleColour || '#e5e7eb';
  // Drafts dim slightly, approved brighten a touch — keeps lifecycle cue.
  const bg = isDraft ? tintColour(rawBg, 0.15) : rawBg;
  const textColour = contrastText(bg);

  // Left 3px border = effort heatmap. 0h blue → 14h+ fire-engine red.
  const scheduledH = Number(task.scheduled_hours) || 0;
  const effortColour = effortGradient(scheduledH);

  // Remaining = scheduled − logged (both in hours on the view row).
  // Fall back to scheduled if view didn't provide remaining_hours.
  const remaining = task.remaining_hours != null ? Number(task.remaining_hours) : scheduledH;
  const remainingMins = Math.max(0, Math.round(remaining * 60));
  const scheduledMins = Math.round(scheduledH * 60);

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      title={`${task.bm_task_name}${entityName ? ' • ' + entityName : ''} • ${task.service || ''}\nScheduled ${scheduledMins}m · Remaining ${remainingMins}m\nDrag to reschedule`}
      style={{
        padding: compact ? '2px 6px' : '4px 7px',
        marginBottom: 2,
        fontSize: 10,
        borderRadius: 4,
        borderLeft: `3px ${isDraft ? 'dashed' : 'solid'} ${effortColour}`,
        background: bg,
        color: textColour,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        cursor: 'grab',
        opacity: dragging ? 0.5 : 1,
        userSelect: 'none',
      }}>
      {hasOverride && <span title="Manually overridden" style={{ fontSize: 8, marginRight: 3 }}>📌</span>}
      <span style={{ fontWeight: isCommitted ? 500 : 600 }}>{entityName || task.bm_task_name}</span>
      <span style={{ opacity: 0.75, marginLeft: 4 }}>· {formatMins(remainingMins)}</span>
    </div>
  );
}

// ── Colour helpers ───────────────────────────────────────────────
function hexToRgb(hex) {
  if (!hex) return null;
  const m = hex.replace('#', '').match(/^([a-f0-9]{6}|[a-f0-9]{3})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function rgbToHex(r, g, b) {
  const to = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}
// Relative luminance per WCAG — used to pick black vs white text.
function luminance({ r, g, b }) {
  const ch = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
function contrastText(hex) {
  const rgb = hexToRgb(hex) || { r: 200, g: 200, b: 200 };
  return luminance(rgb) > 0.55 ? '#0f172a' : '#f8fafc';
}
// Mix hex toward white by `amount` ∈ [0,1].
function tintColour(hex, amount) {
  const rgb = hexToRgb(hex) || { r: 229, g: 231, b: 235 };
  return rgbToHex(
    rgb.r + (255 - rgb.r) * amount,
    rgb.g + (255 - rgb.g) * amount,
    rgb.b + (255 - rgb.b) * amount,
  );
}
// Effort gradient: 0h = blue (#3b82f6), 14+ = fire-engine red (#dc2626).
// Linear RGB interpolation — simple and visually monotonic for this pair.
function effortGradient(hours) {
  const t = Math.max(0, Math.min(1, (Number(hours) || 0) / 14));
  const a = { r: 59, g: 130, b: 246 };   // #3b82f6
  const b = { r: 220, g: 38, b: 38 };    // #dc2626
  return rgbToHex(
    a.r + (b.r - a.r) * t,
    a.g + (b.g - a.g) * t,
    a.b + (b.b - a.b) * t,
  );
}
function formatMins(m) {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

function StaffFilter({ staff, value, onChange, profileId }) {
  const [open, setOpen] = useState(false);
  const ref = React.useRef(null);
  useEffect(() => {
    function h(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const label = value.length === 0 ? 'All staff' : value.length === 1 ? (staff.find((s) => s.id === value[0])?.name || '1 selected') : `${value.length} staff`;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} style={selStyle}>{label} ▾</button>
      {open && (
        <div style={{ position: 'absolute', top: '100%', right: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.1)', zIndex: 20, padding: 8, minWidth: 220, maxHeight: 320, overflow: 'auto' }}>
          <button onClick={() => onChange([])} style={{ ...btnGhost, fontSize: 11, marginBottom: 4 }}>Clear / All</button>
          {profileId && (
            <button onClick={() => onChange([profileId])} style={{ ...btnGhost, fontSize: 11, marginBottom: 4 }}>Just me</button>
          )}
          {staff.map((s) => {
            const checked = value.includes(s.id);
            return (
              <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 2px', cursor: 'pointer', fontSize: 12 }}>
                <input type="checkbox" checked={checked} onChange={() => {
                  if (checked) onChange(value.filter((v) => v !== s.id));
                  else onChange([...value, s.id]);
                }} />
                {s.name}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Column builders ───────────────────────────────────────────────
function buildColumns(startDate, zoomCfg) {
  const cols = [];
  if (zoomCfg.bucket === 'day') {
    for (let i = 0; i < zoomCfg.columns; i++) {
      const d = addDays(startDate, i);
      cols.push({ start: isoDate(d), end: isoDate(d), label: d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' }) });
    }
  } else {
    for (let i = 0; i < zoomCfg.columns; i++) {
      const s = addDays(startDate, i * 7);
      const e = addDays(s, 6);
      cols.push({ start: isoDate(s), end: isoDate(e), label: `w/c ${fmt(s, { day: 'numeric', month: 'short' })}` });
    }
  }
  return cols;
}
function findColumn(dateISO, columns) {
  if (!dateISO) return -1;
  for (let i = 0; i < columns.length; i++) {
    if (dateISO >= columns[i].start && dateISO <= columns[i].end) return i;
  }
  return -1;
}

const gridTh = { padding: '8px 6px', fontSize: 10, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid #e5e7eb' };

const navBtn = {
  width: 28, height: 28, border: '1px solid #e5e7eb', background: '#fff',
  borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  color: '#475569', fontFamily: font,
};
const todayBtn = {
  padding: '6px 10px', fontSize: 12, fontWeight: 500,
  border: '1px solid #e5e7eb', background: '#fff', borderRadius: 6,
  cursor: 'pointer', color: '#475569', fontFamily: font,
};
const selStyle = {
  padding: '6px 10px', fontSize: 12, fontFamily: font,
  border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff',
  color: '#0f172a', cursor: 'pointer',
};
const btnGhost = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '4px 8px', background: 'none', border: 'none',
  color: '#64748b', cursor: 'pointer', fontFamily: font,
};
const btnLink = {
  background: 'none', border: 'none', padding: 0,
  color: '#0e7fe0', cursor: 'pointer', fontSize: 12,
  fontFamily: font, textDecoration: 'underline',
};
const banner = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '8px 12px', borderRadius: 8,
  background: '#fee2e2', border: '1px solid #fca5a5',
  color: '#991b1b', fontSize: 13,
};
