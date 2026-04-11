import React from 'react';
import { fmt } from './ui';

// Cross-entity summary table for group quotes.
// entityTotals: { [entityId]: { lines, annualServices, swAnnual, annualTotal, monthlyGross } }
// entities: array of entity objects
// discounts: { [entityId]: number (%) }
// onDiscountChange: (entityId, pct) => void
// readOnly: boolean (for detail view)
export default function ConsolidationTable({ entities, entityTotals, discounts = {}, onDiscountChange, readOnly = false }) {
  if (!entities?.length) return null;

  // Collect all service IDs across all entities
  const allServiceIds = new Map();
  entities.forEach(e => {
    const totals = entityTotals[e.id];
    if (!totals?.lines) return;
    totals.lines.forEach(l => {
      if (!allServiceIds.has(l.id)) allServiceIds.set(l.id, l.name);
    });
  });

  const serviceRows = Array.from(allServiceIds.entries()); // [[id, name], ...]

  // Per-entity service amounts
  const getAmount = (entityId, serviceId) => {
    const totals = entityTotals[entityId];
    if (!totals?.lines) return 0;
    const line = totals.lines.find(l => l.id === serviceId);
    return line?.annual || 0;
  };

  // Totals
  const entitySubtotals = {};
  const entitySoftware = {};
  const entityDiscounted = {};
  const entityMonthlyDD = {};

  entities.forEach(e => {
    const t = entityTotals[e.id] || {};
    const sub = t.annualServices || 0;
    const sw = t.swAnnual || 0;
    const disc = discounts[e.id] || 0;
    const gross = (sub + sw) * (1 - disc / 100);
    entitySubtotals[e.id] = sub;
    entitySoftware[e.id] = sw;
    entityDiscounted[e.id] = gross;
    entityMonthlyDD[e.id] = Math.round((gross / 12) * 1.2 * 100) / 100;
  });

  const groupAnnual = entities.reduce((s, e) => s + (entityDiscounted[e.id] || 0), 0);
  const groupMonthlyNet = Math.round((groupAnnual / 12) * 100) / 100;
  const groupMonthlyVat = Math.round(groupMonthlyNet * 0.2 * 100) / 100;
  const groupMonthlyDD = Math.round((groupMonthlyNet + groupMonthlyVat) * 100) / 100;

  const colW = entities.length <= 3 ? '1fr' : 'minmax(60px, 1fr)';
  const gridCols = `2fr ${entities.map(() => colW).join(' ')} 80px`;

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
      {/* Header */}
      <div className="grid gap-1 px-3 py-2 bg-gray-50 border-b border-gray-200 text-xs text-gray-500 font-medium" style={{ gridTemplateColumns: gridCols }}>
        <span>Service</span>
        {entities.map(e => <span key={e.id} className="text-right truncate">{e.name}</span>)}
        <span className="text-right">Total</span>
      </div>

      {/* Service rows */}
      {serviceRows.map(([sid, sname]) => {
        const rowTotal = entities.reduce((s, e) => s + getAmount(e.id, sid), 0);
        return (
          <div key={sid} className="grid gap-1 px-3 py-1.5 border-b border-gray-50 text-xs" style={{ gridTemplateColumns: gridCols }}>
            <span className="text-gray-600 truncate">{sname}</span>
            {entities.map(e => {
              const amt = getAmount(e.id, sid);
              return <span key={e.id} className="text-right font-mono text-gray-600">{amt > 0 ? fmt(amt) : '\u2014'}</span>;
            })}
            <span className="text-right font-mono text-gray-700 font-medium">{fmt(rowTotal)}</span>
          </div>
        );
      })}

      {/* Software row */}
      <div className="grid gap-1 px-3 py-1.5 border-b border-gray-100 text-xs bg-gray-50" style={{ gridTemplateColumns: gridCols }}>
        <span className="text-gray-500 font-medium">Software</span>
        {entities.map(e => <span key={e.id} className="text-right font-mono text-gray-500">{entitySoftware[e.id] > 0 ? fmt(entitySoftware[e.id]) : '\u2014'}</span>)}
        <span className="text-right font-mono text-gray-600 font-medium">{fmt(entities.reduce((s, e) => s + (entitySoftware[e.id] || 0), 0))}</span>
      </div>

      {/* Subtotals */}
      <div className="grid gap-1 px-3 py-1.5 border-b border-gray-200 text-xs font-medium" style={{ gridTemplateColumns: gridCols }}>
        <span className="text-gray-700">Subtotal</span>
        {entities.map(e => <span key={e.id} className="text-right font-mono text-gray-700">{fmt((entitySubtotals[e.id] || 0) + (entitySoftware[e.id] || 0))}</span>)}
        <span className="text-right font-mono text-ocean-600">{fmt(entities.reduce((s, e) => s + (entitySubtotals[e.id] || 0) + (entitySoftware[e.id] || 0), 0))}</span>
      </div>

      {/* Discount row */}
      <div className="grid gap-1 px-3 py-1.5 border-b border-gray-100 text-xs" style={{ gridTemplateColumns: gridCols }}>
        <span className="text-gray-500">Discount</span>
        {entities.map(e => (
          <span key={e.id} className="text-right">
            {readOnly ? (
              <span className="font-mono text-gray-500">{discounts[e.id] || 0}%</span>
            ) : (
              <input
                type="number"
                value={discounts[e.id] || 0}
                onChange={(ev) => onDiscountChange?.(e.id, parseFloat(ev.target.value) || 0)}
                min={0} max={100}
                className="w-12 text-xs text-right font-mono border border-gray-200 rounded px-1 py-0.5"
              />
            )}
          </span>
        ))}
        <span></span>
      </div>

      {/* Net after discount */}
      <div className="grid gap-1 px-3 py-1.5 border-b border-gray-200 text-xs font-medium" style={{ gridTemplateColumns: gridCols }}>
        <span className="text-gray-700">Net (after discount)</span>
        {entities.map(e => <span key={e.id} className="text-right font-mono text-gray-700">{fmt(entityDiscounted[e.id])}</span>)}
        <span className="text-right font-mono text-ocean-700 font-bold">{fmt(groupAnnual)}</span>
      </div>

      {/* Monthly DD per entity */}
      <div className="grid gap-1 px-3 py-1.5 border-b border-gray-100 text-xs" style={{ gridTemplateColumns: gridCols }}>
        <span className="text-gray-500">Monthly DD (each)</span>
        {entities.map(e => <span key={e.id} className="text-right font-mono text-gray-500">{fmt(entityMonthlyDD[e.id])}</span>)}
        <span></span>
      </div>

      {/* Group Monthly DD */}
      <div className="grid gap-1 px-3 py-2 bg-ocean-700 text-white text-sm font-bold rounded-b-lg" style={{ gridTemplateColumns: gridCols }}>
        <span>Monthly DD (Inc VAT)</span>
        {entities.map(e => <span key={e.id}></span>)}
        <span className="text-right font-mono text-sun-300">{fmt(groupMonthlyDD)}</span>
      </div>
    </div>
  );
}
