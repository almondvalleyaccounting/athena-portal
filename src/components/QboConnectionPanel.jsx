import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Btn } from './ui';
import { getQboStatus, pullFromQbo, getQboAuthUrl, disconnectQbo } from '../lib/qboApi';
import { supabase } from '../lib/supabase';

export default function QboConnectionPanel({ profile, onSyncComplete }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pulling, setPulling] = useState(false);
  const [pullElapsed, setPullElapsed] = useState(0);
  const [pullResult, setPullResult] = useState(null);
  const [error, setError] = useState('');
  const [mapStats, setMapStats] = useState({ total: 0, unmapped: 0 });
  const elapsedTimerRef = useRef(null);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await getQboStatus();
      setStatus(data);
      setError('');
    } catch (err) {
      setError('Failed to check QBO connection');
      setStatus(null);
    }
    setLoading(false);
  }, []);

  const fetchMapStats = useCallback(async () => {
    try {
      const { count: total } = await supabase
        .from('qbo_customer_mappings')
        .select('*', { count: 'exact', head: true });
      const { count: unmapped } = await supabase
        .from('qbo_customer_mappings')
        .select('*', { count: 'exact', head: true })
        .is('entity_id', null);
      setMapStats({ total: total ?? 0, unmapped: unmapped ?? 0 });
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchMapStats();
    const interval = setInterval(fetchStatus, 60000);
    return () => clearInterval(interval);
  }, [fetchStatus, fetchMapStats]);

  const handleConnect = () => { window.location.href = getQboAuthUrl(profile.id); };

  const handleDisconnect = async () => {
    if (!confirm('Disconnect from QuickBooks Online? You can reconnect at any time.')) return;
    try {
      await disconnectQbo();
      await fetchStatus();
    } catch (err) {
      setError(err.message || 'Failed to disconnect');
    }
  };

  const handlePull = async () => {
    console.log('[QBO] Pull clicked, profile.id =', profile?.id);
    setPulling(true);
    setPullResult(null);
    setError('');
    setPullElapsed(0);

    const started = Date.now();
    elapsedTimerRef.current = setInterval(() => {
      setPullElapsed(Math.floor((Date.now() - started) / 1000));
    }, 500);

    try {
      const result = await pullFromQbo(profile.id);
      console.log('[QBO] Pull result:', result);
      setPullResult(result?.data || result);
      await fetchMapStats();
      if (onSyncComplete) onSyncComplete();
    } catch (err) {
      console.error('[QBO] Pull error:', err);
      setError(err.message || 'Pull from QBO failed');
    }
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    setPulling(false);
  };

  if (loading) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
        <p className="text-xs text-gray-400">Checking QuickBooks connection…</p>
      </div>
    );
  }

  const connected = status?.connected;
  const tokenHealth = status?.token_health;
  const companyName = status?.company_name;

  return (
    <div className={`rounded-lg border p-4 mb-4 ${connected ? 'bg-white border-gray-200' : 'bg-gray-50 border-dashed border-gray-300'}`}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${connected ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-500'}`}>
            QBO
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-semibold text-gray-700">QuickBooks Online</h3>
              <span className={`w-2 h-2 rounded-full ${
                connected
                  ? tokenHealth === 'healthy' ? 'bg-green-500'
                    : tokenHealth === 'expiring_soon' ? 'bg-amber-500'
                    : 'bg-red-500'
                  : 'bg-gray-400'
              }`} />
              <span className="text-xs text-gray-500">
                {connected
                  ? tokenHealth === 'refresh_expired' ? 'Reconnection needed'
                    : tokenHealth === 'expiring_soon' ? 'Token expiring soon'
                    : 'Connected'
                  : 'Not connected'}
              </span>
              {connected && companyName && (
                <span className="text-xs text-gray-400">· {companyName}</span>
              )}
            </div>

            {/* Stats strip */}
            {connected && (
              <div className="flex items-center gap-4 mt-2 text-xs">
                {status?.sync_stats && (
                  <div>
                    <span className="text-gray-500">Billing records synced: </span>
                    <span className="font-semibold text-gray-700">{status.sync_stats.total_synced}</span>
                    {status.sync_stats.pending_sync > 0 && (
                      <span className="text-amber-600 ml-2">({status.sync_stats.pending_sync} pending)</span>
                    )}
                  </div>
                )}
                <div>
                  <span className="text-gray-500">QBO customers tracked: </span>
                  <span className="font-semibold text-gray-700">{mapStats.total}</span>
                </div>
                {mapStats.unmapped > 0 ? (
                  <button
                    onClick={() => navigate('/manage/billing/qbo-mapping')}
                    className="text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-3 py-0.5 hover:bg-amber-100"
                  >
                    <span className="font-semibold">{mapStats.unmapped} unmapped</span> · resolve →
                  </button>
                ) : mapStats.total > 0 ? (
                  <span className="text-green-700">All mapped</span>
                ) : null}
              </div>
            )}

            {connected && status?.refresh_days_left != null && status.refresh_days_left < 14 && (
              <p className="text-xs text-amber-600 mt-1">
                Refresh token expires in {status.refresh_days_left} days — reconnect soon
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {connected ? (
            <>
              <button
                onClick={handlePull}
                disabled={pulling}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                  pulling
                    ? 'bg-ocean-100 text-ocean-700 cursor-wait'
                    : 'bg-ocean-600 text-white hover:bg-ocean-700'
                }`}
              >
                {pulling ? (
                  <>
                    <svg className="animate-spin h-4 w-4 text-ocean-700" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Pulling… {pullElapsed}s
                  </>
                ) : (
                  <>Pull from QBO</>
                )}
              </button>
              <button
                onClick={() => navigate('/manage/billing/qbo-mapping')}
                className="px-3 py-2 text-sm font-medium text-gray-600 hover:text-ocean-600"
              >
                Manage mapping →
              </button>
              <button
                onClick={handleDisconnect}
                className="text-xs text-gray-400 hover:text-red-500"
              >
                Disconnect
              </button>
            </>
          ) : (
            <Btn onClick={handleConnect} variant="primary" className="text-xs">
              Connect to QuickBooks
            </Btn>
          )}
        </div>
      </div>

      {/* Pull result — expanded feedback */}
      {pullResult && (
        <div className="mt-3 bg-green-50 border border-green-200 rounded p-3 text-xs">
          <p className="font-semibold text-green-800 mb-2">Pull complete</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-green-700">
            <Stat label="QBO customers seen" value={pullResult.qbo_customers_seen} />
            <Stat label="New (never seen before)" value={pullResult.qbo_customers_new} />
            <Stat label="Auto-matched to entity" value={pullResult.qbo_customers_auto_matched} />
            <Stat label="Still unmapped" value={pullResult.qbo_customers_unmapped} highlight={pullResult.qbo_customers_unmapped > 0} />
            <Stat label="Billing created" value={pullResult.created} />
            <Stat label="Billing updated" value={pullResult.updated} />
            <Stat label="Recurring txns" value={pullResult.recurring_found} />
            <Stat label="Invoices processed" value={pullResult.unique_customers} />
          </div>
          {pullResult.unmatched_customers?.length > 0 && (
            <details className="mt-2">
              <summary className="text-amber-700 cursor-pointer">
                {pullResult.unmatched_customers.length} customer(s) need manual mapping
              </summary>
              <div className="mt-1 text-gray-500 space-y-0.5 max-h-32 overflow-auto">
                {pullResult.unmatched_customers.map((name, i) => (<p key={i}>{name}</p>))}
              </div>
              <button
                onClick={() => navigate('/manage/billing/qbo-mapping')}
                className="mt-2 text-ocean-600 hover:underline"
              >
                Resolve in mapping UI →
              </button>
            </details>
          )}
          {pullResult.errors?.length > 0 && (
            <p className="text-red-600 mt-2">{pullResult.errors.length} error(s): {pullResult.errors.slice(0, 3).join(', ')}</p>
          )}
        </div>
      )}

      {error && (
        <div className="mt-3 text-xs bg-red-50 text-red-600 rounded p-2">{error}</div>
      )}
    </div>
  );
}

function Stat({ label, value, highlight }) {
  return (
    <div>
      <p className="text-gray-500 text-[10px] uppercase tracking-wide">{label}</p>
      <p className={`font-mono text-sm ${highlight ? 'text-amber-700 font-bold' : 'text-gray-800'}`}>
        {value != null ? Number(value).toLocaleString() : '—'}
      </p>
    </div>
  );
}
