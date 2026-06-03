import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { fmt } from './ui';
import { compareQuoteToBilling } from '../lib/billingComparison';

// Compares a quote (or a group of quotes) against current live billing.
//   items: [{ entityId, name, lines }]  — lines = that quote's quote_line_items
//   groupMode: show the per-entity summary + include/exclude filters
// Aggregates the selected entities' quote lines and their active
// live_billing services into a per-service Quote-vs-Live table + totals.
export default function BillingComparisonPanel({ items, title = 'Quote vs current billing', groupMode = false }) {
  const [loading, setLoading] = useState(true);
  const [maps, setMaps] = useState([]);
  const [perEntity, setPerEntity] = useState([]); // [{ entityId, name, lines, liveServices, quoteAnnual, liveAnnual, deltaAnnual, hasLive }]
  const [selected, setSelected] = useState(null); // Set of entityIds, null = all

  const entityIds = (items || []).map((i) => i.entityId).filter(Boolean);
  const key = entityIds.join(',');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      if (entityIds.length === 0) { setPerEntity([]); setLoading(false); return; }
      const [{ data: billing }, { data: mapRows }] = await Promise.all([
        supabase.from('live_billing').select('entity_id, services, last_synced_qbo, created_at')
          .in('entity_id', entityIds).eq('status', 'active'),
        supabase.from('qbo_service_items').select('service_id, qbo_item_name'),
      ]);
      if (cancelled) return;
      // Latest active billing row per entity.
      const latest = {};
      for (const r of billing || []) {
        const t = r.last_synced_qbo || r.created_at || '';
        if (!latest[r.entity_id] || t > latest[r.entity_id]._t) latest[r.entity_id] = { ...r, _t: t };
      }
      const data = (items || []).map((i) => {
        const liveServices = Array.isArray(latest[i.entityId]?.services) ? latest[i.entityId].services : [];
        const cmp = compareQuoteToBilling(i.lines || [], liveServices, mapRows || []);
        return {
          entityId: i.entityId,
          name: i.name || 'Client',
          lines: i.lines || [],
          liveServices,
          quoteAnnual: cmp.totals.quoteAnnual,
          liveAnnual: cmp.totals.liveAnnual,
          deltaAnnual: cmp.totals.deltaAnnual,
          hasLive: cmp.hasLive,
        };
      });
      setMaps(mapRows || []);
      setPerEntity(data);
      setSelected(null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const isSelected = (id) => selected === null || selected.has(id);
  const toggle = (id) => {
    setSelected((prev) => {
      const base = prev === null ? new Set(perEntity.map((e) => e.entityId)) : new Set(prev);
      if (base.has(id)) base.delete(id); else base.add(id);
      return base;
    });
  };
  const selectAll = () => setSelected(null);
  const selectBilled = () => setSelected(new Set(perEntity.filter((e) => e.hasLive).map((e) => e.entityId)));
  const selectNew = () => setSelected(new Set(perEntity.filter((e) => !e.hasLive).map((e) => e.entityId)));

  const agg = useMemo(() => {
    const chosen = perEntity.filter((e) => isSelected(e.entityId));
    const lines = chosen.flatMap((e) => e.lines);
    const live = chosen.flatMap((e) => e.liveServices);
    return compareQuoteToBilling(lines, live, maps);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perEntity, maps, selected]);

  if (loading) return null;
  if (perEntity.length === 0 || agg.rows.length === 0) return null;

  const { rows, totals, hasLive } = agg;
  const STATUS = {
    new: { label: 'New', bg: '#dcfce7', fg: '#15803d' },
    removed: { label: 'Removed', bg: '#fee2e2', fg: '#b91c1c' },
    changed: { label: 'Changed', bg: '#fef3c7', fg: '#92400e' },
    same: { label: '', bg: 'transparent', fg: '#94a3b8' },
  };
  const dc = (n) => (n > 0.5 ? '#15803d' : n < -0.5 ? '#b91c1c' : '#64748b');
  const sg = (n) => (n > 0 ? '+' : '');
  const billedCount = perEntity.filter((e) => e.hasLive).length;
  const FilterBtn = ({ onClick, active, children }) => (
    <button onClick={onClick} style={{ fontSize: 11, padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
      border: active ? '1px solid #0f172a' : '1px solid #e5e7eb', background: active ? '#0f172a' : '#fff', color: active ? '#fff' : '#475569' }}>
      {children}
    </button>
  );
  const allSel = selected === null;
  const billedSel = !allSel && selected.size === billedCount && perEntity.filter(e => e.hasLive).every(e => selected.has(e.entityId)) && [...selected].every(id => perEntity.find(e => e.entityId === id)?.hasLive);
  const newSel = !allSel && [...(selected || [])].every(id => !perEntity.find(e => e.entityId === id)?.hasLive) && selected.size === (perEntity.length - billedCount);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-3 mb-3">
      <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">{title}</h3>
      {!hasLive && (
        <p className="text-xs text-amber-700 mb-2">No current live billing in the selected set — this is all new business.</p>
      )}

      {groupMode && (
        <>
          {/* Quick filters */}
          <div className="flex items-center gap-1.5 mb-2 flex-wrap">
            <span className="text-[11px] text-gray-400">Compare:</span>
            <FilterBtn onClick={selectAll} active={allSel}>All ({perEntity.length})</FilterBtn>
            <FilterBtn onClick={selectBilled} active={billedSel}>Already billed ({billedCount})</FilterBtn>
            <FilterBtn onClick={selectNew} active={newSel}>Not yet billed ({perEntity.length - billedCount})</FilterBtn>
          </div>
          {/* Client filters (names only — the figures are in the table above) */}
          <div className="flex flex-wrap gap-2 mb-3">
            {perEntity.map((e) => (
              <label key={e.entityId} className="inline-flex items-center gap-1.5 text-xs cursor-pointer border border-gray-200 rounded-full px-2.5 py-1">
                <input type="checkbox" checked={isSelected(e.entityId)} onChange={() => toggle(e.entityId)} className="w-3 h-3 accent-ocean-600" />
                <span className={isSelected(e.entityId) ? 'text-gray-700' : 'text-gray-400'}>
                  {e.name}{!e.hasLive && <span className="ml-1 text-[9px] text-green-600">new</span>}
                </span>
              </label>
            ))}
          </div>
        </>
      )}

      {/* Per-service breakdown for the selected set */}
      <div className="grid gap-1 text-xs" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr 90px' }}>
        <span className="text-gray-400">Service</span>
        <span className="text-right text-gray-400">Quote (yr)</span>
        <span className="text-right text-gray-400">Live (yr)</span>
        <span className="text-right text-gray-400">Δ (yr)</span>
        <span />
        {rows.map((r) => {
          const st = STATUS[r.status] || STATUS.same;
          return (
            <React.Fragment key={r.id}>
              <span className="text-gray-700 truncate">{r.label}</span>
              <span className="text-right font-mono text-gray-600">{r.quoteAnnual ? fmt(r.quoteAnnual) : '—'}</span>
              <span className="text-right font-mono text-gray-600">{r.liveAnnual ? fmt(r.liveAnnual) : '—'}</span>
              <span className="text-right font-mono" style={{ color: dc(r.deltaAnnual) }}>{r.deltaAnnual ? `${sg(r.deltaAnnual)}${fmt(r.deltaAnnual)}` : '—'}</span>
              <span className="text-right">{st.label && <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 999, background: st.bg, color: st.fg }}>{st.label}</span>}</span>
            </React.Fragment>
          );
        })}
        <span className="text-gray-800 font-semibold border-t border-gray-200 pt-1">Annual total</span>
        <span className="text-right font-mono text-gray-800 font-semibold border-t border-gray-200 pt-1">{fmt(totals.quoteAnnual)}</span>
        <span className="text-right font-mono text-gray-800 font-semibold border-t border-gray-200 pt-1">{fmt(totals.liveAnnual)}</span>
        <span className="text-right font-mono font-semibold border-t border-gray-200 pt-1" style={{ color: dc(totals.deltaAnnual) }}>{sg(totals.deltaAnnual)}{fmt(totals.deltaAnnual)}</span>
        <span className="border-t border-gray-200 pt-1" />
      </div>

      {/* One-line difference at total level */}
      <div className="mt-2 pt-2 border-t border-gray-200 flex items-center justify-between">
        <span className="text-xs text-gray-500">
          Difference (quote vs live){groupMode && selected !== null ? ` · ${(selected.size)} of ${perEntity.length} selected` : ''}
        </span>
        <span className="text-sm font-mono font-semibold" style={{ color: dc(totals.deltaAnnual) }}>
          {sg(totals.deltaAnnual)}{fmt(totals.deltaAnnual)}/yr · {sg(totals.deltaMonthly)}{fmt(totals.deltaMonthly)}/mo{totals.pct != null ? ` · ${sg(totals.pct)}${totals.pct}%` : ''}
        </span>
      </div>
    </div>
  );
}
