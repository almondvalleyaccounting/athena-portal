import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ChevronLeft, CheckCircle, Clock, AlertTriangle, FileText, Receipt, Clipboard } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';

const TIME_PERIODS = [
  { value: '1', label: 'Last month' },
  { value: '3', label: 'Last 3 months' },
  { value: '6', label: 'Last 6 months' },
  { value: '12', label: 'Last 12 months' },
  { value: 'all', label: 'All time' },
];

function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export default function ClientDetailView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [entity, setEntity] = useState(null);
  const [billing, setBilling] = useState([]);
  const [quotes, setQuotes] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [scheduledTasks, setScheduledTasks] = useState([]);
  const [completedTasks, setCompletedTasks] = useState([]);
  const [issues, setIssues] = useState([]);
  const [billingItems, setBillingItems] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [allocations, setAllocations] = useState([]); // rows from client_service_allocations
  const [recon, setRecon] = useState(null); // v_email_reconciliation row for this entity
  const [onboardings, setOnboardings] = useState([]); // in-flight onboarding runs for the banner
  const [loading, setLoading] = useState(true);
  const [timePeriod, setTimePeriod] = useState('12');
  const [changeTaskText, setChangeTaskText] = useState('');
  const [actionAssignee, setActionAssignee] = useState('');
  const [taskCreating, setTaskCreating] = useState(false);
  const [taskCreated, setTaskCreated] = useState(false);
  const [activeSection, setActiveSection] = useState(null); // for tile click expansion
  const [archiving, setArchiving] = useState(false);
  const [offboarding, setOffboarding] = useState(false);
  const [offboardResult, setOffboardResult] = useState(null);
  const [fieldOverrides, setFieldOverrides] = useState({}); // field -> { value, bm_value } pending BM sync

  useEffect(() => {
    (async () => {
      try {
        const results = await Promise.allSettled([
          supabase.from('entities').select('*').eq('id', id).single(),
          supabase.from('live_billing').select('*').eq('entity_id', id).order('created_at'),
          supabase.from('quotes').select('id, quote_ref, status, monthly_gross, annual_total, created_at, relationship_group').eq('entity_id', id).order('created_at', { ascending: false }),
          supabase.from('quick_tasks').select('*').eq('entity_id', id).order('created_at', { ascending: false }),
          supabase.from('scheduled_tasks').select('*').eq('entity_id', id).order('title'),
          supabase.from('completed_tasks').select('*').eq('entity_id', id).order('completed_at', { ascending: false }),
          supabase.from('issues_log').select('*').eq('entity_id', id).order('created_at', { ascending: false }),
          supabase.from('billing_items').select('*').eq('entity_id', id).order('created_at', { ascending: false }),
          supabase.from('staff_profiles').select('id, name, email').order('name'),
          supabase.from('client_service_allocations').select('*').eq('entity_id', id),
          supabase.from('v_email_reconciliation').select('*').eq('entity_id', id).maybeSingle(),
          supabase.from('onboardings')
            .select('id, status, template:onboarding_templates(name), steps:onboarding_steps(status)')
            .eq('entity_id', id).in('status', ['active', 'on_hold', 'issues']),
          supabase.from('admin_tasks')
            .select('field, value, bm_value')
            .eq('entity_id', id).eq('kind', 'bm_field').is('confirmed_at', null).is('dismissed_at', null),
        ]);
        const get = (i) => results[i]?.value?.data;
        const ent = get(0);
        setEntity(ent);
        setBilling(get(1) || []);
        setQuotes(get(2) || []);
        setTasks(get(3) || []);
        setScheduledTasks(get(4) || []);
        setCompletedTasks(get(5) || []);
        setIssues(get(6) || []);
        setBillingItems(get(7) || []);
        const staff = (get(8) || []).map((s) => ({ ...s, name: s.name || s.email }));
        setStaffList(staff);
        setAllocations(get(9) || []);
        setRecon(get(10) || null);
        setOnboardings(get(11) || []);
        const ov = {};
        for (const t of (get(12) || [])) ov[t.field] = { value: t.value, bm_value: t.bm_value };
        setFieldOverrides(ov);
        // Default action assignee to client manager
        if (ent?.manager) {
          const mgr = staff.find((s) => s.name?.toLowerCase().includes(ent.manager.toLowerCase()));
          if (mgr) setActionAssignee(mgr.id);
        }
      } catch (e) { console.error('[ClientDetail]', e); }
      setLoading(false);
    })();
  }, [id]);

  // Time-filtered completed tasks
  const filteredCompleted = useMemo(() => {
    if (timePeriod === 'all') return completedTasks;
    const cutoff = monthsAgo(parseInt(timePeriod, 10));
    return completedTasks.filter((t) => t.completed_at >= cutoff);
  }, [completedTasks, timePeriod]);

  const handleRaiseAction = async () => {
    if (!changeTaskText.trim() || taskCreating) return;
    setTaskCreating(true);
    try {
      await supabase.from('quick_tasks').insert({
        title: `Action: ${entity.name} — ${changeTaskText.trim()}`,
        entity_id: entity.id,
        service: 'Admin',
        assignee_id: actionAssignee || profile?.id || null,
        due_date: new Date(Date.now() + 5 * 86400000).toISOString(),
        planned_date: null, duration: 15,
        notes: 'Raised from client page',
        sort_order: 0, created_by: profile?.id,
      });
      setChangeTaskText('');
      setTaskCreated(true);
      // Refresh tasks
      const { data } = await supabase.from('quick_tasks').select('*').eq('entity_id', id).order('created_at', { ascending: false });
      if (data) setTasks(data);
      setTimeout(() => setTaskCreated(false), 3000);
    } catch (e) { console.error(e); }
    setTaskCreating(false);
  };

  // We archive rather than hard-delete: entities have many NO ACTION child
  // FKs (quotes, tasks, timesheets…) so a real delete would either fail or
  // wipe history. Archiving hides the client from the default list while
  // preserving its records. Restorable from the list's "Show archived" view.
  const handleArchive = async () => {
    if (!entity) return;
    const isArchived = entity.entity_status === 'archived';
    const verb = isArchived ? 'Restore' : 'Archive';
    if (!window.confirm(`${verb} "${entity.name}"? ${isArchived ? 'It will reappear in the clients list.' : 'It will be hidden from the clients list. Its records are kept and it can be restored later.'}`)) return;
    setArchiving(true);
    const prev = entity.entity_status || 'active';
    const next = isArchived ? 'active' : 'archived';
    const { error } = await supabase.from('entities').update({ entity_status: next }).eq('id', entity.id);
    if (error) {
      alert(`Could not ${verb.toLowerCase()} client: ` + error.message);
      setArchiving(false);
      return;
    }
    await supabase.from('audit_log').insert({
      user_id: profile?.id || null,
      action: 'entity_status_change',
      entity_type: 'entity',
      entity_id: entity.id,
      detail: { from: prev, to: next, via: 'archive_button' },
    });
    if (isArchived) {
      setEntity({ ...entity, entity_status: next });
      setArchiving(false);
    } else {
      navigate('/clients');
    }
  };

  // "No longer a client" — one deliberate action. Sets NLAC, cascades so the
  // client leaves the operational views (CH codes stalled, onboardings
  // archived), and drops a task on Sophie's list to mirror it in BM (which
  // auto-confirms on the next BM import). See offboard_entity() SQL.
  const handleOffboard = async () => {
    if (!entity || offboarding) return;
    if (!window.confirm(`Mark "${entity.name}" as no longer a client?\n\nThis hides them from the clients list and stops billing views, stalls any Companies House code chasing, archives any in-progress onboarding, and adds a task for Sophie to archive them in BrightManager (which clears itself on the next BM import).`)) return;
    const reason = window.prompt('Reason (optional) — e.g. moved accountant, ceased trading:', '') || '';
    setOffboarding(true);
    try {
      const { data, error } = await supabase.rpc('offboard_entity', { p_entity_id: entity.id, p_reason: reason || null });
      if (error) throw error;
      setEntity({ ...entity, entity_status: 'nlac' });
      setOffboardResult(data || { status: 'nlac' });
    } catch (e) {
      alert('Could not mark as no longer a client: ' + e.message);
    }
    setOffboarding(false);
  };

  const handleReinstate = async () => {
    if (!entity || offboarding) return;
    if (!window.confirm(`Reinstate "${entity.name}" as an active client?`)) return;
    setOffboarding(true);
    try {
      const { error } = await supabase.rpc('reinstate_entity', { p_entity_id: entity.id });
      if (error) throw error;
      setEntity({ ...entity, entity_status: 'active' });
      setOffboardResult(null);
    } catch (e) {
      alert('Could not reinstate client: ' + e.message);
    }
    setOffboarding(false);
  };

  if (loading) return <div style={wrapStyle}><p style={{ color: '#94a3b8', fontSize: 13 }}>Loading client...</p></div>;
  if (!entity) return <div style={wrapStyle}><p style={{ color: '#ef4444', fontSize: 13 }}>Client not found.</p></div>;

  // Compute totals from the services[] jsonb (the post-2026 schema).
  // monthly_fee on the row was the pre-Athena schema; falling back to
  // the new approval-aware aggregation here.
  const approvedServices = (() => {
    const out = [];
    for (const b of billing || []) {
      if (b.status && b.status !== 'active') continue;
      const services = Array.isArray(b.services) ? b.services : [];
      for (const s of services) {
        if (s.recurring_status === 'ending') continue;
        const status = s.approval_status || (b.qbo_recurring_txn_id ? 'approved' : 'suggested');
        if (status !== 'approved') continue;
        out.push({ ...s, row_id: b.id, fromTemplate: !!b.qbo_recurring_txn_id });
      }
    }
    return out;
  })();
  const totalMonthly = approvedServices
    .filter((s) => s.cadence === 'monthly')
    .reduce((sum, s) => sum + (Number(s.monthly_amount) || 0), 0);
  // For annual lines, monthly_amount is the once-per-year fee
  // (annual_amount in storage is monthly_amount × 12 and would inflate).
  const totalAnnualFees = approvedServices
    .filter((s) => s.cadence === 'annual')
    .reduce((sum, s) => sum + (Number(s.monthly_amount) || 0), 0);
  const totalAnnual = totalMonthly * 12 + totalAnnualFees;
  const activeQuotes = quotes.filter((q) => ['accepted', 'sent', 'approved'].includes(q.status));
  const openIssues = issues.filter((i) => !['resolved', 'closed'].includes(i.status));
  const totalCompleted = filteredCompleted.reduce((s, t) => s + (t.completion_mins || 0), 0);
  const pendingBilling = billingItems.filter((b) => b.status === 'draft' || b.status === 'pending_approval');
  const fmt = (n) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2 }).format(n || 0);
  const durFmt = (mins) => (mins == null ? '0m' : `${Math.round(Number(mins) || 0)}m`);

  const toggleSection = (s) => setActiveSection(activeSection === s ? null : s);

  return (
    <div style={wrapStyle}>
      <button onClick={() => navigate('/clients')} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', fontSize: 13, fontFamily: "'Outfit', sans-serif", marginBottom: 16, padding: 0 }}>
        <ChevronLeft size={16} /> Back to Clients
      </button>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 6 }}>{entity.name}</h1>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: '#64748b', flexWrap: 'wrap' }}>
            <span style={{ textTransform: 'capitalize' }}>{entity.type?.replace('_', ' ')}</span>
            {entity.company_number && <span>· {entity.company_number}</span>}
            {entity.manager && <span>· Managed by {entity.manager}</span>}
            {entity.source === 'athena' && <Badge bg="#dbeafe" color="#0e7fe0">Athena</Badge>}
            <StatusEditor
              value={entity.entity_status || 'active'}
              onChange={async (next) => {
                const prev = entity.entity_status || 'active';
                if (next === prev) return;
                let reason = '';
                if (next === 'nlac' || next === 'archived') {
                  reason = window.prompt(`Reason for marking as ${next.toUpperCase()}? (optional)`, '') || '';
                }
                setEntity({ ...entity, entity_status: next });
                const { error } = await supabase.from('entities').update({ entity_status: next }).eq('id', entity.id);
                if (error) {
                  alert('Could not update status: ' + error.message);
                  setEntity({ ...entity, entity_status: prev });
                  return;
                }
                await supabase.from('audit_log').insert({
                  user_id: profile?.id || null,
                  action: 'entity_status_change',
                  entity_type: 'entity',
                  entity_id: entity.id,
                  detail: { from: prev, to: next, reason: reason || null },
                });
              }}
            />
            <CadenceEditor
              value={entity.cadence_preference || 'normal'}
              onChange={async (next) => {
                const prev = entity.cadence_preference;
                setEntity({ ...entity, cadence_preference: next });
                const { error } = await supabase.from('entities').update({ cadence_preference: next }).eq('id', entity.id);
                if (error) {
                  alert('Could not update cadence: ' + error.message);
                  setEntity({ ...entity, cadence_preference: prev });
                }
              }}
            />
            <ExpediteToggle
              value={!!entity.expedite}
              onChange={async (next) => {
                const prev = !!entity.expedite;
                setEntity({ ...entity, expedite: next });
                const { error } = await supabase.from('entities').update({ expedite: next }).eq('id', entity.id);
                if (error) {
                  alert('Could not update expedite flag: ' + error.message);
                  setEntity({ ...entity, expedite: prev });
                }
              }}
            />
            {entity.grade && (
              <span style={{
                fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 6,
                background: '#eef2ff', color: '#4338ca', border: '1px solid #c7d2fe',
                fontFamily: "'Outfit', sans-serif",
              }} title="Client grade (imported)">Grade {entity.grade}</span>
            )}
          </div>
        </div>
        {/* Time period filter + archive */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase' }}>Time</span>
            <select value={timePeriod} onChange={(e) => setTimePeriod(e.target.value)} style={{ padding: '5px 10px', fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 6, outline: 'none', fontFamily: "'Outfit', sans-serif" }}>
              {TIME_PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
          {entity.entity_status === 'nlac' ? (
            <button
              onClick={handleReinstate}
              disabled={offboarding}
              title="Reinstate this former client as active"
              style={{
                fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 8,
                background: '#fff', color: '#0e7fe0', border: '1px solid #bfdbfe',
                cursor: offboarding ? 'wait' : 'pointer', fontFamily: "'Outfit', sans-serif",
              }}
            >
              {offboarding ? '…' : 'Reinstate client'}
            </button>
          ) : (
            <button
              onClick={handleOffboard}
              disabled={offboarding}
              title="Mark as no longer a client — removes them from views and queues the BrightManager change for Sophie"
              style={{
                fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 8,
                background: '#fff', color: '#b91c1c', border: '1px solid #fecaca',
                cursor: offboarding ? 'wait' : 'pointer', fontFamily: "'Outfit', sans-serif",
              }}
            >
              {offboarding ? '…' : 'No longer a client'}
            </button>
          )}
          <button
            onClick={handleArchive}
            disabled={archiving}
            title={entity.entity_status === 'archived' ? 'Restore this client to the active list' : 'Archive this client — hides it from the list, keeps its records'}
            style={{
              fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 8,
              background: '#fff', color: entity.entity_status === 'archived' ? '#0e7fe0' : '#b91c1c',
              border: '1px solid ' + (entity.entity_status === 'archived' ? '#bfdbfe' : '#fecaca'),
              cursor: archiving ? 'wait' : 'pointer', fontFamily: "'Outfit', sans-serif",
            }}
          >
            {archiving ? '…' : entity.entity_status === 'archived' ? 'Restore' : 'Archive'}
          </button>
        </div>
      </div>

      {offboardResult && (
        <div style={{ border: '1px solid #fecaca', background: '#fef2f2', borderRadius: 12, padding: '12px 16px', marginBottom: 20, fontFamily: "'Outfit', sans-serif" }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: '#b91c1c', marginBottom: 4 }}>
            Marked no longer a client
          </div>
          <div style={{ fontSize: 12.5, color: '#7f1d1d' }}>
            Removed from the clients list and billing views.
            {offboardResult.ch_stalled > 0 && ` ${offboardResult.ch_stalled} Companies House chase${offboardResult.ch_stalled === 1 ? '' : 's'} stopped.`}
            {offboardResult.onboardings_archived > 0 && ` ${offboardResult.onboardings_archived} onboarding${offboardResult.onboardings_archived === 1 ? '' : 's'} archived.`}
            {offboardResult.bm_task_created
              ? ' A task has been added to Sophie’s admin list to archive them in BrightManager — it clears itself on the next BM import.'
              : ' No BrightManager record to mirror.'}
          </div>
        </div>
      )}

      {/* Active onboarding banner — click through to the workflow */}
      {onboardings.map((ob) => {
        const applicable = (ob.steps || []).filter((s) => s.status !== 'na');
        const done = applicable.filter((s) => s.status === 'complete').length;
        const pct = applicable.length ? Math.round((done / applicable.length) * 100) : 0;
        return (
          <div
            key={ob.id}
            onClick={() => navigate(`/onboarding/${ob.id}`)}
            style={{
              display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20, cursor: 'pointer',
              border: '1px solid #bfdbfe', background: 'linear-gradient(100deg, #eff6ff, #f0fdfa)',
              borderRadius: 12, padding: '13px 16px',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 4px 14px rgba(14,127,224,0.12)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'none'; }}
          >
            <span style={{ fontSize: 20 }}>🚀</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: '#0f172a' }}>
                Onboarding in progress
                {ob.status !== 'active' && <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 6, background: '#fef3c7', color: '#92400e', textTransform: 'uppercase' }}>{ob.status.replace('_', ' ')}</span>}
              </div>
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                {ob.template?.name || 'Onboarding'} · {done}/{applicable.length} steps ({pct}%)
              </div>
            </div>
            <div style={{ width: 120, height: 6, borderRadius: 999, background: '#e2e8f0', overflow: 'hidden', flexShrink: 0 }}>
              <div style={{ width: `${pct}%`, height: '100%', background: pct === 100 ? '#059669' : '#0e7fe0' }} />
            </div>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: '#0e7fe0', whiteSpace: 'nowrap' }}>View onboarding →</span>
          </div>
        );
      })}

      {/* Email reconciliation: BM contact email (1:1) vs QBO billing email(s) (1:many) */}
      {recon && recon.status !== 'ok' && (
        <EmailReconPanel recon={recon} />
      )}

      {/* Summary cards — all clickable */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 24 }}>
        <SummaryCard icon={Receipt} label="Monthly Billing" value={fmt(totalMonthly)} accent="#0e7fe0" onClick={() => toggleSection('billing')} active={activeSection === 'billing'} />
        <SummaryCard icon={FileText} label="Quotes" value={`${quotes.length} (${activeQuotes.length} active)`} accent="#059669" onClick={() => toggleSection('quotes')} active={activeSection === 'quotes'} />
        <SummaryCard icon={Clock} label="Time Logged" value={durFmt(totalCompleted)} accent="#d97706" onClick={() => toggleSection('time')} active={activeSection === 'time'} />
        <SummaryCard icon={AlertTriangle} label="Open Issues" value={openIssues.length} accent={openIssues.length > 0 ? '#dc2626' : '#059669'} onClick={() => toggleSection('issues')} active={activeSection === 'issues'} />
        <SummaryCard icon={Clipboard} label="Outstanding Actions" value={tasks.length} accent={tasks.length > 0 ? '#d97706' : '#059669'} onClick={() => toggleSection('actions')} active={activeSection === 'actions'} />
      </div>

      {/* Expandable detail sections — shown when tile clicked */}
      {activeSection === 'billing' && (
        <div style={{ ...cardStyle, marginBottom: 20 }}>
          <h3 style={sectionTitle}>Active Billing</h3>
          {approvedServices.length > 0 ? (
            <>
              <div style={{ display: 'flex', gap: 20, marginBottom: 12, flexWrap: 'wrap' }}>
                <div><div style={{ fontSize: 10, color: '#94a3b8' }}>Monthly</div><div style={{ fontSize: 20, fontWeight: 700, color: '#0f172a' }}>{fmt(totalMonthly)}</div></div>
                <div><div style={{ fontSize: 10, color: '#94a3b8' }}>Annual fees (pure)</div><div style={{ fontSize: 20, fontWeight: 700, color: '#0f766e' }}>{fmt(totalAnnualFees)}</div></div>
                <div><div style={{ fontSize: 10, color: '#94a3b8' }}>Annualised (×12 + annual)</div><div style={{ fontSize: 20, fontWeight: 700, color: '#0f172a' }}>{fmt(totalAnnual)}</div></div>
              </div>
              {approvedServices.map((s, idx) => (
                <div key={`${s.row_id}-${idx}`} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 0', borderBottom: '1px solid #f1f5f9' }}>
                  <span style={{ color: '#1e293b' }}>
                    {s.service_id || s.description || 'Service'}
                    {s.fromTemplate && <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 4, background: '#ccfbf1', color: '#115e59' }}>QBO TEMPLATE</span>}
                  </span>
                  <span style={{ fontWeight: 500, fontFamily: 'monospace' }}>
                    {s.cadence === 'annual'
                      ? `${fmt(s.monthly_amount)}/yr`
                      : `${fmt(s.monthly_amount)}/mo`}
                  </span>
                </div>
              ))}

              {/* Fee earner allocation — per service_id, drives practice-wide
                  attribution reports. Source of service_ids: live_billing.services
                  jsonb (union across all billing rows) ∪ existing allocations. */}
              <AllocationEditor
                entityId={entity.id}
                billing={billing}
                allocations={allocations}
                staff={staffList}
                onChange={setAllocations}
              />
            </>
          ) : <p style={{ fontSize: 13, color: '#cbd5e1' }}>No active billing.</p>}
        </div>
      )}

      {activeSection === 'quotes' && (
        <div style={{ ...cardStyle, marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h3 style={{ ...sectionTitle, marginBottom: 0 }}>Quotes ({quotes.length})</h3>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => navigate(`/manage/quotes/new?entity=${entity.id}`)}
                style={{ fontSize: 12, padding: '5px 10px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#0f172a', cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}
              >
                New quote
              </button>
              <button
                onClick={() => navigate(`/manage/quotes/new?entity=${entity.id}&seed=source`)}
                style={{ fontSize: 12, padding: '5px 10px', border: '1px solid #0f172a', borderRadius: 6, background: '#0f172a', color: '#fff', cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}
                title="Start a quote seeded from another client's recurring bill pricing"
              >
                New quote from another client's pricing
              </button>
            </div>
          </div>
          {quotes.map((q) => (
            <div key={q.id} onClick={() => navigate(`/manage/quotes/${q.id}`)} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '5px 0', borderBottom: '1px solid #f1f5f9', cursor: 'pointer' }}>
              <span style={{ fontWeight: 500, color: '#0f172a' }}>{q.quote_ref}</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: '#64748b' }}>{fmt(q.monthly_gross)}/mo</span>
                <Badge bg={q.status === 'accepted' ? '#f0fdf4' : q.status === 'sent' ? '#f5f3ff' : '#f1f5f9'} color={q.status === 'accepted' ? '#059669' : q.status === 'sent' ? '#7c3aed' : '#64748b'}>{q.status}</Badge>
              </div>
            </div>
          ))}
          {quotes.length === 0 && <p style={{ fontSize: 13, color: '#cbd5e1' }}>No quotes.</p>}
        </div>
      )}

      {activeSection === 'time' && (
        <div style={{ ...cardStyle, marginBottom: 20 }}>
          <h3 style={sectionTitle}>Time Logged — {TIME_PERIODS.find((p) => p.value === timePeriod)?.label}</h3>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#d97706', marginBottom: 12 }}>{durFmt(totalCompleted)}</div>
          {filteredCompleted.length > 0 ? filteredCompleted.slice(0, 20).map((t) => (
            <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 0', borderBottom: '1px solid #f1f5f9' }}>
              <span style={{ color: '#1e293b' }}>{t.title}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ color: '#64748b' }}>{t.service}</span>
                <span style={{ fontWeight: 500 }}>{durFmt(t.completion_mins)}</span>
                <span style={{ color: '#94a3b8', fontSize: 11 }}>{new Date(t.completed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
              </div>
            </div>
          )) : <p style={{ fontSize: 13, color: '#cbd5e1' }}>No completed work in this period.</p>}
        </div>
      )}

      {activeSection === 'issues' && (
        <div style={{ ...cardStyle, marginBottom: 20 }}>
          <h3 style={sectionTitle}>Issues ({openIssues.length} open / {issues.length} total)</h3>
          {issues.slice(0, 10).map((iss) => {
            const isOpen = !['resolved', 'closed'].includes(iss.status);
            return (
              <div key={iss.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '5px 0', borderBottom: '1px solid #f1f5f9' }}>
                <span style={{ fontWeight: 500, color: isOpen ? '#0f172a' : '#94a3b8', textDecoration: isOpen ? 'none' : 'line-through' }}>{iss.title}</span>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Badge bg={isOpen ? '#fef2f2' : '#f0fdf4'} color={isOpen ? '#dc2626' : '#059669'}>{iss.status?.replace('_', ' ')}</Badge>
                  <span style={{ fontSize: 10, color: '#94a3b8' }}>{iss.priority}</span>
                </div>
              </div>
            );
          })}
          {issues.length === 0 && <p style={{ fontSize: 13, color: '#cbd5e1' }}>No issues.</p>}
        </div>
      )}

      {activeSection === 'actions' && (
        <div style={{ ...cardStyle, marginBottom: 20 }}>
          <h3 style={sectionTitle}>Outstanding Actions ({tasks.length})</h3>
          {tasks.map((t) => (
            <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '5px 0', borderBottom: '1px solid #f1f5f9' }}>
              <span style={{ fontWeight: 500, color: '#0f172a' }}>{t.title}</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ color: '#64748b' }}>{t.service}</span>
                <span style={{ fontSize: 10, color: '#94a3b8' }}>{new Date(t.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
              </div>
            </div>
          ))}
          {tasks.length === 0 && <p style={{ fontSize: 13, color: '#cbd5e1' }}>No outstanding actions.</p>}
        </div>
      )}

      {/* Always-visible sections */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
        <div style={cardStyle}>
          <h3 style={sectionTitle}>Client Details</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', fontSize: 13 }}>
            <DetailRow label="Name" value={entity.name} />
            <DetailRow label="Type" value={entity.type?.replace('_', ' ')} />
            <EditableRow label="Company No." field="company_number" entity={entity} setEntity={setEntity} profile={profile} placeholder="e.g. SC123456" overrides={fieldOverrides} setOverrides={setFieldOverrides} />
            <EditableRow label="UTR" field="utr" entity={entity} setEntity={setEntity} profile={profile} overrides={fieldOverrides} setOverrides={setFieldOverrides} />
            <EditableRow label="VAT Number" field="vat_number" entity={entity} setEntity={setEntity} profile={profile} overrides={fieldOverrides} setOverrides={setFieldOverrides} />
            <EditableRow label="PAYE Ref" field="paye_ref" entity={entity} setEntity={setEntity} profile={profile} overrides={fieldOverrides} setOverrides={setFieldOverrides} />
            <EditableRow label="CH Auth Code" field="ch_auth_code" entity={entity} setEntity={setEntity} profile={profile} overrides={fieldOverrides} setOverrides={setFieldOverrides} />
            {entity.manager && <DetailRow label="Manager" value={entity.manager} />}
            {entity.grade && <DetailRow label="Grade" value={entity.grade} />}
            <DetailRow label="Expedite" value={entity.expedite ? 'Yes — prioritise post-period-end' : 'No'} />
            <EditableRow label="Email" field="prospect_email" entity={entity} setEntity={setEntity} profile={profile} placeholder="client@example.com" />
            <DetailRow label="Source" value={entity.source === 'athena' ? 'Athena (manual)' : 'BrightManager'} />
          </div>
        </div>

        <div style={cardStyle}>
          <h3 style={sectionTitle}>Work Overview</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <WorkStat icon={Clipboard} label="Quick tasks" count={tasks.length} onClick={() => navigate('/planner')} />
            <WorkStat icon={Clock} label="Scheduled tasks" count={scheduledTasks.length} onClick={() => navigate('/planner/scheduled')} />
            <WorkStat icon={CheckCircle} label="Completed" count={filteredCompleted.length} sub={durFmt(totalCompleted)} onClick={() => navigate('/planner/completed')} />
            {pendingBilling.length > 0 && (
              <WorkStat icon={Receipt} label="Pending billing" count={pendingBilling.length} sub={fmt(pendingBilling.reduce((s, b) => s + (b.gross_amount || 0), 0))} onClick={() => navigate('/billing')} />
            )}
          </div>
        </div>
      </div>

      {/* Raise Action */}
      <div style={cardStyle}>
        <h3 style={sectionTitle}>Raise Action</h3>
        <p style={{ fontSize: 12, color: '#64748b', marginBottom: 10 }}>Create a task in the Work Planner linked to this client.</p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input value={changeTaskText} onChange={(e) => setChangeTaskText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleRaiseAction(); }} placeholder="e.g. Chase outstanding documents, review fees..." disabled={taskCreating} style={{ flex: 1, minWidth: 200, padding: '9px 14px', fontSize: 13, border: '1px solid #e5e7eb', borderRadius: 10, outline: 'none', fontFamily: "'Outfit', sans-serif" }} />
          <select value={actionAssignee} onChange={(e) => setActionAssignee(e.target.value)} style={{ padding: '9px 10px', fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 8, outline: 'none', fontFamily: "'Outfit', sans-serif" }}>
            <option value="">Assign to...</option>
            {staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button onClick={handleRaiseAction} disabled={!changeTaskText.trim() || taskCreating} style={{ padding: '9px 16px', fontSize: 13, fontWeight: 600, background: !changeTaskText.trim() ? '#e5e7eb' : '#0f172a', color: !changeTaskText.trim() ? '#94a3b8' : '#fff', border: 'none', borderRadius: 10, cursor: !changeTaskText.trim() ? 'not-allowed' : 'pointer', fontFamily: "'Outfit', sans-serif", flexShrink: 0 }}>
            {taskCreating ? 'Creating...' : 'Raise Action'}
          </button>
        </div>
        {taskCreated && <div style={{ marginTop: 8, fontSize: 12, color: '#059669', fontWeight: 500 }}>✓ Action created in Work Planner</div>}
      </div>
    </div>
  );
}

