import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { TrendingUp, RotateCcw, Plus, EyeOff, Eye, ArrowUp, ArrowDown } from 'lucide-react';
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
  const [qboItems, setQboItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [scope, setScope] = useState('monthly'); // monthly | annual | all
  const [editing, setEditing] = useState(null); // { entityId, serviceId }
  const [upliftOpen, setUpliftOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(null); // null | { entityId?, serviceId? } — opens AddServiceModal
  // Seed the client filter from a ?client= deep link (e.g. from a client's
  // detail page "Manage billing"), so the matrix opens scoped to them.
  const [search, setSearch] = useState(searchParams.get('client') || '');
  const [excludedFilter, setExcludedFilter] = useState('all'); // all | included | excluded
  // Sort state. type='client' (alpha) | 'total' (per-client total) |
  // 'service' (per-cell amount for the named service). dir asc/desc.
  // Defaults to client name ascending. The legacy "focus" concept on
  // column-header click has been replaced with sort — the Apply Uplift
  // modal already has its own "Limit to service" dropdown, and the
  // ?service= deep link from the dashboard now seeds a sort instead
  // of a focus.
  const initialServiceParam = searchParams.get('service');
  const [sortBy, setSortBy] = useState(
    initialServiceParam ? { type: 'service', serviceId: initialServiceParam, dir: 'desc' } : { type: 'client', dir: 'asc' }
  );
  const focusedServiceId = sortBy.type === 'service' ? sortBy.serviceId : null;

  const load = async () => {
    setLoading(true);
    const [{ data }, { data: items }] = await Promise.all([
      supabase
        .from('live_billing')
        .select('id, entity_id, services, qbo_recurring_txn_id, entity:entities(id, name, entity_status, fee_raise_excluded)')
        .eq('status', 'active')
        .order('id', { ascending: false }),
      supabase
        .from('qbo_items')
        .select('qbo_item_id, name, description, unit_price, active')
        .eq('active', true)
        .order('name', { ascending: true }),
    ]);
    setRows((data || []).filter((r) => (r.entity?.entity_status || 'active') !== 'nlac'));
    setQboItems(items || []);
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
        // Track strategy of the pending uplift on each underlying
        // service so manuals win over floor wins over inflation when
        // the user runs successive uplift passes.
        if (s.pending_monthly_amount != null) cell.pendingStrategy = s.pending_uplift_strategy || 'manual';
        const current = Number(s.monthly_amount) || 0;
        const pendingRaw = s.pending_monthly_amount;
        const hasPending = pendingRaw != null;
        const effective = hasPending ? Number(pendingRaw) : current;
        cell.current += current;
        cell.pending += effective;
        if (hasPending) cell.hasPending = true;
        cell.services.push({ rowId: r.id, idx: i, current, pending: hasPending ? Number(pendingRaw) : null, strategy: s.pending_uplift_strategy || null });
        entities.set(r.entity_id, {
          id: r.entity_id,
          name: r.entity?.name || 'Unknown',
          excluded: !!r.entity?.fee_raise_excluded,
        });
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
      // Manual edits get top priority and won't be touched by a
      // subsequent inflation/floor pass.
      pending_uplift_strategy: 'manual',
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

  // Add a brand-new service line for an entity. Attaches to the
  // entity's template-linked row when one exists (so when the uplift
  // is pushed to QBO it can land on the existing template); otherwise
  // attaches to the largest active manual row. Stages the amount as
  // pending so it flows through Uplift Review → push.
  const addService = async ({ entityId, qboItemId, serviceId, description, cadence, monthlyAmount, effectiveAt, reason }) => {
    if (!entityId || !serviceId) return;
    setSaving(true);
    try {
      // Pick the target billing row.
      const candidates = rows.filter((r) => r.entity_id === entityId);
      const target = candidates.find((r) => r.qbo_recurring_txn_id) || candidates[0];
      if (!target) {
        alert('No active billing row for this client. Create one via QBO pull first.');
        return;
      }
      const services = [...(target.services || [])];
      const monthly = cadence === 'monthly' ? Number(monthlyAmount) || 0 : 0;
      const annual  = cadence === 'annual'  ? Number(monthlyAmount) * 12 : monthly * 12;
      services.push({
        service_id: serviceId,
        qbo_item_id: qboItemId || null,
        description: description || serviceId,
        cadence,
        cadence_months: cadence === 'monthly' ? 1 : cadence === 'annual' ? 12 : 0,
        monthly_amount: 0,                // current = nothing being billed today
        annual_amount: 0,
        approval_status: 'approved',
        approved_by: profile?.id || null,
        approved_at: new Date().toISOString(),
        billing_type: cadence === 'monthly' ? 'recurring' : cadence,
        // Stage the new amount as a pending uplift — pushing to QBO
        // will write it onto the recurring template.
        pending_monthly_amount: cadence === 'annual' ? Math.round((Number(monthlyAmount) || 0) / 12 * 100) / 100 : monthly,
        pending_effective_at: effectiveAt || '2026-06-01',
        pending_uplift_reason: reason || 'New service added on Change matrix',
        pending_uplift_staged_at: new Date().toISOString(),
        pending_uplift_strategy: 'manual',
      });
      await supabase.from('live_billing').update({
        services,
        uplift_review_status: 'staged',
        uplift_reviewed_by: null,
        uplift_reviewed_at: null,
      }).eq('id', target.id);
      setRows((prev) => prev.map((r) => r.id === target.id ? { ...r, services } : r));
    } finally {
      setSaving(false);
      setAddOpen(null);
    }
  };

  // Toggle whether this client is excluded from bulk fee raises.
  const toggleFeeRaiseExcluded = async (entityId, currentValue) => {
    const next = !currentValue;
    await supabase.from('entities').update({ fee_raise_excluded: next }).eq('id', entityId);
    // Optimistic: update the rows array's nested entity ref so the
    // matrix re-renders without a full reload.
    setRows((prev) => prev.map((r) =>
      r.entity_id === entityId
        ? { ...r, entity: { ...(r.entity || {}), fee_raise_excluded: next } }
        : r
    ));
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

  // Apply an inflation % to in-scope service lines on every visible
  // client. Honors priority: skips clients marked fee_raise_excluded,
  // skips services whose pending uplift was already set manually OR
  // by an earlier floor pass.
  const applyInflation = async ({ pct, roundUp, onlyServiceId, reason }) => {
    if (!Number.isFinite(pct) || pct === 0) return;
    const writes = [];
    let skippedExcluded = 0, skippedManual = 0, skippedFloor = 0;
    for (const r of rows) {
      if (r.entity?.fee_raise_excluded) { skippedExcluded++; continue; }
      const services = [...(r.services || [])];
      let touched = false;
      for (let i = 0; i < services.length; i++) {
        const s = services[i];
        if (!inScope(s)) continue;
        if (onlyServiceId && s.service_id !== onlyServiceId) continue;
        // Priority guard: don't overwrite a pending value that came
        // from a manual entry or a floor pass.
        if (s.pending_monthly_amount != null) {
          const strat = s.pending_uplift_strategy;
          if (strat === 'manual') { skippedManual++; continue; }
          if (strat === 'floor')  { skippedFloor++;  continue; }
        }
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
          pending_uplift_strategy: 'inflation',
        };
        touched = true;
      }
      if (touched) writes.push({ id: r.id, services });
    }
    if (writes.length === 0) {
      const skips = [];
      if (skippedExcluded) skips.push(`${skippedExcluded} excluded`);
      if (skippedManual) skips.push(`${skippedManual} manual`);
      if (skippedFloor) skips.push(`${skippedFloor} floor`);
      alert(`No cells matched — nothing to apply.${skips.length ? '\n\nSkipped: ' + skips.join(', ') + '.' : ''}`);
      return;
    }
    const skipSummary = (skippedExcluded || skippedManual || skippedFloor)
      ? `\n\nSkipped: ${skippedExcluded} excluded · ${skippedManual} manual · ${skippedFloor} floor.`
      : '';
    if (!window.confirm(`Apply ${pct}% inflation to ${writes.length} client${writes.length === 1 ? '' : 's'}?${skipSummary}\n\nStages as pending — nothing pushed yet.`)) return;
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

  // Apply a floor £ to a specific service column. Skips excluded
  // clients and any cell where the pending was already manually set.
  const applyFloor = async ({ serviceId, floor, reason }) => {
    if (!serviceId) return;
    if (!Number.isFinite(floor) || floor <= 0) return;
    const writes = [];
    let skippedExcluded = 0, skippedManual = 0;
    for (const r of rows) {
      if (r.entity?.fee_raise_excluded) { skippedExcluded++; continue; }
      const services = [...(r.services || [])];
      let touched = false;
      for (let i = 0; i < services.length; i++) {
        const s = services[i];
        if (!inScope(s)) continue;
        if (s.service_id !== serviceId) continue;
        if (s.pending_monthly_amount != null && s.pending_uplift_strategy === 'manual') { skippedManual++; continue; }
        const current = Number(s.monthly_amount) || 0;
        if (current >= floor) continue;
        services[i] = {
          ...s,
          pending_monthly_amount: floor,
          pending_effective_at: s.pending_effective_at || '2026-06-01',
          pending_uplift_reason: reason || s.pending_uplift_reason || `Floor £${floor.toFixed(2)}`,
          pending_uplift_staged_at: new Date().toISOString(),
          pending_uplift_strategy: 'floor',
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

  // User-driven sort over the matrix rows. By default we keep the
  // canonical alpha-by-name order; click a column header to switch.
  const sortedEntities = useMemo(() => {
    const list = [...matrix.entityList];
    const dir = sortBy.dir === 'asc' ? 1 : -1;
    if (sortBy.type === 'client') {
      list.sort((a, b) => a.name.localeCompare(b.name) * dir);
    } else if (sortBy.type === 'total') {
      list.sort((a, b) => {
        const av = (rowTotals.get(a.id)?.pending) || 0;
        const bv = (rowTotals.get(b.id)?.pending) || 0;
        return (av - bv) * dir;
      });
    } else if (sortBy.type === 'service') {
      list.sort((a, b) => {
        const av = (matrix.cells.get(`${a.id}::${sortBy.serviceId}`)?.pending) || 0;
        const bv = (matrix.cells.get(`${b.id}::${sortBy.serviceId}`)?.pending) || 0;
        return (av - bv) * dir;
      });
    }
    return list;
  }, [matrix, rowTotals, sortBy]);

  // Click a column header → cycle that column's sort: first click
  // sorts desc (highest first, useful for revenue), second flips to
  // asc, third reverts to default (client A-Z).
  const cycleSort = (next) => {
    setSortBy((prev) => {
      const sameType = prev.type === next.type;
      const sameSvc = sameType && (next.type !== 'service' || prev.serviceId === next.serviceId);
      if (!sameType || !sameSvc) return { ...next, dir: next.type === 'client' ? 'asc' : 'desc' };
      if (prev.dir === 'desc') return { ...next, dir: 'asc' };
      if (prev.dir === 'asc')  return { type: 'client', dir: 'asc' };
      return { ...next, dir: 'desc' };
    });
  };

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
        <ExcludedToggle
          value={excludedFilter}
          onChange={setExcludedFilter}
          excludedCount={matrix.entityList.filter((e) => e.excluded).length}
        />
        {sortBy.type !== 'client' && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', background: '#dbeafe', color: '#0c4a6e', borderRadius: 999, fontSize: 12, fontWeight: 500 }}>
            Sorted by <strong>{sortBy.type === 'total' ? 'Total' : sortBy.serviceId}</strong> ({sortBy.dir})
            <button onClick={() => setSortBy({ type: 'client', dir: 'asc' })} title="Reset to A–Z" style={{ background: 'transparent', border: 'none', color: '#0c4a6e', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={() => setAddOpen({})} disabled={saving} style={btnAction}>
          <Plus size={13} /> Add service
        </button>
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
              {matrix.entityList.length} client{matrix.entityList.length === 1 ? '' : 's'}
              {matrix.entityList.filter((e) => e.excluded).length > 0 && (
                <> · <span style={{ color: '#b91c1c' }}>{matrix.entityList.filter((e) => e.excluded).length} excluded from raises</span></>
              )}
              {' · '}{matrix.services.length} service{matrix.services.length === 1 ? '' : 's'}
              {' · '}Priority: manual → floor → inflation · annual = monthly × 12
            </div>
          </div>

          {/* Matrix */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'auto', maxHeight: '72vh' }}>
            <table style={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: 12, minWidth: '100%' }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  <th
                    onClick={() => cycleSort({ type: 'client' })}
                    style={{ ...stickyTh, left: 0, zIndex: 5, minWidth: 220, textAlign: 'left', cursor: 'pointer' }}
                    title="Sort by client name"
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      Client
                      <SortArrow active={sortBy.type === 'client'} dir={sortBy.dir} />
                    </span>
                  </th>
                  <th
                    onClick={() => cycleSort({ type: 'total' })}
                    style={{ ...stickyTh, left: 220, zIndex: 5, minWidth: 110, background: '#f1f5f9', cursor: 'pointer' }}
                    title="Sort by per-client new total"
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                      Total
                      <SortArrow active={sortBy.type === 'total'} dir={sortBy.dir} />
                    </span>
                  </th>
                  {matrix.services.map((sid) => {
                    const isSorted = sortBy.type === 'service' && sortBy.serviceId === sid;
                    return (
                      <th
                        key={sid}
                        onClick={() => cycleSort({ type: 'service', serviceId: sid })}
                        style={{
                          ...stickyTh,
                          top: 0, zIndex: 3, minWidth: 60,
                          cursor: 'pointer',
                          background: isSorted ? '#dbeafe' : '#f8fafc',
                          color: isSorted ? '#0c4a6e' : '#64748b',
                        }}
                        title={`${sid} — click to sort by this column`}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 60 }}>{sid}</span>
                          <SortArrow active={isSorted} dir={sortBy.dir} />
                        </span>
                      </th>
                    );
                  })}
                </tr>
                {/* Per-service totals row — top position = exact height
                    of the row above, otherwise either a gap shows or
                    the rows overlap as the body scrolls past. */}
                <tr style={{ background: '#fafafa' }}>
                  <th style={{ ...stickyTh, left: 0, top: HEADER_ROW_1, zIndex: 5, textAlign: 'left', height: HEADER_ROW_2 }}>
                    <div>Current → New (Δ)</div>
                  </th>
                  <th style={{ ...stickyTh, left: 220, top: HEADER_ROW_1, zIndex: 5, fontWeight: 500, background: '#f1f5f9', height: HEADER_ROW_2 }}>
                    <div style={{ fontFamily: 'monospace', color: '#64748b' }}>{fmtGbp(columnTotals.totalCurrent)}</div>
                    <div style={{ fontFamily: 'monospace', color: grandDelta > 0 ? '#15803d' : grandDelta < 0 ? '#b91c1c' : '#0f172a', fontWeight: 700 }}>{fmtGbp(columnTotals.totalPending)}</div>
                    <div style={{ fontFamily: 'monospace', fontSize: 10, color: grandDelta > 0 ? '#15803d' : grandDelta < 0 ? '#b91c1c' : '#94a3b8' }}>{grandDelta > 0 ? '+' : ''}{fmtGbp(grandDelta)}</div>
                  </th>
                  {matrix.services.map((sid) => {
                    const t = columnTotals.perService[sid];
                    const d = t.pending - t.current;
                    return (
                      <th key={sid} style={{ ...stickyTh, top: HEADER_ROW_1, zIndex: 3, fontWeight: 500, height: HEADER_ROW_2 }}>
                        <div style={{ fontFamily: 'monospace', color: '#64748b' }}>{fmtGbp(t.current)}</div>
                        <div style={{ fontFamily: 'monospace', color: d > 0 ? '#15803d' : d < 0 ? '#b91c1c' : '#0f172a', fontWeight: 600 }}>{fmtGbp(t.pending)}</div>
                        <div style={{ fontFamily: 'monospace', fontSize: 10, color: d > 0 ? '#15803d' : d < 0 ? '#b91c1c' : '#94a3b8' }}>{d > 0 ? '+' : ''}{fmtGbp(d)}</div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sortedEntities
                  .filter((entity) => !search.trim() || (entity.name || '').toLowerCase().includes(search.trim().toLowerCase()))
                  .filter((entity) =>
                    excludedFilter === 'all' ? true :
                    excludedFilter === 'excluded' ? entity.excluded :
                    !entity.excluded
                  )
                  .map((entity) => (
                  <tr key={entity.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={{ ...stickyTd, left: 0, background: entity.excluded ? '#fef2f2' : '#fff', fontWeight: 500, color: entity.excluded ? '#94a3b8' : '#0f172a', textAlign: 'left', paddingLeft: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleFeeRaiseExcluded(entity.id, entity.excluded); }}
                          title={entity.excluded ? 'Currently excluded from fee raises — click to include' : 'Click to exclude this client from bulk fee raises'}
                          style={{
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            width: 22, height: 22, padding: 0,
                            background: 'transparent', border: 'none',
                            color: entity.excluded ? '#b91c1c' : '#cbd5e1', cursor: 'pointer',
                          }}
                        >
                          {entity.excluded ? <EyeOff size={13} /> : <Eye size={13} />}
                        </button>
                        <a
                          href={`/manage/clients/${entity.id}`}
                          style={{ color: 'inherit', textDecoration: entity.excluded ? 'line-through' : 'none' }}
                          onClick={(ev) => { ev.preventDefault(); navigate(`/manage/clients/${entity.id}`); }}
                        >
                          {entity.name}
                        </a>
                      </div>
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
                          onAdd={() => setAddOpen({ entityId: entity.id, serviceId: sid })}
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
      {addOpen && (
        <AddServiceModal
          services={matrix.services}
          entities={matrix.entityList}
          qboItems={qboItems}
          defaults={addOpen}
          onClose={() => setAddOpen(null)}
          onApply={addService}
          saving={saving}
        />
      )}
    </div>
  );
}

function Cell({ cell, isEditing, focused, onEdit, onSave, onCancel, onClearPending, onAdd }) {
  if (!cell) {
    // Empty cell — click to add the service for this client.
    return (
      <td
        onClick={onAdd}
        style={{ ...cellTd, background: focused ? '#f0f9ff' : undefined, cursor: onAdd ? 'pointer' : 'default' }}
        title="Click to add this service for the client"
      >
        <span style={{ color: '#cbd5e1' }}>{onAdd ? '+ add' : '—'}</span>
      </td>
    );
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

function SortArrow({ active, dir }) {
  if (!active) {
    // Faint dual-arrow hint that the column is sortable.
    return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 0, color: '#cbd5e1' }}>
      <ArrowUp size={9} style={{ marginRight: -3 }} />
      <ArrowDown size={9} />
    </span>;
  }
  return dir === 'asc'
    ? <ArrowUp size={11} style={{ color: '#0c4a6e' }} />
    : <ArrowDown size={11} style={{ color: '#0c4a6e' }} />;
}

function ExcludedToggle({ value, onChange, excludedCount }) {
  const opts = [
    { v: 'all', l: 'All' },
    { v: 'included', l: 'Included' },
    { v: 'excluded', l: `Excluded${excludedCount ? ` · ${excludedCount}` : ''}` },
  ];
  return (
    <div style={{ display: 'inline-flex', border: '1px solid #e5e7eb', borderRadius: 6, overflow: 'hidden' }} title="Filter by fee-raise exclusion">
      {opts.map((o, i) => {
        const active = value === o.v;
        const isExcluded = o.v === 'excluded';
        return (
          <button
            key={o.v}
            onClick={() => onChange(o.v)}
            style={{
              padding: '6px 12px', fontSize: 12, fontWeight: active ? 600 : 500,
              background: active ? (isExcluded ? '#b91c1c' : '#0f172a') : '#fff',
              color: active ? '#fff' : (isExcluded ? '#b91c1c' : '#475569'),
              border: 'none', borderLeft: i > 0 ? '1px solid #e5e7eb' : 'none',
              cursor: 'pointer', fontFamily: font,
            }}
          >{o.l}</button>
        );
      })}
    </div>
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

function AddServiceModal({ services, entities, qboItems, defaults, onClose, onApply, saving }) {
  const [entityId, setEntityId] = useState(defaults.entityId || '');
  // Try to pre-pick a QBO item by matching the defaults.serviceId
  // against item names (defaults.serviceId comes from a column header
  // click on the matrix — that header IS a QBO item name).
  const preselected = defaults.serviceId
    ? (qboItems.find((it) => it.name === defaults.serviceId) || null)
    : null;
  const [qboItemId, setQboItemId] = useState(preselected?.qbo_item_id || (qboItems[0]?.qbo_item_id || ''));
  const selectedItem = qboItems.find((it) => it.qbo_item_id === qboItemId) || null;
  const [description, setDescription] = useState(preselected?.description || '');
  const [cadence, setCadence] = useState('monthly');
  const [amount, setAmount] = useState(preselected?.unit_price || 0);
  const [effectiveAt, setEffectiveAt] = useState('2026-06-01');
  const [reason, setReason] = useState('New service added on Change matrix');

  // Amount may be £0 — a placeholder to be priced when the uplift is
  // reviewed on Push. The reason/note explains why it's being raised.
  const canApply = entityId && qboItemId && Number.isFinite(Number(amount)) && Number(amount) >= 0;

  return (
    <ModalShell title="Add service" onClose={onClose}>
      <Label>Client</Label>
      <select value={entityId} onChange={(e) => setEntityId(e.target.value)} style={inputStyle}>
        <option value="">— pick a client —</option>
        {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
      </select>

      <Label style={{ marginTop: 12 }}>QBO service item</Label>
      <select
        value={qboItemId}
        onChange={(e) => {
          const id = e.target.value;
          setQboItemId(id);
          const item = qboItems.find((it) => it.qbo_item_id === id);
          if (item) {
            setDescription(item.description || item.name);
            if (!amount || amount === 0) setAmount(item.unit_price || 0);
          }
        }}
        style={inputStyle}
      >
        <option value="">— pick QBO item —</option>
        {qboItems.map((it) => (
          <option key={it.qbo_item_id} value={it.qbo_item_id}>{it.name}</option>
        ))}
      </select>
      {selectedItem?.description && (
        <p style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>{selectedItem.description}</p>
      )}

      <Label style={{ marginTop: 10 }}>Cadence</Label>
      <select value={cadence} onChange={(e) => setCadence(e.target.value)} style={inputStyle}>
        <option value="monthly">Monthly</option>
        <option value="annual">Annual</option>
        <option value="one_off">One-off</option>
      </select>

      <Label style={{ marginTop: 10 }}>{cadence === 'annual' ? 'Annual £' : cadence === 'monthly' ? 'Monthly £' : 'Amount £'}</Label>
      <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} style={inputStyle} />

      <Label style={{ marginTop: 10 }}>Effective from</Label>
      <input type="date" value={effectiveAt} onChange={(e) => setEffectiveAt(e.target.value)} style={inputStyle} />

      <Label style={{ marginTop: 10 }}>Reason / note</Label>
      <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} style={inputStyle} />

      <p style={{ fontSize: 11, color: '#64748b', marginTop: 10 }}>
        Stages as a pending uplift. Push from <strong>Push uplifts</strong> to land on the QBO recurring template.
      </p>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button onClick={onClose} disabled={saving} style={modalBtnGhost}>Cancel</button>
        <button
          onClick={() => onApply({
            entityId,
            qboItemId,
            serviceId: selectedItem?.name || '',
            description: description || selectedItem?.description || selectedItem?.name || '',
            cadence,
            monthlyAmount: Number(amount),
            effectiveAt,
            reason,
          })}
          disabled={saving || !canApply}
          style={{ ...modalBtnPrimary, opacity: canApply ? 1 : 0.5, cursor: canApply ? 'pointer' : 'not-allowed' }}
        >
          {saving ? 'Adding…' : 'Add service'}
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

// Sticky layering reference:
//   z 5 : corner cells (sticky-top AND sticky-left) — always on top
//   z 3 : sticky-top header cells (column headers, totals row)
//   z 2 : sticky-left body cells (client name, per-client total)
//   z 1 : ordinary body cells
// Without explicit z-index, the column-totals row in the header
// overlaid the client name column when scrolling horizontally.
const HEADER_ROW_1 = 32; // first thead row height in px (top headings)
const HEADER_ROW_2 = 56; // second thead row height in px (3-line totals)

const stickyTh = { position: 'sticky', padding: '4px 8px', fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em', background: '#f8fafc', borderBottom: '1px solid #e5e7eb', borderRight: '1px solid #f1f5f9', textAlign: 'right', top: 0, height: HEADER_ROW_1, boxSizing: 'border-box' };
const stickyTd = { position: 'sticky', padding: '6px 8px', borderRight: '1px solid #f1f5f9', verticalAlign: 'middle', fontSize: 13, zIndex: 2 };
const cellTd = { padding: '6px 8px', textAlign: 'right', verticalAlign: 'middle', borderRight: '1px solid #f1f5f9', fontSize: 13, minWidth: 60 };

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
