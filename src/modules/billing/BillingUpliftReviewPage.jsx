import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, X, RotateCcw, RefreshCw, Mail, MailX, ArrowUp, ArrowDown } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import BillingTabs from './BillingTabs';
import SearchInput from '../../components/SearchInput';
import EmptyState from '../../components/EmptyState';
import { tones } from '../../lib/tokens';
import { composeUpliftEmail } from './composeUpliftEmail';
import { fmtGbp } from '../../lib/money';

const font = "'Outfit', sans-serif";

// Parse "a@b.com, c@d.com; e@f.com" → ["a@b.com", "c@d.com", "e@f.com"].
// QBO routinely packs multiple emails into one PrimaryEmailAddr string,
// and BM's primary email may differ from the company billing address —
// the modal shows whichever set we find as a candidate list.
function splitEmails(s) {
  if (!s) return [];
  return String(s)
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter((x) => /.+@.+\..+/.test(x));
}

// Pick the primary contact for an entity. Falls back to any linked
// person if no row is flagged is_primary_contact (small entities
// often have a single person attached without the flag set).
function resolvePrimaryContact(entity) {
  const links = entity?.entity_people || [];
  if (links.length === 0) return null;
  const primary = links.find((l) => l.is_primary_contact) || links[0];
  return primary?.person || null;
}

