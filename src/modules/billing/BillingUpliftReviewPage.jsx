import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, X, RotateCcw, RefreshCw, Mail, MailX, Trash2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fetchAllRows } from '../../lib/fetchAllRows';
import DataTable from '../../components/DataTable';
import RowMenu from '../../components/RowMenu';
import { useAuth } from '../../shell/AppShell';
import BillingTabs from './BillingTabs';
import SearchInput from '../../components/SearchInput';
import EmptyState from '../../components/EmptyState';
import GmailConnectionPanel from '../../components/GmailConnectionPanel';
import { tones } from '../../lib/tokens';
import { composeUpliftEmail } from './composeUpliftEmail';
import { splitEmails, resolvePrimaryContact, firstNameOf } from './recipients';
import { explainRows, explainBlocked } from './pushOutcome';
import { fmtGbp } from '../../lib/money';
import { BTN } from '../../lib/buttonStyles';

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
  // Controlled paging: a row action reloads the rows, and that must not
  // throw you back to page 1. A new filter, search or sort does.
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [filter, search, sortBy]);

  const load = async () => {
    setLoading(true);
    // Pull every active billing row with at least one pending uplift.
    // We over-fetch (no jsonb filter) then narrow client-side — the set
    // is small (~ tens of rows) — but the over-fetch reads every active
    // row, so page past PostgREST's silent 1000-row cap (id is unique, so
    // the order is stable across pages).
    let data = [];
    try {
      data = await fetchAllRows(() => supabase
        .from('live_billing')
        .select(`
          id, entity_id, services, qbo_recurring_txn_id, qbo_next_run_date,
          uplift_review_status, uplift_reviewed_at,
          uplift_email_sent_at, uplift_email_to, uplift_email_skipped,
          uplift_gmail_draft_id, uplift_gmail_draft_created_at,
          entity:entities(
            id, name, billing_email, entity_status,
            entity_people(is_primary_contact, person:people(id, name, first_name, preferred_name, email)),
            qbo_customer_mappings(qbo_email, role)
          )
        `)
        .eq('status', 'active')
        .order('id', { ascending: false }));
    } catch (err) {
      console.error('Uplift review load failed:', err);
    }
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

  // Rows we've already asked QBO about, and why the date is still
  // missing where the answer came back empty.
  const metaAsked = useRef(new Set());
  const [metaErrors, setMetaErrors] = useState({}); // billing_id → error text

  // A template that 404s and a template with no next run date both
  // render as a bare em-dash. Keep the reason so the cell can say which.
  const noteMetaErrors = (data) => {
    const next = {};
    for (const u of data?.updates || []) if (u.error) next[u.billing_id] = u.error;
    setMetaErrors((prev) => ({ ...prev, ...next }));
  };

  // Auto-refresh next-run dates from QBO once the rows are loaded, but
  // only for rows missing the date, and only once per row per visit.
  //
  // The fetch is what fills qbo_next_run_date, so a row it SUCCEEDS on
  // drops out of `stale` next pass — but a row it fails on does not.
  // Re-running on [loading] therefore made load() → fetch → load() a
  // closed cycle: three templates whose next date never arrived kept
  // the page re-querying and blanking to "Loading…" roughly every
  // second and a half, 39 invocations a minute against QBO. The ref
  // remembers what we've asked, so a failure costs one attempt rather
  // than one per second; "Refresh from QBO" is the way to ask again.
  useEffect(() => {
    if (loading || rows.length === 0) return;
    const stale = rows
      .filter((r) => r.qbo_recurring_txn_id && !r.qbo_next_run_date && !metaAsked.current.has(r.id))
      .map((r) => r.id);
    if (stale.length === 0) return;
    stale.forEach((id) => metaAsked.current.add(id));
    (async () => {
      try {
        const { data } = await supabase.functions.invoke('qbo-fetch-template-meta', { body: { billing_ids: stale } });
        noteMetaErrors(data);
        await load();
      } catch (e) { /* best effort */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, rows]);

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

    // Sorting is the table's (columns below, driven by sortBy).
    return out;
  }, [summarised, filter, search]);

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
    // An explicit refresh is the user asking again, so drop the earlier
    // answers — but count these ids as asked, or the effect below fires
    // the moment load() returns and asks QBO a second time for nothing.
    metaAsked.current = new Set(ids);
    setMetaErrors({});
    try {
      const { data } = await supabase.functions.invoke('qbo-fetch-template-meta', { body: { billing_ids: ids } });
      noteMetaErrors(data);
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
      const results = Array.isArray(data?.results) ? data.results : [];
      if (dryRun) {
        console.log('Dry-run results:', data);
        // The dry-run branch of the edge function returns before its
        // skip check, so the summary counts come back all zero. The
        // useful number is per row: how many QBO lines the pending
        // services matched. No matches means a live push would skip it.
        const wouldSkip = results.filter((r) => r.status === 'dry_run' && !r.match_count);
        const wouldPush = results.filter((r) => r.status === 'dry_run' && r.match_count);
        const added = results.reduce((n, r) => n + (r.added_count || 0), 0);
        const repriced = results.reduce((n, r) => n + (r.repriced_count || 0), 0);
        alert(
          `Dry-run complete\n\nTemplates to change: ${wouldPush.length}\n`
          + `Lines to reprice: ${repriced}\nLines to add: ${added}\n`
          + `Templates to skip: ${wouldSkip.length}`
          + explainRows(wouldSkip, 'nothing on the template to reprice, and nothing that could be added')
          + explainRows(results.filter((r) => r.status === 'skipped' || r.status === 'error'))
          + explainBlocked(results)
        );
      } else {
        console.log('Push results:', data);
        // A bare count is not an answer. Every row the function declines
        // to push carries a reason — show it, or the row stays approved
        // with nothing to act on and no clue what went wrong.
        const problems = results.filter((r) => r.status === 'skipped' || r.status === 'error');
        const added = results.reduce((n, r) => n + (r.added_count || 0), 0);
        alert(
          `${label} complete\n\nPushed: ${s.pushed || 0}\nSkipped: ${s.skipped || 0}\nErrored: ${s.errored || 0}`
          + (added ? `\nNew lines added to templates: ${added}` : '')
          + explainRows(problems)
          + explainBlocked(results)
        );
        await load();
      }
    } catch (err) {
      alert('Push failed: ' + (err.message || err));
    } finally {
      setPushing(false);
    }
  };

  const visibleIds = visible.map((r) => r.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  // This page's heading tickbox has always REPLACED the selection with the
  // lines in view (or cleared it) — the bulk bar acts on the whole selection,
  // so nothing hidden by a filter may stay ticked.
  const onToggleAll = () => setSelected(allVisibleSelected ? new Set() : new Set(visibleIds));

  // Headings keep the page's own three-step cycle (first click, reverse,
  // then back to the default largest-Δ-first), so the table's suggested
  // direction is ignored and cycleSort decides.
  const columns = [
    {
      key: 'client', label: 'Client', wrap: true,
      sortValue: (r) => (r.entity?.name || '').toLowerCase(),
      render: (r) => {
        const hasTemplate = !!r.qbo_recurring_txn_id;
        return (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 500, color: '#0f172a' }}>{r.entity?.name || 'Unknown'}</span>
              {r.uplift_email_sent_at && (
                <span
                  style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: '#dcfce7', color: '#166534' }}
                  title={`Email sent ${new Date(r.uplift_email_sent_at).toLocaleString('en-GB')}${r.uplift_email_to ? ` to ${r.uplift_email_to}` : ''}`}
                >✉ Sent</span>
              )}
              {!r.uplift_email_sent_at && r.uplift_gmail_draft_id && (
                <span
                  style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: '#dbeafe', color: '#0c4a6e' }}
                  title={`Gmail draft created ${r.uplift_gmail_draft_created_at ? new Date(r.uplift_gmail_draft_created_at).toLocaleString('en-GB') : ''}${r.uplift_email_to ? ` for ${r.uplift_email_to}` : ''} — finalise and send in Gmail.`}
                >✎ Draft</span>
              )}
              {r.uplift_email_skipped && !r.uplift_email_sent_at && (
                <span
                  style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: '#f1f5f9', color: '#475569' }}
                  title="Marked as not needing an email — excluded from Send all"
                >No email</span>
              )}
            </div>
            {!hasTemplate && <span style={{ fontSize: 11, color: '#b45309' }}>⚠ No QBO template</span>}
            {r._reason && <div style={{ fontSize: 11, color: '#94a3b8' }} title={r._reason}>{r._reason.length > 50 ? r._reason.slice(0, 50) + '…' : r._reason}</div>}
          </>
        );
      },
    },
    { key: 'lines', label: 'Lines', width: 60, firstDir: 'desc', sortValue: (r) => r._pendingLines || 0, render: (r) => r._pendingLines },
    {
      key: 'old', label: 'Old monthly', width: 95, align: 'right', firstDir: 'desc', sortValue: (r) => r._oldTotal || 0,
      render: (r) => <span style={{ fontFamily: 'monospace' }}>£{r._oldTotal.toFixed(2)}</span>,
    },
    {
      key: 'new', label: 'New monthly', width: 95, align: 'right', firstDir: 'desc', sortValue: (r) => r._newTotal || 0,
      render: (r) => <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>£{r._newTotal.toFixed(2)}</span>,
    },
    {
      key: 'delta', label: 'Δ', width: 75, align: 'right', firstDir: 'desc', sortValue: (r) => r._delta || 0,
      render: (r) => (
        <span style={{ fontFamily: 'monospace', color: r._delta > 0 ? '#15803d' : r._delta < 0 ? '#b91c1c' : '#94a3b8' }}>
          {r._delta > 0 ? '+' : ''}£{r._delta.toFixed(2)}
        </span>
      ),
    },
    {
      key: 'goLive', label: 'Go-live', width: 115, firstDir: 'desc', sortValue: (r) => r._goLive || '',
      render: (r) => <span style={{ color: '#475569' }}>{r._goLive || '—'}</span>,
    },
    {
      key: 'nextRun', label: 'Next invoice date', width: 115, firstDir: 'desc', sortValue: (r) => r.qbo_next_run_date || '',
      render: (r) => (
        <span style={{ color: '#475569' }}>
          {r.qbo_next_run_date || (metaErrors[r.id]
            ? <span style={{ color: '#b45309', cursor: 'help' }} title={`QBO could not be read for this template: ${metaErrors[r.id]}`}>— ⚠</span>
            : '—')}
        </span>
      ),
    },
    {
      key: 'status', label: 'Status', width: 100, sortValue: (r) => r.uplift_review_status || 'staged',
      render: (r) => <StatusChip status={r.uplift_review_status || 'staged'} />,
    },
    {
      key: 'actions', label: '', width: 175, sortable: false,
      // One main action per row (UI audit, Sprint 4): the row's next step is
      // the button, the rest are in the ⋮ menu with Discard last and in red.
      // Same handlers as before — only where they sit has changed.
      render: (r) => {
        const status = r.uplift_review_status || 'staged';
        const skipped = !!r.uplift_email_skipped;
        const guard = (fn) => () => { if (!saving) fn(); };
        const approve = { label: 'Approve', icon: Check, onClick: guard(() => setStatus([r.id], 'approved')) };
        const preview = !skipped && { label: 'Preview email', icon: Mail, onClick: guard(() => setEmailFor(r)) };
        const emailToggle = skipped
          ? { label: 'Email this client after all', icon: Mail, onClick: guard(() => setEmailSkipped([r.id], false)) }
          : { label: "Don't email this client", icon: MailX, onClick: guard(() => setEmailSkipped([r.id], true)), title: 'Excluded from Send all' };
        const restage = { label: 'Back to pending', icon: RotateCcw, onClick: guard(() => setStatus([r.id], 'staged')) };
        const reject = { label: 'Reject', icon: X, onClick: guard(() => setStatus([r.id], 'rejected')), title: 'Keep pending but exclude from push' };
        const discard = { label: 'Discard uplift…', icon: Trash2, onClick: guard(() => unstage(r.id)), danger: true, title: 'The current monthly amount stays as-is' };

        const solid = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 12px', fontSize: 13, fontWeight: 600, borderRadius: 6, border: 'none', background: '#059669', color: '#fff', cursor: saving ? 'wait' : 'pointer', fontFamily: "'Outfit', sans-serif", whiteSpace: 'nowrap' };
        const quiet = { ...BTN.secondary.sm, display: 'inline-flex', alignItems: 'center', gap: 4, cursor: saving ? 'wait' : 'pointer', whiteSpace: 'nowrap' };

        let main = null;
        let items;
        if (status === 'approved' && !skipped) {
          main = <button onClick={() => setEmailFor(r)} disabled={saving} style={quiet} title="Preview the fee-raise email for this client"><Mail size={13} />Preview email</button>;
          items = [emailToggle, restage, reject, discard];
        } else if (status === 'approved') {
          main = <span style={{ fontSize: 12.5, color: '#64748b', whiteSpace: 'nowrap' }}>Ready to push</span>;
          items = [emailToggle, restage, reject, discard];
        } else if (status === 'rejected') {
          main = <button onClick={() => setStatus([r.id], 'staged')} disabled={saving} style={quiet} title="Reset"><RotateCcw size={13} />Back to pending</button>;
          items = [approve, preview, emailToggle, discard];
        } else {
          main = <button onClick={() => setStatus([r.id], 'approved')} disabled={saving} style={solid} title="Approve for push"><Check size={13} strokeWidth={3} />Approve</button>;
          items = [preview, emailToggle, reject, discard];
        }
        return (
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
            {main}
            <RowMenu items={items.filter(Boolean)} />
          </div>
        );
      },
    },
  ];

  const approvedCount = counts.approved || 0;

  return (
    <div style={{ padding: '20px 28px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 }}>
        <div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 2 }}>
            Push uplifts
          </h1>
          <p style={{ fontSize: 14, color: '#64748b', maxWidth: 720, marginBottom: 0 }}>
            Approve fee increases, then send to QBO.
          </p>
        </div>
        <button onClick={refreshFromQbo} disabled={refreshing} style={btnSecondary} title="Pull next-run dates from QBO">
          <RefreshCw size={13} style={refreshing ? { animation: 'spin 1s linear infinite' } : null} />
          {refreshing ? 'Refreshing…' : 'Refresh from QBO'}
        </button>
      </div>

      <BillingTabs active="push" />

      <GmailConnectionPanel staffId={profile?.id} />

      {/* Filter pills */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <Pill label="Pending" count={counts.staged || 0} active={filter === 'staged'} tone="amber" onClick={() => setFilter('staged')} />
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
          <span style={{ fontSize: 14, fontWeight: 500 }}>{selected.size} selected</span>
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
        <p style={{ fontSize: 14, color: '#94a3b8', padding: 40, textAlign: 'center' }}>Loading…</p>
      ) : visible.length === 0 ? (
        filter === 'staged' ? (
          <EmptyState
            icon="✦"
            title="No fee increases to review"
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
            actions={[{ label: 'Show pending', onClick: () => setFilter('staged') }]}
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
            actions={[{ label: 'Show pending', onClick: () => setFilter('staged') }]}
          />
        )
      ) : (
        <DataTable
          columns={columns}
          rows={visible}
          rowKey={(r) => r.id}
          sort={sortBy}
          onSort={(next) => cycleSort(next.key)}
          page={page}
          onPage={setPage}
          selection={{ selected, onChange: setSelected, onToggleAll }}
          footer={() => ({
            old: <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>£{totals.old.toFixed(2)}</span>,
            new: <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>£{totals.neu.toFixed(2)}</span>,
            delta: (
              <span style={{ fontFamily: 'monospace', fontWeight: 700, color: totals.delta > 0 ? '#15803d' : '#94a3b8' }}>
                {totals.delta > 0 ? '+' : ''}£{totals.delta.toFixed(2)}
              </span>
            ),
            goLive: {
              span: 4,
              content: <span style={{ fontSize: 12, fontWeight: 400, color: '#94a3b8' }}>{visible.length} row{visible.length === 1 ? '' : 's'}</span>,
            },
          })}
        />
      )}

      {/* Sticky push footer — appears whenever there's something
          approved. Keeps the primary action one click away wherever
          the user has scrolled to. */}
      {approvedCount > 0 && (
        <div style={pushFooterStyle}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>
            {approvedCount} approved {approvedCount === 1 ? 'template' : 'templates'} ready to push
          </span>
          <div style={{ flex: 1 }} />
          <button
            onClick={() => setEmailsBatch(summarised.filter((r) => r.uplift_review_status === 'approved' && !r.uplift_email_skipped))}
            disabled={pushing}
            style={btnPushDry}
            title="Preview each approved client's fee-raise email and push them all to Gmail as drafts for final review"
          >
            <Mail size={13} style={{ marginRight: 4, verticalAlign: '-2px' }} />
            Review &amp; draft emails
          </button>
          <button onClick={() => pushApproved(true)} disabled={pushing} style={btnPushDry} title="Show proposed bodies in console, no QBO writes">
            Dry-run
          </button>
          <button onClick={() => pushApproved(false)} disabled={pushing} style={btnPushLive}>
            {pushing ? 'Pushing…' : `Send ${approvedCount} to QBO`}
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
    staged:   { tone: 'warning', label: 'Pending' },
    approved: { tone: 'success', label: 'Approved' },
    rejected: { tone: 'neutral', label: 'Rejected' },
  };
  const m = map[status] || map.staged;
  const t = tones[m.tone];
  return (
    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: t.bg, color: t.fg }}>{m.label}</span>
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
    <button onClick={onClick} style={{ fontSize: 13, fontWeight: active ? 600 : 500, padding: '5px 12px', borderRadius: 999, background: bg, color: fg, border: `1px solid ${border}`, cursor: 'pointer', fontFamily: font }}>
      {label}{count != null ? ` · ${count}` : ''}
    </button>
  );
}

