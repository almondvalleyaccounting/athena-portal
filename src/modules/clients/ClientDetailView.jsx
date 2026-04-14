import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ChevronLeft, AlertCircle } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';

/* ─── Client detail view ──────────────────────────────────── */
export default function ClientDetailView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [entity, setEntity] = useState(null);
  const [billing, setBilling] = useState([]);
  const [loading, setLoading] = useState(true);
  const [changeTaskText, setChangeTaskText] = useState('');
  const [taskCreating, setTaskCreating] = useState(false);
  const [taskCreated, setTaskCreated] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [{ data: ent }, { data: bills }] = await Promise.all([
          supabase.from('entities').select('*').eq('id', id).single(),
          supabase.from('live_billing').select('*').eq('entity_id', id).order('service_description'),
        ]);
        setEntity(ent);
        setBilling(bills || []);
      } catch (e) {
        console.error('[ClientDetail] load error:', e);
      }
      setLoading(false);
    })();
  }, [id]);

  const handleRaiseChangeTask = async () => {
    if (!changeTaskText.trim() || taskCreating) return;
    setTaskCreating(true);
    try {
      await supabase.from('quick_tasks').insert({
        title: `Change: ${entity.name} — ${changeTaskText.trim()}`,
        entity_id: entity.id,
        service: 'Admin',
        assignee_id: profile?.id || null,
        due_date: new Date(Date.now() + 5 * 86400000).toISOString(),
        planned_date: null,
        duration: 15,
        notes: `Raised from client page.\n${changeTaskText.trim()}`,
        sort_order: 0,
        created_by: profile?.id,
      });
      setChangeTaskText('');
      setTaskCreated(true);
      setTimeout(() => setTaskCreated(false), 3000);
    } catch (e) {
      console.error('[ClientDetail] change task error:', e);
    }
    setTaskCreating(false);
  };

  if (loading) return <div style={wrapStyle}><p style={{ color: '#94a3b8', fontSize: 13 }}>Loading client...</p></div>;
  if (!entity) return <div style={wrapStyle}><p style={{ color: '#ef4444', fontSize: 13 }}>Client not found.</p></div>;

  const totalMonthly = billing.reduce((s, b) => s + (parseFloat(b.monthly_fee) || 0), 0);
  const totalAnnual = totalMonthly * 12;

  const fmt = (n) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2 }).format(n);

  return (
    <div style={wrapStyle}>
      {/* Back + Header */}
      <button
        onClick={() => navigate('/clients')}
        style={{
          display: 'flex', alignItems: 'center', gap: 4, background: 'none',
          border: 'none', cursor: 'pointer', color: '#64748b', fontSize: 13,
          fontFamily: "'Outfit', sans-serif", marginBottom: 16, padding: 0,
        }}
      >
        <ChevronLeft size={16} /> Back to Clients
      </button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 4 }}>
            {entity.name}
          </h1>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: '#64748b' }}>
            <span style={{ textTransform: 'capitalize' }}>{entity.type?.replace('_', ' ') || 'Unknown'}</span>
            {entity.source === 'athena' && (
              <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 4, background: '#dbeafe', color: '#0e7fe0' }}>
                Created in Athena
              </span>
            )}
            {entity.status && (
              <span style={{
                fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 6,
                background: entity.status === 'prospect' ? '#eff6ff' : entity.status === 'active' ? '#f0fdf4' : '#f1f5f9',
                color: entity.status === 'prospect' ? '#0e7fe0' : entity.status === 'active' ? '#15803d' : '#64748b',
                textTransform: 'capitalize',
              }}>
                {entity.status}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Info cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 28 }}>
        {/* Client Details */}
        <div style={cardStyle}>
          <h3 style={sectionTitle}>Client Details</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', fontSize: 13 }}>
            <DetailRow label="Name" value={entity.name} />
            <DetailRow label="Type" value={entity.type?.replace('_', ' ')} />
            {entity.company_number && <DetailRow label="Company Number" value={entity.company_number} />}
            {entity.utr && <DetailRow label="UTR" value={entity.utr} />}
            {entity.vat_number && <DetailRow label="VAT Number" value={entity.vat_number} />}
            {entity.paye_ref && <DetailRow label="PAYE Ref" value={entity.paye_ref} />}
            {entity.manager && <DetailRow label="Manager" value={entity.manager} />}
            {entity.prospect_email && <DetailRow label="Email" value={entity.prospect_email} />}
            {entity.source && <DetailRow label="Source" value={entity.source === 'athena' ? 'Athena (manual)' : 'BrightManager'} />}
          </div>
        </div>

        {/* Billing Summary */}
        <div style={cardStyle}>
          <h3 style={sectionTitle}>Billing</h3>
          {billing.length > 0 ? (
            <>
              <div style={{ display: 'flex', gap: 20, marginBottom: 16 }}>
                <div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>Monthly</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#0f172a' }}>{fmt(totalMonthly)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>Annual</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#0f172a' }}>{fmt(totalAnnual)}</div>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {billing.map((b) => (
                  <div key={b.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 0', borderBottom: '1px solid #f1f5f9' }}>
                    <span style={{ color: '#1e293b' }}>{b.service_description || 'Service'}</span>
                    <span style={{ fontWeight: 500, color: '#0f172a' }}>{fmt(b.monthly_fee)}/mo</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p style={{ fontSize: 13, color: '#cbd5e1' }}>No active billing.</p>
          )}
        </div>
      </div>

      {/* Raise Change Task */}
      <div style={cardStyle}>
        <h3 style={sectionTitle}>Raise Change Task</h3>
        <p style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
          Create a quick task in the Work Planner for changes needed on this client (e.g. address update, new service, contact change).
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            value={changeTaskText}
            onChange={(e) => setChangeTaskText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRaiseChangeTask(); }}
            placeholder="e.g. Update registered address to..."
            disabled={taskCreating}
            style={{
              flex: 1, padding: '10px 14px', fontSize: 13, border: '1px solid #e5e7eb',
              borderRadius: 10, outline: 'none', fontFamily: "'Outfit', sans-serif",
              transition: 'border-color 0.2s',
            }}
            onFocus={(e) => (e.target.style.borderColor = '#38bdf8')}
            onBlur={(e) => (e.target.style.borderColor = '#e5e7eb')}
          />
          <button
            onClick={handleRaiseChangeTask}
            disabled={!changeTaskText.trim() || taskCreating}
            style={{
              padding: '10px 18px', fontSize: 13, fontWeight: 600,
              background: !changeTaskText.trim() || taskCreating ? '#e5e7eb' : '#0f172a',
              color: !changeTaskText.trim() || taskCreating ? '#94a3b8' : '#fff',
              border: 'none', borderRadius: 10, cursor: !changeTaskText.trim() || taskCreating ? 'not-allowed' : 'pointer',
              fontFamily: "'Outfit', sans-serif", transition: 'all 0.2s',
              flexShrink: 0,
            }}
          >
            {taskCreating ? 'Creating...' : 'Raise Task'}
          </button>
        </div>
        {taskCreated && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, marginTop: 10,
            fontSize: 12, color: '#059669', fontWeight: 500,
          }}>
            <AlertCircle size={14} /> Task created in Work Planner
          </div>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, value }) {
  if (!value) return null;
  return (
    <>
      <span style={{ fontSize: 12, color: '#94a3b8', fontFamily: "'Outfit', sans-serif" }}>{label}</span>
      <span style={{ fontSize: 13, color: '#0f172a', fontFamily: "'Outfit', sans-serif", fontWeight: 500 }}>{value}</span>
    </>
  );
}

const wrapStyle = {
  maxWidth: 900, margin: '0 auto', padding: '32px 24px', fontFamily: "'Outfit', sans-serif",
};

const cardStyle = {
  background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '20px 24px',
};

const sectionTitle = {
  fontFamily: "'Outfit', sans-serif", fontSize: 12, fontWeight: 600,
  textTransform: 'uppercase', color: '#94a3b8', letterSpacing: '0.03em',
  marginBottom: 14, marginTop: 0,
};
