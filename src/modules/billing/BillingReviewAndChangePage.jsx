import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { TrendingUp, RotateCcw } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import BillingTabs from './BillingTabs';
import SearchInput from '../../components/SearchInput';
import OverflowMenu from '../../components/OverflowMenu';
import EmptyState from '../../components/EmptyState';
import { fmtGbp } from '../../lib/money';

const font = "'Outfit', sans-serif";

// Matrix view of current billing: clients × services. Cells show the
// ex-VAT monthly amount. Three ways to amend before pushing to QBO:
//   1. Inflation %  — apply to all/selected cells
//   2. Floor £       — apply to a specific service column
//   3. Manual edit   — click a cell and type
//
// All edits stage as pending_monthly_amount on the underlying service
// (jsonb on live_billing.services[idx]) and flow through the existing
// uplift review → push pipeline. Nothing here writes directly to QBO.
export default function BillingReviewAndChangePage() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [scope, setScope] = useState('monthly'); // monthly | annual | all
  const [editing, setEditing] = useState(null); // { entityId, serviceId }
  const [upliftOpen, setUpliftOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [focusedServiceId, setFocusedServiceId] = useState(searchParams.get('service') || null); // click a column header to highlight + default-scope the uplift modal

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('live_billing')
      .select('id, entity_id, services, qbo_recurring_txn_id, entity:entities(id, name, entity_status)')
      .eq('status', 'active')
      .order('id', { ascending: false });
    setRows((data || []).filter((r) => (r.entity?.entity_status || 'active') !== 'nlac'));
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  // Decide whether a service line is in scope for this view.
  const inScope = (s) => {
    if (s.approval_status !== 'approved') return false;
    if (s.recurring_status === 'ending') return false;
    if (scope === 'all') return true;
    if (scope === 'monthly') return s.cadence === 'monthly';
    if (scope === 'annual') return s.cadence === 'annual';
    return false;
  };

  // Build the matrix from rows. Cell key = `${entityId}::${serviceId}`.
  // A cell contains the underlying service indices so we can write back
  // pending amounts. If a client has multiple service lines with the
  // same service_id, the cell is marked duplicate=true and locked for
  // edit (duplicates are dangerous because they'd be pushed through to
  // a new template as separate lines).
  const matrix = useMemo(() => {
    const serviceSet = new Set();
    const cells = new Map(); // key → { current, pending, services: [{rowId, idx, current, pending}] }
    const entities = new Map(); // entityId → { id, name }

    for (const r of rows) {
      const services = Array.isArray(r.services) ? r.services : [];
      for (let i = 0; i < services.length; i++) {
        const s = services[i];
        if (!inScope(s)) continue;
        const serviceId = s.service_id || s.description || '—';
        serviceSet.add(serviceId);
        const key = `${r.entity_id}::${serviceId}`;
        let cell = cells.get(key);
        if (!cell) {
          cell = { entityId: r.entity_id, entityName: r.entity?.name || 'Unknown', serviceId, current: 0, pending: 0, hasPending: false, services: [] };
          cells.set(key, cell);
        }
        const current = Number(s.monthly_amount) || 0;
        const pendingRaw = s.pending_monthly_amount;
        const hasPending = pendingRaw != null;
        const effective = hasPending ? Number(pendingRaw) : current;
        cell.current += current;
        cell.pending += effective;
        if (hasPending) cell.hasPending = true;
        cell.services.push({ rowId: r.id, idx: i, current, pending: hasPending ? Number(pendingRaw) : null });
        entities.set(r.entity_id, { id: r.entity_id, name: r.entity?.name || 'Unknown' });
      }
    }

    const services = Array.from(serviceSet).sort();
    const entityList = Array.from(entities.values()).sort((a, b) => a.name.localeCompare(b.name));
    return { services, entityList, cells };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, scope]);

  const columnTotals = useMemo(() => {
    const map = {};
    for (const sid of matrix.services) map[sid] = { current: 0, pending: 0 };
    for (const cell of matrix.cells.values()) {
      map[cell.serviceId].current += cell.current;
      map[cell.serviceId].pending += cell.pending;
    }
    let totalCurrent = 0, totalPending = 0;
    for (const sid of matrix.services) {
      totalCurrent += map[sid].current;
      totalPending += map[sid].pending;
    }
    return { perService: map, totalCurrent, totalPending };
  }, [matrix]);

  // Write pending_monthly_amount to a single service line. Patches the
  // jsonb services array and stamps uplift_review_status='staged' on
  // the row so it shows up in the uplift review queue.
  const stagePending = async (rowId, idx, newAmount) => {
    setSaving(true);
    const row = rows.find((r) => r.id === rowId);
    if (!row) { setSaving(false); return; }
    const services = [...(row.services || [])];
    const existing = services[idx] || {};
    services[idx] = {
      ...existing,
      pending_monthly_amount: Number(newAmount),
      pending_effective_at: existing.pending_effective_at || '2026-06-01',
      pending_uplift_staged_at: new Date().toISOString(),
    };
    await supabase.from('live_billing').update({
      services,
      uplift_review_status: 'staged',
      uplift_reviewed_by: null,
      uplift_reviewed_at: null,
    }).eq('id', rowId);
    setRows((prev) => prev.map((r) => r.id === rowId ? { ...r, services } : r));
    setSaving(false);
  };

  // Manual cell edit: writes new amount as pending. If the cell has
  // multiple underlying service lines (duplicate), this is blocked.
  const saveCellEdit = async (cell, newAmount) => {
    setEditing(null);
    if (cell.services.length > 1) return; // duplicate — locked
    const next = Number(newAmount);
    if (!Number.isFinite(next) || next < 0) return;
    const svc = cell.services[0];
    if (next === svc.current) {
      // Clear any existing pending instead of staging the same amount.
      await clearPending(svc.rowId, svc.idx);
      return;
    }
    await stagePending(svc.rowId, svc.idx, next);
  };

  const clearPending = async (rowId, idx) => {
    const row = rows.find((r) => r.id === rowId);
    if (!row) return;
    const services = [...(row.services || [])];
    const existing = services[idx] || {};
    services[idx] = {
      ...existing,
      pending_monthly_amount: null,
      pending_effective_at: null,
      pending_uplift_reason: null,
      pending_uplift_staged_at: null,
    };
    // If no services on this row still have pending, clear the row-level
    // review status too.
    const rowStillPending = services.some((s) => s.pending_monthly_amount != null);
    await supabase.from('live_billing').update({
      services,
      ...(rowStillPending ? {} : { uplift_review_status: null, uplift_reviewed_by: null, uplift_reviewed_at: null }),
    }).eq('id', rowId);
    setRows((prev) => prev.map((r) => r.id === rowId ? { ...r, services } : r));
  };

  const clearAllPending = async () => {
    const affected = [];
    for (const r of rows) {
      const services = Array.isArray(r.services) ? r.services : [];
      const hasPending = services.some((s) => s.pending_monthly_amount != null);
      if (hasPending) affected.push(r.id);
    }
    if (affected.length === 0) return;
    if (!window.confirm(`Clear all pending amendments across ${affected.length} client${affected.length === 1 ? '' : 's'}? Nothing is pushed back to QBO.`)) return;
    setSaving(true);
    for (const r of rows) {
      const services = (r.services || []).map((s) => ({
        ...s,
        pending_monthly_amount: null,
        pending_effective_at: null,
        pending_uplift_reason: null,
        pending_uplift_staged_at: null,
      }));
      await supabase.from('live_billing').update({
        services,
        uplift_review_status: null,
        uplift_reviewed_by: null,
        uplift_reviewed_at: null,
      }).eq('id', r.id);
    }
    setSaving(false);
    await load();
  };

  // Apply an inflation % to in-scope service lines on every selected
  // client (here: all visible). Writes pending_monthly_amount for each.
  const applyInflation = async ({ pct, roundUp, onlyServiceId, reason }) => {
    if (!Number.isFinite(pct) || pct === 0) return;
    const writes = [];
    for (const r of rows) {
      const services = [...(r.services || [])];
      let touched = false;
      for (let i = 0; i < services.length; i++) {
        const s = services[i];
        if (!inScope(s)) continue;
        if (onlyServiceId && s.service_id !== onlyServiceId) continue;
        const current = Number(s.monthly_amount) || 0;
        if (current === 0) continue;
        let next = current * (1 + pct / 100);
        if (roundUp) next = Math.ceil(next * 2) / 2;
        next = Math.round(next * 100) / 100;
        if (next === current) continue;
        services[i] = {
          ...s,
          pending_monthly_amount: next,
          pending_effective_at: s.pending_effective_at || '2026-06-01',
          pending_uplift_reason: reason || s.pending_uplift_reason || 'Inflation uplift',
          pending_uplift_staged_at: new Date().toISOString(),
        };
        touched = true;
      }
      if (touched) writes.push({ id: r.id, services });
    }
    if (writes.length === 0) { alert('No cells matched — nothing to apply.'); return; }
    if (!window.confirm(`Apply ${pct}% inflation to ${writes.length} client${writes.length === 1 ? '' : 's'}? Stages as pending — nothing pushed yet.`)) return;
    setSaving(true);
    for (const w of writes) {
      await supabase.from('live_billing').update({
        services: w.services,
        uplift_review_status: 'staged',
        uplift_reviewed_by: null,
        uplift_reviewed_at: null,
      }).eq('id', w.id);
    }
    setSaving(false);
    setUpliftOpen(false);
    await load();
  };

  // Apply a floor £ to a specific service column. Only cells where the
  // current amount is below the floor get staged.
  const applyFloor = async ({ serviceId, floor, reason }) => {
    if (!serviceId) return;
    if (!Number.isFinite(floor) || floor <= 0) return;
    const writes = [];
    for (const r of rows) {
      const services = [...(r.services || [])];
      let touched = false;
      for (let i = 0; i < services.length; i++) {
        const s = services[i];
        if (!inScope(s)) continue;
        if (s.service_id !== serviceId) continue;
        const current = Number(s.monthly_amount) || 0;
        if (current >= floor) continue;
        services[i] = {
          ...s,
          pending_monthly_amount: floor,
          pending_effective_at: s.pending_effective_at || '2026-06-01',
          pending_uplift_reason: reason || s.pending_uplift_reason || `Floor £${floor.toFixed(2)}`,
          pending_uplift_staged_at: new Date().toISOString(),
        };
        touched = true;
      }
      if (touched) writes.push({ id: r.id, services });
    }
    if (writes.length === 0) { alert('No cells below floor — nothing to apply.'); return; }
    if (!window.confirm(`Apply £${floor.toFixed(2)} floor on ${serviceId} for ${writes.length} client${writes.length === 1 ? '' : 's'}?`)) return;
    setSaving(true);
    for (const w of writes) {
      await supabase.from('live_billing').update({
        services: w.services,
        uplift_review_status: 'staged',
        uplift_reviewed_by: null,
        uplift_reviewed_at: null,
      }).eq('id', w.id);
    }
    setSaving(false);
    setUpliftOpen(false);
    await load();
  };

  // Per-client totals — used both for the "Total" first column and to
  // sanity-check the grand totals across the bottom of the page.
  const rowTotals = useMemo(() => {
    const map = new Map(); // entityId → { current, pending }
    for (const cell of matrix.cells.values()) {
      const t = map.get(cell.entityId) || { current: 0, pending: 0 };
      t.current += cell.current;
      t.pending += cell.pending;
      map.set(cell.entityId, t);
    }
    return map;
  }, [matrix]);

  const grandDelta = columnTotals.totalPending - columnTotals.totalCurrent;

  return (
    <div style={{ padding: '20px 28px', fontFamily: font, maxWidth: 1600 }}>
      <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 2 }}>
        Review and Change
      </h1>
      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 720, marginBottom: 14 }}>
        Client × service grid of ex-VAT monthly amounts. Edit cells, apply inflation, or apply a floor. Changes stage as pending — push them to QBO from the Uplift Review screen.
      </p>

      <BillingTabs active="change" />

      {/* Action bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <ScopeToggle value={scope} onChange={setScope} />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Filter clients…"
          style={{ minWidth: 200 }}
        />
        {focusedServiceId && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', background: '#dbeafe', color: '#0c4a6e', borderRadius: 999, fontSize: 12, fontWeight: 500 }}>
            Focused: <strong>{focusedServiceId}</strong>
            <button onClick={() => setFocusedServiceId(null)} title="Clear column focus" style={{ background: 'transparent', border: 'none', color: '#0c4a6e', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={() => setUpliftOpen(true)} disabled={saving} style={btnAction}>
          <TrendingUp size={13} /> Apply uplift…
        </button>
        <button onClick={() => navigate('/manage/billing/uplifts')} style={btnPrimary}>
          Push uplifts →
        </button>
        <OverflowMenu
          items={[
            {
              label: 'Clear all pending edits',
              icon: <RotateCcw size={13} />,
              onClick: clearAllPending,
              danger: true,
            },
          ]}
          size={32}
        />
      </div>

      {loading ? (
        <p style={{ fontSize: 13, color: '#94a3b8', padding: 40, textAlign: 'center' }}>Loading…</p>
      ) : matrix.entityList.length === 0 ? (
        <EmptyState
          icon="—"
          title={`No ${scope === 'all' ? '' : scope + ' '}services in scope`}
          body={scope === 'monthly'
            ? 'No client has any approved monthly recurring services. Approve some on the Import page, or switch scope to Annual / All.'
            : 'Try switching the scope toggle above, or approve services on the Import page first.'}
          actions={[
            ...(scope !== 'monthly' ? [{ label: 'Switch to Monthly', onClick: () => setScope('monthly') }] : []),
            ...(scope !== 'all' ? [{ label: 'Show All', onClick: () => setScope('all') }] : []),
            { label: 'Go to Import →', onClick: () => navigate('/manage/billing/review'), primary: true },
          ]}
        />
      ) : (
        <>
          {/* Summary tiles */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 10 }}>
              <Tile group="Monthly" label="Current" value={fmtGbp(columnTotals.totalCurrent)} />
              <Tile group="Monthly" label="New"     value={fmtGbp(columnTotals.totalPending)} tone={grandDelta > 0 ? 'green' : 'slate'} />
              <Tile group="Monthly" label="Δ"       value={`${grandDelta >= 0 ? '+' : ''}${fmtGbp(grandDelta)}`} tone={grandDelta > 0 ? 'green' : grandDelta < 0 ? 'red' : 'slate'} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
              <Tile group="Annual" label="Current" value={fmtGbp(columnTotals.totalCurrent * 12)} />
              <Tile group="Annual" label="New"     value={fmtGbp(columnTotals.totalPending * 12)} tone={grandDelta > 0 ? 'green' : 'slate'} />
              <Tile group="Annual" label="Δ"       value={`${grandDelta >= 0 ? '+' : ''}${fmtGbp(grandDelta * 12)}`} tone={grandDelta > 0 ? 'green' : grandDelta < 0 ? 'red' : 'slate'} />
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: '#94a3b8' }}>
              {matrix.entityList.length} client{matrix.entityList.length === 1 ? '' : 's'} · {matrix.services.length} service{matrix.services.length === 1 ? '' : 's'} · annual = monthly × 12
            </div>
          </div>

          {/* Matrix */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'auto', maxHeight: '72vh' }}>
            <table style={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: 12, minWidth: '100%' }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  <th style={{ ...stickyTh, left: 0, zIndex: 4, minWidth: 220, textAlign: 'left' }}>Client</th>
                  <th style={{ ...stickyTh, left: 220, zIndex: 4, minWidth: 130, background: '#f1f5f9' }}>Total</th>
                  {matrix.services.map((sid) => {
                    const isFocused = focusedServiceId === sid;
                    return (
                      <th
                        key={sid}
                        onClick={() => setFocusedServiceId(isFocused ? null : sid)}
                        style={{
                          ...stickyTh,
                          top: 0, zIndex: 3, minWidth: 110,
                          cursor: 'pointer',
                          background: isFocused ? '#dbeafe' : '#f8fafc',
                          color: isFocused ? '#0c4a6e' : '#64748b',
                        }}
                        title={`${sid} — click to ${isFocused ? 'unfocus' : 'focus and scope Apply uplift to this service'}`}
                      >
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 110 }}>{sid}</div>
                      </th>
                    );
                  })}
                </tr>
                {/* Per-service totals row */}
                <tr style={{ background: '#fafafa' }}>
                  <th style={{ ...stickyTh, left: 0, zIndex: 4, textAlign: 'left', fontSize: 10, color: '#64748b' }}>
                    <div>Current → New (Δ)</div>
                  </th>
                  <th style={{ ...stickyTh, left: 220, top: 36, zIndex: 4, fontWeight: 500, fontSize: 10, background: '#f1f5f9' }}>
                    <div style={{ fontFamily: 'monospace', color: '#64748b' }}>{fmtGbp(columnTotals.totalCurrent)}</div>
                    <div style={{ fontFamily: 'monospace', color: grandDelta > 0 ? '#15803d' : grandDelta < 0 ? '#b91c1c' : '#0f172a', fontWeight: 700 }}>{fmtGbp(columnTotals.totalPending)}</div>
                    <div style={{ fontFamily: 'monospace', fontSize: 9, color: grandDelta > 0 ? '#15803d' : grandDelta < 0 ? '#b91c1c' : '#94a3b8' }}>{grandDelta > 0 ? '+' : ''}{fmtGbp(grandDelta)}</div>
                  </th>
                  {matrix.services.map((sid) => {
                    const t = columnTotals.perService[sid];
                    const d = t.pending - t.current;
                    return (
                      <th key={sid} style={{ ...stickyTh, top: 36, zIndex: 3, fontWeight: 500, fontSize: 10 }}>
                        <div style={{ fontFamily: 'monospace', color: '#64748b' }}>{fmtGbp(t.current)}</div>
                        <div style={{ fontFamily: 'monospace', color: d > 0 ? '#15803d' : d < 0 ? '#b91c1c' : '#0f172a', fontWeight: 600 }}>{fmtGbp(t.pending)}</div>
                        <div style={{ fontFamily: 'monospace', fontSize: 9, color: d > 0 ? '#15803d' : d < 0 ? '#b91c1c' : '#94a3b8' }}>{d > 0 ? '+' : ''}{fmtGbp(d)}</div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {matrix.entityList
                  .filter((entity) => !search.trim() || (entity.name || '').toLowerCase().includes(search.trim().toLowerCase()))
                  .map((entity) => (
                  <tr key={entity.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={{ ...stickyTd, left: 0, background: '#fff', fontWeight: 500, color: '#0f172a', textAlign: 'left', paddingLeft: 12 }}>
                      <a href={`/manage/clients/${entity.id}`} style={{ color: '#0f172a', textDecoration: 'none' }} onClick={(e) => { e.preventDefault(); navigate(`/manage/clients/${entity.id}`); }}>
                        {entity.name}
                      </a>
                    </td>
                    {(() => {
                      const t = rowTotals.get(entity.id) || { current: 0, pending: 0 };
                      const d = t.pending - t.current;
                      const hasChange = t.pending !== t.current;
                      return (
                        <td style={{ ...stickyTd, left: 220, background: '#f8fafc', textAlign: 'right', fontWeight: 600 }}>
                          <div style={{ fontFamily: 'monospace', color: hasChange ? '#94a3b8' : '#0f172a', textDecoration: hasChange ? 'line-through' : 'none' }}>{fmtGbp(t.current)}</div>
                          {hasChange && (
                            <div style={{ fontFamily: 'monospace', color: d > 0 ? '#15803d' : '#b91c1c', fontWeight: 700 }}>
                              {fmtGbp(t.pending)} <span style={{ fontSize: 9, fontWeight: 500 }}>({d > 0 ? '+' : ''}{fmtGbp(d)})</span>
                            </div>
                          )}
                        </td>
                      );
                    })()}
                    {matrix.services.map((sid) => {
                      const key = `${entity.id}::${sid}`;
                      const cell = matrix.cells.get(key);
                      const isEditing = editing && editing.entityId === entity.id && editing.serviceId === sid;
                      const focused = focusedServiceId === sid;
                      return (
                        <Cell
                          key={sid}
                          cell={cell}
                          isEditing={isEditing}
                          focused={focused}
                          onEdit={() => cell && cell.services.length === 1 && setEditing({ entityId: entity.id, serviceId: sid })}
                          onSave={(val) => saveCellEdit(cell, val)}
                          onCancel={() => setEditing(null)}
                          onClearPending={() => {
                            if (!cell || cell.services.length !== 1) return;
                            const svc = cell.services[0];
                            clearPending(svc.rowId, svc.idx);
                          }}
                        />
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {upliftOpen && (
        <ApplyUpliftModal
          services={matrix.services}
          defaultServiceId={focusedServiceId}
          onClose={() => setUpliftOpen(false)}
          onApplyInflation={applyInflation}
          onApplyFloor={applyFloor}
          saving={saving}
        />
      )}
    </div>
  );
}

function Cell({ cell, isEditing, focused, onEdit, onSave, onCancel, onClearPending }) {
  if (!cell) {
    return <td style={{ ...cellTd, background: focused ? '#f0f9ff' : undefined }}><span style={{ color: '#cbd5e1' }}>—</span></td>;
  }
  const duplicate = cell.services.length > 1;
  if (isEditing && !duplicate) {
    const single = cell.services[0];
    return (
      <td style={{ ...cellTd, background: '#eff6ff', padding: 0 }}>
        <input
          autoFocus
          type="number"
          step="0.01"
          defaultValue={single.pending != null ? single.pending : single.current}
          onBlur={(e) => onSave(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.target.blur();
            if (e.key === 'Escape') onCancel();
          }}
          style={{ width: '100%', height: '100%', padding: '4px 6px', border: '1px solid #0e7fe0', borderRadius: 4, fontSize: 12, fontFamily: 'monospace', textAlign: 'right', outline: 'none', boxSizing: 'border-box' }}
        />
      </td>
    );
  }
  const delta = cell.pending - cell.current;
  // Background priority: pending edit (purple tint) > focused column
  // (sky tint) > default white.
  const bg = cell.hasPending ? '#f5f3ff' : (focused ? '#f0f9ff' : '#fff');
  return (
    <td
      onClick={duplicate ? undefined : onEdit}
      style={{
        ...cellTd,
        background: bg,
        cursor: duplicate ? 'not-allowed' : 'pointer',
      }}
      title={duplicate
        ? `${cell.services.length} service lines with id "${cell.serviceId}" — edit on the approval queue.`
        : 'Click to edit (stages as pending — push from Uplift Review)'}
    >
      <div style={{ fontFamily: 'monospace', color: cell.hasPending ? '#94a3b8' : '#0f172a', textDecoration: cell.hasPending ? 'line-through' : 'none' }}>
        {fmtGbp(cell.current)}
      </div>
      {cell.hasPending && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
          <span style={{ fontFamily: 'monospace', color: delta > 0 ? '#15803d' : '#b91c1c', fontWeight: 600 }}>
            {fmtGbp(cell.pending)}
          </span>
          <button onClick={(e) => { e.stopPropagation(); onClearPending(); }} title="Clear pending" style={clearBtnStyle}>×</button>
        </div>
      )}
    </td>
  );
}

function ScopeToggle({ value, onChange }) {
  const opts = [
    { v: 'monthly', l: 'Monthly' },
    { v: 'annual', l: 'Annual' },
    { v: 'all', l: 'All' },
  ];
  return (
    <div style={{ display: 'inline-flex', border: '1px solid #e5e7eb', borderRadius: 6, overflow: 'hidden' }}>
      {opts.map((o, i) => {
        const active = value === o.v;
        return (
          <button
            key={o.v}
            onClick={() => onChange(o.v)}
            style={{
              padding: '6px 12px', fontSize: 12, fontWeight: active ? 600 : 500,
              background: active ? '#0f172a' : '#fff', color: active ? '#fff' : '#475569',
              border: 'none', borderLeft: i > 0 ? '1px solid #e5e7eb' : 'none',
              cursor: 'pointer', fontFamily: font,
            }}
          >{o.l}</button>
        );
      })}
    </div>
  );
}

// Unified Apply Uplift modal — pick a strategy at the top, only the
// inputs for that strategy show.
function ApplyUpliftModal({ services, defaultServiceId, onClose, onApplyInflation, onApplyFloor, saving }) {
  const [strategy, setStrategy] = useState('inflation'); // inflation | floor
  const [pct, setPct] = useState(5);
  const [roundUp, setRoundUp] = useState(true);
  const [onlyServiceId, setOnlyServiceId] = useState(defaultServiceId || '');
  const [floorServiceId, setFloorServiceId] = useState(defaultServiceId || services[0] || '');
  const [floor, setFloor] = useState(50);
  const [reason, setReason] = useState('Annual fee review 2026');

  const apply = () => {
    if (strategy === 'inflation') {
      onApplyInflation({ pct: Number(pct), roundUp, onlyServiceId: onlyServiceId || null, reason });
    } else {
      onApplyFloor({ serviceId: floorServiceId, floor: Number(floor), reason });
    }
  };

  return (
    <ModalShell title="Apply uplift" onClose={onClose}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, background: '#f8fafc', padding: 4, borderRadius: 8 }}>
        <StratTab label="Inflation %" active={strategy === 'inflation'} onClick={() => setStrategy('inflation')} />
        <StratTab label="Floor £/month" active={strategy === 'floor'} onClick={() => setStrategy('floor')} />
      </div>

      {strategy === 'inflation' ? (
        <>
          <Label>Inflation %</Label>
          <input type="number" step="0.1" value={pct} onChange={(e) => setPct(Number(e.target.value))} style={inputStyle} />
          <Label style={{ marginTop: 10 }}>Limit to service</Label>
          <select value={onlyServiceId} onChange={(e) => setOnlyServiceId(e.target.value)} style={inputStyle}>
            <option value="">All in-scope services</option>
            {services.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 12 }}>
            <input type="checkbox" checked={roundUp} onChange={(e) => setRoundUp(e.target.checked)} />
            Round up to nearest £0.50
          </label>
        </>
      ) : (
        <>
          <Label>Service</Label>
          <select value={floorServiceId} onChange={(e) => setFloorServiceId(e.target.value)} style={inputStyle}>
            {services.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <Label style={{ marginTop: 10 }}>Floor £/month</Label>
          <input type="number" step="0.5" value={floor} onChange={(e) => setFloor(Number(e.target.value))} style={inputStyle} />
          <p style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>Cells below the floor will be staged to the floor value. Cells already at or above are untouched.</p>
        </>
      )}

      <Label style={{ marginTop: 12 }}>Reason / note</Label>
      <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} style={inputStyle} />

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
        <button onClick={onClose} disabled={saving} style={modalBtnGhost}>Cancel</button>
        <button onClick={apply} disabled={saving} style={modalBtnPrimary}>
          {saving ? 'Staging…' : 'Stage uplift'}
        </button>
      </div>
    </ModalShell>
  );
}

function StratTab({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, padding: '6px 10px', fontSize: 12, fontWeight: active ? 600 : 500,
        background: active ? '#fff' : 'transparent',
        color: active ? '#0f172a' : '#64748b',
        border: active ? '1px solid #e5e7eb' : '1px solid transparent',
        boxShadow: active ? '0 1px 2px rgba(15,23,42,0.05)' : 'none',
        borderRadius: 6, cursor: 'pointer', fontFamily: font,
      }}
    >{label}</button>
  );
}

function ModalShell({ title, onClose, children }) {
  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid #e5e7eb' }}>
          <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, fontWeight: 500, color: '#0f172a', margin: 0 }}>{title}</h2>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', fontSize: 18 }}>×</button>
        </div>
        <div style={{ padding: 18 }}>{children}</div>
      </div>
    </div>
  );
}

// Render £#,##0 — no decimals, thousands separator, negative shown
// with a leading minus inside the £ symbol ("-£123" rather than "£-123").
function Tile({ group, label, value, tone }) {
  const fg = tone === 'green' ? '#15803d' : tone === 'red' ? '#b91c1c' : tone === 'slate' ? '#475569' : '#0f172a';
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{group}</div>
      <div style={{ fontSize: 11, fontWeight: 500, color: '#64748b', marginTop: 2 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: fg, fontFamily: 'monospace', marginTop: 4 }}>{value}</div>
    </div>
  );
}

