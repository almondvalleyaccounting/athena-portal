import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { fmt, Btn } from './ui';
import { exportQboCsv } from '../lib/qboExport';

export default function CommitToLiveModal({ quote, lineItems, profile, onCommitted, onClose }) {
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState('');
  const [generateQbo, setGenerateQbo] = useState(false);

  const recurring = (lineItems || []).filter((l) => l.is_recurring);
  const clientName = quote?.relationship_group || 'Unnamed Client';

  const handleCommit = async () => {
    setCommitting(true);
    setError('');
    try {
      // 1. Build services JSONB from recurring line items
      const services = recurring.map((l) => ({
        service_id: l.service_id,
        description: l.description,
        annual_amount: Number(l.annual_amount) || 0,
        monthly_amount: Number(l.monthly_amount) || 0,
        detail: l.detail || null,
      }));

      // 2. Insert into live_billing
      const { data: billingRow, error: billingErr } = await supabase
        .from('live_billing')
        .insert({
          entity_id: quote.entity_id || quote.primary_entity_id,
          quote_id: quote.id,
          billing_type: 'recurring',
          monthly_net: Number(quote.monthly_net) || 0,
          monthly_vat: Number(quote.monthly_vat) || 0,
          monthly_gross: Number(quote.monthly_gross) || 0,
          annual_total: Number(quote.annual_total) || 0,
          services,
          status: 'active',
          committed_at: new Date().toISOString(),
          committed_by: profile.id,
        })
        .select()
        .single();

      if (billingErr) throw billingErr;

      // 3. Upsert into entity_fees -- one row per line item
      const feeRows = recurring.map((l) => ({
        entity_id: quote.entity_id || quote.primary_entity_id,
        service_id: l.service_id,
        description: l.description,
        annual_amount: Number(l.annual_amount) || 0,
        monthly_amount: Number(l.monthly_amount) || 0,
        source: 'committed_quote',
        source_quote_id: quote.id,
      }));

      if (feeRows.length > 0) {
        const { error: feesErr } = await supabase.from('entity_fees').upsert(feeRows, {
          onConflict: 'entity_id,service_id',
        });
        if (feesErr) throw feesErr;
      }

      // 4. Update quote: committed_at, committed_by, status
      const { error: quoteErr } = await supabase
        .from('quotes')
        .update({
          committed_at: new Date().toISOString(),
          committed_by: profile.id,
          status: 'committed',
        })
        .eq('id', quote.id);

      if (quoteErr) throw quoteErr;

      // 5. Audit log
      await supabase.from('audit_log').insert({
        user_id: profile.id,
        action: 'commit_to_live',
        entity_type: 'quote',
        entity_id: quote.id,
        detail: {
          from: quote.status,
          to: 'committed',
          billing_id: billingRow?.id,
          services_count: services.length,
          monthly_gross: Number(quote.monthly_gross),
        },
      });

      // 6. Optionally generate QBO CSV
      if (generateQbo) {
        const qboItems = recurring.map((l) => ({
          service_id: l.service_id,
          description: l.description,
          qty: 1,
          rate: Number(l.monthly_amount) || 0,
          amount: Number(l.monthly_amount) || 0,
        }));
        exportQboCsv(clientName, qboItems, true);
      }

      onCommitted();
    } catch (e) {
      setError(e.message || 'Failed to commit to live billing');
    }
    setCommitting(false);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl max-w-lg w-full mx-4 max-h-[90vh] overflow-auto">
        {/* Header */}
        <div className="p-4 border-b border-gray-200">
          <h2 className="text-lg font-bold text-ocean-700">Commit to Live Billing</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            This will create a live billing record and update entity fees.
          </p>
        </div>

        {/* Quote Summary */}
        <div className="p-4 space-y-3">
          <div className="bg-gray-50 rounded-lg p-3">
            <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Quote Summary</h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <span className="text-gray-400">Client</span>
              <span className="text-gray-700 font-medium">{clientName}</span>
              <span className="text-gray-400">Quote Ref</span>
              <span className="text-gray-700">{quote.quote_ref}</span>
              <span className="text-gray-400">Monthly DD (Gross)</span>
              <span className="text-ocean-700 font-mono font-semibold">{fmt(quote.monthly_gross)}</span>
              <span className="text-gray-400">Annual Total</span>
              <span className="text-ocean-700 font-mono font-semibold">{fmt(quote.annual_total)}</span>
            </div>
          </div>

          {/* Service Line Items */}
          <div className="bg-gray-50 rounded-lg p-3">
            <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">
              Services Being Committed ({recurring.length})
            </h3>
            <div className="space-y-1 max-h-48 overflow-auto">
              {recurring.map((l, i) => (
                <div key={i} className="flex justify-between text-xs py-1 border-b border-gray-100 last:border-0">
                  <span className="text-gray-600">{l.description}</span>
                  <span className="font-mono text-gray-700">{fmt(l.monthly_amount)}/mo</span>
                </div>
              ))}
            </div>
          </div>

          {/* QBO Option */}
          <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={generateQbo}
              onChange={(e) => setGenerateQbo(e.target.checked)}
              className="w-4 h-4 accent-ocean-600"
            />
            Generate QBO import CSV on commit
          </label>

          {error && <div className="text-xs text-red-600 bg-red-50 rounded p-2">{error}</div>}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 flex justify-end gap-2">
          <Btn onClick={onClose} variant="ghost" disabled={committing}>
            Cancel
          </Btn>
          <Btn onClick={handleCommit} variant="primary" disabled={committing}>
            {committing ? 'Committing...' : 'Commit to Live'}
          </Btn>
        </div>
      </div>
    </div>
  );
}
