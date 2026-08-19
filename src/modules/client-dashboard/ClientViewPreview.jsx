import React, { useCallback, useEffect, useState } from 'react';
import { Eye, Loader } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import PortalDashboardView, { portalTabsFor } from './PortalDashboardView';
import { portalTheme } from './portalTheme';

const font = "'Outfit', sans-serif";

/*
  What this person actually sees, before you tell them it exists.

  The payload comes from the SAME portal-dashboard call the client's browser
  makes — passing previewEmail resolves their grant rather than ours, and the
  function applies the identical redactions. A preview assembled from staff data
  would look right and be wrong, which is the worst outcome for a screen whose
  only job is to let someone sign off on what a client will be shown.

  The strip along the top says whose view it is and, just as importantly, what
  is being withheld — reading "no projection" is how you notice you meant to
  switch it on.
*/
export const SECTION_LABELS = {
  show_overview: 'Overview', show_pl: 'P&L', show_balance: 'Balance sheet',
  show_underlying: 'Underlying', show_projection: 'Projection',
};

export default function ClientViewPreview({ row, onClose, onToggle, busy }) {
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [grain, setGrain] = useState('month');
  const [basis, setBasis] = useState('fiscal');
  const [view, setView] = useState('reported');
  const [tab, setTab] = useState('overview');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: e } = await supabase.functions.invoke('portal-dashboard', {
        body: { entityId: row.entity_id, previewEmail: row.email, grain, basis },
      });
      if (e) throw e;
      if (!data?.success) throw new Error(data?.error || 'Could not load the preview.');
      setPayload(data);
    } catch (e) {
      setError(String(e.message || e));
    }
    setLoading(false);
    // The section flags are in the deps because the server applies them: turning
    // Underlying on has to re-fetch, not just re-render, since the account rows
    // that make the underlying view possible are withheld without it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.entity_id, row.email, grain, basis,
    row.show_overview, row.show_pl, row.show_balance, row.show_underlying, row.show_projection]);

  useEffect(() => { load(); }, [load]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, backgroundColor: 'rgba(15,23,42,0.5)', zIndex: 80,
        display: 'flex', justifyContent: 'flex-end',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(840px, 100%)', height: '100%', background: portalTheme.bg,
          display: 'flex', flexDirection: 'column', fontFamily: font,
          boxShadow: '-8px 0 32px rgba(15,23,42,0.18)',
        }}
      >
        {/* Staff chrome — deliberately NOT client-styled, so the two are never confused */}
        <div style={{ background: '#0f172a', color: '#fff', padding: '14px 20px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Eye size={16} style={{ color: '#7dd3fc' }} />
            <span style={{ fontSize: 14, fontWeight: 700 }}>
              Previewing as {row.email}
            </span>
            {loading && <Loader size={13} style={{ animation: 'spin 1s linear infinite' }} />}
            <button
              onClick={onClose}
              style={{ marginLeft: 'auto', border: 'none', background: 'rgba(255,255,255,0.12)', color: '#fff', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: font }}
            >
              Close
            </button>
          </div>
          <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 5, lineHeight: 1.55 }}>
            {row.entity_name} · the real client view, fetched through the client's own endpoint
            with their grant applied — not a mock.
            {onToggle
              ? ' Click a section below to switch it on or off and watch the page change; the change saves as you click.'
              : ' Sections are set on Client Dashboard Access.'}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 9 }}>
            {Object.keys(SECTION_LABELS).map((k) => {
              const on = !!row[k];
              const chip = {
                fontSize: 11, fontWeight: on ? 600 : 500, padding: '4px 10px', borderRadius: 999,
                border: `1px solid ${on ? 'rgba(125,211,252,0.4)' : 'rgba(148,163,184,0.3)'}`,
                background: on ? 'rgba(125,211,252,0.18)' : 'rgba(148,163,184,0.1)',
                color: on ? '#7dd3fc' : '#94a3b8',
                textDecoration: on ? 'none' : 'line-through',
                fontFamily: font,
              };
              // Read-only where the caller can't save — a chip that looks
              // clickable and silently does nothing is worse than a plain label.
              if (!onToggle) return <span key={k} style={chip}>{SECTION_LABELS[k]}</span>;
              return (
                <button
                  key={k}
                  onClick={() => onToggle(row, k)}
                  disabled={busy === row.id}
                  title={on ? 'Showing — click to hide' : 'Hidden — click to show'}
                  style={{ ...chip, cursor: busy === row.id ? 'wait' : 'pointer' }}
                >
                  {SECTION_LABELS[k]}
                </button>
              );
            })}
          </div>
        </div>

        {/* The client's own page, verbatim */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 18px 60px' }}>
          <div style={{ maxWidth: 720, margin: '0 auto' }}>
            {error && (
              <div style={{ fontSize: 13.5, color: '#991b1b', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12, padding: '12px 15px', marginBottom: 12 }}>
                {error}{' '}
                <button onClick={load} style={{ border: 'none', background: 'none', color: '#991b1b', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }}>
                  Retry
                </button>
              </div>
            )}
            <PortalDashboardView
              payload={payload}
              loading={loading}
              onRetry={load}
              grain={grain} setGrain={setGrain}
              basis={basis} setBasis={setBasis}
              view={view} setView={setView}
              tab={tab} setTab={setTab}
            />
            {payload && portalTabsFor(payload).length === 0 && (
              <div style={{ fontSize: 13.5, color: portalTheme.muted, textAlign: 'center', padding: '30px 0' }}>
                Every section is switched off, so this person would see nothing at all.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

