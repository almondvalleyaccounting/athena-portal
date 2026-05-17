import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, X, RotateCcw, RefreshCw } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import BillingTabs from './BillingTabs';
import SearchInput from '../../components/SearchInput';
import { fmtGbp } from '../../lib/money';

const font = "'Outfit', sans-serif";

// Review staged uplifts (pending_monthly_amount on services) before
// they're pushed to QBO. Approval is row-level — every pending service
// on a row goes through together because each row maps to a single QBO
// RecurringTransaction template. Only rows with
// uplift_review_status='approved' are eligible to push.
export default function BillingUpliftReviewPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState('staged'); // staged | approved | rejected | all
  const [selected, setSelected] = useState(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [search, setSearch] = useState('');

  const load = async () => {
    setLoading(true);
    // Pull every active billing row with at least one pending uplift.
    // We over-fetch (no jsonb filter) then narrow client-side — the set
    // is small (~ tens of rows).
    const { data } = await supabase
      .from('live_billing')
      .select('id, entity_id, services, qbo_recurring_txn_id, qbo_next_run_date, uplift_review_status, uplift_reviewed_at, entity:entities(id, name)')
      .eq('status', 'active')
      .order('id', { ascending: false });
    const filtered = (data || []).filter((r) =>
      Array.isArray(r.services) && r.services.some((s) => s.pending_monthly_amount != null)
    );
    setRows(filtered);
    setSelected(new Set());
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  // Auto-refresh next-run dates from QBO once the rows are loaded, but
  // only for rows missing the date. Keeps the page fresh without
  // hammering QBO if the user reloads frequently.
  useEffect(() => {
    if (loading || rows.length === 0) return;
    const stale = rows.filter((r) => r.qbo_recurring_txn_id && !r.qbo_next_run_date).map((r) => r.id);
    if (stale.length === 0) return;
    (async () => {
      try {
        await supabase.functions.invoke('qbo-fetch-template-meta', { body: { billing_ids: stale } });
        await load();
      } catch (e) { /* best effort */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const summarised = useMemo(() => rows.map((r) => {
    const services = (r.services || []).filter((s) => s.pending_monthly_amount != null);
    const oldTotal = services.reduce((sum, s) => sum + (Number(s.monthly_amount) || 0), 0);
    const newTotal = services.reduce((sum, s) => sum + (Number(s.pending_monthly_amount) || 0), 0);
    const goLive = services.map((s) => s.pending_effective_at).filter(Boolean).sort()[0] || null;
    const reason = services.map((s) => s.pending_uplift_reason).find(Boolean) || null;
    return {
      ...r,
      _pendingLines: services.length,
      _oldTotal: Math.round(oldTotal * 100) / 100,
      _newTotal: Math.round(newTotal * 100) / 100,
      _delta: Math.round((newTotal - oldTotal) * 100) / 100,
      _goLive: goLive,
      _reason: reason,
    };
  }), [rows]);

  const counts = useMemo(() => {
    const c = { staged: 0, approved: 0, rejected: 0, all: summarised.length };
    for (const r of summarised) {
      const k = r.uplift_review_status || 'staged';
      c[k] = (c[k] || 0) + 1;
    }
    return c;
  }, [summarised]);

  const visible = useMemo(() => {
    let out = summarised;
    if (filter === 'all') {
      // no status narrowing
    } else if (filter === 'staged') {
      out = out.filter((r) => !r.uplift_review_status || r.uplift_review_status === 'staged');
    } else {
      out = out.filter((r) => r.uplift_review_status === filter);
    }
    const q = search.trim().toLowerCase();
    if (q) out = out.filter((r) => (r.entity?.name || '').toLowerCase().includes(q));
    return out;
  }, [summarised, filter, search]);

  const totals = useMemo(() => {
    const old = visible.reduce((s, r) => s + r._oldTotal, 0);
    const neu = visible.reduce((s, r) => s + r._newTotal, 0);
    return { old: Math.round(old * 100) / 100, neu: Math.round(neu * 100) / 100, delta: Math.round((neu - old) * 100) / 100 };
  }, [visible]);

  const setStatus = async (ids, status) => {
    if (ids.length === 0) return;
    setSaving(true);
    const updates = {
      uplift_review_status: status,
      uplift_reviewed_by: profile?.id || null,
      uplift_reviewed_at: new Date().toISOString(),
    };
    await supabase.from('live_billing').update(updates).in('id', ids);
    setSaving(false);
    await load();
  };

  const unstage = async (id) => {
    if (!window.confirm('Discard the pending uplift on this row? The current monthly amount stays as-is.')) return;
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    const services = (row.services || []).map((s) => ({
      ...s,
      pending_monthly_amount: null,
      pending_effective_at: null,
      pending_uplift_reason: null,
      pending_uplift_staged_at: null,
    }));
    setSaving(true);
    await supabase.from('live_billing').update({
      services,
      uplift_review_status: null,
      uplift_reviewed_by: null,
      uplift_reviewed_at: null,
    }).eq('id', id);
    setSaving(false);
    await load();
  };

  const refreshFromQbo = async () => {
    const ids = rows.filter((r) => r.qbo_recurring_txn_id).map((r) => r.id);
    if (ids.length === 0) return;
    setRefreshing(true);
    try {
      await supabase.functions.invoke('qbo-fetch-template-meta', { body: { billing_ids: ids } });
      await load();
    } catch (err) {
      alert('Refresh failed: ' + (err.message || err));
    } finally {
      setRefreshing(false);
    }
  };

  const pushApproved = async (dryRun = false) => {
    const approvedRows = summarised.filter((r) => r.uplift_review_status === 'approved' && r.qbo_recurring_txn_id);
    if (approvedRows.length === 0) {
      alert('Nothing to push — no rows are approved with a QBO template link.');
      return;
    }
    const ids = approvedRows.map((r) => r.id);
    const label = dryRun ? 'Dry-run' : 'Push';
    if (!window.confirm(`${label} ${ids.length} approved uplift${ids.length === 1 ? '' : 's'} to QBO?\n\nThis overwrites line amounts on the existing recurring templates.`)) return;
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

  const toggleSel = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleSelAll = () => {
    const visIds = visible.map((r) => r.id);
    const all = visIds.length > 0 && visIds.every((id) => selected.has(id));
    setSelected(all ? new Set() : new Set(visIds));
  };
  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(r.id));

  const approvedCount = counts.approved || 0;

  return (
    <div style={{ padding: '20px 28px', fontFamily: font, maxWidth: 1400 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 }}>
        <div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 2 }}>
            Push uplifts
          </h1>
          <p style={{ fontSize: 13, color: '#64748b', maxWidth: 720, marginBottom: 0 }}>
            Review staged fee uplifts and approve them before pushing to QBO. Approval is per template — every pending service on a row goes through together.
          </p>
        </div>
        <button onClick={refreshFromQbo} disabled={refreshing} style={btnSecondary} title="Pull next-run dates from QBO">
          <RefreshCw size={13} style={refreshing ? { animation: 'spin 1s linear infinite' } : null} />
          {refreshing ? 'Refreshing…' : 'Refresh from QBO'}
        </button>
      </div>

      <BillingTabs active="push" />

      {/* Filter pills */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <Pill label="Staged" count={counts.staged || 0} active={filter === 'staged'} tone="amber" onClick={() => setFilter('staged')} />
        <Pill label="Approved" count={counts.approved || 0} active={filter === 'approved'} tone="green" onClick={() => setFilter('approved')} />
        <Pill label="Rejected" count={counts.rejected || 0} active={filter === 'rejected'} tone="slate" onClick={() => setFilter('rejected')} />
        <Pill label={`All (${counts.all})`} active={filter === 'all'} tone="default" onClick={() => setFilter('all')} />

        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search client…"
          style={{ flex: 1, minWidth: 220, marginLeft: 'auto' }}
        />
      </div>

      {/* Bulk bar */}
      {selected.size > 0 && (
        <div style={bulkBarStyle}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{selected.size} selected</span>
          <div style={{ flex: 1 }} />
          <button onClick={() => setStatus(Array.from(selected), 'approved')} disabled={saving} style={btnApprove}>Approve</button>
          <button onClick={() => setStatus(Array.from(selected), 'rejected')} disabled={saving} style={btnReject}>Reject</button>
          <button onClick={() => setStatus(Array.from(selected), 'staged')} disabled={saving} style={btnUndo}>Reset</button>
          <button onClick={() => setSelected(new Set())} disabled={saving} style={btnGhost}>Clear</button>
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 13, color: '#94a3b8', padding: 40, textAlign: 'center' }}>Loading…</p>
      ) : visible.length === 0 ? (
        <div style={{ padding: 60, textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>
          {filter === 'staged' ? 'No staged uplifts. Plan one from the approval queue.' : 'Nothing in this view.'}
        </div>
      ) : (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <colgroup>
              <col style={{ width: 32 }} />
              <col style={{ width: '22%' }} />
              <col style={{ width: 70 }} />
              <col style={{ width: 110 }} />
              <col style={{ width: 110 }} />
              <col style={{ width: 90 }} />
              <col style={{ width: 110 }} />
              <col style={{ width: 110 }} />
              <col style={{ width: 100 }} />
              <col style={{ width: 160 }} />
            </colgroup>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                <Th><input type="checkbox" checked={allVisibleSelected} onChange={toggleSelAll} /></Th>
                <Th>Client</Th>
                <Th>Lines</Th>
                <Th align="right">Old monthly</Th>
                <Th align="right">New monthly</Th>
                <Th align="right">Δ</Th>
                <Th>Go-live</Th>
                <Th>Next QBO run</Th>
                <Th>Status</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const status = r.uplift_review_status || 'staged';
                const isSel = selected.has(r.id);
                const hasTemplate = !!r.qbo_recurring_txn_id;
                return (
                  <tr key={r.id} style={{ borderTop: '1px solid #f1f5f9', background: isSel ? '#f0f9ff' : 'transparent' }}>
                    <Td><input type="checkbox" checked={isSel} onChange={() => toggleSel(r.id)} /></Td>
                    <Td>
                      <div style={{ fontWeight: 500, color: '#0f172a' }}>{r.entity?.name || 'Unknown'}</div>
                      {!hasTemplate && <span style={{ fontSize: 10, color: '#b45309' }}>⚠ no QBO template</span>}
                      {r._reason && <div style={{ fontSize: 10, color: '#94a3b8' }} title={r._reason}>{r._reason.length > 50 ? r._reason.slice(0, 50) + '…' : r._reason}</div>}
                    </Td>
                    <Td>{r._pendingLines}</Td>
                    <Td align="right" style={{ fontFamily: 'monospace' }}>£{r._oldTotal.toFixed(2)}</Td>
                    <Td align="right" style={{ fontFamily: 'monospace', fontWeight: 600 }}>£{r._newTotal.toFixed(2)}</Td>
                    <Td align="right" style={{ fontFamily: 'monospace', color: r._delta > 0 ? '#15803d' : r._delta < 0 ? '#b91c1c' : '#94a3b8' }}>
                      {r._delta > 0 ? '+' : ''}£{r._delta.toFixed(2)}
                    </Td>
                    <Td style={{ color: '#475569' }}>{r._goLive || '—'}</Td>
                    <Td style={{ color: '#475569' }}>{r.qbo_next_run_date || '—'}</Td>
                    <Td><StatusChip status={status} /></Td>
                    <Td>
                      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                        {status !== 'approved' && (
                          <button onClick={() => setStatus([r.id], 'approved')} disabled={saving} title="Approve for push" style={iconBtn('#059669')}>
                            <Check size={13} />
                          </button>
                        )}
                        {status !== 'rejected' && (
                          <button onClick={() => setStatus([r.id], 'rejected')} disabled={saving} title="Reject (keep staged but exclude from push)" style={iconBtn('#b91c1c')}>
                            <X size={13} />
                          </button>
                        )}
                        {status !== 'staged' && (
                          <button onClick={() => setStatus([r.id], 'staged')} disabled={saving} title="Reset to staged" style={iconBtn('#64748b')}>
                            <RotateCcw size={13} />
                          </button>
                        )}
                        <button onClick={() => unstage(r.id)} disabled={saving} title="Discard the pending uplift entirely" style={{ ...iconBtn('#94a3b8'), fontSize: 10 }}>
                          ✕
                        </button>
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ background: '#f8fafc', borderTop: '2px solid #e5e7eb' }}>
                <Td colSpan={3} />
                <Td align="right" style={{ fontFamily: 'monospace', fontWeight: 600 }}>£{totals.old.toFixed(2)}</Td>
                <Td align="right" style={{ fontFamily: 'monospace', fontWeight: 600 }}>£{totals.neu.toFixed(2)}</Td>
                <Td align="right" style={{ fontFamily: 'monospace', fontWeight: 700, color: totals.delta > 0 ? '#15803d' : '#94a3b8' }}>
                  {totals.delta > 0 ? '+' : ''}£{totals.delta.toFixed(2)}
                </Td>
                <Td colSpan={4} style={{ fontSize: 11, color: '#94a3b8' }}>{visible.length} row{visible.length === 1 ? '' : 's'}</Td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Sticky push footer — appears whenever there's something
          approved. Keeps the primary action one click away wherever
          the user has scrolled to. */}
      {approvedCount > 0 && (
        <div style={pushFooterStyle}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {approvedCount} approved {approvedCount === 1 ? 'template' : 'templates'} ready to push
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={() => pushApproved(true)} disabled={pushing} style={btnPushDry} title="Show proposed bodies in console, no QBO writes">
            Dry-run
          </button>
          <button onClick={() => pushApproved(false)} disabled={pushing} style={btnPushLive}>
            {pushing ? 'Pushing…' : `Push ${approvedCount} to QBO`}
          </button>
        </div>
      )}
    </div>
  );
}

function StatusChip({ status }) {
  const map = {
    staged:   { bg: '#fef3c7', fg: '#78350f', label: 'Staged' },
    approved: { bg: '#dcfce7', fg: '#166534', label: 'Approved' },
    rejected: { bg: '#f1f5f9', fg: '#475569', label: 'Rejected' },
  };
  const t = map[status] || map.staged;
  return (
    <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: t.bg, color: t.fg }}>{t.label}</span>
  );
}

function Pill({ label, count, active, tone, onClick }) {
  const tones = {
    amber:   { active: { bg: '#fef3c7', fg: '#78350f', border: '#fcd34d' }, idle: { bg: '#fff', fg: '#78350f', border: '#fcd34d' } },
    green:   { active: { bg: '#dcfce7', fg: '#166534', border: '#86efac' }, idle: { bg: '#fff', fg: '#166534', border: '#86efac' } },
    slate:   { active: { bg: '#f1f5f9', fg: '#475569', border: '#cbd5e1' }, idle: { bg: '#fff', fg: '#64748b', border: '#cbd5e1' } },
    default: { active: { bg: '#0f172a', fg: '#fff', border: '#0f172a' }, idle: { bg: '#fff', fg: '#475569', border: '#e5e7eb' } },
  };
  const t = tones[tone] || tones.default;
  const s = active ? t.active : t.idle;
  return (
    <button onClick={onClick} style={{ fontSize: 12, fontWeight: active ? 600 : 500, padding: '5px 12px', borderRadius: 999, background: s.bg, color: s.fg, border: `1px solid ${s.border}`, cursor: 'pointer', fontFamily: font }}>
      {label}{count != null ? ` · ${count}` : ''}
    </button>
  );
}

const Th = ({ children, align }) => <th style={{ textAlign: align || 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{children}</th>;
const Td = ({ children, align, style, colSpan }) => <td colSpan={colSpan} style={{ padding: '8px 12px', verticalAlign: 'middle', textAlign: align || 'left', ...style }}>{children}</td>;

const backLinkStyle = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 500, color: '#64748b', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 12, padding: 0, fontFamily: font };
const bulkBarStyle = { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', marginBottom: 10, background: '#0f172a', color: '#fff', borderRadius: 8, position: 'sticky', top: 0, zIndex: 20 };
const btnApprove = { padding: '6px 14px', fontSize: 12, fontWeight: 600, background: '#059669', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: font };
const btnReject = { padding: '6px 14px', fontSize: 12, fontWeight: 600, background: '#b91c1c', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: font };
const btnUndo = { padding: '6px 14px', fontSize: 12, fontWeight: 500, background: '#64748b', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: font };
const btnGhost = { padding: '6px 12px', fontSize: 12, fontWeight: 500, background: 'none', color: '#cbd5e1', border: 'none', cursor: 'pointer', fontFamily: font };
const btnSecondary = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 12, fontWeight: 500, background: '#fff', color: '#475569', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', fontFamily: font };
const btnPushDry = { padding: '6px 14px', fontSize: 12, fontWeight: 500, background: '#fff', color: '#6d28d9', border: '1px solid #c4b5fd', borderRadius: 6, cursor: 'pointer', fontFamily: font };
const btnPushLive = { padding: '6px 14px', fontSize: 12, fontWeight: 600, background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: font };
const pushFooterStyle = {
  position: 'sticky', bottom: 0, marginTop: 14,
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '12px 16px',
  background: '#fff', border: '1px solid #c4b5fd', borderRadius: 10,
  boxShadow: '0 -6px 20px rgba(15,23,42,0.05)',
  color: '#0f172a', fontFamily: font, zIndex: 10,
};

function iconBtn(color) {
  return { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, padding: 0, background: '#fff', border: `1px solid ${color}40`, borderRadius: 6, color, cursor: 'pointer' };
}