function DetailRow({ label, value }) {
  if (!value) return null;
  return (<>
    <span style={{ fontSize: 12, color: '#94a3b8' }}>{label}</span>
    <span style={{ fontSize: 13, color: '#0f172a', fontWeight: 500 }}>{value}</span>
  </>);
}

// Fields that also live in BrightManager — editing these keeps the Athena
// value, raises a Sophie to-do, and shows a "BM differs" flag until BM aligns.
const BM_SHARED_FIELDS = new Set(['company_number', 'utr', 'vat_number', 'paye_ref', 'ch_auth_code']);
const normCode = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Click-to-edit registration field. Always rendered (even when empty) so
// missing values — company number especially — are obviously addable.
// Persists straight to entities with an audit_log entry.
function EditableRow({ label, field, entity, setEntity, profile, placeholder, overrides, setOverrides }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const [saving, setSaving] = useState(false);
  const current = entity[field] || '';
  const ov = overrides?.[field];
  const bmDiffers = ov && normCode(ov.value) !== normCode(ov.bm_value);

  async function save(nextRaw) {
    const next = (nextRaw ?? val).trim() || null;
    if (next === (entity[field] || null)) { setEditing(false); return; }
    setSaving(true);
    const oldVal = entity[field] || null;
    const { error } = await supabase.from('entities').update({ [field]: next }).eq('id', entity.id);
    if (error) {
      alert(`Could not save ${label}: ` + error.message);
    } else {
      setEntity({ ...entity, [field]: next });
      await supabase.from('audit_log').insert({
        user_id: profile?.id || null, action: 'entity_field_edit', entity_type: 'entity',
        entity_id: entity.id, detail: { field, from: oldVal, to: next },
      });
      // BM-shared field: keep the Athena value, flag BM, and raise Sophie's to-do.
      if (BM_SHARED_FIELDS.has(field) && setOverrides) {
        // Preserve the last-known BM value if an override already exists, else
        // the value we just replaced was BM's.
        const bmVal = ov?.bm_value ?? oldVal;
        try {
          await supabase.rpc('record_field_override', { p_entity_id: entity.id, p_field: field, p_value: next, p_bm_value: bmVal });
        } catch (e) { console.warn('[record_field_override]', e); }
        setOverrides((prev) => {
          const n = { ...prev };
          if (normCode(next) === normCode(bmVal)) delete n[field];
          else n[field] = { value: next, bm_value: bmVal };
          return n;
        });
      }
    }
    setSaving(false);
    setEditing(false);
  }

  return (<>
    <span style={{ fontSize: 12, color: '#94a3b8' }}>{label}</span>
    {editing ? (
      <input
        autoFocus value={val} placeholder={placeholder || ''}
        onChange={(e) => setVal(e.target.value)}
        onBlur={(e) => save(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') save(e.currentTarget.value); if (e.key === 'Escape') setEditing(false); }}
        disabled={saving}
        style={{ fontSize: 13, padding: '3px 8px', border: '1px solid #0e7fe0', borderRadius: 6, outline: 'none', fontFamily: "'Outfit', sans-serif", maxWidth: 220 }}
      />
    ) : (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span
          onClick={() => { setVal(current); setEditing(true); }}
          title={`Click to ${current ? 'edit' : 'add'} ${label}`}
          style={{
            fontSize: 13, fontWeight: 500, cursor: 'pointer',
            color: current ? '#0f172a' : '#94a3b8',
            borderBottom: '1px dashed #cbd5e1',
          }}
        >
          {current || '+ add'}
        </span>
        {bmDiffers && (
          <span
            title={`BrightManager still shows "${ov.bm_value || '(blank)'}" — on Sophie's admin list to update in BM. Clears automatically once BM matches.`}
            style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 6, background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d', whiteSpace: 'nowrap' }}
          >
            BM: {ov.bm_value || '—'}
          </span>
        )}
      </span>
    )}
  </>);
}

function Badge({ bg, color, children }) {
  return <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 6, background: bg, color, textTransform: 'capitalize', fontFamily: "'Outfit', sans-serif" }}>{children}</span>;
}

