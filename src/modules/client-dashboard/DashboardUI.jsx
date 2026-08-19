import React from 'react';
import { Loader, CloudOff, RefreshCw, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { money, OUTFIT, cardStyle } from './dashboardData';

/*
  Small presentational pieces shared across the Client Dashboard tabs.

  Pulled out of ClientDashboardPage when the Overview tab moved to its own file
  and both needed the same tiles. Everything here is pure — data in via props,
  no supabase, no auth — so the same components render the client-portal view.
*/

export function LoadingCard({ label }) {
  return (
    <div style={{ ...cardStyle, textAlign: 'center', padding: '48px 24px' }}>
      <Loader size={22} style={{ color: '#7dd3fc', marginBottom: '10px', animation: 'spin 1s linear infinite' }} />
      <div style={{ fontFamily: OUTFIT, fontSize: '13px', color: '#64748b' }}>Loading {label}…</div>
    </div>
  );
}

export function EmptyState({ label, needsReconnect, selectedName, onPull, loading }) {
  return (
    <div style={{ ...cardStyle, textAlign: 'center', padding: '48px 24px' }}>
      <CloudOff size={26} style={{ color: '#cbd5e1', marginBottom: '10px' }} />
      <div style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a', marginBottom: '6px' }}>
        No {label} for this client yet
      </div>
      <div style={{ fontFamily: OUTFIT, fontSize: '13px', color: '#64748b', maxWidth: '460px', margin: '0 auto 16px' }}>
        {needsReconnect
          ? `${selectedName || 'This client'}'s QuickBooks connection has no usable access tokens, so nothing can be pulled. Reconnect them from Reports → Connect, then pull again.`
          : 'Pull from QuickBooks to fetch this report. If the pull fails, the client’s QuickBooks needs (re)connecting from the Reports module.'}
      </div>
      {onPull && (
        <button
          onClick={onPull}
          disabled={loading}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '9px 18px',
            border: '1px solid #e5e7eb', borderRadius: '10px', backgroundColor: '#ffffff',
            cursor: loading ? 'not-allowed' : 'pointer', fontFamily: OUTFIT, fontSize: '13px',
            fontWeight: 600, color: '#38bdf8',
          }}
        >
          <RefreshCw size={14} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
          Pull from QuickBooks
        </button>
      )}
    </div>
  );
}

// "vs …" change indicator. upIsGood flips the colouring for figures where an
// increase is unwelcome (creditors, aged debt).
export function Delta({ now, prev, currency, upIsGood = true, label = 'vs last month' }) {
  if (now === null || now === undefined || prev === null || prev === undefined) return null;
  const diff = now - prev;
  if (Math.abs(diff) < 0.005) {
    return <span style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: '#94a3b8' }}>unchanged {label}</span>;
  }
  const up = diff > 0;
  const good = up === upIsGood;
  const color = good ? '#166534' : '#991b1b';
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span style={{ fontFamily: OUTFIT, fontSize: '11.5px', fontWeight: 600, color, display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
      <Icon size={12} /> {money(Math.abs(diff), currency)} {label}
    </span>
  );
}

export function MetricTile({ label, value, currency, sub, delta, onClick, accent }) {
  return (
    <div
      onClick={onClick}
      title={onClick ? 'Open the full report' : undefined}
      style={{
        backgroundColor: accent ? '#f0f9ff' : '#ffffff',
        border: `1px solid ${accent ? '#bae6fd' : '#e5e7eb'}`,
        borderRadius: '12px', padding: '14px 16px',
        cursor: onClick ? 'pointer' : 'default', transition: 'all 0.15s ease',
      }}
      onMouseEnter={(e) => { if (onClick) { e.currentTarget.style.borderColor = '#7dd3fc'; e.currentTarget.style.boxShadow = '0 4px 14px rgba(56,189,248,0.08)'; } }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = accent ? '#bae6fd' : '#e5e7eb'; e.currentTarget.style.boxShadow = 'none'; }}
    >
      <div style={{ fontFamily: OUTFIT, fontSize: '12px', color: '#94a3b8', marginBottom: '4px' }}>{label}</div>
      <div style={{ fontFamily: OUTFIT, fontSize: '22px', fontWeight: 700, color: (value ?? 0) < 0 ? '#991b1b' : '#0f172a' }}>
        {money(value, currency)}
      </div>
      <div style={{ minHeight: '16px', marginTop: '2px', display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' }}>
        {delta}
        {sub && <span style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: '#94a3b8' }}>{sub}</span>}
      </div>
    </div>
  );
}

/*
  Segmented control — the Overview's grain / basis / view toggles, and the
  Projection tab's sub-tabs. Options are [{ key, label, hint }].
*/
export function Segmented({ options = [], value, onChange, size = 'md', label }) {
  const pad = size === 'sm' ? '5px 10px' : '7px 13px';
  const fs = size === 'sm' ? '12px' : '12.5px';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      {label && (
        <span style={{ fontFamily: OUTFIT, fontSize: '11px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#94a3b8' }}>
          {label}
        </span>
      )}
      <div style={{ display: 'inline-flex', border: '1px solid #e5e7eb', borderRadius: '9px', overflow: 'hidden', backgroundColor: '#ffffff' }}>
        {options.map((o, i) => {
          const active = o.key === value;
          return (
            <button
              key={o.key}
              onClick={() => onChange(o.key)}
              title={o.hint || undefined}
              style={{
                padding: pad, border: 'none', cursor: 'pointer',
                borderLeft: i === 0 ? 'none' : '1px solid #e5e7eb',
                backgroundColor: active ? '#0f172a' : '#ffffff',
                color: active ? '#ffffff' : '#475569',
                fontFamily: OUTFIT, fontSize: fs, fontWeight: active ? 700 : 500,
                whiteSpace: 'nowrap',
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
