import React from 'react';
import { fmt } from './ui';

// Cross-entity summary table for group quotes.
// entityTotals: { [entityId]: { lines, annualServices, swAnnual, annualTotal, monthlyGross } }
// entities: array of entity objects
// discounts: { [entityId]: number (%) }
// onDiscountChange: (entityId, pct) => void
// readOnly: boolean (for detail view)
// liveByEntity (optional): { [entityId]: monthlyNet } — current live billing.
// When provided, a 'Current billing' + 'Difference' row render under the
// blue Monthly Direct Debit row, comparing quote vs live per column.
export default function ConsolidationTable({ entities, entityTotals, discounts = {}, onDiscountChange, readOnly = false, liveByEntity = null }) {
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
  const entityAnnualBeforeDiscount = {};
  const entityDiscountAmt = {};
  const entityAnnualAfterDiscount = {};
  const entityMonthlyNet = {};
  const entityMonthlyVat = {};
  const entityMonthlyGross = {};

  entities.forEach(e => {
    const t = entityTotals[e.id] || {};
    const sub = t.annualServices || 0;
    const sw = t.swAnnual || 0;
    const annualBefore = sub + sw;
    const disc = discounts[e.id] || 0;
    const discAmt = Math.round(annualBefore * (disc / 100) * 100) / 100;
    const annualAfter = annualBefore - discAmt;
    const monthlyNet = Math.round((annualAfter / 12) * 100) / 100;
    const monthlyVat = Math.round(monthlyNet * 0.2 * 100) / 100;
    const monthlyGross = Math.round((monthlyNet + monthlyVat) * 100) / 100;

    entitySubtotals[e.id] = sub;
    entitySoftware[e.id] = sw;
    entityAnnualBeforeDiscount[e.id] = annualBefore;
    entityDiscountAmt[e.id] = discAmt;
    entityAnnualAfterDiscount[e.id] = annualAfter;
    entityMonthlyNet[e.id] = monthlyNet;
    entityMonthlyVat[e.id] = monthlyVat;
    entityMonthlyGross[e.id] = monthlyGross;
  });

  const groupAnnualBefore = entities.reduce((s, e) => s + (entityAnnualBeforeDiscount[e.id] || 0), 0);
  const groupDiscountAmt = entities.reduce((s, e) => s + (entityDiscountAmt[e.id] || 0), 0);
  const groupAnnualAfter = entities.reduce((s, e) => s + (entityAnnualAfterDiscount[e.id] || 0), 0);
  const groupMonthlyNet = entities.reduce((s, e) => s + (entityMonthlyNet[e.id] || 0), 0);
  const groupMonthlyVat = entities.reduce((s, e) => s + (entityMonthlyVat[e.id] || 0), 0);
  const groupMonthlyGross = entities.reduce((s, e) => s + (entityMonthlyGross[e.id] || 0), 0);

  const numW = 'minmax(80px, 1fr)';
  const gridCols = `2fr ${entities.map(() => numW).join(' ')} minmax(80px, 1fr)`;

  return (
    <div className="space-y-3">
      {/* Annual Section */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
        {/* Header */}
        <div className="grid gap-1 px-3 py-2 bg-gray-50 border-b border-gray-200 text-xs text-gray-500 font-medium" style={{ gridTemplateColumns: gridCols }}>
          <span>Service</span>
          {entities.map(e => <span key={e.id} className="text-right truncate">{e.name}</span>)}
          <span className="text-right">Group Total</span>
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
          <span className="text-gray-700">Annual Subtotal</span>
          {entities.map(e => <span key={e.id} className="text-right font-mono text-gray-700">{fmt(entityAnnualBeforeDiscount[e.id])}</span>)}
          <span className="text-right font-mono text-ocean-600">{fmt(groupAnnualBefore)}</span>
        </div>

        {/* Discount row */}
        <div className="grid gap-1 px-3 py-1.5 border-b border-gray-100 text-xs" style={{ gridTemplateColumns: gridCols }}>
          <span className="text-gray-500">Discount (%)</span>
          {entities.map(e => (
            <div key={e.id} className="text-right">
              {readOnly ? (
                <span className="font-mono text-gray-500">{discounts[e.id] || 0}%</span>
              ) : (
                <input
                  type="number"
                  value={discounts[e.id] || 0}
                  onChange={(ev) => onDiscountChange?.(e.id, parseFloat(ev.target.value) || 0)}
                  min={0} max={100}
                  className="w-14 text-xs text-right font-mono border border-gray-200 rounded px-1 py-0.5"
                />
              )}
              <div className="text-[10px] font-mono text-gray-400 mt-0.5">
                {entityDiscountAmt[e.id] > 0 ? `\u2212${fmt(entityDiscountAmt[e.id])}` : '\u2014'}
              </div>
            </div>
          ))}
          <div className="text-right">
            <span className="font-mono text-gray-500 text-xs">&nbsp;</span>
            <div className="text-[10px] font-mono text-gray-400 mt-0.5">
              {groupDiscountAmt > 0 ? `\u2212${fmt(groupDiscountAmt)}` : '\u2014'}
            </div>
          </div>
        </div>

        {/* Annual After Discount — headline (matches the monthly DD row) */}
        <div className={`grid gap-1 px-3 py-2.5 bg-ocean-700 text-white text-sm font-bold ${liveByEntity ? '' : 'rounded-b-lg'}`} style={{ gridTemplateColumns: gridCols }}>
          <span>Annual After Discount</span>
          {entities.map(e => <span key={e.id} className="text-right font-mono text-sun-300">{fmt(entityAnnualAfterDiscount[e.id])}</span>)}
          <span className="text-right font-mono text-sun-300">{fmt(groupAnnualAfter)}</span>
        </div>

        {/* Annual comparison vs current billing (net basis, per column) */}
        {liveByEntity && (() => {
          const liveAnnual = (id) => (liveByEntity[id] != null ? Math.round(liveByEntity[id] * 12 * 100) / 100 : null);
          const groupLiveAnnual = entities.reduce((s, e) => s + (liveAnnual(e.id) || 0), 0);
          const diff = (id) => Math.round(((entityAnnualAfterDiscount[id] || 0) - (liveAnnual(id) || 0)) * 100) / 100;
          const groupDiff = Math.round((groupAnnualAfter - groupLiveAnnual) * 100) / 100;
          const dc = (n) => (n > 0.5 ? '#15803d' : n < -0.5 ? '#b91c1c' : '#94a3b8');
          const sgn = (n) => (n > 0 ? '+' : '');
          return (
            <>
              <div className="grid gap-1 px-3 py-1.5 border-t border-gray-100 text-xs" style={{ gridTemplateColumns: gridCols }}>
                <span className="text-gray-500">Current billing (annual, net)</span>
                {entities.map(e => <span key={e.id} className="text-right font-mono text-gray-500">{liveAnnual(e.id) != null ? fmt(liveAnnual(e.id)) : '—'}</span>)}
                <span className="text-right font-mono text-gray-600 font-medium">{groupLiveAnnual > 0 ? fmt(groupLiveAnnual) : '—'}</span>
              </div>
              <div className="grid gap-1 px-3 py-1.5 border-t border-gray-100 text-xs font-medium rounded-b-lg" style={{ gridTemplateColumns: gridCols }}>
                <span className="text-gray-700">Difference</span>
                {entities.map(e => {
                  const d = diff(e.id);
                  const isNew = liveAnnual(e.id) == null;
                  return <span key={e.id} className="text-right font-mono" style={{ color: dc(d) }} title={isNew ? 'No current billing — new business' : undefined}>{sgn(d)}{fmt(d)}{isNew ? '*' : ''}</span>;
                })}
                <span className="text-right font-mono font-bold" style={{ color: dc(groupDiff) }}>{sgn(groupDiff)}{fmt(groupDiff)}</span>
              </div>
            </>
          );
        })()}
      </div>

      {/* Monthly Section */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
        <div className="grid gap-1 px-3 py-2 bg-gray-50 border-b border-gray-200 text-xs text-gray-500 font-medium" style={{ gridTemplateColumns: gridCols }}>
          <span>Monthly Breakdown</span>
          {entities.map(e => <span key={e.id} className="text-right truncate">{e.name}</span>)}
          <span className="text-right">Group Total</span>
        </div>

        {/* Monthly Net */}
        <div className="grid gap-1 px-3 py-1.5 border-b border-gray-50 text-xs" style={{ gridTemplateColumns: gridCols }}>
          <span className="text-gray-600">Monthly Net</span>
          {entities.map(e => <span key={e.id} className="text-right font-mono text-gray-600">{fmt(entityMonthlyNet[e.id])}</span>)}
          <span className="text-right font-mono text-gray-700 font-medium">{fmt(groupMonthlyNet)}</span>
        </div>

        {/* VAT */}
        <div className="grid gap-1 px-3 py-1.5 border-b border-gray-100 text-xs" style={{ gridTemplateColumns: gridCols }}>
          <span className="text-gray-500">VAT (20%)</span>
          {entities.map(e => <span key={e.id} className="text-right font-mono text-gray-500">{fmt(entityMonthlyVat[e.id])}</span>)}
          <span className="text-right font-mono text-gray-600 font-medium">{fmt(groupMonthlyVat)}</span>
        </div>

        {/* Monthly Gross per entity */}
        <div className="grid gap-1 px-3 py-1.5 border-b border-gray-200 text-xs font-medium" style={{ gridTemplateColumns: gridCols }}>
          <span className="text-gray-700">Monthly Gross (Inc VAT)</span>
          {entities.map(e => <span key={e.id} className="text-right font-mono text-gray-700">{fmt(entityMonthlyGross[e.id])}</span>)}
          <span className="text-right font-mono text-ocean-600 font-bold">{fmt(groupMonthlyGross)}</span>
        </div>

        {/* Headline Monthly Direct Debit */}
        <div className={`grid gap-1 px-3 py-2.5 bg-ocean-700 text-white text-sm font-bold ${liveByEntity ? '' : 'rounded-b-lg'}`} style={{ gridTemplateColumns: gridCols }}>
          <span>Monthly Direct Debit</span>
          {entities.map(e => <span key={e.id} className="text-right font-mono text-sun-300">{fmt(entityMonthlyGross[e.id])}</span>)}
          <span className="text-right font-mono text-sun-300">{fmt(groupMonthlyGross)}</span>
        </div>

        {/* Comparison vs current live billing (per column), under the blue row */}
        {liveByEntity && (() => {
          const liveGross = (id) => (liveByEntity[id] != null ? Math.round(liveByEntity[id] * 1.2 * 100) / 100 : null);
          const groupLiveGross = entities.reduce((s, e) => s + (liveGross(e.id) || 0), 0);
          const diff = (id) => Math.round(((entityMonthlyGross[id] || 0) - (liveGross(id) || 0)) * 100) / 100;
          const groupDiff = Math.round((groupMonthlyGross - groupLiveGross) * 100) / 100;
          const dc = (n) => (n > 0.5 ? '#15803d' : n < -0.5 ? '#b91c1c' : '#94a3b8');
          const sgn = (n) => (n > 0 ? '+' : '');
          return (
            <>
              <div className="grid gap-1 px-3 py-1.5 border-t border-gray-100 text-xs" style={{ gridTemplateColumns: gridCols }}>
                <span className="text-gray-500">Current billing (DD)</span>
                {entities.map(e => (
                  <span key={e.id} className="text-right font-mono text-gray-500">
                    {liveGross(e.id) != null ? fmt(liveGross(e.id)) : '—'}
                  </span>
                ))}
                <span className="text-right font-mono text-gray-600 font-medium">{groupLiveGross > 0 ? fmt(groupLiveGross) : '—'}</span>
              </div>
              <div className="grid gap-1 px-3 py-1.5 border-t border-gray-100 text-xs font-medium rounded-b-lg" style={{ gridTemplateColumns: gridCols }}>
                <span className="text-gray-700">Difference</span>
                {entities.map(e => {
                  const d = diff(e.id);
                  const isNew = liveGross(e.id) == null;
                  return (
                    <span key={e.id} className="text-right font-mono" style={{ color: dc(d) }} title={isNew ? 'No current billing — new business' : undefined}>
                      {sgn(d)}{fmt(d)}{isNew ? '*' : ''}
                    </span>
                  );
                })}
                <span className="text-right font-mono font-bold" style={{ color: dc(groupDiff) }}>{sgn(groupDiff)}{fmt(groupDiff)}</span>
              </div>
            </>
          );
        })()}
      </div>
    </div>
  );
}