// Read-only reconciliation panel: BrightManager contact email vs QuickBooks
// billing email(s). Only rendered when there's something to flag.
function EmailReconPanel({ recon }) {
  const META = {
    mismatch: { label: 'Email mismatch', bg: '#fef3c7', fg: '#92400e', msg: 'The BrightManager contact email is not among the QuickBooks billing emails.' },
    gap_qbo:  { label: 'No QBO billing email', bg: '#fee2e2', fg: '#b91c1c', msg: 'QuickBooks has no billing email for this client.' },
    gap_bm:   { label: 'No BM contact email', bg: '#e0e7ff', fg: '#3730a3', msg: 'No BrightManager contact email on file.' },
    gap_both: { label: 'No email either side', bg: '#f1f5f9', fg: '#475569', msg: 'Neither BrightManager nor QuickBooks has an email.' },
  };
  const m = META[recon.status] || META.gap_both;
  const qbo = recon.qbo_billing_emails || [];
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, marginBottom: 20, fontFamily: "'Outfit', sans-serif" }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', margin: 0 }}>Email reconciliation</h3>
        <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: m.bg, color: m.fg }}>{m.label}</span>
      </div>
      <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 10px 0' }}>{m.msg}</p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13 }}>
        <div>
          <div style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', marginBottom: 2 }}>BM contact email</div>
          <div style={{ fontFamily: 'monospace', fontSize: 12, color: recon.bm_contact_email ? '#1e293b' : '#cbd5e1' }}>{recon.bm_contact_email || '—'}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', marginBottom: 2 }}>QBO billing email(s)</div>
          <div style={{ fontFamily: 'monospace', fontSize: 12, color: qbo.length ? '#1e293b' : '#cbd5e1', wordBreak: 'break-word' }}>{qbo.length ? qbo.join(', ') : '—'}</div>
        </div>
      </div>
    </div>
  );
}

