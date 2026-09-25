import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronDown, Copy, Check } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import { Btn } from '../../components/ui';
import { approvedServicesOf, feeTotals, underBillingOf, yearlyFeeOf } from './feeRollup';
import ClientCommsTab from './ClientCommsTab';
import ClientAgendaCard from './ClientAgendaCard';
import ClientHmrcPanel from '../hmrc/ClientHmrcPanel';
import { BTN } from '../../lib/buttonStyles';

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
  // Client fees are confidential: money renders only for staff with the
  // fee-visibility flags (RLS enforces the same at the data layer, so this
  // gate is presentation — without it the tiles would show misleading £0s).
  const canSeeFees = profile?.can_view_client_fees === true;
  const canSeeQuotes = profile?.can_view_quotes === true || canSeeFees;
  const canSeeBillingQueue = profile?.can_view_billing === true || canSeeFees;
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
  const [bmJobs, setBmJobs] = useState([]); // open BrightManager jobs — the compliance strip
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
  const [people, setPeople] = useState([]); // entity_people (directors / PSCs / contacts)
  const [activeTab, setActiveTab] = useState('overview');
  const raiseInputRef = useRef(null);

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
          // "Open issues" = this client's Triage cases (the Issues Log merged into Triage, sql/293).
          supabase.from('triage_cases').select('id, category, title, description, status, stage, priority, created_at').eq('entity_id', id).order('created_at', { ascending: false }),
          supabase.from('billing_items').select('*').eq('entity_id', id).order('created_at', { ascending: false }),
          supabase.from('staff_profiles').select('id, name, email, is_active').order('name'),
          supabase.from('client_service_allocations').select('*').eq('entity_id', id),
          supabase.from('v_email_reconciliation').select('*').eq('entity_id', id).maybeSingle(),
          supabase.from('onboardings')
            .select('id, status, template:onboarding_templates(name), steps:onboarding_steps(status)')
            .eq('entity_id', id).in('status', ['active', 'on_hold', 'issues'])
            // Archiving leaves status alone (onboarding api.js), so an archived
            // run still reads 'active' — without this it shows as a second banner.
            .is('archived_at', null),
          supabase.from('admin_tasks')
            .select('field, value, bm_value')
            .eq('entity_id', id).eq('kind', 'bm_field').is('confirmed_at', null).is('dismissed_at', null),
          supabase.from('bm_task_schedule')
            .select('id, service, bm_task_name, bm_deadline, bm_status')
            .eq('entity_id', id).eq('state', 'planned').is('excluded_at', null).order('bm_deadline'),
          supabase.from('entity_people')
            .select('role, role_pct, started_on, source, is_primary_contact, person:people(id, name, email, phone, dob_year, dob_month, ch_personal_code, ch_officer_id, ch_psc_id)')
            .eq('entity_id', id),
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
        setBmJobs(get(13) || []);
        setPeople(get(14) || []);
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

  const refreshTasks = async () => {
    const { data } = await supabase.from('quick_tasks').select('*').eq('entity_id', id).order('created_at', { ascending: false });
    if (data) setTasks(data);
  };

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
    if (!window.confirm(`Mark "${entity.name}" as no longer a client?\n\nStops chasing and onboarding, and asks Admin to archive them in BrightManager.`)) return;
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

  if (loading) return <div style={wrapStyle}><p style={{ color: '#94a3b8', fontSize: 14 }}>Loading client...</p></div>;
  if (!entity) return <div style={wrapStyle}><p style={{ color: '#ef4444', fontSize: 14 }}>Client not found.</p></div>;

  // Approved-fee roll-up — shared rules live in feeRollup.js.
  const approvedServices = approvedServicesOf(billing);
  const { monthly: totalMonthly, annual: totalAnnualFees } = feeTotals(billing);
  const totalAnnual = totalMonthly * 12 + totalAnnualFees;
  const activeQuotes = quotes.filter((q) => ['accepted', 'sent', 'approved'].includes(q.status));
  const openIssues = issues.filter((i) => i.status === 'open');
  const totalCompleted = filteredCompleted.reduce((s, t) => s + (t.completion_mins || 0), 0);
  const pendingBilling = billingItems.filter((b) => b.status === 'draft' || b.status === 'pending_approval');
  const fmt = (n) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2 }).format(n || 0);
  const durFmt = (mins) => (mins == null ? '0m' : `${Math.round(Number(mins) || 0)}m`);

  // Header "More" menu edits — status, cadence, expedite. Each is optimistic
  // with a rollback, and status changes are audited as before.
  const changeStatus = async (next) => {
    const prev = entity.entity_status || 'active';
    if (next === prev) return;
    let reason = '';
    if (next === 'nlac' || next === 'archived') {
      reason = window.prompt('Reason (optional)', '') || '';
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
  };
  const changeCadence = async (next) => {
    const prev = entity.cadence_preference;
    setEntity({ ...entity, cadence_preference: next });
    const { error } = await supabase.from('entities').update({ cadence_preference: next }).eq('id', entity.id);
    if (error) {
      alert('Could not update cadence: ' + error.message);
      setEntity({ ...entity, cadence_preference: prev });
    }
  };
  const changeExpedite = async (next) => {
    const prev = !!entity.expedite;
    setEntity({ ...entity, expedite: next });
    const { error } = await supabase.from('entities').update({ expedite: next }).eq('id', entity.id);
    if (error) {
      alert('Could not update expedite flag: ' + error.message);
      setEntity({ ...entity, expedite: prev });
    }
  };

  // Layout (UI audit, Sprint 4): header with the actions, tabs for the
  // record's areas, and a right rail — contact, references, fees — that stays
  // put on every tab, so the facts you reach for are never a tab away.
  const isLtd = entity?.type === 'limited_company';
  const primary = people.find((p) => p.is_primary_contact)?.person || null;
  // One card per human, carrying every role they hold here — a director who
  // is also a PSC and the primary contact is one person with three tags,
  // not three rows (entity_people holds a link per role).
  const peopleGrouped = groupPeople(people);
  const showBillingTab = canSeeFees || canSeeQuotes;
  const CLIENT_TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'work', label: 'Work', count: tasks.length },
    ...(showBillingTab ? [{ id: 'billing', label: canSeeFees && canSeeQuotes ? 'Billing & quotes' : canSeeFees ? 'Billing' : 'Quotes' }] : []),
    { id: 'people', label: 'People', count: peopleGrouped.length },
    { id: 'comms', label: 'Communications' },
  ];
  const tab = CLIENT_TABS.some((t) => t.id === activeTab) ? activeTab : 'overview';

  const contactEmail = primary?.email || entity.billing_email || entity.prospect_email || null;
  const contactPhone = primary?.phone || entity.prospect_phone || null;
  const address = [entity.billing_line1, entity.billing_line2, entity.billing_city, entity.billing_postcode].filter(Boolean);
  const staffName = (sid) => staffList.find((s) => s.id === sid)?.name || null;
  const feeEarners = [...new Set(allocations.map((a) => staffName(a.fee_earner_id)).filter(Boolean))];
  const deadlineJobs = bmJobs.filter((j) => j.bm_deadline);

  const goRaiseAction = () => {
    setActiveTab('work');
    setTimeout(() => raiseInputRef.current?.focus(), 0);
  };

  const rowStyle = { display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13.5, padding: '6px 0', borderBottom: '1px solid #f1f5f9' };
  const emptyStyle = { fontSize: 14, color: '#94a3b8', margin: 0 };
  const linkStyle = { display: 'inline-block', marginTop: 10, fontSize: 13, color: '#1E4560', fontWeight: 600, textDecoration: 'none' };
  const dateShort = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  const billingCard = canSeeFees && (
    <div style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ ...sectionTitle, marginBottom: 0 }}>Active billing</h3>
        <Btn variant="secondary" onClick={() => navigate(`/manage/billing/change?client=${encodeURIComponent(entity.name)}`)}>
          Manage billing
        </Btn>
      </div>
      {approvedServices.length > 0 ? (
        <>
          <div style={{ display: 'flex', gap: 28, marginBottom: 12, flexWrap: 'wrap' }}>
            <div><div style={{ fontSize: 12, color: '#94a3b8' }}>Monthly</div><div style={{ fontSize: 20, fontWeight: 700, color: '#0f172a' }}>{fmt(totalMonthly)}</div></div>
            <div><div style={{ fontSize: 12, color: '#94a3b8' }}>Annual-only fees</div><div style={{ fontSize: 20, fontWeight: 700, color: '#0f172a' }}>{fmt(totalAnnualFees)}</div></div>
            <div><div style={{ fontSize: 12, color: '#94a3b8' }}>Total a year</div><div style={{ fontSize: 20, fontWeight: 700, color: '#0f172a' }}>{fmt(totalAnnual)}</div></div>
          </div>
          {approvedServices.map((s, idx) => (
            <div key={`${s.row_id}-${idx}`} style={rowStyle}>
              <span style={{ color: '#1e293b' }}>
                {s.service_id || s.description || 'Service'}
                {s.fromTemplate && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, padding: '1px 5px', borderRadius: 4, background: '#ccfbf1', color: '#115e59' }}>QuickBooks template</span>}
                {(() => {
                  const ub = underBillingOf(s);
                  return ub && (
                    <span
                      style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, padding: '1px 5px', borderRadius: 4, background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d' }}
                      title={`Below the standard minimum of ${fmt(ub.min)}/yr — under by ${fmt(ub.under)}/yr`}
                    >
                      Under {fmt(ub.under)}/yr
                    </span>
                  );
                })()}
              </span>
              <span style={{ fontWeight: 500, fontFamily: 'monospace' }}>
                {s.cadence === 'annual' ? `${fmt(yearlyFeeOf(s))}/yr` : `${fmt(s.monthly_amount)}/mo`}
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
      ) : <p style={emptyStyle}>No active billing.</p>}
    </div>
  );

  const quotesCard = canSeeQuotes && (
    <div style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ ...sectionTitle, marginBottom: 0 }}>Quotes ({quotes.length}{activeQuotes.length ? ` · ${activeQuotes.length} active` : ''})</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn variant="secondary" onClick={() => navigate(`/manage/quotes/new?entity=${entity.id}&seed=source`)}>
            Copy another client's pricing
          </Btn>
          <Btn onClick={() => navigate(`/manage/quotes/new?entity=${entity.id}`)}>New quote</Btn>
        </div>
      </div>
      {quotes.map((q) => (
        <div key={q.id} onClick={() => navigate(`/manage/quotes/${q.id}`)} style={{ ...rowStyle, cursor: 'pointer' }}>
          <span style={{ fontWeight: 500, color: '#0f172a' }}>{q.quote_ref}</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: '#64748b' }}>{fmt(q.monthly_gross)}/mo</span>
            <Badge bg={q.status === 'accepted' ? '#f0fdf4' : q.status === 'sent' ? '#f5f3ff' : '#f1f5f9'} color={q.status === 'accepted' ? '#059669' : q.status === 'sent' ? '#7c3aed' : '#64748b'}>{q.status}</Badge>
          </div>
        </div>
      ))}
      {quotes.length === 0 && <p style={emptyStyle}>No quotes.</p>}
    </div>
  );

  return (
    <div style={wrapStyle}>
      <a href="/clients" onClick={(e) => { e.preventDefault(); navigate('/clients'); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#64748b', fontSize: 14, marginBottom: 14, textDecoration: 'none' }}>
        <ChevronLeft size={16} /> Clients
      </a>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <EditableName entity={entity} setEntity={setEntity} profile={profile} />
            <StatusChip value={entity.entity_status || 'active'} />
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, color: '#64748b', flexWrap: 'wrap' }}>
            <span style={{ textTransform: 'capitalize' }}>{entity.type?.replace('_', ' ')}</span>
            {entity.company_number && <span>· {entity.company_number}</span>}
            {entity.manager && <span>· Managed by {entity.manager}</span>}
            {entity.grade && <span>· Grade {entity.grade}</span>}
            {entity.expedite && <Badge bg="#fef3c7" color="#b45309">Expedite</Badge>}
            {entity.cadence_preference && entity.cadence_preference !== 'normal' && (
              <Badge bg="#f1f5f9" color="#475569">Scheduled {entity.cadence_preference}</Badge>
            )}
            {entity.source === 'athena' && <Badge bg="#dbeafe" color="#1E4560">Added in Athena</Badge>}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Btn onClick={goRaiseAction}>Raise action</Btn>
          {canSeeQuotes && <Btn variant="secondary" onClick={() => navigate(`/manage/quotes/new?entity=${entity.id}`)}>New quote</Btn>}
          <MoreMenu
            entity={entity}
            busy={offboarding || archiving}
            onStatus={changeStatus}
            onCadence={changeCadence}
            onExpedite={changeExpedite}
            onOffboard={handleOffboard}
            onReinstate={handleReinstate}
            onArchive={handleArchive}
          />
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid #e5e7eb', marginBottom: 20, flexWrap: 'wrap' }}>
        {CLIENT_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            style={{
              padding: '9px 16px', border: 'none', background: 'none', cursor: 'pointer',
              fontFamily: "'Outfit', sans-serif", fontSize: 14.5, fontWeight: tab === t.id ? 700 : 500,
              color: tab === t.id ? '#0f172a' : '#64748b',
              borderBottom: tab === t.id ? '2px solid #1E4560' : '2px solid transparent',
              marginBottom: -1,
            }}
          >
            {t.label}
            {t.count > 0 && <span style={{ marginLeft: 6, fontSize: 12, fontWeight: 600, padding: '1px 7px', borderRadius: 999, background: '#f1f5f9', color: '#475569' }}>{t.count}</span>}
          </button>
        ))}
      </div>

      <div className="grid gap-6 items-start min-[1000px]:grid-cols-[minmax(0,1fr)_300px]">
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>

      {tab === 'overview' && (<>
        {offboardResult && (
          <div style={{ border: '1px solid #fecaca', background: '#fef2f2', borderRadius: 12, padding: '12px 16px' }}>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: '#b91c1c', marginBottom: 4 }}>
              Marked no longer a client
            </div>
            <div style={{ fontSize: 13.5, color: '#7f1d1d' }}>
              Removed from the clients list and billing views.
              {offboardResult.ch_stalled > 0 && ` ${offboardResult.ch_stalled} Companies House chase${offboardResult.ch_stalled === 1 ? '' : 's'} stopped.`}
              {offboardResult.onboardings_archived > 0 && ` ${offboardResult.onboardings_archived} onboarding${offboardResult.onboardings_archived === 1 ? '' : 's'} archived.`}
              {offboardResult.bm_task_created
                ? ' Admin has a task to archive them in BrightManager.'
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
            <a
              key={ob.id}
              href={`/onboarding/${ob.id}`}
              onClick={(e) => { e.preventDefault(); navigate(`/onboarding/${ob.id}`); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 14, textDecoration: 'none',
                border: '1px solid #bfdbfe', background: '#eff6ff', borderRadius: 12, padding: '13px 16px',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14.5, fontWeight: 700, color: '#0f172a' }}>
                  Onboarding in progress
                  {ob.status !== 'active' && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6, background: '#fef3c7', color: '#92400e' }}>{ob.status.replace('_', ' ')}</span>}
                </div>
                <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>
                  {ob.template?.name || 'Onboarding'} · {done} of {applicable.length} steps ({pct}%)
                </div>
              </div>
              <div style={{ width: 120, height: 6, borderRadius: 999, background: '#e2e8f0', overflow: 'hidden', flexShrink: 0 }}>
                <div style={{ width: `${pct}%`, height: '100%', background: pct === 100 ? '#059669' : '#1E4560' }} />
              </div>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: '#1E4560', whiteSpace: 'nowrap' }}>View onboarding →</span>
            </a>
          );
        })}

        {/* Email reconciliation: BM contact email (1:1) vs QBO billing email(s) (1:many) */}
        {recon && recon.status !== 'ok' && <EmailReconPanel recon={recon} />}

        {/* What HMRC's own records say about this client (sql/197). Renders
            nothing unless they hold a PAYE scheme on our agent list. */}
        <ClientHmrcPanel entityId={id} />

        {/* Next deadlines — open BrightManager jobs. The home-screen deadline
            alerts link here, so the thing that was clicked must be visible
            on arrival. */}
        <CompliancePanel jobs={deadlineJobs} navigate={navigate} />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20 }}>
          <div style={cardStyle}>
            <h3 style={sectionTitle}>Open issues ({openIssues.length})</h3>
            {openIssues.slice(0, 6).map((iss) => (
              <div key={iss.id} style={rowStyle}>
                <span style={{ fontWeight: 500, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{iss.title || iss.description}</span>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                  <Badge bg="#fef2f2" color="#dc2626">{(iss.stage || iss.status)?.replace(/_/g, ' ')}</Badge>
                  {iss.priority && <span style={{ fontSize: 12, color: '#94a3b8' }}>{iss.priority}</span>}
                </div>
              </div>
            ))}
            {openIssues.length === 0 && <p style={emptyStyle}>No open issues.</p>}
            <a href="/triage/list" onClick={(e) => { e.preventDefault(); navigate('/triage/list'); }} style={linkStyle}>Open Triage →</a>
          </div>

          <div style={cardStyle}>
            <h3 style={sectionTitle}>Open actions ({tasks.length})</h3>
            {tasks.slice(0, 6).map((t) => (
              <div key={t.id} style={rowStyle}>
                <span style={{ fontWeight: 500, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{t.title}</span>
                <span style={{ fontSize: 12, color: '#94a3b8', flexShrink: 0 }}>{t.due_date ? `due ${dateShort(t.due_date)}` : dateShort(t.created_at)}</span>
              </div>
            ))}
            {tasks.length === 0 && <p style={emptyStyle}>No open actions.</p>}
            <button onClick={() => setActiveTab('work')} style={{ ...linkStyle, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}>All work →</button>
          </div>
        </div>
      </>)}

      {tab === 'work' && (<>
        {/* Raise Action */}
        <div style={cardStyle}>
          <h3 style={sectionTitle}>Raise an action</h3>
          <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 10px' }}>Creates a task in the Work Planner for this client, due in five days.</p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input ref={raiseInputRef} value={changeTaskText} onChange={(e) => setChangeTaskText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleRaiseAction(); }} placeholder="e.g. Chase outstanding documents, review fees…" disabled={taskCreating} style={{ flex: 1, minWidth: 220, padding: '9px 14px', fontSize: 14, border: '1px solid #e5e7eb', borderRadius: 10, outline: 'none', fontFamily: "'Outfit', sans-serif" }} />
            <select value={actionAssignee} onChange={(e) => setActionAssignee(e.target.value)} style={{ padding: '9px 10px', fontSize: 13.5, border: '1px solid #e5e7eb', borderRadius: 8, outline: 'none', fontFamily: "'Outfit', sans-serif" }}>
              <option value="">Assign to…</option>
              {staffList.filter((s) => s.is_active !== false).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <Btn onClick={handleRaiseAction} disabled={!changeTaskText.trim() || taskCreating}>
              {taskCreating ? 'Creating…' : 'Raise action'}
            </Btn>
          </div>
          {taskCreated && <div style={{ marginTop: 8, fontSize: 13, color: '#059669', fontWeight: 500 }}>✓ Action created in the Work Planner</div>}
        </div>

        <ClientAgendaCard
          entity={entity}
          staffList={staffList}
          profile={profile}
          defaultAssignee={actionAssignee}
          onActionRaised={refreshTasks}
        />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20 }}>
          <div style={cardStyle}>
            <h3 style={sectionTitle}>Outstanding actions ({tasks.length})</h3>
            {tasks.map((t) => (
              <div key={t.id} style={rowStyle}>
                <span style={{ fontWeight: 500, color: '#0f172a', minWidth: 0 }}>{t.title}</span>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0, fontSize: 12.5 }}>
                  {staffName(t.assignee_id) && <span style={{ color: '#64748b' }}>{staffName(t.assignee_id)}</span>}
                  <span style={{ color: '#94a3b8' }}>{t.due_date ? `due ${dateShort(t.due_date)}` : dateShort(t.created_at)}</span>
                </div>
              </div>
            ))}
            {tasks.length === 0 && <p style={emptyStyle}>No outstanding actions.</p>}
            <a href="/planner" onClick={(e) => { e.preventDefault(); navigate('/planner'); }} style={linkStyle}>Open the Work Planner →</a>
          </div>

          <div style={cardStyle}>
            <h3 style={sectionTitle}>Scheduled tasks ({scheduledTasks.length})</h3>
            {scheduledTasks.map((t) => (
              <div key={t.id} style={rowStyle}>
                <span style={{ color: '#0f172a', minWidth: 0 }}>{t.title}</span>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0, fontSize: 12.5 }}>
                  {t.service && <span style={{ color: '#64748b' }}>{t.service}</span>}
                  {t.planned_date && <span style={{ color: '#94a3b8' }}>{dateShort(t.planned_date)}</span>}
                </div>
              </div>
            ))}
            {scheduledTasks.length === 0 && <p style={emptyStyle}>Nothing scheduled.</p>}
            <a href="/planner/scheduled" onClick={(e) => { e.preventDefault(); navigate('/planner/scheduled'); }} style={linkStyle}>Scheduled work →</a>
          </div>
        </div>

        <div style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <h3 style={{ ...sectionTitle, marginBottom: 0 }}>Time logged · {durFmt(totalCompleted)} across {filteredCompleted.length} task{filteredCompleted.length === 1 ? '' : 's'}</h3>
            <select value={timePeriod} onChange={(e) => setTimePeriod(e.target.value)} aria-label="Period" style={{ padding: '5px 8px', fontSize: 13.5, border: '1px solid #e5e7eb', borderRadius: 6, outline: 'none', fontFamily: "'Outfit', sans-serif" }}>
              {TIME_PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
          <div style={{ marginTop: 10 }}>
            {filteredCompleted.length > 0 ? filteredCompleted.slice(0, 20).map((t) => (
              <div key={t.id} style={rowStyle}>
                <span style={{ color: '#1e293b', minWidth: 0 }}>{t.title}</span>
                <div style={{ display: 'flex', gap: 10, flexShrink: 0, fontSize: 12.5 }}>
                  <span style={{ color: '#64748b' }}>{t.service}</span>
                  <span style={{ fontWeight: 500 }}>{durFmt(t.completion_mins)}</span>
                  <span style={{ color: '#94a3b8' }}>{dateShort(t.completed_at)}</span>
                </div>
              </div>
            )) : <p style={emptyStyle}>No completed work in this period.</p>}
          </div>
        </div>

        {canSeeBillingQueue && pendingBilling.length > 0 && (
          <div style={cardStyle}>
            <h3 style={sectionTitle}>Waiting to be billed</h3>
            <p style={{ fontSize: 14, color: '#0f172a', margin: 0 }}>
              {pendingBilling.length} item{pendingBilling.length === 1 ? '' : 's'} · {fmt(pendingBilling.reduce((s, b) => s + (b.gross_amount || 0), 0))}
            </p>
            <a href="/billing" onClick={(e) => { e.preventDefault(); navigate('/billing'); }} style={linkStyle}>Open Billing →</a>
          </div>
        )}
      </>)}

      {tab === 'billing' && (<>
        {billingCard}
        {quotesCard}
      </>)}

      {tab === 'people' && (
        <PeopleList people={peopleGrouped} isLtd={isLtd} />
      )}

      {tab === 'comms' && <ClientCommsTab entityId={id} />}
      </div>

      {/* Right rail — the same on every tab */}
      <aside style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={cardStyle}>
          <h3 style={sectionTitle}>Contact</h3>
          {primary?.name && <div style={{ fontSize: 15, fontWeight: 600, color: '#0f172a', marginBottom: 4 }}>{primary.name}</div>}
          {contactEmail
            ? <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, marginBottom: 3, minWidth: 0 }}>
                <a href={`mailto:${contactEmail}`} style={{ color: '#1E4560', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{contactEmail}</a>
                <CopyButton value={contactEmail} />
              </div>
            : <EditableContactEmail entity={entity} setEntity={setEntity} profile={profile} />}
          {contactPhone && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, marginBottom: 3 }}>
              <a href={`tel:${contactPhone}`} style={{ color: '#1E4560', textDecoration: 'none' }}>{contactPhone}</a>
              <CopyButton value={contactPhone} />
            </div>
          )}
          {address.length > 0 && (
            <div style={{ fontSize: 13.5, color: '#475569', marginTop: 8, lineHeight: 1.45 }}>
              {address.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          )}
          {!primary && !contactPhone && address.length === 0 && (
            <p style={{ ...emptyStyle, fontSize: 13, marginTop: 6 }}>No primary contact set.</p>
          )}
        </div>

        <div style={cardStyle}>
          <h3 style={sectionTitle}>References</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '8px 14px', alignItems: 'center' }}>
            <EditableRow label="Company no." field="company_number" entity={entity} setEntity={setEntity} profile={profile} placeholder="e.g. SC123456" overrides={fieldOverrides} setOverrides={setFieldOverrides} />
            <EditableRow label="UTR" field="utr" entity={entity} setEntity={setEntity} profile={profile} overrides={fieldOverrides} setOverrides={setFieldOverrides} />
            <EditableRow label="VAT" field="vat_number" entity={entity} setEntity={setEntity} profile={profile} overrides={fieldOverrides} setOverrides={setFieldOverrides} />
            <EditableRow label="PAYE" field="paye_ref" entity={entity} setEntity={setEntity} profile={profile} overrides={fieldOverrides} setOverrides={setFieldOverrides} />
            {/* Presence only, and read-only. Athena does not hold the code —
                sql/257 coerces any write to the marker 'held' and a CHECK
                constraint refuses a real one. BrightManager is the system of
                record; a code is a filing credential we have no use for. */}
            <DetailRow label="CH auth code" value={entity.ch_auth_code ? 'Held on BrightManager' : 'Not held'} />
            <DetailRow label="Source" value={entity.source === 'athena' ? 'Added in Athena' : 'BrightManager'} />
          </div>
        </div>

        {canSeeFees && (
          <div style={cardStyle}>
            <h3 style={sectionTitle}>Fees</h3>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#0f172a' }}>{fmt(totalMonthly)}<span style={{ fontSize: 13, fontWeight: 500, color: '#64748b' }}> /month</span></div>
            <div style={{ fontSize: 13.5, color: '#64748b', marginTop: 4 }}>
              {approvedServices.length} service{approvedServices.length === 1 ? '' : 's'}
              {totalAnnualFees > 0 && ` · ${fmt(totalAnnualFees)} annual-only`}
            </div>
            {feeEarners.length > 0 && <div style={{ fontSize: 13.5, color: '#475569', marginTop: 4 }}>Fee earner: {feeEarners.join(', ')}</div>}
            <button onClick={() => setActiveTab('billing')} style={{ ...linkStyle, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}>Billing &amp; quotes →</button>
          </div>
        )}
      </aside>
      </div>
    </div>
  );
}

