import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, Building2, User } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import NewClientModal from '../../components/NewClientModal';
import AlphabetFilter, { firstCharBucket } from '../../components/AlphabetFilter';
import { fmtGbp } from '../../lib/money';
import { feeTotals } from './feeRollup';

/* ─── Clients list page ────────────────────────────────────── */
export default function ClientsPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  // Client fees are confidential — RLS returns no live_billing rows without
  // the flag, and we hide the column rather than show a misleading "—".
  const canSeeFees = profile?.can_view_client_fees === true;
  const [entities, setEntities] = useState([]);
  const [billingByEntity, setBillingByEntity] = useState({}); // entity_id → { monthly, annual, hasTemplate }
  const [search, setSearch] = useState('');
  const [letter, setLetter] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showNewClient, setShowNewClient] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const loadEntities = async () => {
    try {
      const [entitiesResp, billingResp] = await Promise.all([
        supabase
          .from('entities')
          .select('id, name, type, entity_status, company_number, manager, prospect_email, source, created_at')
          .order('name', { ascending: true }),
        supabase
          .from('live_billing')
          .select('entity_id, services, qbo_recurring_txn_id')
          .eq('status', 'active'),
      ]);
      if (entitiesResp.error) {
        console.error('[Clients] entities load error:', entitiesResp.error.message);
        setEntities([]);
      } else {
        setEntities(entitiesResp.data || []);
      }

      // Aggregate approved fees per entity — shared rules live in feeRollup.js.
      const rowsByEntity = {};
      for (const r of billingResp.data || []) {
        if (!r.entity_id) continue;
        (rowsByEntity[r.entity_id] = rowsByEntity[r.entity_id] || []).push(r);
      }
      const map = {};
      for (const [id, rows] of Object.entries(rowsByEntity)) map[id] = feeTotals(rows);
      setBillingByEntity(map);
    } catch (e) {
      console.error('[Clients] load threw:', e);
      setEntities([]);
    }
    setLoading(false);
  };

  useEffect(() => { loadEntities(); }, []);

  const filtered = entities.filter((e) => {
    if (letter && firstCharBucket(e.name) !== letter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      e.name?.toLowerCase().includes(q) ||
      e.company_number?.toLowerCase().includes(q) ||
      e.manager?.toLowerCase().includes(q)
    );
  });

  // Group by lifecycle status so prospects and signed-up clients are
  // visually separated. Archived clients are hidden unless toggled on.
  const statusOf = (e) => e.entity_status || 'active';
  const clientRows = filtered.filter((e) => statusOf(e) === 'active');
  const prospectRows = filtered.filter((e) => statusOf(e) === 'prospect');
  // Former (nlac) and archived clients are hidden by default — surfaced together
  // under the toggle. third_party etc. stay visible in "Other".
  const otherRows = filtered.filter((e) => !['active', 'prospect', 'archived', 'nlac'].includes(statusOf(e)));
  const hiddenRows = filtered.filter((e) => ['archived', 'nlac'].includes(statusOf(e)));
  const athenaCount = filtered.filter((e) => e.source === 'athena').length;
  const visibleCount = clientRows.length + prospectRows.length + otherRows.length + (showArchived ? hiddenRows.length : 0);

  const handleNewClient = async (fields) => {
    const { data, error } = await supabase
      .from('entities')
      .insert({
        name: fields.name,
        type: fields.type || 'limited_company',
        entity_status: fields.entity_status || fields.status || 'prospect',
        prospect_email: fields.prospect_email || null,
        prospect_phone: fields.prospect_phone || null,
        source: 'athena',
      })
      .select()
      .single();
    if (error) {
      console.error('[Clients] insert error:', error.message);
      throw error;
    }
    await loadEntities();
    return data;
  };

  const typeIcon = (type) => {
    if (type === 'sole_trader') return <User size={14} style={{ color: '#94a3b8' }} />;
    return <Building2 size={14} style={{ color: '#94a3b8' }} />;
  };

  const statusBadge = (status) => {
    const s = status || 'active';
    const styles = {
      active: { bg: '#f0fdf4', color: '#15803d' },
      prospect: { bg: '#eff6ff', color: '#0e7fe0' },
      inactive: { bg: '#f1f5f9', color: '#64748b' },
      archived: { bg: '#f1f5f9', color: '#64748b' },
      nlac: { bg: '#fef2f2', color: '#b91c1c' },
      third_party: { bg: '#f5f3ff', color: '#6d28d9' },
    };
    const st = styles[s] || styles.active;
    const label = s === 'nlac' ? 'Former client' : s.replace('_', ' ');
    return (
      <span style={{
        fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 6,
        background: st.bg, color: st.color, fontFamily: "'Outfit', sans-serif",
        textTransform: 'capitalize',
      }}>
        {label}
      </span>
    );
  };

  const FeesBlock = ({ fees }) => {
    const monthly = fees?.monthly || 0;
    const annual = fees?.annual || 0;
    if (monthly === 0 && annual === 0) {
      return (
        <div style={{ textAlign: 'right', minWidth: 100 }}>
          <div style={{ fontSize: 11, color: '#cbd5e1' }}>—</div>
        </div>
      );
    }
    return (
      <div style={{ textAlign: 'right', minWidth: 110 }} title="Approved fees, ex VAT">
        {monthly > 0 && (
          <div style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 600, color: '#0f172a' }}>
            {fmtGbp(monthly)}<span style={{ fontSize: 10, fontWeight: 500, color: '#94a3b8' }}> /mo</span>
          </div>
        )}
        {annual > 0 && (
          <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#0f766e' }}>
            {fmtGbp(annual)}<span style={{ fontSize: 10, color: '#94a3b8' }}> /yr</span>
          </div>
        )}
      </div>
    );
  };

  const sourceBadge = (source) => {
    if (source === 'athena') {
      return (
        <span style={{
          fontSize: 9, fontWeight: 600, padding: '1px 6px', borderRadius: 4,
          background: '#dbeafe', color: '#0e7fe0', fontFamily: "'Outfit', sans-serif",
        }}>
          Athena
        </span>
      );
    }
    return null;
  };

  const renderRow = (e) => (
    <div
      key={e.id}
      onClick={() => navigate(`/clients/${e.id}`)}
      style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '14px 18px', background: '#fff', borderRadius: 12,
        border: '1px solid #e5e7eb', cursor: 'pointer',
        transition: 'all 0.2s ease',
      }}
      onMouseEnter={(ev) => { ev.currentTarget.style.transform = 'translateY(-1px)'; ev.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.05)'; }}
      onMouseLeave={(ev) => { ev.currentTarget.style.transform = 'none'; ev.currentTarget.style.boxShadow = 'none'; }}
    >
      {typeIcon(e.type)}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 500, color: '#0f172a' }}>{e.name}</span>
          {sourceBadge(e.source)}
        </div>
        <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
          {e.type?.replace('_', ' ')}
          {e.company_number && ` · ${e.company_number}`}
          {e.manager && ` · ${e.manager}`}
        </div>
      </div>
      {canSeeFees && <FeesBlock fees={billingByEntity[e.id]} />}
      {statusBadge(e.entity_status)}
    </div>
  );

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '32px 24px', fontFamily: "'Outfit', sans-serif" }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 4 }}>
            Clients
          </h1>
          <p style={{ fontSize: 13, color: '#64748b' }}>
            {clientRows.length} clients · {prospectRows.length} prospects{athenaCount > 0 && ` · ${athenaCount} created in Athena`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => navigate('/clients/qbo-mapping')}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              backgroundColor: '#fff', color: '#0f172a',
              fontSize: 13, fontWeight: 500, border: '1px solid #e5e7eb', borderRadius: 10,
              padding: '10px 14px', cursor: 'pointer',
              fontFamily: "'Outfit', sans-serif",
            }}
          >
            QBO mapping
          </button>
          <button
            onClick={() => setShowNewClient(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              backgroundColor: '#0f172a', color: '#fff',
              fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 10,
              padding: '10px 18px', cursor: 'pointer', transition: 'all 0.2s ease',
              fontFamily: "'Outfit', sans-serif",
            }}
          >
            <Plus size={15} /> New Client
          </button>
        </div>
      </div>

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: 20 }}>
        <Search size={16} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, company number, or manager..."
          style={{
            width: '100%', padding: '11px 16px 11px 40px', fontSize: 14,
            border: '1px solid #e5e7eb', borderRadius: 10, outline: 'none',
            fontFamily: "'Outfit', sans-serif", transition: 'border-color 0.2s ease',
            boxSizing: 'border-box',
          }}
          onFocus={(e) => (e.target.style.borderColor = '#38bdf8')}
          onBlur={(e) => (e.target.style.borderColor = '#e5e7eb')}
        />
      </div>

      <AlphabetFilter items={entities} selected={letter} onChange={setLetter} />

      {loading ? (
        <p style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: 40 }}>Loading clients...</p>
      ) : visibleCount === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb' }}>
          <p style={{ fontSize: 15, fontWeight: 500, color: '#94a3b8', marginBottom: 4 }}>
            {entities.length === 0 ? 'No clients yet' : 'No matches'}
          </p>
          <p style={{ fontSize: 13, color: '#cbd5e1' }}>
            {entities.length === 0 ? 'Add a client or import from BrightManager.' : 'Try a different search term.'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <Section title="Clients" count={clientRows.length} rows={clientRows} renderRow={renderRow} />
          <Section title="Prospects" count={prospectRows.length} rows={prospectRows} renderRow={renderRow} />
          <Section title="Other" count={otherRows.length} rows={otherRows} renderRow={renderRow} />
          {showArchived && (
            <Section title="Former & archived" count={hiddenRows.length} rows={hiddenRows} renderRow={renderRow} />
          )}
        </div>
      )}

      {/* Former & archived toggle */}
      {hiddenRows.length > 0 && (
        <button
          onClick={() => setShowArchived((v) => !v)}
          style={{
            marginTop: 20, fontSize: 12, color: '#64748b', background: 'none',
            border: 'none', cursor: 'pointer', fontFamily: "'Outfit', sans-serif",
            textDecoration: 'underline',
          }}
        >
          {showArchived ? 'Hide former & archived' : `Show former & archived (${hiddenRows.length})`}
        </button>
      )}

      <NewClientModal
        open={showNewClient}
        onClose={() => setShowNewClient(false)}
        onSave={handleNewClient}
      />
    </div>
  );
}

// A titled group of client rows. Renders nothing when the group is empty
// so sections only appear when they have members.
function Section({ title, count, rows, renderRow }) {
  if (!rows || rows.length === 0) return null;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em', margin: 0 }}>
          {title}
        </h2>
        <span style={{ fontSize: 12, color: '#94a3b8' }}>{count}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map(renderRow)}
      </div>
    </div>
  );
}