// Greeting name preference: preferred_name (BM "Preferred Name") wins
// over first_name; falls back to the first word of `name` so legacy
// people rows pre-dating the column split still render sensibly.
function firstNameOf(person) {
  if (!person) return null;
  if (person.preferred_name) return person.preferred_name.trim();
  if (person.first_name) return person.first_name.trim();
  if (person.name) return person.name.trim().split(/\s+/)[0] || null;
  return null;
}

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
  const [emailFor, setEmailFor] = useState(null); // row whose draft email is being previewed
  const [emailsBatch, setEmailsBatch] = useState(null); // list of rows for bulk preview
  // Sort state for the Push table. Default: largest delta first so
  // the user works through the meaningful changes top-down.
  const [sortBy, setSortBy] = useState({ key: 'delta', dir: 'desc' });
  const cycleSort = (key) => setSortBy((prev) => {
    if (prev.key !== key) return { key, dir: key === 'client' ? 'asc' : 'desc' };
    if (prev.dir === 'desc') return { key, dir: 'asc' };
    return { key: 'delta', dir: 'desc' };
  });

  const load = async () => {
    setLoading(true);
    // Pull every active billing row with at least one pending uplift.
    // We over-fetch (no jsonb filter) then narrow client-side — the set
    // is small (~ tens of rows).
    const { data } = await supabase
      .from('live_billing')
      .select(`
        id, entity_id, services, qbo_recurring_txn_id, qbo_next_run_date,
        uplift_review_status, uplift_reviewed_at,
        uplift_email_sent_at, uplift_email_to, uplift_email_skipped,
        entity:entities(
          id, name, billing_email, entity_status,
          entity_people(is_primary_contact, person:people(id, name, first_name, preferred_name, email)),
          qbo_customer_mappings(qbo_email, role)
        )
      `)
      .eq('status', 'active')
      .order('id', { ascending: false });
    // A row is "really" pending only if at least one service has a
    // pending amount AND that service is in scope for push:
    //   - approval_status must be 'approved' (rejected/suggested lines
    //     have no business pushing to QBO; the Change matrix can stage
    //     pending values on them, but they're filtered out here)
    //   - recurring_status must not be 'ending' (a pending value on an
    //     ending service is dead weight — contributes £0 and just
    //     clogs the queue with phantom rows)
    // Past offenders fixed by this filter: Road To Sea Ltd (ending),
    // Boiler Installation Glasgow Ltd (rejected).
    const filtered = (data || []).filter((r) =>
      Array.isArray(r.services)
      && r.services.some((s) =>
        s.pending_monthly_amount != null
        && s.recurring_status !== 'ending'
        && (s.approval_status || 'approved') === 'approved'
      )
      && (r.entity?.entity_status || 'active') !== 'nlac'
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

  // Totals are now full-row (the QBO template's total monthly), not
  // just the pending services. Sum every approved monthly service —
  // for ones with a pending uplift use the pending amount in the new
  // total; otherwise the unchanged amount appears in both columns.
  const summarised = useMemo(() => rows.map((r) => {
    const allServices = r.services || [];
    const pending = allServices.filter((s) => s.pending_monthly_amount != null);
    let oldTotal = 0;
    let newTotal = 0;
    for (const s of allServices) {
      if (s.recurring_status === 'ending') continue;
      const status = s.approval_status || (r.qbo_recurring_txn_id ? 'approved' : 'suggested');
      if (status !== 'approved') continue;
      if (s.cadence !== 'monthly') continue;
      const cur = Number(s.monthly_amount) || 0;
      const pen = s.pending_monthly_amount != null ? Number(s.pending_monthly_amount) : cur;
      oldTotal += cur;
      newTotal += pen;
    }
    const goLive = pending.map((s) => s.pending_effective_at).filter(Boolean).sort()[0] || null;
    const reason = pending.map((s) => s.pending_uplift_reason).find(Boolean) || null;
    return {
      ...r,
      _pendingLines: pending.length,
      _oldTotal: Math.round(oldTotal * 100) / 100,
      _newTotal: Math.round(newTotal * 100) / 100,
      _delta: Math.round((newTotal - oldTotal) * 100) / 100,
      _goLive: goLive,
      _reason: reason,
    };
  }), [rows]);

  const counts = useMemo(() => {
    const c = { staged: 0, approved: 0, rejected: 0, no_email: 0, all: summarised.length };
    for (const r of summarised) {
      const k = r.uplift_review_status || 'staged';
      c[k] = (c[k] || 0) + 1;
      if (r.uplift_email_skipped) c.no_email += 1;
    }
    return c;
  }, [summarised]);

  const visible = useMemo(() => {
    let out = summarised;
    if (filter === 'all') {
      // no status narrowing
    } else if (filter === 'staged') {
      out = out.filter((r) => !r.uplift_review_status || r.uplift_review_status === 'staged');
    } else if (filter === 'no_email') {
      out = out.filter((r) => r.uplift_email_skipped);
    } else {
      out = out.filter((r) => r.uplift_review_status === filter);
    }
    const q = search.trim().toLowerCase();
    if (q) out = out.filter((r) => (r.entity?.name || '').toLowerCase().includes(q));

    const dir = sortBy.dir === 'asc' ? 1 : -1;
    const getKey = (r) => {
      switch (sortBy.key) {
        case 'client':    return (r.entity?.name || '').toLowerCase();
        case 'lines':     return r._pendingLines || 0;
        case 'old':       return r._oldTotal || 0;
        case 'new':       return r._newTotal || 0;
        case 'delta':     return r._delta || 0;
        case 'goLive':    return r._goLive || '';
        case 'nextRun':   return r.qbo_next_run_date || '';
        case 'status':    return r.uplift_review_status || 'staged';
        default:          return 0;
      }
    };
    out = [...out].sort((a, b) => {
      const av = getKey(a), bv = getKey(b);
      if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * dir;
      return ((av || 0) - (bv || 0)) * dir;
    });
    return out;
  }, [summarised, filter, search, sortBy]);

  const totals = useMemo(() => {
    const old = visible.reduce((s, r) => s + r._oldTotal, 0);
    const neu = visible.reduce((s, r) => s + r._newTotal, 0);
    return { old: Math.round(old * 100) / 100, neu: Math.round(neu * 100) / 100, delta: Math.round((neu - old) * 100) / 100 };
  }, [visible]);

  // Toggle the "no email needed" flag on one or more rows. The push to
  // QBO still happens (or not) per uplift_review_status; this only
  // governs whether the client gets a notification email.
  const setEmailSkipped = async (ids, skipped) => {
    if (ids.length === 0) return;
    setSaving(true);
    await supabase.from('live_billing')
      .update({ uplift_email_skipped: skipped })
      .in('id', ids);
    setSaving(false);
    await load();
  };

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
        <Pill label="No email" count={counts.no_email || 0} active={filter === 'no_email'} tone="slate" onClick={() => setFilter('no_email')} />
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
          <button
            onClick={() => {
              const ids = Array.from(selected);
              const allSkipped = ids.every((id) => summarised.find((r) => r.id === id)?.uplift_email_skipped);
              setEmailSkipped(ids, !allSkipped);
            }}
            disabled={saving}
            style={btnUndo}
            title="Toggle 'no email needed' for selected rows"
          >No email</button>
          <button onClick={() => setSelected(new Set())} disabled={saving} style={btnGhost}>Clear</button>
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 13, color: '#94a3b8', padding: 40, textAlign: 'center' }}>Loading…</p>
      ) : visible.length === 0 ? (
        filter === 'staged' ? (
          <EmptyState
            icon="✦"
            title="Nothing staged to review"
            body="When you stage an uplift on the Change page, it lands here for approval before it's pushed to QBO."
            actions={[
              { label: 'Go to Change →', onClick: () => navigate('/manage/billing/change'), primary: true },
            ]}
          />
        ) : filter === 'approved' ? (
          <EmptyState
            icon="—"
            title="Nothing approved yet"
            body="Approve staged uplifts to queue them for push."
            actions={[{ label: 'Show staged', onClick: () => setFilter('staged') }]}
          />
        ) : filter === 'no_email' ? (
          <EmptyState
            icon="—"
            title="No rows marked 'no email'"
            body="Use the MailX icon on a row, or select rows and click 'No email' in the bulk bar, to flag uplifts that don't need a client email."
            actions={[{ label: 'Show all', onClick: () => setFilter('all') }]}
          />
        ) : (
          <EmptyState
            icon="—"
            title="No results"
            body="Try a different filter or clear the search."
            actions={[{ label: 'Show staged', onClick: () => setFilter('staged') }]}
          />
        )
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
                <SortTh label="Client"      sortKey="client"  active={sortBy} onClick={cycleSort} />
                <SortTh label="Lines"       sortKey="lines"   active={sortBy} onClick={cycleSort} />
                <SortTh label="Old monthly" sortKey="old"     active={sortBy} onClick={cycleSort} align="right" />
                <SortTh label="New monthly" sortKey="new"     active={sortBy} onClick={cycleSort} align="right" />
                <SortTh label="Δ"           sortKey="delta"   active={sortBy} onClick={cycleSort} align="right" />
                <SortTh label="Go-live"     sortKey="goLive"  active={sortBy} onClick={cycleSort} />
                <SortTh label="Next QBO run" sortKey="nextRun" active={sortBy} onClick={cycleSort} />
                <SortTh label="Status"      sortKey="status"  active={sortBy} onClick={cycleSort} />
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
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontWeight: 500, color: '#0f172a' }}>{r.entity?.name || 'Unknown'}</span>
                        {r.uplift_email_sent_at && (
                          <span
                            style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: '#dcfce7', color: '#166534' }}
                            title={`Email sent ${new Date(r.uplift_email_sent_at).toLocaleString('en-GB')}${r.uplift_email_to ? ` to ${r.uplift_email_to}` : ''}`}
                          >✉ SENT</span>
                        )}
                        {r.uplift_email_skipped && !r.uplift_email_sent_at && (
                          <span
                            style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: '#f1f5f9', color: '#475569' }}
                            title="Marked as not needing an email — excluded from Send all"
                          >NO EMAIL</span>
                        )}
                      </div>
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
                        <button
                          onClick={() => setEmailSkipped([r.id], !r.uplift_email_skipped)}
                          disabled={saving}
                          title={r.uplift_email_skipped ? 'Email currently skipped — click to re-enable' : 'Mark this client as not needing an email (excluded from Send all)'}
                          style={r.uplift_email_skipped
                            ? { ...iconBtn('#b91c1c'), background: '#fee2e2', borderColor: '#b91c1c' }
                            : iconBtn('#94a3b8')}
                        >
                          <MailX size={13} />
                        </button>
                        <button
                          onClick={() => setEmailFor(r)}
                          disabled={saving || r.uplift_email_skipped}
                          title={r.uplift_email_skipped ? 'Email skipped for this row' : 'Preview the fee-raise email for this client'}
                          style={iconBtn('#0e7fe0')}
                        >
                          <Mail size={13} />
                        </button>
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
          <button
            onClick={() => setEmailsBatch(summarised.filter((r) => r.uplift_review_status === 'approved' && !r.uplift_email_skipped))}
            disabled={pushing}
            style={btnPushDry}
            title="Preview a fee-raise email for every approved client — copy/paste or open in your mail client"
          >
            <Mail size={13} style={{ marginRight: 4, verticalAlign: '-2px' }} />
            Generate emails
          </button>
          <button onClick={() => pushApproved(true)} disabled={pushing} style={btnPushDry} title="Show proposed bodies in console, no QBO writes">
            Dry-run
          </button>
          <button onClick={() => pushApproved(false)} disabled={pushing} style={btnPushLive}>
            {pushing ? 'Pushing…' : `Push ${approvedCount} to QBO`}
          </button>
        </div>
      )}

      {emailFor && (
        <EmailPreviewModal rows={[emailFor]} onClose={() => setEmailFor(null)} initiatedBy={profile?.id} onSent={load} />
      )}
      {emailsBatch && (
        <EmailPreviewModal rows={emailsBatch} onClose={() => setEmailsBatch(null)} initiatedBy={profile?.id} onSent={load} />
      )}
    </div>
  );
}

