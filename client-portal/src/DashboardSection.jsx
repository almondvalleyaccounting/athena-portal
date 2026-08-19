import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase';
import PortalDashboardView from '@dash/PortalDashboardView.jsx';

/*
  The client's financial dashboard — data only.

  Everything visible lives in @dash/PortalDashboardView, which Athena also
  renders in its "Preview as client" panel. This file is the half that cannot be
  shared: the Supabase calls, made as the signed-in client.

  Two calls, and neither can ask for more than the client is owed:
    portal_my_dashboards()  — a SECURITY DEFINER RPC filtered to the caller's
                              own verified email claim.
    portal-dashboard        — the edge function, which checks the grant, resolves
                              the realm itself and picks the dates itself. The
                              body carries a grain and a basis; there is nothing
                              in it that could name another company, a date range
                              or a metric.
*/

export default function DashboardSection({ onHasDashboards }) {
  const [grants, setGrants] = useState(null);   // null = still loading
  const [entityId, setEntityId] = useState('');
  const [grain, setGrain] = useState('month');
  const [basis, setBasis] = useState('fiscal');
  const [view, setView] = useState('reported');
  const [tab, setTab] = useState('overview');
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const { data, error: e } = await supabase.rpc('portal_my_dashboards');
        if (e) throw e;
        setGrants(data || []);
        if ((data || []).length) setEntityId(data[0].entity_id);
        onHasDashboards?.((data || []).length > 0);
      } catch {
        // A portal deployed before sql/238 simply has no dashboards. Not an
        // error the client should ever be shown.
        setGrants([]);
        onHasDashboards?.(false);
      }
    })();
    // onHasDashboards is a setState from the parent and stable in practice;
    // depending on it would re-run the load on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    if (!entityId) return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: e } = await supabase.functions.invoke('portal-dashboard', {
        body: { entityId, grain, basis },
      });
      if (e) throw e;
      if (!data?.success) throw new Error(data?.error || 'Could not load your figures.');
      setPayload(data);
    } catch (e) {
      setError(e.message === 'Not authorised'
        ? "You don't have access to these figures."
        : "We couldn't load your figures just now. Please try again shortly.");
    }
    setLoading(false);
  }, [entityId, grain, basis]);

  useEffect(() => { load(); }, [load]);

  const onSelectEntity = useMemo(() => (id) => {
    setEntityId(id);
    setPayload(null);
  }, []);

  if (grants === null || grants.length === 0) return null;

  return (
    <div className="fade-up" style={{ marginTop: 30 }}>
      <PortalDashboardView
        payload={payload}
        loading={loading}
        error={error}
        onRetry={load}
        grain={grain} setGrain={setGrain}
        basis={basis} setBasis={setBasis}
        view={view} setView={setView}
        tab={tab} setTab={setTab}
        grants={grants}
        entityId={entityId}
        setEntityId={onSelectEntity}
      />
    </div>
  );
}
