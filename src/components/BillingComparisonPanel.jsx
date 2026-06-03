import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { fmt } from './ui';
import { compareQuoteToBilling } from '../lib/billingComparison';

// Compares a quote (or a group of quotes) against current live billing.
//   items: [{ entityId, lines }]  — lines = that quote's quote_line_items
//   title: heading text
// Aggregates the quote lines and the entities' active live_billing services,
// then shows a per-service quote-vs-live table with a totals delta.
export default function BillingComparisonPanel({ items, title = 'Quote vs current billing' }) {
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState(null);

  const entityIds = (items || []).map((i) => i.entityId).filter(Boolean);
  const key = entityIds.join(',');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      if (entityIds.length === 0) { setResult(null); setLoading(false); return; }
      const [{ data: billing }, { data: maps }] = await Promise.all([
        supabase.from('live_billing').select('entity_id, services, last_synced_qbo, created_at')
          .in('entity_id', entityIds).eq('status', 'active'),
        supabase.from('qbo_service_items').select('service_id, qbo_item_name'),
      ]);
      if (cancelled) return;
      // Latest active billing row per entity.
      const latest = {};
      for (const r of billing || []) {
        const prev = latest[r.entity_id];
        const t = r.last_synced_qbo || r.created_at || '';
        if (!prev || t > (prev._t || '')) latest[r.entity_id] = { ...r, _t: t };
      }
      const liveServices = Object.values(latest).flatMap((r) => Array.isArray(r.services) ? r.services : []);
      const quoteLines = (items || []).flatMap((i) => i.lines || []);
      setResult(compareQuoteToBilling(quoteLines, liveServices, maps || []));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (loading) return null;
  if (!result || result.rows.length === 0) return null;

  const { rows, totals, hasLive } = result;
  const STATUS = {
    new: { label: 'New', bg: '#dcfce7', fg: '#15803d' },
    removed: { label: 'Removed', bg: '#fee2e2', fg: '#b91c1c' },
    changed: { label: 'Changed', bg: '#fef3c7', fg: '#92400e' },
    same: { label: '', bg: 'transparent', fg: '#94a3b8' },
  };
  const deltaColor = (n) => (n > 0.5 ? '#15803d' : n < -0.5 ? '#b91c1c' : '#64748b');
  const sign = (n) => (n > 0 ? '+' : '');

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-3 mb-3">
      <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">{title}</h3>
      {!hasLive && (
        <p className="text-xs text-amber-700 mb-2">No current live billing on file — the quote is entirely new business.</p>
      )}
      <div className="grid gap-1 text-xs" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr 90px' }}>
        <span className="text-gray-400">Service</span>
        <span className="text-right text-gray-400">Quote (yr)</span>
        <span className="text-right text-gray-400">Live (yr)</span>
        <span className="text-right text-gray-400">Δ (yr)</span>
        <span className="text-right text-gray-400" />
        {rows.map((r) => {
          const st = STATUS[r.status] || STATUS.same;
          return (
            <React.Fragment key={r.id}>
              <span className="text-gray-700 truncate">{r.label}</span>
              <span className="text-right font-mono text-gray-600">{r.quoteAnnual ? fmt(r.quoteAnnual) : '—'}</span>
              <span className="text-right font-mono text-gray-600">{r.liveAnnual ? fmt(r.liveAnnual) : '—'}</span>
              <span className="text-right font-mono" style={{ color: deltaColor(r.deltaAnnual) }}>
                {r.deltaAnnual ? `${sign(r.deltaAnnual)}${fmt(r.deltaAnnual)}` : '—'}
              </span>
              <span className="text-right">
                {st.label && <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 999, background: st.bg, color: st.fg }}>{st.label}</span>}
              </span>
            </React.Fragment>
          );
        })}
        {/* Totals */}
        <span className="text-gray-800 font-semibold border-t border-gray-200 pt-1">Annual total</span>
        <span className="text-right font-mono text-gray-800 font-semibold border-t border-gray-200 pt-1">{fmt(totals.quoteAnnual)}</span>
        <span className="text-right font-mono text-gray-800 font-semibold border-t border-gray-200 pt-1">{fmt(totals.liveAnnual)}</span>
        <span className="text-right font-mono font-semibold border-t border-gray-200 pt-1" style={{ color: deltaColor(totals.deltaAnnual) }}>
          {sign(totals.deltaAnnual)}{fmt(totals.deltaAnnual)}
        </span>
        <span className="border-t border-gray-200 pt-1" />
        <span className="text-gray-500">Monthly</span>
        <span className="text-right font-mono text-gray-500">{fmt(totals.quoteMonthly)}</span>
        <span className="text-right font-mono text-gray-500">{fmt(totals.liveMonthly)}</span>
        <span className="text-right font-mono" style={{ color: deltaColor(totals.deltaMonthly) }}>{sign(totals.deltaMonthly)}{fmt(totals.deltaMonthly)}</span>
        <span className="text-right text-gray-400">{totals.pct != null ? `${sign(totals.pct)}${totals.pct}%` : ''}</span>
      </div>
    </div>
  );
}
