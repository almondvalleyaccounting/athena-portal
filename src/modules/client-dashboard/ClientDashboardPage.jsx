import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  RefreshCw, AlertCircle, CheckCircle, Loader, ShieldCheck,
  ShieldAlert, TrendingUp, Link2Off, Plus, X,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { getReportsAuthUrl } from '../../lib/qboApi';
import { useAuth } from '../../shell/AppShell';

/*
  Client Dashboard from QuickBooks — Phase A.
  Staff pick a connected client; we pull a slice of live figures via the
  dashboard-qbo-pull edge function (cached + refresh). Metrics so far:
    - company      → name / country
    - pl_summary   → last-12-months P&L headline
    - file_health  → bookkeeping-quality traffic light
  More figures are added by extending METRICS in the edge function + a card here.
*/

/* ─── Formatting helpers ───────────────────────────────────────── */
function money(v, currency = 'GBP') {
  if (v === null || v === undefined || isNaN(v)) return '—';
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency', currency, maximumFractionDigits: 0,
    }).format(v);
  } catch {
    return `£${Math.round(v).toLocaleString('en-GB')}`;
  }
}
function timeAgo(iso) {
  if (!iso) return '';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
  return `${Math.floor(secs / 86400)} d ago`;
}

const HEALTH_COLORS = {
  green: { dot: '#22c55e', bg: '#f0fdf4', border: '#bbf7d0', text: '#166534', label: 'Clean' },
  amber: { dot: '#f59e0b', bg: '#fffbeb', border: '#fde68a', text: '#92400e', label: 'Needs a look' },
  red:   { dot: '#ef4444', bg: '#fef2f2', border: '#fecaca', text: '#991b1b', label: 'Attention' },
};

