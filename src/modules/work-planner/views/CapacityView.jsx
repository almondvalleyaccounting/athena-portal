import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useWorkPlanner } from '../WorkPlannerModule';
import { useAuth } from '../../../shell/AppShell';
import {
  fetchBmLoadClassified, fetchAllocationDrafts, fetchCapacityShifts,
  upsertCapacityShift, commitCapacityShifts, discardCapacityShift,
  updateStaffCapacityHours,
} from '../lib/allocationsQueries';
import { teamColour } from '../lib/helpers';

const STAFF_COL_W = 220;
const MONTH_COL_W = 88;
const ROW_H = 44;
const MONTHS_AHEAD = 12;
const DEFAULT_WEEKLY_CAPACITY = 35;
const WORKING_WEEKS_PER_MONTH = 4.33;

function monthStart(d) {
  const x = new Date(d);
  return new Date(x.getFullYear(), x.getMonth(), 1);
}
function addMonths(d, n) {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}
function isoMonth(d) {
  // YYYY-MM-01
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function fmtMonth(d) {
  return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
}

export default function CapacityView() {
  const { staffList, staffMap } = useWorkPlanner();
  const { profile } = useAuth();

  const [rows, setRows] = useState([]);            // v_bm_load_classified
  const [drafts, setDrafts] = useState([]);        // allocation_changes (proposals)
  const [shifts, setShifts] = useState([]);
  const [showProposed, setShowProposed] = useState(true);
  const [showShifts, setShowShifts] = useState(true);
  const [loading, setLoading] = useState(true);
  const [editingCapacity, setEditingCapacity] = useState(null);
  const [capacityDraft, setCapacityDraft] = useState('');
  const [shiftPopover, setShiftPopover] = useState(null); // { staff, monthIso, x, y }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [r, d, s] = await Promise.all([
          fetchBmLoadClassified(),
          fetchAllocationDrafts(),
          fetchCapacityShifts(),
        ]);
        if (!cancelled) {
          setRows(r);
          setDrafts(d);
          setShifts(s.filter((x) => x.status !== 'discarded'));
        }
      } catch (e) {
        console.error('[Capacity] load failed:', e);
      }
      if (!cancelled) setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const months = useMemo(() => {
    const start = monthStart(new Date());
    return Array.from({ length: MONTHS_AHEAD }, (_, i) => addMonths(start, i));
  }, []);

  // Drafts indexed by (entity_id, canonical_service_id) for reallocation lookup.
  const draftLookup = useMemo(() => {
    const m = new Map();
    drafts.forEach((d) => m.set(`${d.entity_id}__${d.canonical_service_id}`, d.proposed_fee_earner_id || null));
    return m;
  }, [drafts]);

  // Hours per (staffId, isoMonth). Layered:
  //   1. BM baseline (rows from v_bm_load_classified)
  //   2. Reallocation proposals (showProposed=true): redirect rows to proposed assignee
  //   3. Capacity shifts (showShifts=true): subtract from source month, add to target month
  const hoursMap = useMemo(() => {
    const m = new Map();
    const add = (sid, monthIso, hours) => {
      if (!sid) return;
      const k = `${sid}__${monthIso}`;
      m.set(k, (m.get(k) || 0) + hours);
    };
    rows.forEach((row) => {
      const monthIso = row.month.slice(0, 10);
      const hours = Number(row.hours) || 0;
      let assignee = row.assignee_id;
      if (showProposed && row.canonical_service_id) {
        const draftKey = `${row.entity_id}__${row.canonical_service_id}`;
        if (draftLookup.has(draftKey)) {
          assignee = draftLookup.get(draftKey);
        }
      }
      add(assignee, monthIso, hours);
    });
    if (showShifts) {
      shifts.filter((s) => s.status === 'draft' || s.status === 'committed').forEach((s) => {
        const h = Number(s.hours) || 0;
        if (h <= 0) return;
        add(s.staff_id, String(s.source_month).slice(0, 10), -h);
        add(s.staff_id, String(s.target_month).slice(0, 10),  h);
      });
    }
    return m;
  }, [rows, draftLookup, showProposed, shifts, showShifts]);

  // Baseline (pre-reallocation) hours per (staffId, isoMonth) — used for diff display.
  const baselineMap = useMemo(() => {
    const m = new Map();
    rows.forEach((row) => {
      const k = `${row.assignee_id}__${row.month.slice(0, 10)}`;
      m.set(k, (m.get(k) || 0) + (Number(row.hours) || 0));
    });
    return m;
  }, [rows]);

  const draftCount = drafts.length;

  // Monthly capacity per staff: weekly_capacity_hours (or default) × 4.33
  const monthlyCapacity = useCallback((s) => {
    const weekly = Number(s.weekly_capacity_hours) || DEFAULT_WEEKLY_CAPACITY;
    return weekly * WORKING_WEEKS_PER_MONTH;
  }, []);

  const orderedStaff = useMemo(
    () => staffList
      .filter((s) => s.is_active !== false && s.work_planner !== false)
      .sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [staffList]
  );

  const draftShiftCount = shifts.filter((x) => x.status === 'draft').length;

  const handleSaveCapacity = useCallback(async (staffId) => {
    const n = Number(capacityDraft);
    if (Number.isNaN(n) || n < 0) {
      alert('Enter a positive number of hours per week.');
      return;
    }
    await updateStaffCapacityHours(staffId, n);
    // Mutate the staff list locally so the view reflects the change.
    const s = staffList.find((x) => x.id === staffId);
    if (s) s.weekly_capacity_hours = n;
    setEditingCapacity(null);
    setCapacityDraft('');
  }, [capacityDraft, staffList]);

  const handleCommitShifts = useCallback(async () => {
    const ids = shifts.filter((s) => s.status === 'draft').map((s) => s.id);
    if (!ids.length) return;
    if (!confirm(`Commit ${ids.length} pending capacity shift${ids.length === 1 ? '' : 's'}?`)) return;
    await commitCapacityShifts(ids);
    setShifts((prev) => prev.map((s) => s.status === 'draft' ? { ...s, status: 'committed' } : s));
  }, [shifts]);

  const handleProposeShift = useCallback(async (payload) => {
    const saved = await upsertCapacityShift({
      ...payload,
      status: 'draft',
      created_by: profile?.id ?? null,
    });
    setShifts((prev) => [...prev, saved]);
  }, [profile]);

  const handleDiscardShifts = useCallback(async () => {
    const drafts = shifts.filter((s) => s.status === 'draft');
    if (!drafts.length) return;
    if (!confirm(`Discard ${drafts.length} pending capacity shift${drafts.length === 1 ? '' : 's'}?`)) return;
    await Promise.all(drafts.map((d) => discardCapacityShift(d.id)));
    setShifts((prev) => prev.filter((s) => s.status !== 'draft'));
  }, [shifts]);

  if (loading) {
    return <div style={{ padding: 24, color: '#94a3b8', fontSize: 14 }}>Loading capacity…</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: "'Outfit', sans-serif" }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px',
        borderBottom: '1px solid #e5e7eb', background: '#f8fafc',
      }}>
        <div style={{ fontSize: 13, color: '#475569' }}>
          Monthly load from BM tasks vs each member's weekly capacity × 4.33.
        </div>
        {draftCount > 0 && (
          <label style={{
            fontSize: 12, color: '#475569',
            display: 'flex', alignItems: 'center', gap: 6,
            background: '#fef3c7', border: '1px solid #fde68a',
            padding: '4px 10px', borderRadius: 12,
          }}>
            <input
              type="checkbox"
              checked={showProposed}
              onChange={(e) => setShowProposed(e.target.checked)}
            />
            Apply {draftCount} proposed reallocation{draftCount === 1 ? '' : 's'}
          </label>
        )}
        {shifts.length > 0 && (
          <label style={{
            fontSize: 12, color: '#475569',
            display: 'flex', alignItems: 'center', gap: 6,
            background: '#dbeafe', border: '1px solid #93c5fd',
            padding: '4px 10px', borderRadius: 12,
          }}>
            <input
              type="checkbox"
              checked={showShifts}
              onChange={(e) => setShowShifts(e.target.checked)}
            />
            Apply {shifts.length} pull-forward shift{shifts.length === 1 ? '' : 's'}
          </label>
        )}
        <div style={{ flex: 1 }} />
        {draftShiftCount > 0 && (
          <>
            <span style={{
              fontSize: 12, color: '#92400e', background: '#fef3c7',
              border: '1px solid #fde68a', padding: '4px 10px', borderRadius: 12,
            }}>
              {draftShiftCount} pending shift{draftShiftCount === 1 ? '' : 's'}
            </span>
            <button onClick={handleDiscardShifts} style={btnStyle('ghost')}>Discard all</button>
            <button onClick={handleCommitShifts} style={btnStyle('primary')}>Commit all</button>
          </>
        )}
      </div>

      {/* Heatmap */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        <div style={{ display: 'inline-block', minWidth: '100%' }}>
          {/* Header */}
          <div style={{ display: 'flex', position: 'sticky', top: 0, background: '#fff', zIndex: 2 }}>
            <div style={headerCellStyle(STAFF_COL_W, 'left')}>Team member</div>
            {months.map((m) => (
              <div key={isoMonth(m)} style={headerCellStyle(MONTH_COL_W)}>{fmtMonth(m)}</div>
            ))}
            <div style={headerCellStyle(MONTH_COL_W + 20)}>12-mo total</div>
          </div>

          {orderedStaff.map((s) => {
            const cap = monthlyCapacity(s);
            let totalHours = 0;
            return (
              <div key={s.id} style={{ display: 'flex', borderBottom: '1px solid #f1f5f9' }}>
                <div style={{
                  width: STAFF_COL_W, minWidth: STAFF_COL_W, height: ROW_H,
                  padding: '0 10px', display: 'flex', alignItems: 'center', gap: 8,
                  borderRight: '1px solid #e5e7eb', background: '#fff',
                  position: 'sticky', left: 0, zIndex: 1,
                }}>
                  <span style={{
                    width: 10, height: 10, borderRadius: '50%',
                    background: s.colour || teamColour(s.id),
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.name}
                    </div>
                    <div style={{ fontSize: 10, color: '#94a3b8' }}>
                      {editingCapacity === s.id ? (
                        <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                          <input
                            type="number"
                            value={capacityDraft}
                            onChange={(e) => setCapacityDraft(e.target.value)}
                            style={{ width: 50, fontSize: 10, padding: '1px 3px', border: '1px solid #cbd5e1', borderRadius: 3 }}
                            autoFocus
                          />
                          h/wk
                          <button onClick={() => handleSaveCapacity(s.id)} style={miniBtn('save')}>✓</button>
                          <button onClick={() => { setEditingCapacity(null); setCapacityDraft(''); }} style={miniBtn('cancel')}>×</button>
                        </span>
                      ) : (
                        <span
                          onClick={() => {
                            setEditingCapacity(s.id);
                            setCapacityDraft(String(s.weekly_capacity_hours || ''));
                          }}
                          style={{ cursor: 'pointer' }}
                          title="Click to edit weekly capacity"
                        >
                          {(s.weekly_capacity_hours ?? `${DEFAULT_WEEKLY_CAPACITY}*`)}h/wk → {Math.round(cap)}h/mo
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                {months.map((m) => {
                  const key = `${s.id}__${isoMonth(m)}`;
                  const hours = hoursMap.get(key) || 0;
                  const baseline = baselineMap.get(key) || 0;
                  const delta = (showProposed && draftCount > 0) || (showShifts && shifts.length > 0) ? hours - baseline : 0;
                  totalHours += hours;
                  return (
                    <HeatCell
                      key={key}
                      hours={hours}
                      capacity={cap}
                      delta={delta}
                      onClick={(ev) => {
                        const r = ev.currentTarget.getBoundingClientRect();
                        setShiftPopover({
                          staff: s,
                          monthIso: isoMonth(m),
                          monthLabel: fmtMonth(m),
                          x: r.left,
                          y: r.bottom + 4,
                        });
                      }}
                    />
                  );
                })}
                <div style={{
                  width: MONTH_COL_W + 20, minWidth: MONTH_COL_W + 20, height: ROW_H,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 13, fontWeight: 600, color: '#0f172a',
                  borderLeft: '1px solid #e5e7eb',
                }}>
                  {Math.round(totalHours)}h
                </div>
              </div>
            );
          })}

          {/* Legend */}
          <div style={{ display: 'flex', gap: 12, padding: '12px 6px', fontSize: 11, color: '#64748b', alignItems: 'center' }}>
            <span>Load vs capacity:</span>
            <Swatch colour="#dbeafe" label="< 50%" />
            <Swatch colour="#bbf7d0" label="50–80%" />
            <Swatch colour="#fde68a" label="80–100%" />
            <Swatch colour="#fecaca" label="100–120%" />
            <Swatch colour="#fca5a5" label="> 120%" />
            <span style={{ marginLeft: 16, fontStyle: 'italic' }}>* default capacity if not set</span>
          </div>
        </div>
      </div>

      <ShiftPopover
        popover={shiftPopover}
        months={months}
        onClose={() => setShiftPopover(null)}
        onSubmit={handleProposeShift}
      />
    </div>
  );
}

function HeatCell({ hours, capacity, delta = 0, onClick }) {
  const pct = capacity > 0 ? hours / capacity : 0;
  const colour = heatColour(pct);
  const text = hours > 0 ? `${Math.round(hours)}` : '';
  const showDelta = Math.abs(delta) >= 0.5;
  return (
    <div
      onClick={onClick}
      title={`${Math.round(hours)}h of ${Math.round(capacity)}h capacity (${Math.round(pct * 100)}%)${showDelta ? ` — ${delta > 0 ? '+' : ''}${Math.round(delta)}h vs baseline` : ''}\nClick to pull forward / push out hours.`}
      style={{
        width: MONTH_COL_W, minWidth: MONTH_COL_W, height: ROW_H,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        background: colour, borderRight: '1px solid #f1f5f9',
        fontSize: 12, fontWeight: hours > 0 ? 600 : 400,
        color: pct > 1.0 ? '#7f1d1d' : '#0f172a',
        cursor: 'pointer',
      }}
    >
      <span>{text}</span>
      {showDelta && (
        <span style={{
          fontSize: 9, fontWeight: 600,
          color: delta > 0 ? '#7c2d12' : '#166534',
        }}>
          {delta > 0 ? '+' : ''}{Math.round(delta)}
        </span>
      )}
    </div>
  );
}

function ShiftPopover({ popover, months, onClose, onSubmit }) {
  const [hours, setHours] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  if (!popover) return null;
  const { staff, monthIso, monthLabel, x, y } = popover;
  const otherMonths = months.filter((m) => `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}-01` !== monthIso);

  async function go() {
    const n = Number(hours);
    if (!Number.isFinite(n) || n <= 0) { alert('Enter a positive number of hours.'); return; }
    if (!target) { alert('Pick a target month.'); return; }
    setBusy(true);
    try {
      await onSubmit({ staff_id: staff.id, source_month: monthIso, target_month: target, hours: n });
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 100 }} />
      <div
        style={{
          position: 'fixed',
          left: Math.min(x, window.innerWidth - 320),
          top: Math.min(y, window.innerHeight - 240),
          width: 300, padding: 14, zIndex: 101,
          background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
          boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
          fontFamily: "'Outfit', sans-serif",
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Pull forward / push out
        </div>
        <div style={{ fontSize: 14, fontWeight: 500, color: '#0f172a', marginTop: 4, marginBottom: 10 }}>
          {staff.name} · {monthLabel}
        </div>
        <label style={{ fontSize: 12, color: '#475569', display: 'block', marginBottom: 4 }}>Hours to move</label>
        <input
          type="number" autoFocus value={hours}
          onChange={(e) => setHours(e.target.value)}
          placeholder="e.g. 5"
          style={{ width: '100%', padding: '6px 8px', fontSize: 13, border: '1px solid #cbd5e1', borderRadius: 6, fontFamily: "'Outfit', sans-serif", marginBottom: 10 }}
        />
        <label style={{ fontSize: 12, color: '#475569', display: 'block', marginBottom: 4 }}>To month</label>
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          style={{ width: '100%', padding: '6px 8px', fontSize: 13, border: '1px solid #cbd5e1', borderRadius: 6, fontFamily: "'Outfit', sans-serif", marginBottom: 14 }}
        >
          <option value="">— pick a month —</option>
          {otherMonths.map((m) => {
            const iso = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}-01`;
            return <option key={iso} value={iso}>{m.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}</option>;
          })}
        </select>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={busy} style={{
            padding: '5px 12px', fontSize: 12, border: '1px solid #cbd5e1',
            background: '#fff', color: '#64748b', borderRadius: 6, cursor: 'pointer',
            fontFamily: "'Outfit', sans-serif",
          }}>Cancel</button>
          <button onClick={go} disabled={busy} style={{
            padding: '5px 12px', fontSize: 12, border: '1px solid #0f172a',
            background: '#0f172a', color: '#fff', borderRadius: 6, cursor: 'pointer',
            fontFamily: "'Outfit', sans-serif",
          }}>{busy ? 'Saving…' : 'Propose shift'}</button>
        </div>
      </div>
    </>
  );
}

function heatColour(pct) {
  if (pct === 0) return '#fff';
  if (pct < 0.5) return '#dbeafe';
  if (pct < 0.8) return '#bbf7d0';
  if (pct < 1.0) return '#fde68a';
  if (pct < 1.2) return '#fecaca';
  return '#fca5a5';
}

function Swatch({ colour, label }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span style={{ width: 14, height: 14, background: colour, border: '1px solid #e5e7eb', borderRadius: 3 }} />
      {label}
    </span>
  );
}

function headerCellStyle(width, align = 'center') {
  return {
    width, minWidth: width, height: 32,
    display: 'flex', alignItems: 'center', justifyContent: align === 'left' ? 'flex-start' : 'center',
    padding: '0 10px', fontSize: 11, fontWeight: 600,
    color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5,
    borderBottom: '1px solid #e5e7eb', background: '#f8fafc',
  };
}

function btnStyle(variant) {
  if (variant === 'primary') {
    return {
      padding: '5px 12px', fontSize: 12, fontWeight: 500,
      border: '1px solid #0f172a', borderRadius: 6,
      background: '#0f172a', color: '#fff', cursor: 'pointer',
      fontFamily: "'Outfit', sans-serif",
    };
  }
  return {
    padding: '5px 12px', fontSize: 12, fontWeight: 500,
    border: '1px solid #cbd5e1', borderRadius: 6,
    background: '#fff', color: '#64748b', cursor: 'pointer',
    fontFamily: "'Outfit', sans-serif",
  };
}

function miniBtn(kind) {
  return {
    border: 'none', padding: '0 4px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
    background: kind === 'save' ? '#0f172a' : '#e5e7eb',
    color: kind === 'save' ? '#fff' : '#64748b',
    fontFamily: "'Outfit', sans-serif",
  };
}