// Per client × service fee earner & manager editor. Lists every
// distinct service_id that appears on this client's live_billing rows,
// plus any that already have an allocation. Changes persist immediately
// via upsert; empty fee_earner_id + empty manager_id = no allocation.
function AllocationEditor({ entityId, billing, allocations, staff, onChange }) {
  const serviceIds = React.useMemo(() => {
    const set = new Set();
    for (const b of billing || []) {
      const services = Array.isArray(b.services) ? b.services : [];
      for (const s of services) {
        if (s.service_id) set.add(s.service_id);
        else if (s.description) set.add(s.description);
      }
    }
    for (const a of allocations || []) {
      if (a.service_id) set.add(a.service_id);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [billing, allocations]);

  const byService = React.useMemo(() => {
    const m = {};
    for (const a of allocations || []) m[a.service_id] = a;
    return m;
  }, [allocations]);

  const persist = async (serviceId, patch) => {
    const existing = byService[serviceId] || { entity_id: entityId, service_id: serviceId };
    const next = {
      entity_id: entityId,
      service_id: serviceId,
      fee_earner_id: existing.fee_earner_id || null,
      fee_earner_manager_id: existing.fee_earner_manager_id || null,
      ...patch,
    };
    // Auto-mirror manager to match fee earner on first set.
    if (patch.fee_earner_id && !existing.fee_earner_manager_id && !patch.fee_earner_manager_id) {
      next.fee_earner_manager_id = patch.fee_earner_id;
    }
    // Optimistic update.
    const nextAllocations = [
      ...(allocations || []).filter((a) => a.service_id !== serviceId),
      next,
    ];
    onChange(nextAllocations);

    const { error } = await supabase
      .from('client_service_allocations')
      .upsert(next, { onConflict: 'entity_id,service_id' });
    if (error) alert('Failed to save allocation: ' + error.message);
  };

  if (serviceIds.length === 0) return null;

  return (
    <div style={{ marginTop: 18 }}>
      <h4 style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
        Fee earner allocation
      </h4>
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr', gap: 8, fontSize: 11, color: '#94a3b8', paddingBottom: 4, borderBottom: '1px solid #f1f5f9' }}>
        <span>Service</span>
        <span>Fee earner</span>
        <span>Fee earner manager</span>
      </div>
      {serviceIds.map((sid) => {
        const a = byService[sid] || {};
        return (
          <div key={sid} style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f8fafc' }}>
            <span style={{ fontSize: 12, color: '#1e293b', fontWeight: 500 }}>{sid}</span>
            <select
              value={a.fee_earner_id || ''}
              onChange={(e) => persist(sid, { fee_earner_id: e.target.value || null })}
              style={allocSelectStyle}
            >
              <option value="">— unassigned —</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select
              value={a.fee_earner_manager_id || ''}
              onChange={(e) => persist(sid, { fee_earner_manager_id: e.target.value || null })}
              style={allocSelectStyle}
            >
              <option value="">— unassigned —</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        );
      })}
    </div>
  );
}

const allocSelectStyle = {
  fontSize: 12, padding: '4px 6px',
  border: '1px solid #e5e7eb', borderRadius: 6,
  background: '#fff', color: '#1e293b',
  fontFamily: "'Outfit', sans-serif", outline: 'none',
};

// Editable status pill. `third_party` covers non-client invoicees —
// finance partners, insurance co's, asset buyers — so they stay
// invoiceable but drop out of client KPIs. `archived` is a former
// client, `prospect` is pre-billing, `active` is a billable client.
const STATUS_OPTIONS = [
  { value: 'active',      label: 'Active',      bg: '#f0fdf4', color: '#15803d' },
  { value: 'prospect',    label: 'Prospect',    bg: '#eff6ff', color: '#0e7fe0' },
  { value: 'nlac',        label: 'NLAC',        bg: '#fef2f2', color: '#b91c1c' },
  { value: 'third_party', label: 'Third party', bg: '#f5f3ff', color: '#6d28d9' },
  { value: 'archived',    label: 'Archived',    bg: '#f1f5f9', color: '#64748b' },
];
function StatusEditor({ value, onChange }) {
  const current = STATUS_OPTIONS.find((o) => o.value === value) || STATUS_OPTIONS[0];
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        title="Change entity status"
        style={{
          appearance: 'none', WebkitAppearance: 'none',
          fontSize: 10, fontWeight: 600,
          padding: '2px 22px 2px 8px', borderRadius: 6,
          background: current.bg, color: current.color,
          border: '1px solid transparent',
          fontFamily: "'Outfit', sans-serif",
          textTransform: 'capitalize', cursor: 'pointer',
        }}
      >
        {STATUS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <span style={{
        position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
        pointerEvents: 'none', color: current.color, fontSize: 9,
      }}>▾</span>
    </div>
  );
}

const CADENCE_OPTIONS = [
  { value: 'early',  label: 'Early',  bg: '#ecfdf5', color: '#15803d', hint: 'Shift scheduled work one week earlier than the task-type default' },
  { value: 'normal', label: 'Normal', bg: '#f1f5f9', color: '#475569', hint: 'Use the task-type default slot as-is' },
  { value: 'late',   label: 'Late',   bg: '#fffbeb', color: '#b45309', hint: 'Shift scheduled work one week later than the task-type default' },
];

function CadenceEditor({ value, onChange }) {
  const current = CADENCE_OPTIONS.find((o) => o.value === value) || CADENCE_OPTIONS[1];
  return (
    <div style={{ position: 'relative', display: 'inline-block' }} title={`Scheduling cadence — ${current.hint}`}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          appearance: 'none', WebkitAppearance: 'none',
          fontSize: 10, fontWeight: 600,
          padding: '2px 22px 2px 8px', borderRadius: 6,
          background: current.bg, color: current.color,
          border: '1px solid transparent',
          fontFamily: "'Outfit', sans-serif",
          cursor: 'pointer',
        }}
      >
        {CADENCE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{`Cadence: ${o.label}`}</option>
        ))}
      </select>
      <span style={{
        position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
        pointerEvents: 'none', color: current.color, fontSize: 9,
      }}>▾</span>
    </div>
  );
}

