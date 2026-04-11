import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { fmt } from './ui';

// Shows current billing baseline vs quoted amounts for an entity.
// Red for increases, green for decreases.
export default function EntityFeesComparison({ entityId, quotedLines }) {
  const [fees, setFees] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!entityId) { setLoading(false); return; }
    supabase.from('entity_fees').select('*').eq('entity_id', entityId)
      .then(({ data }) => { setFees(data || []); setLoading(false); });
  }, [entityId]);

  if (loading) return null;
  if (fees.length === 0) return null;

  // Match by service_id
  const allServiceIds = new Set([
    ...fees.map(f => f.service_id),
    ...quotedLines.map(l => l.id || l.service_id),
  ]);

  const comparisons = Array.from(allServiceIds).map(sid => {
    const fee = fees.find(f => f.service_id === sid);
    const quoted = quotedLines.find(l => (l.id || l.service_id) === sid);
    const currentAnnual = fee ? Number(fee.annual_amount) : 0;
    const quotedAnnual = quoted ? (quoted.annual || Number(quoted.annual_amount) || 0) : 0;
    const delta = quotedAnnual - currentAnnual;
    return {
      service: fee?.description || quoted?.name || quoted?.description || sid,
      current: currentAnnual,
      quoted: quotedAnnual,
      delta,
    };
  }).filter(c => c.current > 0 || c.quoted > 0);

  if (comparisons.length === 0) return null;

  const totalDelta = comparisons.reduce((s, c) => s + c.delta, 0);

  return (
    <div className="bg-white rounded-lg border border-amber-200 p-3 mb-3">
      <h3 className="text-xs font-semibold text-amber-700 mb-2">Current Billing Comparison</h3>
      <div className="grid gap-0.5 text-xs text-gray-400 mb-1" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr' }}>
        <span>Service</span><span className="text-right">Current</span><span className="text-right">Quoted</span><span className="text-right">Delta</span>
      </div>
      {comparisons.map((c, i) => (
        <div key={i} className="grid gap-0.5 text-xs py-1 border-b border-gray-50" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr' }}>
          <span className="text-gray-600 truncate">{c.service}</span>
          <span className="text-right font-mono text-gray-500">{c.current > 0 ? fmt(c.current) : '\u2014'}</span>
          <span className="text-right font-mono text-gray-700">{c.quoted > 0 ? fmt(c.quoted) : '\u2014'}</span>
          <span className={`text-right font-mono font-medium ${c.delta > 0 ? 'text-red-500' : c.delta < 0 ? 'text-green-600' : 'text-gray-400'}`}>
            {c.delta === 0 ? '\u2014' : (c.delta > 0 ? '+' : '') + fmt(c.delta)}
          </span>
        </div>
      ))}
      <div className="grid gap-0.5 text-xs font-medium pt-1 mt-1 border-t border-gray-200" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr' }}>
        <span className="text-gray-700">Total</span>
        <span className="text-right font-mono">{fmt(comparisons.reduce((s, c) => s + c.current, 0))}</span>
        <span className="text-right font-mono">{fmt(comparisons.reduce((s, c) => s + c.quoted, 0))}</span>
        <span className={`text-right font-mono font-bold ${totalDelta > 0 ? 'text-red-500' : totalDelta < 0 ? 'text-green-600' : 'text-gray-400'}`}>
          {totalDelta === 0 ? '\u2014' : (totalDelta > 0 ? '+' : '') + fmt(totalDelta)}
        </span>
      </div>
    </div>
  );
}