/* ─── Page ─────────────────────────────────────────────────────── */
export default function ClientDashboardPage() {
  const { profile } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [clients, setClients] = useState([]);
  const [clientsLoading, setClientsLoading] = useState(true);
  const [realmId, setRealmId] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(null);

  const loadClients = async () => {
    try {
      const { data, error } = await supabase
        .from('qbo_report_connections')
        .select('realm_id, company_name')
        .eq('status', 'active')
        .order('company_name');
      if (!error && data) setClients(data);
    } catch { /* silent */ }
    setClientsLoading(false);
  };

  useEffect(() => { loadClients(); }, []);

  // Handle the OAuth return (?qbo=connected|error) after a Connect round-trip.
  useEffect(() => {
    const qbo = searchParams.get('qbo');
    if (qbo === 'connected') {
      setFlash({ type: 'success', message: 'Client connected. Select them to pull live figures.' });
      loadClients();
    } else if (qbo === 'error') {
      setFlash({ type: 'error', message: searchParams.get('message') || 'Connection failed.' });
    }
    if (qbo) {
      searchParams.delete('qbo');
      searchParams.delete('message');
      setSearchParams(searchParams, { replace: true });
    }
  }, []);

  const handleConnect = () => {
    window.location.href = getReportsAuthUrl(profile?.id || '', '/client-dashboard');
  };

  const load = async (realm, refresh = false) => {
    if (!realm) return;
    setLoading(true);
    setError(null);
    try {
      const { data: payload, error: fnErr } = await supabase.functions.invoke('dashboard-qbo-pull', {
        body: { realmId: realm, refresh },
      });
      if (fnErr) { setError(fnErr.message || 'Request failed'); setData(null); }
      else setData(payload);
    } catch (e) {
      setError(e.message || 'Request failed');
      setData(null);
    }
    setLoading(false);
  };

  const onSelect = (realm) => { setRealmId(realm); setData(null); setError(null); if (realm) load(realm, false); };

  const selectedName = clients.find((c) => c.realm_id === realmId)?.company_name || '';
  const metrics = data?.metrics || {};
  const company = metrics.company;
  const pl = metrics.pl_summary;
  const health = metrics.file_health;

  // A realm with no stored tokens → every metric errors with the same reconnect message.
  const errs = data?.errors ? Object.values(data.errors) : [];
  const needsReconnect = errs.length > 0 && errs.every((e) => /reconnect/i.test(e));

  return (
    <div style={{ maxWidth: '860px', margin: '0 auto', padding: '40px 24px' }}>
      <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: '28px', fontWeight: 500, color: '#0f172a', marginBottom: '8px' }}>
        Client Dashboard
      </h1>
      <p style={{ fontFamily: "'Outfit', sans-serif", fontSize: '14px', color: '#64748b', marginBottom: '28px' }}>
        Live figures and bookkeeping health pulled from the client's QuickBooks.
      </p>

      {/* Flash (OAuth return) */}
      {flash && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px',
          borderRadius: '10px', marginBottom: '16px',
          backgroundColor: flash.type === 'success' ? '#f0fdf4' : '#fef2f2',
          border: `1px solid ${flash.type === 'success' ? '#bbf7d0' : '#fecaca'}`,
        }}>
          {flash.type === 'success'
            ? <CheckCircle size={16} style={{ color: '#22c55e' }} />
            : <AlertCircle size={16} style={{ color: '#ef4444' }} />}
          <span style={{ fontFamily: "'Outfit', sans-serif", fontSize: '13px', fontWeight: 500, flex: 1, color: flash.type === 'success' ? '#166534' : '#991b1b' }}>
            {flash.message}
          </span>
          <button onClick={() => setFlash(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px' }}>
            <X size={14} style={{ color: '#94a3b8' }} />
          </button>
        </div>
      )}

      {/* Client selector + refresh + connect */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '24px' }}>
        <select
          value={realmId}
          onChange={(e) => onSelect(e.target.value)}
          disabled={clientsLoading}
          style={{ ...inputStyle, flex: 1, appearance: 'auto' }}
        >
          <option value="">{clientsLoading ? 'Loading clients…' : 'Select a client…'}</option>
          {clients.map((c) => (
            <option key={c.realm_id} value={c.realm_id}>{c.company_name}</option>
          ))}
        </select>
        {realmId && (
          <button
            onClick={() => load(realmId, true)}
            disabled={loading}
            title="Refresh from QuickBooks"
            style={{
              display: 'flex', alignItems: 'center', gap: '6px', padding: '0 16px',
              border: '1px solid #e5e7eb', borderRadius: '10px', backgroundColor: '#ffffff',
              cursor: loading ? 'not-allowed' : 'pointer', fontFamily: "'Outfit', sans-serif",
              fontSize: '13px', fontWeight: 600, color: '#38bdf8', flexShrink: 0, whiteSpace: 'nowrap',
            }}
          >
            <RefreshCw size={14} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
            Refresh
          </button>
        )}
        <button
          onClick={handleConnect}
          title="Connect a QuickBooks client"
          style={{
            display: 'flex', alignItems: 'center', gap: '6px', padding: '0 16px',
            border: '1px solid #e5e7eb', borderRadius: '10px', backgroundColor: '#ffffff',
            cursor: 'pointer', fontFamily: "'Outfit', sans-serif", fontSize: '13px',
            fontWeight: 600, color: '#38bdf8', flexShrink: 0, whiteSpace: 'nowrap',
          }}
        >
          <Plus size={14} /> Connect
        </button>
      </div>

      {/* Loading */}
      {loading && !data && (
        <div style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#0369a1' }}>
            <Loader size={16} style={{ animation: 'spin 1s linear infinite' }} />
            <span style={{ fontFamily: "'Outfit', sans-serif", fontSize: '14px', fontWeight: 600 }}>
              Pulling {selectedName} from QuickBooks…
            </span>
          </div>
        </div>
      )}

      {/* Hard error (auth / network) */}
      {error && (
        <div style={{ ...cardStyle, backgroundColor: '#fef2f2', border: '1px solid #fecaca' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#991b1b', fontFamily: "'Outfit', sans-serif", fontSize: '13px', fontWeight: 600 }}>
            <AlertCircle size={16} /> {error}
          </div>
        </div>
      )}

      {/* Needs reconnect */}
      {needsReconnect && (
        <div style={{ ...cardStyle, backgroundColor: '#fffbeb', border: '1px solid #fde68a' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
            <Link2Off size={18} style={{ color: '#d97706', flexShrink: 0, marginTop: '1px' }} />
            <div>
              <div style={{ fontFamily: "'Outfit', sans-serif", fontSize: '14px', fontWeight: 700, color: '#92400e', marginBottom: '4px' }}>
                {selectedName} needs to reconnect QuickBooks
              </div>
              <div style={{ fontFamily: "'Outfit', sans-serif", fontSize: '13px', color: '#92400e' }}>
                This client was connected for Reports before the dashboard stored access tokens.
                Reconnect them (Reports → Connect) to pull live figures here.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Data */}
      {data && !needsReconnect && (company || pl || health) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Company + last updated */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontFamily: "'Playfair Display', serif", fontSize: '20px', color: '#0f172a' }}>
              {company?.name || selectedName}
              {company?.country && (
                <span style={{ fontFamily: "'Outfit', sans-serif", fontSize: '12px', color: '#94a3b8', marginLeft: '8px' }}>
                  {company.country}
                </span>
              )}
            </div>
            <span style={{ fontFamily: "'Outfit', sans-serif", fontSize: '12px', color: '#94a3b8' }}>
              {data.cached ? 'Cached' : 'Fresh'} · {timeAgo(data.pulled_at)}
            </span>
          </div>

          {/* File health */}
          {health && <FileHealthCard health={health} currency={pl?.currency} />}

          {/* P&L headline */}
          {pl && <PlCard pl={pl} />}

          {/* Per-metric errors (partial) */}
          {data.errors && (
            <div style={{ fontFamily: "'Outfit', sans-serif", fontSize: '12px', color: '#b45309' }}>
              Some figures couldn't be pulled: {Object.entries(data.errors).map(([k, v]) => `${k} (${v})`).join('; ')}
            </div>
          )}
        </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

/* ─── File Health card ─────────────────────────────────────────── */
function FileHealthCard({ health, currency }) {
  const c = HEALTH_COLORS[health.score] || HEALTH_COLORS.amber;
  const rows = [
    ['Uncategorised', health.uncategorised_total],
    ['Undeposited funds', health.undeposited_funds],
    ['Opening balance equity', health.opening_balance_equity],
    ['Ask My Accountant', health.ask_my_accountant],
    ['Reconciliation discrepancies', health.reconciliation_discrepancies],
  ];
  return (
    <div style={{ ...cardStyle, backgroundColor: c.bg, border: `1px solid ${c.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
        {health.score === 'green'
          ? <ShieldCheck size={20} style={{ color: c.dot }} />
          : <ShieldAlert size={20} style={{ color: c.dot }} />}
        <span style={{ fontFamily: "'Outfit', sans-serif", fontSize: '15px', fontWeight: 700, color: c.text }}>
          Bookkeeping health — {c.label}
        </span>
        <span style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: c.dot, marginLeft: 'auto' }} />
      </div>

      {health.flags?.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '14px' }}>
          {health.flags.map((f) => (
            <span key={f} style={{
              fontFamily: "'Outfit', sans-serif", fontSize: '12px', fontWeight: 600, color: c.text,
              backgroundColor: '#ffffff', border: `1px solid ${c.border}`, borderRadius: '8px', padding: '3px 10px',
            }}>{f}</span>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px' }}>
        {rows.map(([label, val]) => (
          <div key={label} style={{ backgroundColor: '#ffffff', borderRadius: '10px', padding: '10px 12px', border: '1px solid rgba(0,0,0,0.04)' }}>
            <div style={{ fontFamily: "'Outfit', sans-serif", fontSize: '11px', color: '#94a3b8', marginBottom: '2px' }}>{label}</div>
            <div style={{ fontFamily: "'Outfit', sans-serif", fontSize: '16px', fontWeight: 700, color: Math.abs(val || 0) > 0.005 ? c.text : '#0f172a' }}>
              {money(val, currency)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── P&L card ─────────────────────────────────────────────────── */
function PlCard({ pl }) {
  const cur = pl.currency || 'GBP';
  const tiles = [
    ['Income', pl.income, '#0f172a'],
    ['Gross profit', pl.gross_profit, '#0f172a'],
    ['Expenses', pl.expenses, '#0f172a'],
    ['Net income', pl.net_income, (pl.net_income || 0) >= 0 ? '#166534' : '#991b1b'],
  ];
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
        <TrendingUp size={18} style={{ color: '#38bdf8' }} />
        <span style={{ fontFamily: "'Outfit', sans-serif", fontSize: '15px', fontWeight: 700, color: '#0f172a' }}>
          Profit &amp; Loss — last 12 months
        </span>
        {pl.period && (
          <span style={{ fontFamily: "'Outfit', sans-serif", fontSize: '12px', color: '#94a3b8', marginLeft: 'auto' }}>
            {pl.period.start} → {pl.period.end}
          </span>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px' }}>
        {tiles.map(([label, val, color]) => (
          <div key={label} style={{ backgroundColor: '#f8fafc', borderRadius: '10px', padding: '14px 16px' }}>
            <div style={{ fontFamily: "'Outfit', sans-serif", fontSize: '12px', color: '#94a3b8', marginBottom: '4px' }}>{label}</div>
            <div style={{ fontFamily: "'Outfit', sans-serif", fontSize: '22px', fontWeight: 700, color }}>{money(val, cur)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Shared styles ────────────────────────────────────────────── */
const cardStyle = {
  backgroundColor: '#ffffff',
  borderRadius: '12px',
  border: '1px solid #e5e7eb',
  padding: '20px 24px',
};
const inputStyle = {
  border: '1px solid #e5e7eb',
  borderRadius: '10px',
  padding: '10px 14px',
  fontSize: '14px',
  fontFamily: "'Outfit', sans-serif",
  outline: 'none',
  boxSizing: 'border-box',
};
