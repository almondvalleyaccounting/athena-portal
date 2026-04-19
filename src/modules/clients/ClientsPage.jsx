import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, Building2, User } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import NewClientModal from '../../components/NewClientModal';

/* ─── Clients list page ────────────────────────────────────── */
export default function ClientsPage() {
  const navigate = useNavigate();
  const [entities, setEntities] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [showNewClient, setShowNewClient] = useState(false);

  const loadEntities = async () => {
    try {
      const { data, error } = await supabase
        .from('entities')
        .select('id, name, type, entity_status, company_number, manager, prospect_email, source, created_at')
        .order('name', { ascending: true });
      if (error) {
        console.error('[Clients] load error:', error.message);
        setEntities([]);
      } else {
        setEntities(data || []);
      }
    } catch (e) {
      console.error('[Clients] load threw:', e);
      setEntities([]);
    }
    setLoading(false);
  };

  useEffect(() => { loadEntities(); }, []);

  const filtered = entities.filter((e) =>
    !search ||
    e.name?.toLowerCase().includes(search.toLowerCase()) ||
    e.company_number?.toLowerCase().includes(search.toLowerCase()) ||
    e.manager?.toLowerCase().includes(search.toLowerCase())
  );

  // Group by source
  const athenaClients = filtered.filter((e) => e.source === 'athena');
  const bmClients = filtered.filter((e) => e.source !== 'athena');

  const handleNewClient = async (fields) => {
    const { data, error } = await supabase
      .from('entities')
      .insert({
        name: fields.name,
        type: fields.type || 'limited_company',
        entity_status: fields.entity_status || fields.status || 'prospect',
        prospect_email: fields.prospect_email || null,
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
    };
    const st = styles[s] || styles.active;
    return (
      <span style={{
        fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 6,
        background: st.bg, color: st.color, fontFamily: "'Outfit', sans-serif",
        textTransform: 'capitalize',
      }}>
        {s}
      </span>
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

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '32px 24px', fontFamily: "'Outfit', sans-serif" }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 4 }}>
            Clients
          </h1>
          <p style={{ fontSize: 13, color: '#64748b' }}>
            {entities.length} clients{athenaClients.length > 0 && ` · ${athenaClients.length} created in Athena`}
          </p>
        </div>
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

      {loading ? (
        <p style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: 40 }}>Loading clients...</p>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb' }}>
          <p style={{ fontSize: 15, fontWeight: 500, color: '#94a3b8', marginBottom: 4 }}>
            {entities.length === 0 ? 'No clients yet' : 'No matches'}
          </p>
          <p style={{ fontSize: 13, color: '#cbd5e1' }}>
            {entities.length === 0 ? 'Add a client or import from BrightManager.' : 'Try a different search term.'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {filtered.map((e) => (
            <div
              key={e.id}
              onClick={() => navigate(`/clients/${e.id}`)}
              style={{
                display: 'flex', alignItems: 'center', gap: 14,
                padding: '14px 18px', background: '#fff', borderRadius: 12,
                border: '1px solid #e5e7eb', cursor: 'pointer',
                transition: 'all 0.2s ease',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.05)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none'; }}
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
              {statusBadge(e.entity_status)}
            </div>
          ))}
        </div>
      )}

      <NewClientModal
        open={showNewClient}
        onClose={() => setShowNewClient(false)}
        onSave={handleNewClient}
      />
    </div>
  );
}