// Months only from Companies House (never the day) — show "Apr 1975".
const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dobLabel(y, m) {
  if (!y) return null;
  return `${m ? MONTHS[m] + ' ' : ''}${y}`;
}

// Collapse entity_people links (one per role) into one entry per person.
// Directors first, then PSCs, then everyone else.
function groupPeople(links) {
  const byId = new Map();
  for (const l of links) {
    const person = l.person || {};
    const key = person.id || `${person.name}-${byId.size}`;
    if (!byId.has(key)) byId.set(key, { person, director: null, psc: null, otherRoles: new Set(), primary: false });
    const g = byId.get(key);
    if (l.role === 'director') g.director = l;
    else if (l.source === 'ch_psc') g.psc = l;
    else if (l.role) g.otherRoles.add(l.role);
    if (l.is_primary_contact) g.primary = true;
  }
  const rank = (g) => (g.director ? 0 : g.psc ? 1 : 2);
  return [...byId.values()].sort((a, b) => rank(a) - rank(b) || (a.person.name || '').localeCompare(b.person.name || ''));
}

// People tab: one card per person with a tag for each role they hold.
// Codes ending -2223 are genuine (confirmed 2026-07-15).
function PeopleList({ people, isLtd }) {
  if (!people || people.length === 0) {
    return (
      <div style={{ ...cardStyle, textAlign: 'center', padding: '40px 24px', color: '#94a3b8', fontSize: 14 }}>
        {isLtd
          ? 'No directors or PSCs from Companies House.'
          : 'No people recorded for this client.'}
      </div>
    );
  }
  const tag = (bg, color, text) => <Badge bg={bg} color={color}>{text}</Badge>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {people.map((g, i) => {
        const person = g.person;
        const dob = dobLabel(person.dob_year, person.dob_month);
        const code = person.ch_personal_code;
        const appointed = g.director?.started_on || g.psc?.started_on;
        return (
          <div key={person.id || i} style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 15.5, fontWeight: 700, color: '#0f172a', marginRight: 4 }}>{person.name || 'Unnamed'}</span>
                {g.director && tag('#e0e7ff', '#3730a3', 'Director')}
                {g.psc && tag('#f5f3ff', '#6d28d9', `PSC${g.psc.role_pct != null ? ` · ${g.psc.role_pct}%+` : ''}`)}
                {[...g.otherRoles].filter((r) => r !== 'contact').map((r) => <span key={r}>{tag('#f1f5f9', '#475569', r.replace(/_/g, ' '))}</span>)}
                {g.primary && tag('#dbeafe', '#1E4560', 'Primary contact')}
                {!g.director && !g.psc && !g.primary && g.otherRoles.size <= 1 && [...g.otherRoles][0] === 'contact' && tag('#f1f5f9', '#475569', 'Contact')}
              </div>
              <div style={{ fontSize: 13, color: '#64748b', display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                {dob && <span>b. {dob}</span>}
                {appointed && <span>{dob ? '· ' : ''}appointed {new Date(appointed).toLocaleDateString('en-GB')}</span>}
                {person.email && <a href={`mailto:${person.email}`} style={{ color: '#1E4560', textDecoration: 'none' }}>{(dob || appointed) ? '· ' : ''}{person.email}</a>}
              </div>
            </div>
            {(isLtd || code) && (
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 12, color: '#94a3b8' }}>CH personal code</div>
                {code
                  ? <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end', fontSize: 14, fontFamily: 'monospace', fontWeight: 600, color: '#0f172a' }}>{code}<CopyButton value={code} /></div>
                  : <div style={{ fontSize: 13.5, color: '#94a3b8' }}>none on file</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Click-to-edit client name (ported from the retired fee-engine client page).
// Note: for BM-sourced entities a rename here is overwritten by the next BM
// import ("BM is truth") — it's mainly for Athena-created prospects.
function EditableName({ entity, setEntity, profile }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const next = draft.trim();
    if (!next || next === entity.name) { setEditing(false); return; }
    setSaving(true);
    const prev = entity.name;
    const { error } = await supabase.from('entities').update({ name: next }).eq('id', entity.id);
    if (error) {
      alert('Could not rename client: ' + error.message);
    } else {
      setEntity({ ...entity, name: next });
      await supabase.from('audit_log').insert({
        user_id: profile?.id || null, action: 'entity_field_edit', entity_type: 'entity',
        entity_id: entity.id, detail: { field: 'name', from: prev, to: next },
      });
    }
    setSaving(false);
    setEditing(false);
  };

  if (editing) {
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
          autoFocus
          disabled={saving}
          style={{ fontFamily: "'Playfair Display', serif", fontSize: 24, fontWeight: 500, color: '#0f172a', border: '1px solid #cbd5e1', borderRadius: 8, padding: '2px 10px', minWidth: 320 }}
        />
        <button onClick={save} disabled={saving} style={{ ...BTN.primary.sm, cursor: 'pointer' }}>{saving ? '…' : 'Save'}</button>
        <button onClick={() => setEditing(false)} style={{ fontSize: 13, background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}>Cancel</button>
      </div>
    );
  }
  return (
    <h1
      onClick={() => { setDraft(entity.name); setEditing(true); }}
      title="Click to rename"
      style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 6, cursor: 'pointer' }}
    >
      {entity.name}
    </h1>
  );
}

function DetailRow({ label, value }) {
  if (!value) return null;
  return (<>
    <span style={{ fontSize: 13, color: '#94a3b8' }}>{label}</span>
    <span style={{ fontSize: 14, color: '#0f172a', fontWeight: 500 }}>{value}</span>
  </>);
}

// Fields that also live in BrightManager — editing these keeps the Athena
// value, raises a Sophie to-do, and shows a "BM differs" flag until BM aligns.
// ch_auth_code is deliberately absent: Athena stores only a presence marker, so
// there is no Athena-vs-BM value to disagree about. See sql/257.
const BM_SHARED_FIELDS = new Set(['company_number', 'utr', 'vat_number', 'paye_ref']);
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
    <span style={{ fontSize: 13, color: '#94a3b8' }}>{label}</span>
    {editing ? (
      <input
        autoFocus value={val} placeholder={placeholder || ''}
        onChange={(e) => setVal(e.target.value)}
        onBlur={(e) => save(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') save(e.currentTarget.value); if (e.key === 'Escape') setEditing(false); }}
        disabled={saving}
        style={{ fontSize: 14, padding: '3px 8px', border: '1px solid #0e7fe0', borderRadius: 6, outline: 'none', fontFamily: "'Outfit', sans-serif", width: '100%', boxSizing: 'border-box' }}
      />
    ) : (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', minWidth: 0 }}>
        <span
          onClick={() => { setVal(current); setEditing(true); }}
          title={`Click to ${current ? 'edit' : 'add'} ${label}`}
          style={{
            fontSize: 14, fontWeight: 500, cursor: 'pointer',
            color: current ? '#0f172a' : '#94a3b8',
            borderBottom: '1px dashed #cbd5e1',
          }}
        >
          {current || '+ add'}
        </span>
        {current && <CopyButton value={current} />}
        {bmDiffers && (
          <span
            title={`BrightManager still shows "${ov.bm_value || '(blank)'}". Update queued.`}
            style={{ fontSize: 11, fontWeight: 700, padding: '1px 7px', borderRadius: 6, background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d', whiteSpace: 'nowrap' }}
          >
            BM: {ov.bm_value || '—'}
          </span>
        )}
      </span>
    )}
  </>);
}

function Badge({ bg, color, children }) {
  return <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 6, background: bg, color, textTransform: 'capitalize', fontFamily: "'Outfit', sans-serif" }}>{children}</span>;
}

// Compliance & deadlines strip: every open (state='planned') BrightManager job
// for this client, overdue first. SA / Annual Accounts rows deep-link to the
// filtered Ready Now view; other services have no planner surface, so those
// rows don't navigate. BM status labels come through verbatim.
function CompliancePanel({ jobs, navigate }) {
  const [showAll, setShowAll] = useState(false);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const daysLate = (iso) => Math.floor((today - new Date(iso)) / 86400000);
  const overdue = jobs.filter((j) => j.bm_deadline && daysLate(j.bm_deadline) > 0);

  // Only SA and Annual Accounts have a Ready Now page to land on.
  const readyNowService = (name) => {
    if (/^self assessment submission/i.test(name || '')) return 'SA';
    if (/^companies house submission/i.test(name || '')) return 'Acc';
    return null;
  };

  const visible = showAll ? jobs : jobs.slice(0, 5);

  return (
    <div style={{ ...cardStyle, ...(overdue.length > 0 ? { border: '1px solid #fecaca' } : {}) }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: jobs.length > 0 ? 12 : 0 }}>
        <h3 style={{ ...sectionTitle, marginBottom: 0 }}>Next deadlines</h3>
        {overdue.length > 0 && (
          <Badge bg="#fef2f2" color="#dc2626">{overdue.length} overdue</Badge>
        )}
        {jobs.length > 0 && overdue.length === 0 && (
          <Badge bg="#f0fdf4" color="#059669">on track</Badge>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 12.5, color: '#94a3b8', fontFamily: "'Outfit', sans-serif" }}>
          {jobs.length > 0 ? `${jobs.length} open job${jobs.length === 1 ? '' : 's'} in BrightManager` : 'from BrightManager'}
        </span>
      </div>
      {jobs.length === 0 && (
        <p style={{ fontSize: 14, color: '#94a3b8', margin: 0 }}>No open deadlines for this client.</p>
      )}
      {visible.map((j) => {
        const late = j.bm_deadline ? daysLate(j.bm_deadline) : null;
        const isLate = late !== null && late > 0;
        const svc = readyNowService(j.bm_task_name);
        return (
          <div
            key={j.id}
            onClick={svc ? () => navigate(`/planner/ready?service=${svc}`) : undefined}
            style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
              fontSize: 13, padding: '5px 0', borderBottom: '1px solid #f1f5f9',
              cursor: svc ? 'pointer' : 'default',
            }}
            title={svc ? 'Open in Ready Now' : undefined}
          >
            <span style={{ color: '#1e293b', fontWeight: isLate ? 600 : 400, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {j.bm_task_name}
              
            </span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
              {j.service && <span style={{ color: '#94a3b8', fontSize: 12 }}>{j.service}</span>}
              {j.bm_status && !/^no latest action$/i.test(j.bm_status) && <Badge bg="#f1f5f9" color="#64748b">{j.bm_status}</Badge>}
              <span style={{ color: isLate ? '#dc2626' : '#64748b', fontWeight: isLate ? 700 : 400, fontFamily: 'monospace', fontSize: 12 }}>
                {j.bm_deadline
                  ? isLate
                    ? `${late}d late · due ${new Date(j.bm_deadline).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
                    : `due ${new Date(j.bm_deadline).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
                  : 'no deadline'}
              </span>
            </div>
          </div>
        );
      })}
      {jobs.length > 8 && (
        <button
          onClick={() => setShowAll((v) => !v)}
          style={{ marginTop: 8, fontSize: 13, color: '#1E4560', fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: "'Outfit', sans-serif" }}
        >
          {showAll ? 'Show fewer' : `Show all ${jobs.length}`}
        </button>
      )}
    </div>
  );
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
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: '16px 20px', background: '#fffbeb', borderColor: '#fde68a', fontFamily: "'Outfit', sans-serif" }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', margin: 0 }}>Needs a look: contact email</h3>
        <span style={{ fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: m.bg, color: m.fg }}>{m.label}</span>
      </div>
      <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 10px 0' }}>{m.msg}</p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 14 }}>
        <div>
          <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 2 }}>BM contact email</div>
          <div style={{ fontFamily: 'monospace', fontSize: 13, color: recon.bm_contact_email ? '#1e293b' : '#cbd5e1' }}>{recon.bm_contact_email || '—'}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 2 }}>QBO billing email(s)</div>
          <div style={{ fontFamily: 'monospace', fontSize: 13, color: qbo.length ? '#1e293b' : '#cbd5e1', wordBreak: 'break-word' }}>{qbo.length ? qbo.join(', ') : '—'}</div>
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
      <h4 style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 8 }}>
        Fee earner allocation
      </h4>
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr', gap: 8, fontSize: 12, color: '#94a3b8', paddingBottom: 4, borderBottom: '1px solid #f1f5f9' }}>
        <span>Service</span>
        <span>Fee earner</span>
        <span>Fee earner manager</span>
      </div>
      {serviceIds.map((sid) => {
        const a = byService[sid] || {};
        return (
          <div key={sid} style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f8fafc' }}>
            <span style={{ fontSize: 13, color: '#1e293b', fontWeight: 500 }}>{sid}</span>
            <select
              value={a.fee_earner_id || ''}
              onChange={(e) => persist(sid, { fee_earner_id: e.target.value || null })}
              style={allocSelectStyle}
            >
              <option value="">— unassigned —</option>
              {staff.filter((s) => s.is_active !== false || s.id === a.fee_earner_id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select
              value={a.fee_earner_manager_id || ''}
              onChange={(e) => persist(sid, { fee_earner_manager_id: e.target.value || null })}
              style={allocSelectStyle}
            >
              <option value="">— unassigned —</option>
              {staff.filter((s) => s.is_active !== false || s.id === a.fee_earner_manager_id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        );
      })}
    </div>
  );
}

const allocSelectStyle = {
  fontSize: 13, padding: '4px 6px',
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
const CADENCE_OPTIONS = [
  { value: 'early',  label: 'Early',  bg: '#ecfdf5', color: '#15803d', hint: 'Shift scheduled work one week earlier than the task-type default' },
  { value: 'normal', label: 'Normal', bg: '#f1f5f9', color: '#475569', hint: 'Use the task-type default slot as-is' },
  { value: 'late',   label: 'Late',   bg: '#fffbeb', color: '#b45309', hint: 'Shift scheduled work one week later than the task-type default' },
];

function StatusChip({ value }) {
  const s = STATUS_OPTIONS.find((o) => o.value === value) || STATUS_OPTIONS[0];
  return (
    <span style={{ fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 999, background: s.bg, color: s.color, whiteSpace: 'nowrap' }}>
      {s.label}
    </span>
  );
}

// "More" menu in the header: the settings that used to be tiny chips beside
// the name (status, cadence, expedite) as labelled controls, plus the two
// rarely-used, consequential actions (no longer a client, archive).
function MoreMenu({ entity, busy, onStatus, onCadence, onExpedite, onOffboard, onReinstate, onArchive }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  const cadence = CADENCE_OPTIONS.find((o) => o.value === (entity.cadence_preference || 'normal')) || CADENCE_OPTIONS[1];
  const isArchived = entity.entity_status === 'archived';
  const label = { display: 'block', fontSize: 12.5, fontWeight: 600, color: '#64748b', marginBottom: 5 };
  const select = { width: '100%', padding: '7px 10px', fontSize: 14, border: '1px solid #e5e7eb', borderRadius: 8, outline: 'none', fontFamily: "'Outfit', sans-serif", background: '#fff' };
  const action = (danger) => ({
    display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', fontSize: 14, fontWeight: 500,
    border: 'none', borderRadius: 8, background: 'none', cursor: busy ? 'wait' : 'pointer',
    color: danger ? '#b91c1c' : '#1E4560', fontFamily: "'Outfit', sans-serif",
  });
  const run = (fn) => { setOpen(false); fn(); };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <Btn variant="secondary" onClick={() => setOpen((v) => !v)}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>More <ChevronDown size={15} /></span>
      </Btn>
      {open && (
        <div role="menu" style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 30, width: 290, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, boxShadow: '0 12px 32px rgba(15,23,42,0.14)', padding: 14 }}>
          <label style={label}>Status</label>
          <select value={entity.entity_status || 'active'} onChange={(e) => onStatus(e.target.value)} style={{ ...select, marginBottom: 12 }}>
            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>

          <label style={label}>Scheduling</label>
          <select value={cadence.value} onChange={(e) => onCadence(e.target.value)} style={select}>
            {CADENCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <p style={{ fontSize: 12.5, color: '#94a3b8', margin: '5px 0 12px' }}>{cadence.hint}.</p>

          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 14, color: '#0f172a', cursor: 'pointer' }}>
            <input type="checkbox" checked={!!entity.expedite} onChange={(e) => onExpedite(e.target.checked)} style={{ marginTop: 3 }} />
            <span>Expedite<span style={{ display: 'block', fontSize: 12.5, color: '#94a3b8' }}>Prioritise their work after period end.</span></span>
          </label>

          <div style={{ borderTop: '1px solid #f1f5f9', margin: '12px -14px 8px' }} />
          {entity.entity_status === 'nlac'
            ? <button disabled={busy} onClick={() => run(onReinstate)} style={action(false)}>Reinstate as a client</button>
            : <button disabled={busy} onClick={() => run(onOffboard)} style={action(true)} title="Removes them from views and queues the BrightManager change for Admin">No longer a client…</button>}
          <button disabled={busy} onClick={() => run(onArchive)} style={action(!isArchived)} title={isArchived ? 'Restore this client to the active list' : 'Hides it from the list, keeps its records'}>
            {isArchived ? 'Restore from archive' : 'Archive…'}
          </button>
        </div>
      )}
    </div>
  );
}

function CopyButton({ value }) {
  const [done, setDone] = useState(false);
  if (!value) return null;
  const copy = async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1400); } catch { /* clipboard blocked */ }
  };
  return (
    <button onClick={copy} title={done ? 'Copied' : 'Copy'} aria-label="Copy" style={{ display: 'inline-flex', padding: 3, border: 'none', background: 'none', cursor: 'pointer', color: done ? '#059669' : '#94a3b8', flexShrink: 0 }}>
      {done ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

// No contact email from BrightManager or QuickBooks — let staff add one
// (stored on entities.prospect_email, as the old Details card did).
function EditableContactEmail({ entity, setEntity, profile }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '6px 12px', alignItems: 'center' }}>
      <EditableRow label="Email" field="prospect_email" entity={entity} setEntity={setEntity} profile={profile} placeholder="client@example.com" />
    </div>
  );
}

const wrapStyle = { margin: '0 auto', padding: '28px 32px', fontFamily: "'Outfit', sans-serif" };
const cardStyle = { background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '18px 22px' };
const sectionTitle = { fontFamily: "'Outfit', sans-serif", fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 12, marginTop: 0 };
