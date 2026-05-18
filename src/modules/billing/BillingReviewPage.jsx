import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, X, Edit2, ArrowUp, ArrowDown, CalendarX, Copy, RotateCcw } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import AlphabetFilter, { firstCharBucket } from '../../components/AlphabetFilter';
import SearchInput from '../../components/SearchInput';
import PlanUpliftModal from './PlanUpliftModal';
import BillingTabs from './BillingTabs';
import FiltersPopover from '../../components/FiltersPopover';
import OverflowMenu from '../../components/OverflowMenu';
import EmptyState from '../../components/EmptyState';
import { tones } from '../../lib/tokens';

const font = "'Outfit', sans-serif";

// The review queue is the approval gate for every invoice-inferred
// monthly recurring suggestion. Nothing counts in "Recurring Monthly"
// on the dashboard until it's approved here. QBO RecurringTransaction
// templates are auto-approved (explicit staff intent), but still
// editable from this page.
export default function BillingReviewPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();

  const [rows, setRows] = useState([]); // live_billing rows w/ entity
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState('suggested'); // suggested | approved | rejected | ending | all
  const [cadenceFilter, setCadenceFilter] = useState('all'); // all | monthly | annual | one_off | unset
  const [sourceFilter, setSourceFilter] = useState('all'); // all | qbo | invoice
  const [showNlac, setShowNlac] = useState(false);
  const [upliftOpen, setUpliftOpen] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnoseResult, setDiagnoseResult] = useState(null);
  const [sortBy, setSortBy] = useState('client'); // client | service | monthly
  const [sortDir, setSortDir] = useState('asc'); // asc | desc
  const [search, setSearch] = useState('');
  const [letter, setLetter] = useState(null);
  const [selected, setSelected] = useState(new Set()); // "rowId::serviceId"
  const [editing, setEditing] = useState(null); // { rowId, serviceIdx }

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('live_billing')
      .select('id, entity_id, billing_type, services, monthly_net, annual_total, qbo_recurring_txn_id, entity:entities(id, name, entity_status)')
      .eq('status', 'active')
      .order('created_at', { ascending: false });
    setRows(data || []);
    setSelected(new Set());
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  // Flatten rows → per-service items for the queue table. Each item
  // carries back-pointer (rowId, serviceIdx) so we can write updates
  // to the services jsonb in place.
  const items = useMemo(() => {
    const out = [];
    for (const r of rows) {
      const services = Array.isArray(r.services) ? r.services : [];
      services.forEach((s, idx) => {
        const status = s.approval_status || (r.qbo_recurring_txn_id ? 'approved' : 'suggested');
        out.push({
          rowId: r.id,
          serviceIdx: idx,
          entityName: r.entity?.name || 'Unknown',
          entityId: r.entity_id,
          entityStatus: r.entity?.entity_status || 'active',
          fromTemplate: !!r.qbo_recurring_txn_id,
          service: s,
          status,
        });
      });
    }
    return out;
  }, [rows]);

  // Duplicate detection: (entity_id, service_id) pairs with ≥2
  // unacknowledged service lines. A user can explicitly mark a line
  // duplicate_acknowledged=true to say "this is intentional, don't
  // flag it" — those don't count toward the group size.
  const dupKeySet = useMemo(() => {
    const counts = new Map();
    for (const i of items) {
      if (i.service.duplicate_acknowledged) continue;
      const sid = i.service.service_id || '';
      if (!sid) continue;
      const k = `${i.entityId}::${sid}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const dups = new Set();
    for (const [k, n] of counts) if (n >= 2) dups.add(k);
    return dups;
  }, [items]);

  const isDup = (i) => {
    const sid = i.service.service_id || '';
    if (!sid || i.service.duplicate_acknowledged) return false;
    return dupKeySet.has(`${i.entityId}::${sid}`);
  };

  const filtered = useMemo(() => {
    let out = items;
    if (!showNlac) out = out.filter((i) => i.entityStatus !== 'nlac');
    // Ending and Duplicates are their own buckets, shown only on their
    // pill and excluded from the other filters.
    if (filter === 'ending') {
      out = out.filter((i) => i.service.recurring_status === 'ending');
    } else if (filter === 'duplicates') {
      out = out.filter((i) => i.service.recurring_status !== 'ending' && isDup(i));
    } else {
      out = out.filter((i) => i.service.recurring_status !== 'ending');
      if (filter !== 'all') out = out.filter((i) => i.status === filter);
    }
    if (cadenceFilter !== 'all') {
      out = out.filter((i) => {
        const c = i.service.cadence;
        if (cadenceFilter === 'unset') return !c;
        return c === cadenceFilter;
      });
    }
    if (sourceFilter !== 'all') {
      out = out.filter((i) => sourceFilter === 'qbo' ? i.fromTemplate : !i.fromTemplate);
    }
    if (letter) out = out.filter((i) => firstCharBucket(i.entityName) === letter);
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter((i) =>
        (i.entityName || '').toLowerCase().includes(q) ||
        (i.service.description || '').toLowerCase().includes(q) ||
        (i.service.service_id || '').toLowerCase().includes(q)
      );
    }
    // Sort
    const dir = sortDir === 'asc' ? 1 : -1;
    out = [...out].sort((a, b) => {
      let av, bv;
      if (sortBy === 'monthly') {
        av = Number(a.service.monthly_amount) || 0;
        bv = Number(b.service.monthly_amount) || 0;
        return (av - bv) * dir;
      }
      if (sortBy === 'service') {
        av = (a.service.service_id || a.service.description || '').toLowerCase();
        bv = (b.service.service_id || b.service.description || '').toLowerCase();
      } else { // client
        av = (a.entityName || '').toLowerCase();
        bv = (b.entityName || '').toLowerCase();
      }
      return av.localeCompare(bv) * dir;
    });
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, filter, cadenceFilter, sourceFilter, showNlac, search, letter, sortBy, sortDir, dupKeySet]);

  const counts = useMemo(() => {
    const c = { suggested: 0, approved: 0, rejected: 0, ending: 0, duplicates: 0, all: 0 };
    for (const i of items) {
      if (i.service.recurring_status === 'ending') {
        c.ending++;
      } else {
        c[i.status] = (c[i.status] || 0) + 1;
        c.all++;
        if (isDup(i)) c.duplicates++;
      }
    }
    return c;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, dupKeySet]);

  // Count rows (live_billing entries) with at least one pending uplift
  // AND a QBO recurring template id — these are eligible to push.
  const pendingPushableRows = useMemo(() => {
    return rows.filter((r) =>
      r.qbo_recurring_txn_id &&
      Array.isArray(r.services) &&
      r.services.some((s) => s.pending_monthly_amount != null)
    );
  }, [rows]);

  const pushPendingToQbo = async (dryRun = false) => {
    const ids = pendingPushableRows.map((r) => r.id);
    if (ids.length === 0) return;
    const label = dryRun ? 'Dry-run' : 'Push';
    if (!window.confirm(`${label} ${ids.length} QBO recurring template${ids.length === 1 ? '' : 's'} with staged uplifts?\n\nThis will overwrite line amounts on the existing templates in QuickBooks.`)) return;
    setPushing(true);
    try {
      const { data, error } = await supabase.functions.invoke('qbo-push-recurring', {
        body: { billing_ids: ids, dry_run: dryRun, initiated_by: profile?.id || null },
      });
      if (error) throw error;
      const s = data?.summary || {};
      const msg = `${label} complete\n\nPushed: ${s.pushed || 0}\nSkipped: ${s.skipped || 0}\nErrored: ${s.errored || 0}`;
      if (dryRun) {
        console.log('Dry-run results:', data);
        alert(msg + '\n\nFull dry-run output logged to console.');
      } else {
        alert(msg);
        await load();
      }
    } catch (err) {
      alert('Push failed: ' + (err.message || err));
    } finally {
      setPushing(false);
    }
  };

  // ── Mutation: patch a single service line in live_billing.services.
  // We read the row, modify the one index, write back. No FOR UPDATE
  // lock — the review queue is a single-user-at-a-time flow in practice.
  const patchService = async (rowId, serviceIdx, patch) => {
    const row = rows.find((r) => r.id === rowId);
    if (!row) return;
    const services = Array.isArray(row.services) ? [...row.services] : [];
    const existing = services[serviceIdx] || {};
    const updated = { ...existing, ...patch };

    // Recompute annual_amount if monthly changed.
    if (patch.monthly_amount !== undefined && updated.cadence === 'monthly') {
      updated.annual_amount = Math.round(Number(patch.monthly_amount) * 12 * 100) / 100;
    }
    if (patch.cadence) {
      updated.cadence_months = patch.cadence === 'monthly' ? 1 : patch.cadence === 'annual' ? 12 : 0;
      updated.billing_type = patch.cadence === 'monthly' ? 'recurring' : patch.cadence;
    }
    services[serviceIdx] = updated;

    // Recompute row totals from the services jsonb.
    const rowMonthlyNet = services.reduce((s, sv) => {
      if (sv.cadence === 'monthly' && sv.approval_status === 'approved') {
        return s + (Number(sv.monthly_amount) || 0);
      }
      return s;
    }, 0);
    const rowAnnualTotal = services.reduce((s, sv) => s + (Number(sv.annual_amount) || 0), 0);

    setSaving(true);
    const { error } = await supabase
      .from('live_billing')
      .update({
        services,
        monthly_net: Math.round(rowMonthlyNet * 100) / 100,
        monthly_vat: Math.round(rowMonthlyNet * 0.2 * 100) / 100,
        monthly_gross: Math.round(rowMonthlyNet * 1.2 * 100) / 100,
        annual_total: Math.round(rowAnnualTotal * 100) / 100,
      })
      .eq('id', rowId);

    if (error) {
      alert('Save failed: ' + error.message);
      setSaving(false);
      return;
    }

    // Optimistic local state update.
    setRows((prev) => prev.map((r) => r.id === rowId ? { ...r, services } : r));
    setSaving(false);
  };

  const approve = (item) => patchService(item.rowId, item.serviceIdx, {
    approval_status: 'approved',
    approved_by: profile?.id || null,
    approved_at: new Date().toISOString(),
  });

  const reject = (item) => patchService(item.rowId, item.serviceIdx, {
    approval_status: 'rejected',
    approved_by: profile?.id || null,
    approved_at: new Date().toISOString(),
  });

  const acknowledgeDuplicate = (item) => patchService(item.rowId, item.serviceIdx, {
    duplicate_acknowledged: true,
    duplicate_acknowledged_by: profile?.id || null,
    duplicate_acknowledged_at: new Date().toISOString(),
  });

  const unacknowledgeDuplicate = (item) => patchService(item.rowId, item.serviceIdx, {
    duplicate_acknowledged: null,
    duplicate_acknowledged_by: null,
    duplicate_acknowledged_at: null,
  });

  const toggleEnding = (item) => {
    const isEnding = item.service.recurring_status === 'ending';
    return patchService(item.rowId, item.serviceIdx, {
      recurring_status: isEnding ? 'recurring' : 'ending',
    });
  };

  const unapprove = (item) => patchService(item.rowId, item.serviceIdx, {
    approval_status: 'suggested',
    approved_by: null,
    approved_at: null,
  });

  const bulkApprove = async () => {
    if (selected.size === 0) return;
    if (!window.confirm(`Approve ${selected.size} service line(s) as monthly recurring?`)) return;
    setSaving(true);
    const now = new Date().toISOString();
    // Group by rowId so we write each row once.
    const byRow = {};
    for (const key of selected) {
      const [rowId, serviceIdxStr] = key.split('::');
      (byRow[rowId] ||= []).push(Number(serviceIdxStr));
    }
    for (const [rowId, idxs] of Object.entries(byRow)) {
      const row = rows.find((r) => r.id === rowId);
      if (!row) continue;
      const services = [...(row.services || [])];
      for (const i of idxs) {
        services[i] = { ...services[i], approval_status: 'approved', approved_by: profile?.id || null, approved_at: now };
      }
      const rowMonthlyNet = services.reduce((s, sv) => sv.cadence === 'monthly' && sv.approval_status === 'approved' ? s + (Number(sv.monthly_amount) || 0) : s, 0);
      const rowAnnualTotal = services.reduce((s, sv) => s + (Number(sv.annual_amount) || 0), 0);
      await supabase.from('live_billing').update({
        services,
        monthly_net: Math.round(rowMonthlyNet * 100) / 100,
        monthly_vat: Math.round(rowMonthlyNet * 0.2 * 100) / 100,
        monthly_gross: Math.round(rowMonthlyNet * 1.2 * 100) / 100,
        annual_total: Math.round(rowAnnualTotal * 100) / 100,
      }).eq('id', rowId);
    }
    await load();
    setSaving(false);
  };

  const bulkReject = async () => {
    if (selected.size === 0) return;
    if (!window.confirm(`Reject ${selected.size} service line(s)? They'll be excluded from Recurring Monthly.`)) return;
    setSaving(true);
    const now = new Date().toISOString();
    const byRow = {};
    for (const key of selected) {
      const [rowId, serviceIdxStr] = key.split('::');
      (byRow[rowId] ||= []).push(Number(serviceIdxStr));
    }
    for (const [rowId, idxs] of Object.entries(byRow)) {
      const row = rows.find((r) => r.id === rowId);
      if (!row) continue;
      const services = [...(row.services || [])];
      for (const i of idxs) {
        services[i] = { ...services[i], approval_status: 'rejected', approved_by: profile?.id || null, approved_at: now };
      }
      const rowMonthlyNet = services.reduce((s, sv) => sv.cadence === 'monthly' && sv.approval_status === 'approved' ? s + (Number(sv.monthly_amount) || 0) : s, 0);
      await supabase.from('live_billing').update({
        services,
        monthly_net: Math.round(rowMonthlyNet * 100) / 100,
        monthly_vat: Math.round(rowMonthlyNet * 0.2 * 100) / 100,
        monthly_gross: Math.round(rowMonthlyNet * 1.2 * 100) / 100,
      }).eq('id', rowId);
    }
    await load();
    setSaving(false);
  };

  const toggleSel = (key) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const toggleSelAll = () => {
    const visibleKeys = filtered.map((i) => `${i.rowId}::${i.serviceIdx}`);
    const allSelected = visibleKeys.length > 0 && visibleKeys.every((k) => selected.has(k));
    setSelected(allSelected ? new Set() : new Set(visibleKeys));
  };

  const visibleKeys = filtered.map((i) => `${i.rowId}::${i.serviceIdx}`);
  const allVisibleSelected = visibleKeys.length > 0 && visibleKeys.every((k) => selected.has(k));

  return (
    <div style={{ padding: '20px 28px', fontFamily: font, maxWidth: 1280 }}>
      <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 2 }}>
        Billing approval queue
      </h1>
      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 720, marginBottom: 14 }}>
        Approve each suggested monthly recurring bill before it counts in the headline. Edit cadence or amount if the system got it wrong.
      </p>

      <BillingTabs active="import" />

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <button
          onClick={async () => {
            setDiagnosing(true);
            try {
              const { data, error } = await supabase.functions.invoke('qbo-diagnose-templates', { body: {} });
              if (error) throw error;
              setDiagnoseResult(data);
            } catch (err) {
              alert('Diagnose failed: ' + (err.message || err));
            } finally {
              setDiagnosing(false);
            }
          }}
          disabled={diagnosing}
          style={{ fontSize: 11, fontWeight: 500, padding: '4px 10px', background: '#fff', color: '#64748b', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', fontFamily: font }}
          title="Show every QBO recurring template and its link status"
        >
          {diagnosing ? 'Checking…' : 'Diagnose QBO templates'}
        </button>
      </div>

      {diagnoseResult && (
        <DiagnoseModal
          data={diagnoseResult}
          onClose={() => setDiagnoseResult(null)}
          onRepaired={() => load()}
        />
      )}

      {/* Filter pills */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <FilterPill label="Suggested" count={counts.suggested || 0} active={filter === 'suggested'} tone="amber" onClick={() => setFilter('suggested')} />
        <FilterPill label="Approved" count={counts.approved || 0} active={filter === 'approved'} tone="green" onClick={() => setFilter('approved')} />
        <FilterPill label="Rejected" count={counts.rejected || 0} active={filter === 'rejected'} tone="slate" onClick={() => setFilter('rejected')} />
        <FilterPill label="Ending" count={counts.ending || 0} active={filter === 'ending'} tone="orange" onClick={() => setFilter('ending')} />
        <FilterPill label="Duplicates" count={counts.duplicates || 0} active={filter === 'duplicates'} tone="red" onClick={() => setFilter('duplicates')} />
        <FilterPill label={`All (${counts.all})`} count={null} active={filter === 'all'} tone="default" onClick={() => setFilter('all')} />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search client or service..."
          style={{ flex: 1, minWidth: 240, marginLeft: 'auto' }}
        />
      </div>

      {/* Secondary filter controls collapsed behind a single Filters
          popover so the pill row stays the only thing the eye scans. */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <FiltersPopover
          activeCount={
            (cadenceFilter !== 'all' ? 1 : 0) +
            (sourceFilter !== 'all' ? 1 : 0) +
            (showNlac ? 1 : 0)
          }
        >
          <Label>Cadence</Label>
          <select value={cadenceFilter} onChange={(e) => setCadenceFilter(e.target.value)} style={popoverSelectStyle}>
            <option value="all">All</option>
            <option value="monthly">Monthly</option>
            <option value="annual">Annual</option>
            <option value="one_off">One-off</option>
            <option value="unset">Unset</option>
          </select>

          <Label style={{ marginTop: 10 }}>Source</Label>
          <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} style={popoverSelectStyle}>
            <option value="all">All</option>
            <option value="qbo">QBO template</option>
            <option value="invoice">Invoice-inferred</option>
          </select>

          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, fontSize: 12, color: '#475569', cursor: 'pointer' }}>
            <input type="checkbox" checked={showNlac} onChange={(e) => setShowNlac(e.target.checked)} />
            Show NLAC clients
          </label>

          {(cadenceFilter !== 'all' || sourceFilter !== 'all' || showNlac) && (
            <button
              onClick={() => { setCadenceFilter('all'); setSourceFilter('all'); setShowNlac(false); }}
              style={{ marginTop: 12, fontSize: 11, fontWeight: 500, background: 'none', border: 'none', color: '#0e7fe0', cursor: 'pointer', fontFamily: font, padding: 0 }}
            >
              Reset filters
            </button>
          )}
        </FiltersPopover>

        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: '#94a3b8' }}>{filtered.length} of {items.length}</span>
      </div>

      {pendingPushableRows.length > 0 && (
        <div style={pendingBarStyle}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>
            {pendingPushableRows.length} template{pendingPushableRows.length === 1 ? ' has' : 's have'} a staged uplift waiting for review
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={() => navigate('/manage/billing/uplifts')} style={btnPushLive}>
            Review uplifts →
          </button>
        </div>
      )}

      <div style={{ marginBottom: 10 }}>
        <AlphabetFilter
          items={items.map(i => ({ name: i.entityName || '' }))}
          selected={letter}
          onChange={setLetter}
        />
      </div>

      {/* Bulk bar */}
      {selected.size > 0 && (
        <div style={bulkBarStyle}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{selected.size} selected</span>
          <div style={{ flex: 1 }} />
          <button onClick={bulkApprove} disabled={saving} style={btnApprove}>Approve</button>
          <button onClick={bulkReject} disabled={saving} style={btnReject}>Reject</button>
          <span style={{ width: 1, alignSelf: 'stretch', background: '#334155', margin: '0 4px' }} />
          <button onClick={() => setUpliftOpen(true)} disabled={saving} style={btnUplift} title="Stage a fee uplift on the selected lines">
            Plan uplift on {selected.size} selected →
          </button>
          <button onClick={() => setSelected(new Set())} disabled={saving} style={btnGhost}>Clear</button>
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 13, color: '#94a3b8', padding: 40, textAlign: 'center' }}>Loading…</p>
      ) : filtered.length === 0 ? (
        filter === 'suggested' ? (
          <EmptyState
            icon="✓"
            title="Queue clear"
            body="Every imported service has been reviewed. When QBO sends new billing, the suggestions will land here."
            actions={[
              { label: 'Plan a fee uplift →', onClick: () => navigate('/manage/billing/change'), primary: true },
              { label: 'Back to Dashboard', onClick: () => navigate('/manage/billing') },
            ]}
          />
        ) : filter === 'duplicates' ? (
          <EmptyState
            icon="✓"
            title="No duplicates"
            body="Every client has unique service lines (or you've already acknowledged the intentional ones)."
            actions={[
              { label: 'Show all', onClick: () => setFilter('all') },
            ]}
          />
        ) : filter === 'ending' ? (
          <EmptyState
            icon="—"
            title="Nothing marked ending"
            body="When a service is winding down, mark it ending so it drops out of your forward billing view."
            actions={[{ label: 'Show all', onClick: () => setFilter('all') }]}
          />
        ) : (
          <EmptyState
            icon="—"
            title="No results"
            body="Try a different filter or clear the search."
            actions={[{ label: 'Show all', onClick: () => setFilter('all') }]}
          />
        )
      ) : null}

      {upliftOpen && (
        <PlanUpliftModal
          rows={rows}
          selectedKeys={selected}
          onClose={() => setUpliftOpen(false)}
          onApplied={() => { setSelected(new Set()); load(); }}
        />
      )}

      {!loading && filtered.length > 0 && (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: 32 }} />
              <col style={{ width: '20%' }} />
              <col style={{ width: '26%' }} />
              <col style={{ width: 230 }} />
              <col style={{ width: 100 }} />
              <col style={{ width: 130 }} />
              <col style={{ width: 210 }} />
            </colgroup>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                <Th>
                  <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelAll} title="Select all in view" />
                </Th>
                <SortableTh label="Client" sortKey="client" sortBy={sortBy} sortDir={sortDir} onSort={(k) => { if (sortBy === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc'); else { setSortBy(k); setSortDir('asc'); } }} />
                <SortableTh label="Service" sortKey="service" sortBy={sortBy} sortDir={sortDir} onSort={(k) => { if (sortBy === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc'); else { setSortBy(k); setSortDir('asc'); } }} />
                <Th>Cadence</Th>
                <SortableTh label="Monthly" sortKey="monthly" sortBy={sortBy} sortDir={sortDir} onSort={(k) => { if (sortBy === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc'); else { setSortBy(k); setSortDir('desc'); } }} />
                <Th>Status</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((i) => {
                const key = `${i.rowId}::${i.serviceIdx}`;
                const isSel = selected.has(key);
                const isEdit = editing?.rowId === i.rowId && editing?.serviceIdx === i.serviceIdx;
                const s = i.service;
                return (
                  <tr key={key} style={{ borderTop: '1px solid #f1f5f9', background: isSel ? '#f0f9ff' : 'transparent' }}>
                    <Td>
                      <input type="checkbox" checked={isSel} onChange={() => toggleSel(key)} />
                    </Td>
                    <Td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={i.entityName}>
                      {i.entityName}
                      {i.entityStatus === 'nlac' && <span style={tagStyle('red')} title="No Longer A Client">NLAC</span>}
                      {i.fromTemplate && <span style={tagStyle('teal')} title="From QBO RecurringTransaction template">QBO template</span>}
                      {isDup(i) && <span style={tagStyle('red')} title={`Potential duplicate — another line on this client also has service "${i.service.service_id}"`}>DUP</span>}
                      {i.service.duplicate_acknowledged && <span style={tagStyle('slate')} title="Duplicate acknowledged as intentional">DUP OK</span>}
                    </Td>
                    <Td>
                      <div style={{ fontWeight: 500, color: '#0f172a' }}>{s.service_id || 'service'}</div>
                      {s.description && s.description !== s.service_id && (
                        <div style={{ fontSize: 10, color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.description}>
                          {s.description.length > 60 ? s.description.slice(0, 60) + '…' : s.description}
                        </div>
                      )}
                      {s.review_reason && (
                        <div style={{ fontSize: 10, color: '#b45309', marginTop: 2 }}>⚠ {s.review_reason}</div>
                      )}
                    </Td>
                    <Td>
                      <CadenceSegmented
                        value={s.cadence || 'monthly'}
                        onChange={(next) => {
                          if (next !== (s.cadence || 'monthly')) {
                            patchService(i.rowId, i.serviceIdx, { cadence: next });
                          }
                          setSelected((prev) => {
                            if (prev.has(key)) return prev;
                            const nextSet = new Set(prev);
                            nextSet.add(key);
                            return nextSet;
                          });
                        }}
                        disabled={saving}
                      />
                    </Td>
                    <Td>
                      {isEdit ? (
                        <input
                          type="number"
                          step="0.01"
                          defaultValue={s.monthly_amount || 0}
                          onBlur={(e) => {
                            const v = parseFloat(e.target.value) || 0;
                            if (v !== Number(s.monthly_amount)) patchService(i.rowId, i.serviceIdx, { monthly_amount: v });
                          }}
                          style={{ ...selectStyle, width: 90 }}
                        />
                      ) : (
                        <div>
                          <span style={{ fontFamily: 'monospace' }}>£{Number(s.monthly_amount || 0).toFixed(2)}</span>
                          {s.pending_monthly_amount != null && Number(s.pending_monthly_amount) !== Number(s.monthly_amount) && (
                            <div style={{ fontSize: 10, fontFamily: 'monospace', color: '#7c3aed', marginTop: 2 }}
                                 title={`Pending from ${s.pending_effective_at || ''}${s.pending_uplift_reason ? ` — ${s.pending_uplift_reason}` : ''}`}>
                              → £{Number(s.pending_monthly_amount).toFixed(2)}
                            </div>
                          )}
                        </div>
                      )}
                    </Td>
                    <Td>
                      <StatusChip status={i.status} />
                      {s.recurring_status === 'ending' && (
                        <span style={{ ...tagStyle('amber'), marginLeft: 6 }} title="Service marked as ending — excluded from future billing">Ending</span>
                      )}
                    </Td>
                    <Td>
                      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', alignItems: 'center' }}>
                        {i.status !== 'approved' && (
                          <button onClick={() => approve(i)} disabled={saving} title="Approve" style={iconBtn('#059669')}>
                            <Check size={13} />
                          </button>
                        )}
                        {i.status !== 'rejected' && (
                          <button onClick={() => reject(i)} disabled={saving} title="Reject" style={iconBtn('#b91c1c')}>
                            <X size={13} />
                          </button>
                        )}
                        {i.status === 'approved' && (
                          <button onClick={() => unapprove(i)} disabled={saving} title="Un-approve" style={iconBtn('#64748b')}>
                            <RotateCcw size={13} />
                          </button>
                        )}
                        <button
                          onClick={() => toggleEnding(i)}
                          disabled={saving}
                          title={s.recurring_status === 'ending' ? 'Unmark ending (back to recurring)' : 'Mark ending (drops from future billing)'}
                          style={iconBtn(s.recurring_status === 'ending' ? '#b45309' : '#64748b')}
                        >
                          <CalendarX size={13} />
                        </button>
                        {(isDup(i) || s.duplicate_acknowledged) && (
                          <button
                            onClick={() => s.duplicate_acknowledged ? unacknowledgeDuplicate(i) : acknowledgeDuplicate(i)}
                            disabled={saving}
                            title={s.duplicate_acknowledged ? 'Re-flag as potential duplicate' : 'Mark not a duplicate (intentional)'}
                            style={iconBtn(s.duplicate_acknowledged ? '#475569' : '#b91c1c')}
                          >
                            <Copy size={13} />
                          </button>
                        )}
                        <button
                          onClick={() => setEditing(isEdit ? null : { rowId: i.rowId, serviceIdx: i.serviceIdx })}
                          disabled={saving}
                          title="Edit cadence and amount"
                          style={iconBtn(isEdit ? '#0e7fe0' : '#64748b')}
                        >
                          <Edit2 size={13} />
                        </button>
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DiagnoseModal({ data, onClose, onRepaired }) {
  const s = data?.summary || {};
  const noEntity = data?.unlinked_no_entity_mapping || [];
  const noBilling = data?.unlinked_no_billing_row || [];
  // Repair workflow: for each unlinked_no_billing_row template, find
  // the entity's existing manual live_billing row and attach the
  // qbo_recurring_txn_id. We load candidates on first render.
  const [candidates, setCandidates] = useState({}); // entity_id → [{ id, monthly_net, has_existing_txn }]
  const [repairing, setRepairing] = useState(false);
  const [repaired, setRepaired] = useState(new Set()); // txn_ids that have been attached

  useEffect(() => {
    if (noBilling.length === 0) return;
    const entityIds = [...new Set(noBilling.map((r) => r.entity_id).filter(Boolean))];
    if (entityIds.length === 0) return;
    (async () => {
      const { data: rows } = await supabase
        .from('live_billing')
        .select('id, entity_id, qbo_recurring_txn_id, monthly_net')
        .in('entity_id', entityIds)
        .eq('status', 'active');
      const map = {};
      for (const r of rows || []) {
        (map[r.entity_id] ||= []).push({ id: r.id, monthly_net: r.monthly_net, has_existing_txn: !!r.qbo_recurring_txn_id });
      }
      setCandidates(map);
    })();
  }, [noBilling]);

  // Returns the best billing row to attach this template to: prefer
  // rows WITHOUT an existing txn and WITH monthly revenue.
  const pickCandidate = (entityId) => {
    const list = candidates[entityId] || [];
    const free = list.filter((r) => !r.has_existing_txn);
    if (free.length === 0) return null;
    return free.sort((a, b) => (Number(b.monthly_net) || 0) - (Number(a.monthly_net) || 0))[0];
  };

  const attachOne = async (txn) => {
    const candidate = pickCandidate(txn.entity_id);
    if (!candidate) return false;
    const { error } = await supabase
      .from('live_billing')
      .update({ qbo_recurring_txn_id: txn.txn_id })
      .eq('id', candidate.id);
    if (error) { alert('Repair failed: ' + error.message); return false; }
    setRepaired((prev) => new Set([...prev, txn.txn_id]));
    return true;
  };

  const repairAll = async () => {
    const repairable = noBilling.filter((r) => pickCandidate(r.entity_id) && !repaired.has(r.txn_id));
    if (repairable.length === 0) { alert('Nothing to repair — no candidate billing rows found.'); return; }
    if (!window.confirm(`Attach ${repairable.length} unlinked QBO template${repairable.length === 1 ? '' : 's'} to existing billing rows?\n\nEach client's largest unlinked billing row will get the template id. Re-pull from QBO afterwards to refresh the service lines from the template.`)) return;
    setRepairing(true);
    let ok = 0;
    for (const t of repairable) {
      const success = await attachOne(t);
      if (success) ok++;
    }
    setRepairing(false);
    alert(`Repaired ${ok} of ${repairable.length}. Re-pull from QBO to refresh services from the templates.`);
    onRepaired?.();
  };

  const repairableCount = noBilling.filter((r) => pickCandidate(r.entity_id) && !repaired.has(r.txn_id)).length;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, fontFamily: font }} onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 12, width: 760, maxWidth: '95vw', maxHeight: '85vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center' }}>
          <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, fontWeight: 500, color: '#0f172a', margin: 0 }}>QBO template diagnostic</h2>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', fontSize: 18 }}>×</button>
        </div>
        <div style={{ padding: 18, overflow: 'auto' }}>
          <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
            <DiagStat label="Templates in QBO" value={s.qbo_templates_total ?? '—'} />
            <DiagStat label="Linked" value={s.linked ?? '—'} tone="green" />
            <DiagStat label="No entity mapping" value={s.unlinked_no_entity_mapping ?? '—'} tone="red" />
            <DiagStat label="No billing row" value={s.unlinked_no_billing_row ?? '—'} tone="amber" />
          </div>

          {noEntity.length > 0 && (
            <details open style={{ marginBottom: 14 }}>
              <summary style={{ fontWeight: 600, fontSize: 13, color: '#b91c1c', cursor: 'pointer', marginBottom: 6 }}>
                {noEntity.length} template{noEntity.length === 1 ? '' : 's'} — QBO customer not mapped to any Athena entity
              </summary>
              <p style={{ fontSize: 11, color: '#64748b', marginTop: 0 }}>Fix on the <a href="/manage/billing/qbo-mapping" style={{ color: '#0e7fe0' }}>QBO mapping</a> page, then re-run pull.</p>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead><tr style={{ background: '#f8fafc' }}><DiagTh>Template</DiagTh><DiagTh>QBO customer</DiagTh><DiagTh>QBO ID</DiagTh><DiagTh>Active</DiagTh></tr></thead>
                <tbody>
                  {noEntity.map((r, i) => (
                    <tr key={i} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <DiagTd>{r.template_name || `(txn ${r.txn_id})`}</DiagTd>
                      <DiagTd>{r.qbo_customer_name}</DiagTd>
                      <DiagTd>{r.qbo_customer_id}</DiagTd>
                      <DiagTd>{r.active ? '✓' : '✗'}</DiagTd>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}

          {noBilling.length > 0 && (
            <details open>
              <summary style={{ fontWeight: 600, fontSize: 13, color: '#b45309', cursor: 'pointer', marginBottom: 6 }}>
                {noBilling.length} template{noBilling.length === 1 ? '' : 's'} — entity matched but no live_billing row carries the txn id
              </summary>
              <p style={{ fontSize: 11, color: '#64748b', marginTop: 0 }}>
                These templates exist in QBO and belong to entities we already know about — they just never got attached to a billing row. Click <strong>Attach</strong> to wire each one to the entity's largest unlinked billing row. After repair, re-pull from QBO to refresh the service lines from the templates.
              </p>
              {repairableCount > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <button
                    onClick={repairAll}
                    disabled={repairing}
                    style={{ padding: '6px 14px', fontSize: 12, fontWeight: 600, background: '#059669', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: font }}
                  >
                    {repairing ? 'Attaching…' : `Attach all ${repairableCount} suggested →`}
                  </button>
                </div>
              )}
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead><tr style={{ background: '#f8fafc' }}><DiagTh>Template</DiagTh><DiagTh>Entity</DiagTh><DiagTh>QBO customer</DiagTh><DiagTh>Active</DiagTh><DiagTh></DiagTh></tr></thead>
                <tbody>
                  {noBilling.map((r, i) => {
                    const cand = pickCandidate(r.entity_id);
                    const done = repaired.has(r.txn_id);
                    return (
                      <tr key={i} style={{ borderTop: '1px solid #f1f5f9' }}>
                        <DiagTd>{r.template_name || `(txn ${r.txn_id})`}</DiagTd>
                        <DiagTd>{r.entity_name}</DiagTd>
                        <DiagTd>{r.qbo_customer_name}</DiagTd>
                        <DiagTd>{r.active ? '✓' : '✗'}</DiagTd>
                        <DiagTd>
                          {done ? (
                            <span style={{ fontSize: 11, color: '#059669', fontWeight: 600 }}>✓ Attached</span>
                          ) : cand ? (
                            <button
                              onClick={async () => { await attachOne(r); onRepaired?.(); }}
                              disabled={repairing}
                              style={{ fontSize: 11, fontWeight: 500, padding: '3px 10px', background: '#fff', color: '#059669', border: '1px solid #6ee7b7', borderRadius: 6, cursor: 'pointer', fontFamily: font }}
                            >Attach</button>
                          ) : (
                            <span style={{ fontSize: 10, color: '#94a3b8' }}>No free billing row</span>
                          )}
                        </DiagTd>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </details>
          )}

          {noEntity.length === 0 && noBilling.length === 0 && (
            <div style={{ padding: 30, textAlign: 'center', color: '#15803d', fontSize: 13 }}>
              Every QBO template is linked to a billing row. Nothing to fix.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DiagStat({ label, value, tone }) {
  const fg = tone === 'green' ? '#15803d' : tone === 'red' ? '#b91c1c' : tone === 'amber' ? '#b45309' : '#0f172a';
  return (
    <div style={{ flex: 1, minWidth: 130, padding: '10px 12px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8 }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: fg, fontFamily: 'monospace', marginTop: 2 }}>{value}</div>
    </div>
  );
}
const DiagTh = ({ children }) => <th style={{ textAlign: 'left', padding: '6px 10px', fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{children}</th>;
const DiagTd = ({ children }) => <td style={{ padding: '6px 10px', verticalAlign: 'middle' }}>{children}</td>;

function StatusChip({ status }) {
  const map = {
    suggested: { tone: 'warning', label: 'Suggested' },
    approved:  { tone: 'success', label: 'Approved' },
    rejected:  { tone: 'neutral', label: 'Rejected' },
  };
  const m = map[status] || map.suggested;
  const t = tones[m.tone];
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
      background: t.bg, color: t.fg,
    }}>{m.label}</span>
  );
}

// Three-option segmented control — one click to set cadence, no
// edit-mode detour. Selected option is filled with its tone colour so
// the current classification is legible at a glance across the row.
const CADENCE_OPTIONS = [
  { value: 'monthly', label: 'Monthly', fg: '#0e7fe0', bg: '#dbeafe' },
  { value: 'annual',  label: 'Annual',  fg: '#0f766e', bg: '#ccfbf1' },
  { value: 'one_off', label: 'One-off', fg: '#6d28d9', bg: '#ede9fe' },
];
function CadenceSegmented({ value, onChange, disabled }) {
  return (
    <div style={{ display: 'inline-flex', border: '1px solid #e5e7eb', borderRadius: 6, overflow: 'hidden', whiteSpace: 'nowrap' }}>
      {CADENCE_OPTIONS.map((o, idx) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            disabled={disabled}
            title={`Classify as ${o.label}`}
            style={{
              fontSize: 11, fontWeight: active ? 600 : 500,
              padding: '4px 10px',
              background: active ? o.bg : '#fff',
              color: active ? o.fg : '#64748b',
              border: 'none',
              borderLeft: idx > 0 ? '1px solid #e5e7eb' : 'none',
              cursor: disabled ? 'not-allowed' : 'pointer',
              fontFamily: font,
              transition: 'background 0.1s',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function FilterPill({ label, count, active, tone, onClick }) {
  // Legacy tone names → semantic. The "default" pill (All) goes dark
  // when active so it reads as the master.
  const semanticMap = { amber: 'warning', green: 'success', slate: 'neutral', orange: 'warning', red: 'danger' };
  const isMaster = !tone || tone === 'default';
  const semantic = semanticMap[tone] || 'neutral';
  const t = tones[semantic];
  const bg = active ? (isMaster ? '#0f172a' : t.bg) : '#fff';
  const fg = active && isMaster ? '#fff' : t.fg;
  const border = isMaster && !active ? '#e5e7eb' : t.border;
  return (
    <button onClick={onClick} style={{
      fontSize: 12, fontWeight: active ? 600 : 500,
      padding: '5px 12px', borderRadius: 999,
      background: bg, color: fg, border: `1px solid ${border}`,
      cursor: 'pointer', fontFamily: font,
    }}>
      {label}{count != null ? ` · ${count}` : ''}
    </button>
  );
}

const Th = ({ children }) => (
  <th style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
    {children}
  </th>
);
const Td = ({ children, style }) => <td style={{ padding: '8px 12px', verticalAlign: 'middle', ...style }}>{children}</td>;

function SortableTh({ label, sortKey, sortBy, sortDir, onSort }) {
  const active = sortBy === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: active ? '#0f172a' : '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', cursor: 'pointer', userSelect: 'none' }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {label}
        {active && (sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
      </span>
    </th>
  );
}

const filterLabelStyle = { fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', fontFamily: font };
const popoverSelectStyle = { width: '100%', padding: '6px 10px', fontSize: 13, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#0f172a', outline: 'none', boxSizing: 'border-box' };

const Label = ({ children, style }) => <div style={{ fontSize: 10, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5, ...style }}>{children}</div>;

const selectStyle = { padding: '4px 8px', fontSize: 12, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#1e293b', outline: 'none' };

const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  fontSize: 12, fontWeight: 500, color: '#64748b',
  background: 'none', border: 'none', cursor: 'pointer',
  marginBottom: 12, padding: 0, fontFamily: font,
};

const bulkBarStyle = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '10px 14px', marginBottom: 10,
  background: '#0f172a', color: '#fff', borderRadius: 8,
  position: 'sticky', top: 0, zIndex: 20,
};

const btnApprove = { padding: '6px 14px', fontSize: 12, fontWeight: 600, background: '#059669', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: font };
const btnReject = { padding: '6px 14px', fontSize: 12, fontWeight: 600, background: '#b91c1c', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: font };
const btnUplift = { padding: '6px 14px', fontSize: 12, fontWeight: 600, background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: font };
const pendingBarStyle = { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', marginBottom: 12, background: '#f5f3ff', border: '1px solid #c4b5fd', borderRadius: 8 };
const btnPushDry = { padding: '6px 14px', fontSize: 12, fontWeight: 500, background: '#fff', color: '#6d28d9', border: '1px solid #c4b5fd', borderRadius: 6, cursor: 'pointer', fontFamily: font };
const btnPushLive = { padding: '6px 14px', fontSize: 12, fontWeight: 600, background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: font };
const btnGhost = { padding: '6px 12px', fontSize: 12, fontWeight: 500, background: 'none', color: '#cbd5e1', border: 'none', cursor: 'pointer', fontFamily: font };

function iconBtn(color) {
  return {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 24, height: 24, padding: 0,
    background: '#fff', border: `1px solid ${color}40`, borderRadius: 6,
    color, cursor: 'pointer',
  };
}

function tagStyle(tone) {
  // Legacy tone names → semantic. teal historically meant "QBO
  // template" — info reads better.
  const map = { teal: 'info', red: 'danger', amber: 'warning', slate: 'neutral' };
  const t = tones[map[tone] || 'neutral'];
  return {
    display: 'inline-block', marginLeft: 8,
    fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em',
    padding: '1px 6px', borderRadius: 4,
    background: t.bg, color: t.fg,
  };
}
