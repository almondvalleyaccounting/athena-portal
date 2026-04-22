import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { fmt, Btn } from './ui';
import { exportQboCsv } from '../lib/qboExport';
import { pushToQbo, getQboStatus } from '../lib/qboApi';

export default function CommitToLiveModal({ quote, lineItems, profile, onCommitted, onClose }) {
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState('');
  const [qboAction, setQboAction] = useState('none'); // 'none' | 'push' | 'csv'
  const [qboConnected, setQboConnected] = useState(false);
  const [pushStatus, setPushStatus] = useState(''); // '' | 'pushing' | 'pushed' | 'push_error'
  const [staff, setStaff] = useState([]);
  // Per-line allocations — keyed by line index, { fee_earner_id, fee_earner_manager_id }.
  const [allocations, setAllocations] = useState({});

  const recurring = (lineItems || []).filter((l) => l.is_recurring);
  const clientName = quote?.relationship_group || 'Unnamed Client';
  const entityId = quote?.entity_id || quote?.primary_entity_id;

  // Check QBO connection + load staff + prefill any existing allocations for this entity.
  useEffect(() => {
    getQboStatus()
      .then((data) => {
        if (data?.connected) {
          setQboConnected(true);
          setQboAction('push');
        }
      })
      .catch(() => {});

    (async () => {
      const { data: staffRows } = await supabase
        .from('staff_profiles')
        .select('id, name, email')
        .order('name');
      const clean = (staffRows || []).map((s) => ({ ...s, name: s.name || s.email }));
      setStaff(clean);

      // Prefill existing allocations so re-commits don't wipe prior work.
      if (entityId && recurring.length > 0) {
        const { data: existing } = await supabase
          .from('client_service_allocations')
          .select('service_id, fee_earner_id, fee_earner_manager_id')
          .eq('entity_id', entityId)
          .in('service_id', recurring.map((l) => l.service_id).filter(Boolean));
        if (existing?.length) {
          const next = {};
          recurring.forEach((l, idx) => {
            const hit = existing.find((e) => e.service_id === l.service_id);
            if (hit) next[idx] = {
              fee_earner_id: hit.fee_earner_id || '',
              fee_earner_manager_id: hit.fee_earner_manager_id || '',
            };
          });
          setAllocations(next);
        }
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setAlloc = (idx, patch) => {
    setAllocations((prev) => {
      const cur = prev[idx] || { fee_earner_id: '', fee_earner_manager_id: '' };
      const next = { ...cur, ...patch };
      // Auto-mirror manager to match fee earner on first set, if manager empty.
      if (patch.fee_earner_id && !cur.fee_earner_manager_id) {
        next.fee_earner_manager_id = patch.fee_earner_id;
      }
      return { ...prev, [idx]: next };
    });
  };

  const unallocatedCount = recurring.filter((_, idx) => !allocations[idx]?.fee_earner_id).length;

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

      // 3b. Upsert fee earner allocations for any line the user chose.
      //     Lines left blank are skipped — they can be set later from the
      //     client detail page.
      const allocRows = recurring
        .map((l, idx) => ({
          entity_id: entityId,
          service_id: l.service_id,
          fee_earner_id: allocations[idx]?.fee_earner_id || null,
          fee_earner_manager_id: allocations[idx]?.fee_earner_manager_id || null,
        }))
        .filter((r) => r.service_id && (r.fee_earner_id || r.fee_earner_manager_id));
      if (allocRows.length > 0) {
        const { error: allocErr } = await supabase
          .from('client_service_allocations')
          .upsert(allocRows, { onConflict: 'entity_id,service_id' });
        if (allocErr) throw allocErr;
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

      // 6. QBO action: push or CSV
      if (qboAction === 'push' && billingRow?.id) {
        setPushStatus('pushing');
        try {
          const pushResult = await pushToQbo(billingRow.id, profile.id);
          if (pushResult?.success) {
            setPushStatus('pushed');
          } else {
            setPushStatus('push_error');
            setError(`Committed successfully but QBO push failed: ${pushResult?.error || 'Unknown error'}. You can push from the Billing page later.`);
            setCommitting(false);
            // Still call onCommitted since the commit itself succeeded
            onCommitted();
            return;
          }
        } catch (pushErr) {
          setPushStatus('push_error');
          setError(`Committed successfully but QBO push failed: ${pushErr.message}. You can push from the Billing page later.`);
          setCommitting(false);
          onCommitted();
          return;
        }
      } else if (qboAction === 'csv') {
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

          {/* Service Line Items + per-service fee earner allocation.
              Allocation is the point of commit — this is how practice-wide
              fee attribution reports get populated. Unallocated rows are
              allowed (non-blocking) but counted in the footer so it's
              visible they need follow-up from the client detail page. */}
          <div className="bg-gray-50 rounded-lg p-3">
            <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">
              Services & fee earner allocation ({recurring.length})
            </h3>
            <div className="space-y-2 max-h-72 overflow-auto">
              {recurring.map((l, i) => {
                const a = allocations[i] || {};
                return (
                  <div key={i} className="bg-white rounded border border-gray-100 p-2">
                    <div className="flex justify-between text-xs mb-1.5">
                      <span className="text-gray-700 font-medium">{l.service_id || l.description}</span>
                      <span className="font-mono text-gray-700">{fmt(l.monthly_amount)}/mo</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-gray-400 block mb-0.5">Fee earner</label>
                        <select
                          value={a.fee_earner_id || ''}
                          onChange={(e) => setAlloc(i, { fee_earner_id: e.target.value })}
                          className="w-full text-xs border border-gray-200 rounded px-1.5 py-1"
                        >
                          <option value="">— select —</option>
                          {staff.map((s) => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-gray-400 block mb-0.5">Manager</label>
                        <select
                          value={a.fee_earner_manager_id || ''}
                          onChange={(e) => setAlloc(i, { fee_earner_manager_id: e.target.value })}
                          className="w-full text-xs border border-gray-200 rounded px-1.5 py-1"
                        >
                          <option value="">— select —</option>
                          {staff.map((s) => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {unallocatedCount > 0 && (
              <p className="text-xs text-amber-700 mt-2">
                {unallocatedCount} service{unallocatedCount === 1 ? '' : 's'} unallocated — you can set these later from the client page.
              </p>
            )}
          </div>

          {/* QBO Options */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-gray-500 uppercase">QuickBooks Export</p>
            {qboConnected && (
              <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
                <input
                  type="radio"
                  name="qboAction"
                  checked={qboAction === 'push'}
                  onChange={() => setQboAction('push')}
                  className="w-4 h-4 accent-ocean-600"
                />
                <span>Push directly to QBO</span>
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 ml-1" title="Connected" />
              </label>
            )}
            <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
              <input
                type="radio"
                name="qboAction"
                checked={qboAction === 'csv'}
                onChange={() => setQboAction('csv')}
                className="w-4 h-4 accent-ocean-600"
              />
              Download QBO import CSV
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
              <input
                type="radio"
                name="qboAction"
                checked={qboAction === 'none'}
                onChange={() => setQboAction('none')}
                className="w-4 h-4 accent-ocean-600"
              />
              Skip QBO export
            </label>
            {pushStatus === 'pushing' && (
              <p className="text-xs text-ocean-600">Pushing to QBO...</p>
            )}
            {pushStatus === 'pushed' && (
              <p className="text-xs text-green-600">Successfully pushed to QBO</p>
            )}
          </div>

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