function Stat({ label, value, tone }) {
  const fg = tone === 'green' ? '#15803d' : tone === 'red' ? '#b91c1c' : tone === 'slate' ? '#475569' : '#0f172a';
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: fg, fontFamily: 'monospace' }}>{value}</div>
    </div>
  );
}

const Label = ({ children, style }) => <div style={{ fontSize: 10, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5, ...style }}>{children}</div>;

const stickyTh = { position: 'sticky', padding: '6px 10px', fontSize: 10, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em', background: '#f8fafc', borderBottom: '1px solid #e5e7eb', borderRight: '1px solid #f1f5f9', textAlign: 'right', top: 0 };
const stickyTd = { position: 'sticky', padding: '8px 10px', borderRight: '1px solid #f1f5f9', verticalAlign: 'middle', fontSize: 12 };
const cellTd = { padding: '6px 8px', textAlign: 'right', verticalAlign: 'middle', borderRight: '1px solid #f1f5f9', fontSize: 12, minWidth: 110 };

const backLinkStyle = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 500, color: '#64748b', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 12, padding: 0, fontFamily: font };
const btnAction = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 12, fontWeight: 500, background: '#fff', color: '#0e7fe0', border: '1px solid #bfdbfe', borderRadius: 6, cursor: 'pointer', fontFamily: font };
const btnGhost = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 12, fontWeight: 500, background: '#fff', color: '#64748b', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', fontFamily: font };
const btnPrimary = { padding: '6px 14px', fontSize: 12, fontWeight: 600, background: '#0f172a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: font };
const clearBtnStyle = { width: 16, height: 16, padding: 0, fontSize: 14, lineHeight: 1, background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer' };

const overlayStyle = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, fontFamily: font };
const modalStyle = { background: '#fff', borderRadius: 12, width: 460, maxWidth: '95vw', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' };
const inputStyle = { padding: '6px 10px', fontSize: 13, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#0f172a', outline: 'none', width: '100%', boxSizing: 'border-box' };
const modalBtnPrimary = { padding: '8px 16px', fontSize: 13, fontWeight: 600, background: '#0f172a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: font };
const modalBtnGhost = { padding: '8px 14px', fontSize: 13, fontWeight: 500, background: '#fff', color: '#475569', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', fontFamily: font };
