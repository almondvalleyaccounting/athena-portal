import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Star, Loader, AlertTriangle, Link2Off, ArrowRight } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import {
  money, timeAgo, latestByMetric,
  OUTFIT, PLAYFAIR, cardStyle,
} from './dashboardData';
import { Sparkline } from './DashboardCharts';

/*
  Portfolio Dashboard — the logged-in user's starred clients at a glance.

  Stars live in staff_client_favourites (RLS: own rows). Metrics come straight
  from qbo_dashboard_cache snapshots (no live pulls from this page — it must
  stay instant), matched to clients via qbo_report_connections.entity_id.
  Cards link into the full Client Dashboard via /client-dashboard?realm=…
*/

const BAD_CH_STATUS = /(strike|liquidat|administrat|insolven|dissolv|receiver)/i;

export default function PortfolioDashboardPage() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!profile?.id) return;
    setLoading(true);
    try {
      // 1. My starred clients (+ CH status from entities)
      const { data: favs } = await supabase
        .from('staff_client_favourites')
        .select('entity_id, created_at, entity:entities(id, name, company_status, company_status_detail)')
        .eq('staff_id', profile.id)
        .order('created_at', { ascending: true });
      const favourites = favs || [];
      if (!favourites.length) { setCards([]); setLoading(false); return; }

      // 2. QBO report connections for those entities
      const entityIds = favourites.map((f) => f.entity_id);
      const { data: conns } = await supabase
        .from('qbo_report_connections')
        .select('realm_id, company_name, entity_id, status')
        .in('entity_id', entityIds);
      const connByEntity = {};
      for (const c of conns || []) {
        if (!connByEntity[c.entity_id] || c.status === 'active') connByEntity[c.entity_id] = c;
      }

      // 3. Latest cached headline metrics per realm
      const realms = Object.values(connByEntity).map((c) => c.realm_id).filter(Boolean);
      let cacheByRealm = {};
      if (realms.length) {
        const { data: rows } = await supabase
          .from('qbo_dashboard_cache')
          .select('realm_id, metric_key, period_end, data, pulled_at')
          .in('realm_id', realms)
          .in('metric_key', ['pl_fytd', 'balances', 'pnl_monthly', 'aged_receivables', 'file_health'])
          .order('pulled_at', { ascending: false });
        for (const r of rows || []) {
          if (!cacheByRealm[r.realm_id]) cacheByRealm[r.realm_id] = [];
          cacheByRealm[r.realm_id].push(r);
        }
      }

      setCards(favourites.map((f) => {
        const conn = connByEntity[f.entity_id] || null;
        const latest = conn ? latestByMetric(cacheByRealm[conn.realm_id] || []) : {};
        return {
          entityId: f.entity_id,
          name: conn?.company_name || f.entity?.name || 'Unknown client',
          chStatus: f.entity?.company_status || null,
          chDetail: f.entity?.company_status_detail || null,
          realmId: conn?.realm_id || null,
          plFytd: latest.pl_fytd?.data || null,
          balances: latest.balances?.data || null,
          pnlMonthly: latest.pnl_monthly?.data || null,
          agedAR: latest.aged_receivables?.data || null,
          fileHealth: latest.file_health?.data || null,
          pulledAt: conn && (cacheByRealm[conn.realm_id] || [])[0]?.pulled_at || null,
        };
      }));
    } catch { setCards([]); }
    setLoading(false);
  };

  useEffect(() => { load(); }, [profile?.id]);

  const unstar = async (entityId) => {
    setCards((prev) => prev.filter((c) => c.entityId !== entityId));
    try {
      await supabase.from('staff_client_favourites').delete()
        .eq('staff_id', profile.id).eq('entity_id', entityId);
    } catch { load(); }
  };

  return (
    <div style={{ maxWidth: '1060px', margin: '0 auto', padding: '40px 24px' }}>
      <h1 style={{ fontFamily: PLAYFAIR, fontSize: '28px', fontWeight: 500, color: '#0f172a', marginBottom: '8px' }}>
        Portfolio
      </h1>
      <p style={{ fontFamily: OUTFIT, fontSize: '14px', color: '#64748b', marginBottom: '28px' }}>
        Your starred clients with their latest cached QuickBooks figures.
      </p>

      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#0369a1', fontFamily: OUTFIT, fontSize: '14px', fontWeight: 600 }}>
          <Loader size={16} style={{ animation: 'spin 1s linear infinite' }} /> Loading your portfolio…
        </div>
      )}

      {!loading && cards.length === 0 && (
        <div style={{ ...cardStyle, textAlign: 'center', padding: '56px 24px' }}>
          <Star size={28} style={{ color: '#f59e0b', marginBottom: '12px' }} />
          <div style={{ fontFamily: OUTFIT, fontSize: '16px', fontWeight: 700, color: '#0f172a', marginBottom: '6px' }}>
            No starred clients yet
          </div>
          <div style={{ fontFamily: OUTFIT, fontSize: '13px', color: '#64748b', maxWidth: '440px', margin: '0 auto 18px' }}>
            Open the Client Dashboard, pick a client and click the star next to their name.
            Starred clients appear here with their key metrics, so you can watch your portfolio at a glance.
          </div>
          <button
            onClick={() => navigate('/client-dashboard')}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '9px 18px',
              border: '1px solid #e5e7eb', borderRadius: '10px', backgroundColor: '#ffffff',
              cursor: 'pointer', fontFamily: OUTFIT, fontSize: '13px', fontWeight: 600, color: '#38bdf8',
            }}
          >
            Open Client Dashboard <ArrowRight size={14} />
          </button>
        </div>
      )}

      {!loading && cards.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '16px' }}>
          {cards.map((c) => <PortfolioCard key={c.entityId} card={c} navigate={navigate} unstar={unstar} />)}
        </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function PortfolioCard({ card, navigate, unstar }) {
  const currency = card.pnlMonthly?.currency || card.plFytd?.currency || 'GBP';
  const chBad = card.chStatus && card.chStatus !== 'active';
  const spark = card.pnlMonthly?.series?.income || null;
  const debtors = card.agedAR?.buckets?.total ?? card.balances?.debtors;
  const healthColor = { green: '#22c55e', amber: '#f59e0b', red: '#ef4444' }[card.fileHealth?.score] || null;
  const openDash = () => { if (card.realmId) navigate(`/client-dashboard?realm=${encodeURIComponent(card.realmId)}`); };

  const metricRows = [
    ['Revenue YTD', card.plFytd?.income],
    ['Profit YTD', card.plFytd?.net_income],
    ['Cash', card.balances?.cash],
    ['Debtors', debtors],
  ];

  return (
    <div style={{ ...cardStyle, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {/* Header: name + health dot + unstar */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            onClick={openDash}
            title={card.realmId ? 'Open dashboard' : undefined}
            style={{
              fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a',
              cursor: card.realmId ? 'pointer' : 'default', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {card.name}
          </div>
          {chBad && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: '4px', marginTop: '4px',
              fontFamily: OUTFIT, fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '7px',
              color: BAD_CH_STATUS.test(`${card.chStatus} ${card.chDetail || ''}`) ? '#991b1b' : '#92400e',
              backgroundColor: BAD_CH_STATUS.test(`${card.chStatus} ${card.chDetail || ''}`) ? '#fef2f2' : '#fffbeb',
              border: `1px solid ${BAD_CH_STATUS.test(`${card.chStatus} ${card.chDetail || ''}`) ? '#fecaca' : '#fde68a'}`,
            }}>
              <AlertTriangle size={10} />
              {card.chStatus.replace(/-/g, ' ')}{card.chDetail ? ` (${card.chDetail.replace(/-/g, ' ')})` : ''}
            </span>
          )}
        </div>
        {healthColor && (
          <span title={`Bookkeeping health: ${card.fileHealth.score}`}
            style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: healthColor, marginTop: '5px', flexShrink: 0 }} />
        )}
        <button
          onClick={() => unstar(card.entityId)}
          title="Remove from Portfolio"
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', flexShrink: 0 }}
        >
          <Star size={16} style={{ color: '#f59e0b', fill: '#f59e0b' }} />
        </button>
      </div>

      {/* Body */}
      {!card.realmId ? (
        <div style={{ fontFamily: OUTFIT, fontSize: '12.5px', color: '#94a3b8', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Link2Off size={14} /> No QuickBooks reports connection for this client.
        </div>
      ) : !card.plFytd && !card.balances && !card.pnlMonthly ? (
        <div style={{ fontFamily: OUTFIT, fontSize: '12.5px', color: '#94a3b8' }}>
          No cached figures yet — open the dashboard to pull from QuickBooks
          (or reconnect them if the pull fails).
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            {metricRows.map(([label, val]) => (
              <div key={label}>
                <div style={{ fontFamily: OUTFIT, fontSize: '11px', color: '#94a3b8' }}>{label}</div>
                <div style={{ fontFamily: OUTFIT, fontSize: '16px', fontWeight: 700, color: (val ?? 0) < 0 ? '#991b1b' : '#0f172a' }}>
                  {money(val, currency)}
                </div>
              </div>
            ))}
          </div>
          {spark && spark.length > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Sparkline values={spark} width={160} height={34} />
              <span style={{ fontFamily: OUTFIT, fontSize: '10.5px', color: '#94a3b8' }}>revenue, last 12 months</span>
            </div>
          )}
        </>
      )}

      {/* Footer */}
      <div style={{ display: 'flex', alignItems: 'center', marginTop: 'auto', paddingTop: '4px' }}>
        <span style={{ fontFamily: OUTFIT, fontSize: '11px', color: '#cbd5e1' }}>
          {card.pulledAt ? `pulled ${timeAgo(card.pulledAt)}` : ''}
        </span>
        {card.realmId && (
          <button
            onClick={openDash}
            style={{
              marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '4px',
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              fontFamily: OUTFIT, fontSize: '12px', fontWeight: 600, color: '#38bdf8',
            }}
          >
            Open dashboard <ArrowRight size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
