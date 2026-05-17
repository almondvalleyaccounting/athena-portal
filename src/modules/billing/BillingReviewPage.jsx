import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, X, Edit2, ArrowUp, ArrowDown } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import AlphabetFilter, { firstCharBucket } from '../../components/AlphabetFilter';

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
  const [filter, setFilter] = useState('suggested'); // suggested | approved | rejected | all
  const [cadenceFilter, setCadenceFilter] = useState('all'); // all | monthly | annual | one_off | unset
  const [sourceFilter, setSourceFilter] = useState('all'); // all | qbo | invoice
  const [showNlac, setShowNlac] = useState(false);
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

  const filtered = useMemo(() => {
    let out = items;
    if (!showNlac) out = out.filter((i) => i.entityStatus !== 'nlac');
    if (filter !== 'all') out = out.filter((i) => i.status === filter);
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
  }, [items, filter, cadenceFilter, sourceFilter, showNlac, search, letter, sortBy, sortDir]);

  const counts = useMemo(() => {
    const c = { suggested: 0, approved: 0, rejected: 0, all: items.length };
    for (const i of items) c[i.status] = (c[i.status] || 0) + 1;
    return c;
  }, [items]);

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
      <button onClick={() => navigate('/manage/billing')} style={backLinkStyle}>
        <ArrowLeft size={14} /> Back to Fee Billing
      </button>

      <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 2 }}>
        Billing approval queue
      </h1>
      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 720, marginBottom: 16 }}>
        Approve each suggested monthly recurring bill before it counts in the headline. Edit cadence or amount if the system got it wrong.
      </p>

      {/* Filter pills */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <FilterPill label="Suggested" count={counts.suggested || 0} active={filter === 'suggested'} tone="amber" onClick={() => setFilter('suggested')} />
        <FilterPill label="Approved" count={counts.approved || 0} active={filter === 'approved'} tone="green" onClick={() => setFilter('approved')} />
        <FilterPill label="Rejected" count={counts.rejected || 0} active={filter === 'rejected'} tone="slate" onClick={() => setFilter('rejected')} />
        <FilterPill label={`All (${counts.all})`} count={null} active={filter === 'all'} tone="default" onClick={() => setFilter('all')} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search client or service..."
          style={{ ...selectStyle, flex: 1, minWidth: 240, marginLeft: 'auto' }}
        />
      </div>

      {/* Secondary filters: cadence, source, needs-classification */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={filterLabelStyle}>Cadence</label>
        <select value={cadenceFilter} onChange={(e) => setCadenceFilter(e.target.value)} style={selectStyle}>
          <option value="all">All</option>
          <option value="monthly">Monthly</option>
          <option value="annual">Annual</option>
          <option value="one_off">One-off</option>
          <option value="unset">Unset</option>
        </select>

        <label style={{ ...filterLabelStyle, marginLeft: 8 }}>Source</label>
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} style={selectStyle}>
          <option value="all">All</option>
          <option value="qbo">QBO template</option>
          <option value="invoice">Invoice-inferred</option>
        </select>

        <label style={{ ...filterLabelStyle, marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }} title="Include rows for clients marked No Longer A Client">
          <input type="checkbox" checked={showNlac} onChange={(e) => setShowNlac(e.target.checked)} />
          Show NLAC clients
        </label>

        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: '#94a3b8' }}>{filtered.length} of {items.length}</span>
      </div>

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
          <button onClick={() => setSelected(new Set())} disabled={saving} style={btnGhost}>Clear</button>
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 13, color: '#94a3b8', padding: 40, textAlign: 'center' }}>Loading…</p>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 60, textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>
          {filter === 'suggested' ? 'Queue clear — nothing to review.' : 'Nothing here.'}
        </div>
      ) : (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: 32 }} />
              <col style={{ width: '20%' }} />
              <col style={{ width: '26%' }} />
              <col style={{ width: 230 }} />
              <col style={{ width: 100 }} />
              <col style={{ width: 100 }} />
              <col style={{ width: 150 }} />
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
                        <span style={{ fontFamily: 'monospace' }}>£{Number(s.monthly_amount || 0).toFixed(2)}</span>
                      )}
                    </Td>
                    <Td>
                      <StatusChip status={i.status} />
                    </Td>
                    <Td>
                      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
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
                            ↺
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

function StatusChip({ status }) {
  const map = {
    suggested: { bg: '#fef3c7', fg: '#78350f', label: 'Suggested' },
    approved: { bg: '#dcfce7', fg: '#166534', label: 'Approved' },
    rejected: { bg: '#f1f5f9', fg: '#475569', label: 'Rejected' },
  };
  const t = map[status] || map.suggested;
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
      background: t.bg, color: t.fg,
    }}>{t.label}</span>
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
  const tones = {
    amber: { active: { bg: '#fef3c7', fg: '#78350f', border: '#fcd34d' }, idle: { bg: '#fff', fg: '#78350f', border: '#fcd34d' } },
    green: { active: { bg: '#dcfce7', fg: '#166534', border: '#86efac' }, idle: { bg: '#fff', fg: '#166534', border: '#86efac' } },
    slate: { active: { bg: '#f1f5f9', fg: '#475569', border: '#cbd5e1' }, idle: { bg: '#fff', fg: '#64748b', border: '#cbd5e1' } },
    default: { active: { bg: '#0f172a', fg: '#fff', border: '#0f172a' }, idle: { bg: '#fff', fg: '#475569', border: '#e5e7eb' } },
  };
  const t = tones[tone] || tones.default;
  const s = active ? t.active : t.idle;
  return (
    <button onClick={onClick} style={{
      fontSize: 12, fontWeight: active ? 600 : 500,
      padding: '5px 12px', borderRadius: 999,
      background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
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
  const palettes = {
    teal: { bg: '#ccfbf1', fg: '#115e59' },
    red:  { bg: '#fee2e2', fg: '#b91c1c' },
  };
  const p = palettes[tone] || palettes.teal;
  return {
    display: 'inline-block', marginLeft: 8,
    fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em',
    padding: '1px 6px', borderRadius: 4,
    background: p.bg, color: p.fg,
  };
}
