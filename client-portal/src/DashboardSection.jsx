import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase';
import PortalDashboardView from '@dash/PortalDashboardView.jsx';
import { usePortalDashboard } from '@dash/usePortalDashboard.js';

/*
  The client's financial dashboard — the grants list, and nothing else.

  Everything visible lives in @dash/PortalDashboardView, and every control and
  the figures call live in @dash/usePortalDashboard. Athena renders both in its
  "Preview as client" panel, so the preview exercises the same date pickers,
  the same Compare control and the same endpoint the client does — a preview
  that could not work the controls would be signing off half a page.

  This file is the half that cannot be shared: the Supabase client, which is the
  client-portal's own.

  Two calls, and neither can ask for more than the client is owed:
    portal_my_dashboards()  — a SECURITY DEFINER RPC filtered to the caller's
                              own verified email claim. It also carries the
                              client's fiscal year start month, so the fiscal
                              date presets resolve correctly on the FIRST
                              request rather than after one wrong one.
    portal-dashboard        — the edge function, which checks the grant, resolves
                              the realm itself and clamps every date it is sent.
                              The body carries dates, a grain and a basis; there
                              is nothing in it that could name another company,
                              a realm or a metric.
*/

export default function DashboardSection({ onHasDashboards }) {
  const [grants, setGrants] = useState(null);   // null = still loading
  const [entityId, setEntityId] = useState('');

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

  const grant = useMemo(
    () => (grants || []).find((g) => g.entity_id === entityId) || null,
    [grants, entityId],
  );

  const ui = usePortalDashboard({ supabase, entityId, grant });

  if (grants === null || grants.length === 0) return null;

  return (
    <div className="fade-up" style={{ marginTop: 30 }}>
      <PortalDashboardView
        payload={ui.payload}
        loading={ui.loading}
        error={ui.error}
        onRetry={ui.reload}
        ui={ui}
        grants={grants}
        entityId={entityId}
        setEntityId={setEntityId}
      />
    </div>
  );
}
