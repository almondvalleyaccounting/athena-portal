import React, { useState, useEffect, useCallback } from 'react';
import { Btn, fmt } from './ui';
import { getQboStatus, pullFromQbo, getQboAuthUrl, disconnectQbo } from '../lib/qboApi';

export default function QboConnectionPanel({ profile, onSyncComplete }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pulling, setPulling] = useState(false);
  const [pullResult, setPullResult] = useState(null);
  const [error, setError] = useState('');

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

  useEffect(() => {
    fetchStatus();
    // Poll every 60 seconds
    const interval = setInterval(fetchStatus, 60000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const handleConnect = () => {
    window.location.href = getQboAuthUrl(profile.id);
  };

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
    setPulling(true);
    setPullResult(null);
    setError('');
    try {
      const result = await pullFromQbo(profile.id);
      setPullResult(result?.data || result);
      if (onSyncComplete) onSyncComplete();
    } catch (err) {
      setError(err.message || 'Pull from QBO failed');
    }
    setPulling(false);
  };

  if (loading) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
        <p className="text-xs text-gray-400">Checking QuickBooks connection...</p>
      </div>
    );
  }

  const connected = status?.connected;
  const tokenHealth = status?.token_health;
  const companyName = status?.company_name;

  return (
    <div className={`rounded-lg border p-4 mb-4 ${connected ? 'bg-white border-gray-200' : 'bg-gray-50 border-dashed border-gray-300'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* QBO Logo placeholder */}
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold ${connected ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-500'}`}>
            QBO
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-700">QuickBooks Online</h3>
              {/* Status dot */}
              <span className={`w-2 h-2 rounded-full ${
                connected
                  ? tokenHealth === 'healthy' ? 'bg-green-500'
                    : tokenHealth === 'expiring_soon' ? 'bg-amber-500'
                    : 'bg-red-500'
                  : 'bg-gray-400'
              }`} />
              <span className="text-xs text-gray-400">
                {connected
                  ? tokenHealth === 'refresh_expired' ? 'Reconnection needed'
                    : tokenHealth === 'expiring_soon' ? 'Token expiring soon'
                    : 'Connected'
                  : 'Not connected'}
              </span>
            </div>
            {connected && companyName && (
              <p className="text-xs text-gray-500">{companyName}</p>
            )}
            {connected && status?.sync_stats && (
              <p className="text-xs text-gray-400 mt-0.5">
                {status.sync_stats.total_synced} synced
                {status.sync_stats.pending_sync > 0 && (
                  <span className="text-amber-600 ml-2">{status.sync_stats.pending_sync} pending</span>
                )}
              </p>
            )}
            {connected && status?.refresh_days_left != null && status.refresh_days_left < 14 && (
              <p className="text-xs text-amber-600 mt-0.5">
                Refresh token expires in {status.refresh_days_left} days — reconnect soon
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {connected ? (
            <>
              <Btn onClick={handlePull} variant="secondary" disabled={pulling} className="text-xs">
                {pulling ? 'Pulling...' : 'Pull from QBO'}
              </Btn>
              <Btn onClick={handleDisconnect} variant="ghost" className="text-xs text-gray-400">
                Disconnect
              </Btn>
            </>
          ) : (
            <Btn onClick={handleConnect} variant="primary" className="text-xs">
              Connect to QuickBooks
            </Btn>
          )}
        </div>
      </div>

      {/* Pull result feedback */}
      {pullResult && (
        <div className="mt-3 text-xs bg-green-50 text-green-700 rounded p-2">
          Pulled from QBO: {pullResult.created || 0} created, {pullResult.updated || 0} updated, {pullResult.skipped || 0} skipped
          {pullResult.errors?.length > 0 && (
            <span className="text-red-600 ml-2">({pullResult.errors.length} errors)</span>
          )}
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="mt-3 text-xs bg-red-50 text-red-600 rounded p-2">{error}</div>
      )}
    </div>
  );
}