function StatusChip({ status }) {
  const map = {
    staged:   { tone: 'warning', label: 'Staged' },
    approved: { tone: 'success', label: 'Approved' },
    rejected: { tone: 'neutral', label: 'Rejected' },
  };
  const m = map[status] || map.staged;
  const t = tones[m.tone];
  return (
    <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: t.bg, color: t.fg }}>{m.label}</span>
  );
}

function Pill({ label, count, active, tone, onClick }) {
  const semanticMap = { amber: 'warning', green: 'success', slate: 'neutral' };
  const isMaster = !tone || tone === 'default';
  const semantic = semanticMap[tone] || 'neutral';
  const t = tones[semantic];
  const bg = active ? (isMaster ? '#0f172a' : t.bg) : '#fff';
  const fg = active && isMaster ? '#fff' : t.fg;
  const border = isMaster && !active ? '#e5e7eb' : t.border;
  return (
    <button onClick={onClick} style={{ fontSize: 12, fontWeight: active ? 600 : 500, padding: '5px 12px', borderRadius: 999, background: bg, color: fg, border: `1px solid ${border}`, cursor: 'pointer', fontFamily: font }}>
      {label}{count != null ? ` · ${count}` : ''}
    </button>
  );
}

const Th = ({ children, align }) => <th style={{ textAlign: align || 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{children}</th>;

function SortTh({ label, sortKey, active, onClick, align }) {
  const isActive = active.key === sortKey;
  return (
    <th
      onClick={() => onClick(sortKey)}
      style={{ textAlign: align || 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: isActive ? '#0f172a' : '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', cursor: 'pointer', userSelect: 'none' }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexDirection: align === 'right' ? 'row-reverse' : 'row' }}>
        {label}
        {isActive
          ? (active.dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)
          : <span style={{ display: 'inline-flex', color: '#cbd5e1' }}><ArrowUp size={9} style={{ marginRight: -3 }} /><ArrowDown size={9} /></span>}
      </span>
    </th>
  );
}
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

// Preview drafts of the fee-raise email for one or many approved
// rows. Each draft can be copied to clipboard or opened in the
// system mail client via a mailto: link (subject + body pre-filled).
// No backend send wiring — that comes in a separate piece once we
// pick the sender (accounts@ via Gmail OAuth or transactional).
function EmailPreviewModal({ rows, onClose, initiatedBy, onSent }) {
  const drafts = (rows || []).map((r) => {
    const services = (r.services || []).filter((s) => s.pending_monthly_amount != null);
    const contact = resolvePrimaryContact(r.entity);
    const contactName = firstNameOf(contact);
    // Candidate "To" addresses, in priority order, deduped.
    // Order matters — first entry is the default selection.
    const candidates = [];
    const seen = new Set();
    const push = (addr, label) => {
      const a = (addr || '').trim();
      if (!a || seen.has(a.toLowerCase())) return;
      seen.add(a.toLowerCase());
      candidates.push({ addr: a, label });
    };
    // Candidate sources, in user-facing priority order:
    //   1. QBO PrimaryEmailAddr (often the one Intuit invoices go to)
    //   2. entity.billing_email (manual billing override)
    //   3. BM primary contact's personal email
    // All three may carry comma/semicolon-separated lists.
    const qboMaps = r.entity?.qbo_customer_mappings || [];
    for (const m of qboMaps) {
      if (m.role === 'not_a_client') continue;
      for (const a of splitEmails(m.qbo_email)) push(a, 'QBO email');
    }
    for (const a of splitEmails(r.entity?.billing_email)) push(a, 'Billing email');
    for (const a of splitEmails(contact?.email)) push(a, 'Primary contact');
    return {
      row: r,
      contact,
      contactName,
      candidates,
      email: composeUpliftEmail({
        clientName: r.entity?.name || 'Client',
        services,
        contactName,
      }),
    };
  });
  const [idx, setIdx] = useState(0);
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  // Per-row selected address (keyed by billing_id). Empty string = use
  // the default (first candidate). Allows manual override per row.
  const [selectedAddr, setSelectedAddr] = useState({});
  // Per-row "send as physical letter" toggle. Records the send without
  // calling Resend — for elderly clients etc. who only receive post.
  const [letterMode, setLetterMode] = useState({});
  // Track which billing_ids have been sent in this modal session so
  // the Send button flips to "Sent ✓" immediately.
  const [sentRowIds, setSentRowIds] = useState(new Set());
  const active = drafts[idx];
  if (!active) return null;

  const rowId = active.row.id;
  const defaultTo = active.candidates[0]?.addr || '';
  const to = selectedAddr[rowId] ?? defaultTo;
  const isLetter = !!letterMode[rowId];
  const alreadySentOnServer = !!active.row.uplift_email_sent_at;
  const sentThisSession = sentRowIds.has(rowId);
  const isSent = sentThisSession || alreadySentOnServer;
  const noContactName = !active.contactName;

  const markLetterSent = async () => {
    setSending(true);
    try {
      const { error } = await supabase.from('live_billing').update({
        uplift_email_sent_at: new Date().toISOString(),
        uplift_email_sent_by: initiatedBy || null,
        uplift_email_to: 'Physical letter',
      }).eq('id', rowId);
      if (error) throw error;
      setSentRowIds((prev) => new Set([...prev, rowId]));
      onSent?.();
    } catch (e) {
      alert('Failed to record letter send: ' + (e.message || e));
    } finally {
      setSending(false);
    }
  };

  const send = async () => {
    if (noContactName) { alert('No primary contact name on file. Add one in Bright Manager before sending.'); return; }
    if (isLetter) { return markLetterSent(); }
    if (!to) { alert('Pick a recipient address first.'); return; }
    if (isSent && !window.confirm('This row has already been emailed. Send again?')) return;
    setSending(true);
    try {
      const { data, error } = await supabase.functions.invoke('send-uplift-email', {
        body: {
          billing_id: rowId,
          to,
          subject: active.email.subject,
          body_text: active.email.body,
          body_html: active.email.bodyHtml,
          initiated_by: initiatedBy || null,
        },
      });
      if (error || !data?.success) throw new Error(error?.message || data?.error || 'Send failed');
      setSentRowIds((prev) => new Set([...prev, rowId]));
      onSent?.();
    } catch (e) {
      alert('Send failed: ' + (e.message || e));
    } finally {
      setSending(false);
    }
  };

  const sendAll = async () => {
    if (drafts.length <= 1) { send(); return; }
    const pending = drafts.filter((d) =>
      !sentRowIds.has(d.row.id)
      && !d.row.uplift_email_sent_at
      && !d.row.uplift_email_skipped
      && d.contactName
      && !letterMode[d.row.id]
      && d.candidates[0]?.addr
    );
    const blocked = drafts.length - pending.length;
    if (pending.length === 0) { alert('Nothing left to send (all already sent, marked as letter, or missing contact name / email).'); return; }
    const note = blocked > 0 ? `\n\n${blocked} row${blocked === 1 ? '' : 's'} skipped (already sent, marked as letter, or missing contact name / email).` : '';
    if (!window.confirm(`Send the fee-raise email to ${pending.length} client${pending.length === 1 ? '' : 's'} now? This goes via Resend from accounts@.${note}`)) return;
    setSending(true);
    let ok = 0, err = 0;
    for (const d of pending) {
      const dTo = selectedAddr[d.row.id] ?? d.candidates[0].addr;
      try {
        const { data, error } = await supabase.functions.invoke('send-uplift-email', {
          body: {
            billing_id: d.row.id,
            to: dTo,
            subject: d.email.subject,
            body_text: d.email.body,
            body_html: d.email.bodyHtml,
            initiated_by: initiatedBy || null,
          },
        });
        if (error || !data?.success) { err++; continue; }
        ok++;
        setSentRowIds((prev) => new Set([...prev, d.row.id]));
      } catch { err++; }
    }
    setSending(false);
    alert(`Sent ${ok} email${ok === 1 ? '' : 's'}${err ? ` (${err} failed)` : ''}.`);
    onSent?.();
  };

  const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(active.email.subject)}&body=${encodeURIComponent(active.email.body)}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(active.email.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard may be unavailable */ }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, fontFamily: font }} onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 12, width: 760, maxWidth: '95vw', maxHeight: '92vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, fontWeight: 500, color: '#0f172a', margin: 0 }}>
            Fee-raise email
            {drafts.length > 1 && <span style={{ fontSize: 12, fontWeight: 500, color: '#94a3b8', marginLeft: 8 }}>{idx + 1} of {drafts.length}</span>}
          </h2>
          <div style={{ flex: 1 }} />
          {drafts.length > 1 && (
            <>
              <button onClick={() => setIdx(Math.max(0, idx - 1))} disabled={idx === 0} style={{ ...modalBtnGhost, opacity: idx === 0 ? 0.5 : 1 }}>Previous</button>
              <button onClick={() => setIdx(Math.min(drafts.length - 1, idx + 1))} disabled={idx === drafts.length - 1} style={{ ...modalBtnGhost, opacity: idx === drafts.length - 1 ? 0.5 : 1 }}>Next</button>
            </>
          )}
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', fontSize: 18 }}>×</button>
        </div>

        <div style={{ padding: '12px 18px', borderBottom: '1px solid #f1f5f9', fontSize: 12, color: '#475569', display: 'grid', gridTemplateColumns: '70px 1fr', gap: '6px 10px', alignItems: 'start' }}>
          <strong style={{ color: '#0f172a', paddingTop: 4 }}>Contact</strong>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {active.contact ? (
              <>
                <span>{active.contact.name}{active.contactName ? ` (greeting: ${active.contactName})` : ''}</span>
                {noContactName && (
                  <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: '#fee2e2', color: '#991b1b' }}>
                    Cannot derive first name — set one in BM
                  </span>
                )}
              </>
            ) : (
              <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: '#fee2e2', color: '#991b1b' }}>
                No primary contact on file — add one in BM before sending
              </span>
            )}
          </span>

          <strong style={{ color: '#0f172a', paddingTop: 4 }}>To</strong>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {isLetter ? (
              <span style={{ fontSize: 12, color: '#475569', fontStyle: 'italic' }}>
                Physical letter — no email will be sent. Marks the row as sent for tracking.
              </span>
            ) : active.candidates.length === 0 ? (
              <span style={{ fontSize: 11, color: '#991b1b' }}>
                No email addresses on file. Type one below or switch to physical letter.
              </span>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {active.candidates.map((c) => (
                  <label key={c.addr} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name={`to-${rowId}`}
                      checked={to === c.addr}
                      onChange={() => setSelectedAddr((s) => ({ ...s, [rowId]: c.addr }))}
                    />
                    <span style={{ fontFamily: 'monospace' }}>{c.addr}</span>
                    <span style={{ fontSize: 10, color: '#94a3b8' }}>· {c.label}</span>
                  </label>
                ))}
              </div>
            )}
            {!isLetter && (
              <input
                type="email"
                value={to}
                onChange={(e) => setSelectedAddr((s) => ({ ...s, [rowId]: e.target.value }))}
                placeholder="Or type a different address…"
                style={{ padding: '4px 8px', fontSize: 12, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 6, outline: 'none' }}
              />
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#475569', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={isLetter}
                onChange={(e) => setLetterMode((m) => ({ ...m, [rowId]: e.target.checked }))}
              />
              Send as physical letter (no email)
            </label>
            {(alreadySentOnServer && !sentThisSession) || sentThisSession ? (
              <span style={{ display: 'inline-flex', alignSelf: 'flex-start' }}>
                {sentThisSession ? (
                  <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: '#dcfce7', color: '#166534' }}>✓ Sent this session</span>
                ) : (
                  <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: '#fef3c7', color: '#92400e' }} title={`Last sent ${new Date(active.row.uplift_email_sent_at).toLocaleString('en-GB')}${active.row.uplift_email_to ? ` to ${active.row.uplift_email_to}` : ''}`}>
                    Previously sent{active.row.uplift_email_to ? ` to ${active.row.uplift_email_to}` : ''}
                  </span>
                )}
              </span>
            ) : null}
          </div>

          <strong style={{ color: '#0f172a' }}>From</strong>
          <span>accounts@almondvalleyaccounting.co.uk</span>
          <strong style={{ color: '#0f172a' }}>Subject</strong>
          <span>{active.email.subject}</span>
        </div>

        {/* HTML preview — sandboxed iframe shows exactly what the
            recipient will see. Text version is still copyable from the
            footer button. */}
        <iframe
          title="Email preview"
          srcDoc={active.email.bodyHtml}
          sandbox=""
          style={{
            flex: 1,
            width: '100%',
            border: 'none',
            background: '#fafafa',
          }}
        />

        <div style={{ padding: '12px 18px', borderTop: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={copy} disabled={sending} style={modalBtnGhost}>{copied ? 'Copied ✓' : 'Copy text'}</button>
          <a
            href={mailto}
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...modalBtnGhost, textDecoration: 'none' }}
            title="Open in your local mail client (no send via accounts@)"
          >Open in mail app</a>
          <div style={{ flex: 1 }} />
          {drafts.length > 1 && (
            <button onClick={sendAll} disabled={sending} style={{ ...modalBtnGhost, color: '#0e7fe0', borderColor: '#bfdbfe' }}>
              {sending ? 'Sending…' : `Send all (${drafts.length})`}
            </button>
          )}
          <button
            onClick={send}
            disabled={sending || noContactName || (!isLetter && !to)}
            title={noContactName ? 'Add a primary contact name in BM before sending' : ''}
            style={{ ...modalBtnPrimary, opacity: (sending || noContactName || (!isLetter && !to)) ? 0.5 : 1 }}
          >
            {sending ? 'Sending…' : isLetter ? 'Mark letter sent' : isSent ? 'Send again' : 'Send via accounts@'}
          </button>
          <button onClick={onClose} disabled={sending} style={modalBtnGhost}>Close</button>
        </div>
      </div>
    </div>
  );
}

const modalBtnPrimary = { padding: '8px 16px', fontSize: 13, fontWeight: 600, background: '#0f172a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: font };
const modalBtnGhost = { padding: '8px 14px', fontSize: 13, fontWeight: 500, background: '#fff', color: '#475569', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', fontFamily: font };
