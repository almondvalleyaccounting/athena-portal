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
  const [loading, setLoading] = useState(true);
  const [timePeriod, setTimePeriod] = useState('12');
  const [changeTaskText, setChangeTaskText] = useState('');
  const [actionAssignee, setActionAssignee] = useState('');
  const [taskCreating, setTaskCreating] = useState(false);
  const [taskCreated, setTaskCreated] = useState(false);
  const [activeSection, setActiveSection] = useState(null); // for tile click expansion

  useEffect(() => {
    (async () => {
      try {
        const results = await Promise.allSettled([
          supabase.from('entities').select('*').eq('id', id).single(),
          supabase.from('live_billing').select('*').eq('entity_id', id).order('service_description'),
          supabase.from('quotes').select('id, quote_ref, status, monthly_gross, annual_total, created_at, relationship_group').eq('entity_id', id).order('created_at', { ascending: false }),
          supabase.from('quick_tasks').select('*').eq('entity_id', id).order('created_at', { ascending: false }),
          supabase.from('scheduled_tasks').select('*').eq('entity_id', id).order('title'),
          supabase.from('completed_tasks').select('*').eq('entity_id', id).order('completed_at', { ascending: false }),
          supabase.from('issues_log').select('*').eq('entity_id', id).order('created_at', { ascending: false }),
          supabase.from('billing_items').select('*').eq('entity_id', id).order('created_at', { ascending: false }),
          supabase.from('staff_profiles').select('id, name, email').order('name'),
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

  if (loading) return <div style={wrapStyle}><p style={{ color: '#94a3b8', fontSize: 13 }}>Loading client...</p></div>;
  if (!entity) return <div style={wrapStyle}><p style={{ color: '#ef4444', fontSize: 13 }}>Client not found.</p></div>;

  const totalMonthly = billing.reduce((s, b) => s + (parseFloat(b.monthly_fee) || 0), 0);
  const totalAnnual = totalMonthly * 12;
  const activeQuotes = quotes.filter((q) => ['accepted', 'sent', 'approved'].includes(q.status));
  const openIssues = issues.filter((i) => !['resolved', 'closed'].includes(i.status));
  const totalCompleted = filteredCompleted.reduce((s, t) => s + (t.completion_mins || 0), 0);
  const pendingBilling = billingItems.filter((b) => b.status === 'draft' || b.status === 'pending_approval');
  const fmt = (n) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2 }).format(n || 0);
  const durFmt = (mins) => { if (!mins) return '0h'; const h = Math.floor(mins / 60); const m = mins % 60; return m ? `${h}h ${m}m` : `${h}h`; };

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
            <Badge bg={entity.entity_status === 'prospect' ? '#eff6ff' : entity.entity_status === 'active' ? '#f0fdf4' : '#f1f5f9'} color={entity.entity_status === 'prospect' ? '#0e7fe0' : entity.entity_status === 'active' ? '#15803d' : '#64748b'}>{entity.entity_status || 'active'}</Badge>
          </div>
        </div>
        {/* Time period filter */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase' }}>Time</span>
          <select value={timePeriod} onChange={(e) => setTimePeriod(e.target.value)} style={{ padding: '5px 10px', fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 6, outline: 'none', fontFamily: "'Outfit', sans-serif" }}>
            {TIME_PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
      </div>

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
          {billing.length > 0 ? (
            <>
              <div style={{ display: 'flex', gap: 20, marginBottom: 12 }}>
                <div><div style={{ fontSize: 10, color: '#94a3b8' }}>Monthly</div><div style={{ fontSize: 20, fontWeight: 700, color: '#0f172a' }}>{fmt(totalMonthly)}</div></div>
                <div><div style={{ fontSize: 10, color: '#94a3b8' }}>Annual</div><div style={{ fontSize: 20, fontWeight: 700, color: '#0f172a' }}>{fmt(totalAnnual)}</div></div>
              </div>
              {billing.map((b) => (
                <div key={b.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 0', borderBottom: '1px solid #f1f5f9' }}>
                  <span style={{ color: '#1e293b' }}>{b.service_description || 'Service'}</span>
                  <span style={{ fontWeight: 500 }}>{fmt(b.monthly_fee)}/mo</span>
                </div>
              ))}
            </>
          ) : <p style={{ fontSize: 13, color: '#cbd5e1' }}>No active billing.</p>}
        </div>
      )}

      {activeSection === 'quotes' && (
        <div style={{ ...cardStyle, marginBottom: 20 }}>
          <h3 style={sectionTitle}>Quotes ({quotes.length})</h3>
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
            {entity.company_number && <DetailRow label="Company No." value={entity.company_number} />}
            {entity.utr && <DetailRow label="UTR" value={entity.utr} />}
            {entity.vat_number && <DetailRow label="VAT Number" value={entity.vat_number} />}
            {entity.paye_ref && <DetailRow label="PAYE Ref" value={entity.paye_ref} />}
            {entity.manager && <DetailRow label="Manager" value={entity.manager} />}
            {entity.prospect_email && <DetailRow label="Email" value={entity.prospect_email} />}
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

function Badge({ bg, color, children }) {
  return <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 6, background: bg, color, textTransform: 'capitalize', fontFamily: "'Outfit', sans-serif" }}>{children}</span>;
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