const backLinkStyle = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13, fontWeight: 500, color: '#64748b', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 12, padding: 0, fontFamily: font };
const bulkBarStyle = { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', marginBottom: 10, background: '#0f172a', color: '#fff', borderRadius: 8, position: 'sticky', top: 0, zIndex: 20 };
const btnApprove = { padding: '6px 14px', fontSize: 13, fontWeight: 600, background: '#059669', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: font };
const btnReject = { padding: '6px 14px', fontSize: 13, fontWeight: 600, background: '#b91c1c', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: font };
const btnUndo = { padding: '6px 14px', fontSize: 13, fontWeight: 500, background: '#64748b', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: font };
const btnGhost = { padding: '6px 12px', fontSize: 13, fontWeight: 500, background: 'none', color: '#cbd5e1', border: 'none', cursor: 'pointer', fontFamily: font };
const btnSecondary = { ...BTN.secondary.sm, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' };
const btnPushDry = { padding: '6px 14px', fontSize: 13, fontWeight: 500, background: '#fff', color: '#6d28d9', border: '1px solid #c4b5fd', borderRadius: 6, cursor: 'pointer', fontFamily: font };
const btnPushLive = { padding: '6px 14px', fontSize: 13, fontWeight: 600, background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: font };
const pushFooterStyle = {
  position: 'sticky', bottom: 0, marginTop: 14,
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '12px 16px',
  background: '#fff', border: '1px solid #c4b5fd', borderRadius: 10,
  boxShadow: '0 -6px 20px rgba(15,23,42,0.05)',
  color: '#0f172a', fontFamily: font, zIndex: 10,
};

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
  const draftedOnServer = !!active.row.uplift_gmail_draft_id;
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

  // Primary action: create a Gmail draft for this row. The send proper
  // happens inside Gmail, where the user can edit / re-style / attach
  // before clicking Send. We stamp uplift_gmail_draft_id back so the
  // table chip flips to "DRAFT".
  const send = async () => {
    if (noContactName) { alert('No primary contact name on file. Add one in BrightManager before drafting.'); return; }
    if (isLetter) { return markLetterSent(); }
    if (!to) { alert('Pick a recipient address first.'); return; }
    if (draftedOnServer && !window.confirm('A Gmail draft already exists for this row. Create another one?')) return;
    setSending(true);
    try {
      const { data, error } = await supabase.functions.invoke('gmail-create-draft', {
        body: {
          billing_id: rowId,
          to,
          subject: active.email.subject,
          body_text: active.email.body,
          body_html: active.email.bodyHtml,
          initiated_by: initiatedBy || null,
        },
      });
      if (error || !data?.success) {
        const msg = error?.message || data?.error || 'Draft creation failed';
        if (data?.code === 'no_gmail_connection') {
          alert('No active Gmail connection. Use the "Connect Gmail" banner at the top of the page to sign in.');
        } else {
          alert('Draft creation failed: ' + msg);
        }
        return;
      }
      setSentRowIds((prev) => new Set([...prev, rowId]));
      onSent?.();
    } catch (e) {
      alert('Draft creation failed: ' + (e.message || e));
    } finally {
      setSending(false);
    }
  };

  const sendAll = async () => {
    if (drafts.length <= 1) { send(); return; }
    const pending = drafts.filter((d) =>
      !sentRowIds.has(d.row.id)
      && !d.row.uplift_email_sent_at
      && !d.row.uplift_gmail_draft_id
      && !d.row.uplift_email_skipped
      && d.contactName
      && !letterMode[d.row.id]
      && d.candidates[0]?.addr
    );
    const blocked = drafts.length - pending.length;
    if (pending.length === 0) { alert('Nothing left to draft (all already drafted/sent, marked as letter, or missing contact name / email).'); return; }
    const note = blocked > 0 ? `\n\n${blocked} row${blocked === 1 ? '' : 's'} skipped (already drafted/sent, marked as letter, or missing contact name / email).` : '';
    if (!window.confirm(`Create Gmail drafts for ${pending.length} client${pending.length === 1 ? '' : 's'} now? They'll appear in your Gmail Drafts folder — nothing sends until you click Send in Gmail.${note}`)) return;
    setSending(true);
    let ok = 0, err = 0;
    for (const d of pending) {
      const dTo = selectedAddr[d.row.id] ?? d.candidates[0].addr;
      try {
        const { data, error } = await supabase.functions.invoke('gmail-create-draft', {
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
    alert(`Created ${ok} Gmail draft${ok === 1 ? '' : 's'}${err ? ` (${err} failed)` : ''}.\n\nOpen Gmail → Drafts to review and send.`);
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
            {drafts.length > 1 && <span style={{ fontSize: 13, fontWeight: 500, color: '#94a3b8', marginLeft: 8 }}>{idx + 1} of {drafts.length}</span>}
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

        <div style={{ padding: '12px 18px', borderBottom: '1px solid #f1f5f9', fontSize: 13, color: '#475569', display: 'grid', gridTemplateColumns: '70px 1fr', gap: '6px 10px', alignItems: 'start' }}>
          <strong style={{ color: '#0f172a', paddingTop: 4 }}>Contact</strong>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {active.contact ? (
              <>
                <span>{active.contact.name}{active.contactName ? ` (greeting: ${active.contactName})` : ''}</span>
                {noContactName && (
                  <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: '#fee2e2', color: '#991b1b' }}>
                    Cannot derive first name — set one in BM
                  </span>
                )}
              </>
            ) : (
              <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: '#fee2e2', color: '#991b1b' }}>
                No primary contact on file — add one in BM before sending
              </span>
            )}
          </span>

          <strong style={{ color: '#0f172a', paddingTop: 4 }}>To</strong>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {isLetter ? (
              <span style={{ fontSize: 13, color: '#475569', fontStyle: 'italic' }}>
                Physical letter — no email will be sent. Marks the row as sent for tracking.
              </span>
            ) : active.candidates.length === 0 ? (
              <span style={{ fontSize: 12, color: '#991b1b' }}>
                No email addresses on file. Type one below or switch to physical letter.
              </span>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {active.candidates.map((c) => (
                  <label key={c.addr} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name={`to-${rowId}`}
                      checked={to === c.addr}
                      onChange={() => setSelectedAddr((s) => ({ ...s, [rowId]: c.addr }))}
                    />
                    <span style={{ fontFamily: 'monospace' }}>{c.addr}</span>
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>· {c.label}</span>
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
                style={{ padding: '4px 8px', fontSize: 13, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 6, outline: 'none' }}
              />
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#475569', cursor: 'pointer' }}>
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
                  <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: '#dcfce7', color: '#166534' }}>✓ Sent this session</span>
                ) : (
                  <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: '#fef3c7', color: '#92400e' }} title={`Last sent ${new Date(active.row.uplift_email_sent_at).toLocaleString('en-GB')}${active.row.uplift_email_to ? ` to ${active.row.uplift_email_to}` : ''}`}>
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
            <button onClick={sendAll} disabled={sending} style={modalBtnGhost}>
              {sending ? 'Drafting…' : `Draft all (${drafts.length})`}
            </button>
          )}
          <button
            onClick={send}
            disabled={sending || noContactName || (!isLetter && !to)}
            title={noContactName ? 'Add a primary contact name in BM before drafting' : 'Creates a draft in your Gmail Drafts folder — nothing sends until you click Send in Gmail'}
            style={{ ...modalBtnPrimary, opacity: (sending || noContactName || (!isLetter && !to)) ? 0.5 : 1 }}
          >
            {sending ? 'Drafting…' : isLetter ? 'Mark letter sent' : draftedOnServer ? 'Re-draft in Gmail' : 'Create Gmail draft'}
          </button>
          <button onClick={onClose} disabled={sending} style={modalBtnGhost}>Close</button>
        </div>
      </div>
    </div>
  );
}

const modalBtnPrimary = { ...BTN.primary.md, cursor: 'pointer' };
const modalBtnGhost = { ...BTN.secondary.md, cursor: 'pointer' };
