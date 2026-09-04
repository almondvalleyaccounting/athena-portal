import React from 'react';
import { Eye, Loader } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import PortalDashboardView, { portalTabsFor } from './PortalDashboardView';
import { usePortalDashboard } from './usePortalDashboard';
import { portalTheme } from './portalTheme';

const font = "'Outfit', sans-serif";

/*
  What this person actually sees, before you tell them it exists.

  The payload comes from the SAME portal-dashboard call the client's browser
  makes — passing previewEmail resolves their grant rather than ours, and the
  function applies the identical redactions. A preview assembled from staff data
  would look right and be wrong, which is the worst outcome for a screen whose
  only job is to let someone sign off on what a client will be shown.

  The controls come from the same hook the client's page uses, so the preview can
  work the date picker, the Compare control and every tab. It used to hold a
  thinner copy of that state, which meant the half of the page a client would
  actually poke at was the half the preview could not reach.

  The strip along the top says whose view it is and, just as importantly, what is
  being withheld — reading "no projection" is how you notice you meant to switch
  it on.
*/
export const SECTION_LABELS = {
  show_overview: 'Overview', show_pl: 'P&L', show_balance: 'Balance sheet',
  show_debtors: 'Debtors', show_creditors: 'Creditors', show_kpis: 'Measures',
  show_reports: 'Reports', show_underlying: 'Underlying', show_projection: 'Projection',
};

export default function ClientViewPreview({ row, onClose, onToggle, busy }) {
  // The section flags are part of the fetch signature because the SERVER applies
  // them: turning Underlying on has to re-fetch, not just re-render, since the
  // account rows that make the underlying view possible are withheld without it.
  const flagSignature = Object.keys(SECTION_LABELS).map((k) => (row[k] ? '1' : '0')).join('');

  const ui = usePortalDashboard({
    supabase,
    entityId: row.entity_id,
    previewEmail: row.email,
    grant: row,
    flagSignature,
  });

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
          width: 'min(980px, 100%)', height: '100%', background: portalTheme.bg,
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
            {ui.loading && <Loader size={13} style={{ animation: 'spin 1s linear infinite' }} />}
            <button
              onClick={onClose}
              style={{ marginLeft: 'auto', border: 'none', background: 'rgba(255,255,255,0.12)', color: '#fff', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: font }}
            >
              Close
            </button>
          </div>
          <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 5, lineHeight: 1.55 }}>
            {row.entity_name} · the real client view, fetched through the client's own endpoint
            with their grant applied — not a mock. Every control below works as it will for them.
            {onToggle
              ? ' Click a section to switch it on or off and watch the page change; the change saves as you click.'
              : ' Sections are set on the Client access tab.'}
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
          <div style={{ maxWidth: 880, margin: '0 auto' }}>
            <PortalDashboardView
              payload={ui.payload}
              loading={ui.loading}
              error={ui.error}
              onRetry={ui.reload}
              ui={ui}
            />
            {ui.payload && portalTabsFor(ui.payload).length === 0 && (
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