function ExpediteToggle({ value, onChange }) {
  const on = !!value;
  return (
    <button
      onClick={() => onChange(!on)}
      title={on ? 'Expedite ON — work prioritised post-period-end. Click to turn off.' : 'Expedite OFF. Click to flag this client for fast turnaround.'}
      style={{
        fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 6,
        background: on ? '#fef3c7' : '#f1f5f9',
        color: on ? '#b45309' : '#64748b',
        border: '1px solid ' + (on ? '#fcd34d' : '#cbd5e1'),
        fontFamily: "'Outfit', sans-serif",
        cursor: 'pointer', letterSpacing: 0.3, textTransform: 'uppercase',
      }}
    >
      {on ? '⚡ Expedite' : 'Expedite off'}
    </button>
  );
}

function SummaryCard({ icon: Icon, label, value, accent, onClick, active }) {
  return (
    <div onClick={onClick} style={{
      background: '#fff', borderRadius: 12,
      border: active ? `2px solid ${accent}` : '1px solid #e5e7eb',
      padding: '14px 16px', cursor: 'pointer', transition: 'all 0.15s',
    }}
    onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.06)'; }}
    onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none'; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <Icon size={14} style={{ color: accent }} />
        <span style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase' }}>{label}</span>
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, color: accent, fontFamily: "'Outfit', sans-serif" }}>{value}</div>
    </div>
  );
}

function WorkStat({ icon: Icon, label, count, sub, onClick }) {
  return (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', cursor: onClick ? 'pointer' : 'default', borderBottom: '1px solid #f1f5f9' }}>
      <Icon size={14} style={{ color: '#94a3b8', flexShrink: 0 }} />
      <span style={{ fontSize: 12, color: '#1e293b', flex: 1 }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>{count}</span>
      {sub && <span style={{ fontSize: 11, color: '#64748b' }}>{sub}</span>}
    </div>
  );
}

const wrapStyle = { maxWidth: 960, margin: '0 auto', padding: '28px 24px', fontFamily: "'Outfit', sans-serif" };
const cardStyle = { background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '18px 22px' };
const sectionTitle = { fontFamily: "'Outfit', sans-serif", fontSize: 12, fontWeight: 600, textTransform: 'uppercase', color: '#94a3b8', letterSpacing: '0.03em', marginBottom: 12, marginTop: 0 };
