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

  // Two-phase QBO push: after the DB commit we fetch a dry-run plan and show
  // a confirmation step before any QBO writes happen.
  const [phase, setPhase] = useState('form'); // 'form' | 'confirm'
  const [plan, setPlan] = useState(null);
  const [committedBillingId, setCommittedBillingId] = useState(null);
  const [sendSetupNow, setSendSetupNow] = useState(false);
  const [recurringStart, setRecurringStart] = useState('');
  // When there's no client email on file: emails from other group members to
  // pick from, plus a manually chosen/entered one for this push.
  const [groupEmails, setGroupEmails] = useState([]); // [{ email, name }]
  const [chosenEmail, setChosenEmail] = useState('');
  const [chosenEmailIsNew, setChosenEmailIsNew] = useState(false);
  const [dueDays, setDueDays] = useState(14); // invoice due-date offset, default 14

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

      // 6. QBO action: push (with confirmation) or CSV.
      //    For a push we fetch a read-only plan and move to the confirm
      //    phase — nothing is written to QBO until the user confirms.
      if (qboAction === 'push' && billingRow?.id) {
        try {
          const hasSetupLines = (lineItems || []).some((l) => !l.is_recurring);
          const planResult = await pushToQbo(billingRow.id, profile.id, {
            mode: 'recurring_template',
            quoteId: quote.id,
            alsoPushSetup: hasSetupLines,
            dryRun: true,
          });
          if (planResult?.success) {
            setPlan(planResult.plan);
            setCommittedBillingId(billingRow.id);
            setRecurringStart(planResult.plan?.recurring?.next_run_date || '');
            if (planResult.plan?.due_date_offset_days != null) setDueDays(planResult.plan.due_date_offset_days);
            // No email on file + part of a group → offer other group emails.
            if (planResult.plan?.setup_invoice && !planResult.plan.setup_invoice.has_email && quote.group_id) {
              await loadGroupEmails();
            }
            setPhase('confirm');
            setCommitting(false);
            return; // wait for the user to confirm the push
          }
          setError(`Committed, but couldn't build the QBO plan: ${planResult?.error || 'Unknown error'}. You can push from the Billing page later.`);
          setCommitting(false);
          onCommitted();
          return;
        } catch (planErr) {
          setError(`Committed, but couldn't build the QBO plan: ${planErr.message}. You can push from the Billing page later.`);
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

  // Load billing/prospect emails from other entities in this quote's group,
  // to offer when the client has no email on file.
  const loadGroupEmails = async () => {
    try {
      const { data: members } = await supabase
        .from('billing_group_members')
        .select('entity_id')
        .eq('group_id', quote.group_id);
      const ids = (members || []).map((m) => m.entity_id).filter((id) => id && id !== entityId);
      if (ids.length === 0) return;
      const { data: ents } = await supabase
        .from('entities')
        .select('id, name, billing_email, prospect_email')
        .in('id', ids);
      const seen = new Set();
      const emails = [];
      for (const e of ents || []) {
        const email = e.billing_email || e.prospect_email;
        if (email && !seen.has(email)) {
          seen.add(email);
          emails.push({ email, name: e.name });
        }
      }
      setGroupEmails(emails);
    } catch { /* non-blocking */ }
  };

  // Resolved email for the setup invoice: whatever's on file, else the user's
  // pick/entry from the group/manual chooser.
  const effectiveSetupEmail = plan?.setup_invoice?.email || chosenEmail || '';

  // Confirm phase: execute the real QBO push with the user's choices.
  const handleConfirmPush = async () => {
    setCommitting(true);
    setError('');
    setPushStatus('pushing');
    try {
      // Persist a newly-entered email as this client's billing email so it's
      // on file for next time (group-picked emails are used one-off only).
      if (chosenEmail && chosenEmailIsNew && entityId) {
        await supabase.from('entities').update({ billing_email: chosenEmail }).eq('id', entityId);
      }
      const hasSetupLines = (lineItems || []).some((l) => !l.is_recurring);
      const result = await pushToQbo(committedBillingId, profile.id, {
        mode: 'recurring_template',
        quoteId: quote.id,
        alsoPushSetup: hasSetupLines,
        sendSetupNow,
        recurringStartDate: recurringStart || undefined,
        billEmail: effectiveSetupEmail || undefined,
        dueDateOffsetDays: Number.isFinite(Number(dueDays)) ? Number(dueDays) : undefined,
      });
      if (result?.success) {
        setPushStatus('pushed');
        onCommitted();
      } else {
        setPushStatus('push_error');
        setError(`QBO push failed: ${result?.error || 'Unknown error'}. The commit is saved — you can push from the Billing page later.`);
      }
    } catch (pushErr) {
      setPushStatus('push_error');
      setError(`QBO push failed: ${pushErr.message}. The commit is saved — you can push from the Billing page later.`);
    }
    setCommitting(false);
  };

  // Commit is already saved; just close without pushing to QBO.
  const handleSkipPush = () => onCommitted();

  // Cancel out of the whole process: undo the commit we just made — remove
  // the live_billing record and put the quote back to Accepted — then close.
  const handleCancelCommit = async () => {
    setCommitting(true);
    setError('');
    try {
      if (committedBillingId) {
        await supabase.from('live_billing').delete().eq('id', committedBillingId);
      }
      await supabase
        .from('quotes')
        .update({ status: 'accepted', committed_at: null, committed_by: null })
        .eq('id', quote.id);
      onCommitted(); // refresh the parent so it shows Accepted again
    } catch (e) {
      setError(e.message || 'Failed to cancel');
      setCommitting(false);
    }
  };

  // Re-fetch the dry-run plan (e.g. after fixing a service→QBO mapping).
  const handleRefreshPlan = async () => {
    setCommitting(true);
    setError('');
    try {
      const hasSetupLines = (lineItems || []).some((l) => !l.is_recurring);
      const planResult = await pushToQbo(committedBillingId, profile.id, {
        mode: 'recurring_template',
        quoteId: quote.id,
        alsoPushSetup: hasSetupLines,
        dryRun: true,
      });
      if (planResult?.success) {
        setPlan(planResult.plan);
        setRecurringStart(planResult.plan?.recurring?.next_run_date || recurringStart);
      } else {
        setError(planResult?.error || 'Could not refresh plan');
      }
    } catch (e) {
      setError(e.message || 'Could not refresh plan');
    }
    setCommitting(false);
  };

  if (phase === 'confirm') {
    const c = plan?.customer;
    const setup = plan?.setup_invoice;
    const rec = plan?.recurring;
    const missing = plan?.missing_mappings || [];
    return (
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
        <div className="bg-white rounded-xl shadow-xl max-w-lg w-full mx-4 max-h-[90vh] overflow-auto">
          <div className="p-4 border-b border-gray-200">
            <h2 className="text-lg font-bold text-ocean-700">Confirm QuickBooks push</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              The live billing record is saved. Review what will be sent to QBO, then confirm.
            </p>
          </div>

          <div className="p-4 space-y-3">
            {/* Customer */}
            <div className="bg-gray-50 rounded-lg p-3 text-xs">
              <h3 className="font-semibold text-gray-500 uppercase mb-1">Customer</h3>
              {c?.action === 'create' ? (
                <p className="text-gray-700">
                  <span className="text-green-700 font-medium">New customer</span> will be created: {c?.name}
                </p>
              ) : (
                <p className="text-gray-700">
                  Using <span className="font-medium">existing customer</span>: {c?.name}
                </p>
              )}
            </div>

            {/* Payment terms — invoice due-date offset (default 14 days). */}
            <div className="bg-gray-50 rounded-lg p-3 text-xs flex items-center gap-2">
              <h3 className="font-semibold text-gray-500 uppercase">Payment terms</h3>
              <span className="text-gray-600">Due in</span>
              <input
                type="number"
                min="0"
                value={dueDays}
                onChange={(e) => setDueDays(e.target.value)}
                className="w-16 text-xs border border-gray-200 rounded px-1.5 py-1"
              />
              <span className="text-gray-600">days from the invoice date</span>
            </div>

            {/* Setup invoice */}
            {setup && (
              <div className="bg-gray-50 rounded-lg p-3 text-xs">
                <h3 className="font-semibold text-gray-500 uppercase mb-1">One-off setup invoice</h3>
                <div className="space-y-0.5 mb-2">
                  {setup.lines.map((l, i) => (
                    <div key={i} className="flex justify-between text-gray-700">
                      <span>{l.description}</span>
                      <span className="font-mono">{fmt(l.amount)}</span>
                    </div>
                  ))}
                  <div className="flex justify-between text-gray-800 font-semibold border-t border-gray-200 pt-0.5">
                    <span>Total</span>
                    <span className="font-mono">{fmt(setup.total)}</span>
                  </div>
                </div>
                {/* No email on file → let the user pick a group email or add one. */}
                {!setup.has_email && !chosenEmail && (
                  <div className="mb-2 space-y-1.5 border-t border-gray-200 pt-2">
                    <p className="text-amber-700">No client email on file.</p>
                    {groupEmails.length > 0 && (
                      <div>
                        <label className="text-gray-400 block mb-0.5">Use an email from the group</label>
                        <select
                          value=""
                          onChange={(e) => { if (e.target.value) { setChosenEmail(e.target.value); setChosenEmailIsNew(false); } }}
                          className="w-full text-xs border border-gray-200 rounded px-1.5 py-1"
                        >
                          <option value="">— select —</option>
                          {groupEmails.map((g, i) => (
                            <option key={i} value={g.email}>{g.email}{g.name ? ` (${g.name})` : ''}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div>
                      <label className="text-gray-400 block mb-0.5">Or add a new email</label>
                      <input
                        type="email"
                        placeholder="name@example.com"
                        onChange={(e) => { setChosenEmail(e.target.value.trim()); setChosenEmailIsNew(true); }}
                        className="w-full text-xs border border-gray-200 rounded px-1.5 py-1"
                      />
                      <p className="text-gray-400 mt-0.5">A new email is saved as this client's billing email.</p>
                    </div>
                  </div>
                )}
                {!setup.has_email && chosenEmail && (
                  <p className="text-gray-600 mb-1">
                    Using {chosenEmail}{chosenEmailIsNew ? ' (will be saved as billing email)' : ' (from group)'}{' '}
                    <button onClick={() => { setChosenEmail(''); setChosenEmailIsNew(false); setSendSetupNow(false); }} className="text-ocean-600 hover:text-ocean-700 underline">change</button>
                  </p>
                )}
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sendSetupNow}
                    onChange={(e) => setSendSetupNow(e.target.checked)}
                    disabled={!effectiveSetupEmail}
                    className="w-4 h-4 accent-ocean-600"
                  />
                  <span className="text-gray-700">
                    Email this invoice now{effectiveSetupEmail ? ` to ${effectiveSetupEmail}` : ''}
                  </span>
                </label>
                {!effectiveSetupEmail && (
                  <p className="text-amber-700 mt-1">Without an email it will be created as a draft to send from QBO.</p>
                )}
                {effectiveSetupEmail && !sendSetupNow && (
                  <p className="text-gray-400 mt-1">Will be created as a draft (send later from QBO).</p>
                )}
              </div>
            )}

            {/* Recurring template */}
            {rec && (
              <div className="bg-gray-50 rounded-lg p-3 text-xs">
                <h3 className="font-semibold text-gray-500 uppercase mb-1">Recurring template</h3>
                <p className="text-gray-700 mb-2">
                  {rec.action === 'overwrite' ? (
                    <span className="text-amber-700 font-medium">Overwriting existing template</span>
                  ) : (
                    <span className="text-green-700 font-medium">New recurring template</span>
                  )}
                  {' '}— {rec.template_name}
                </p>
                <div className="space-y-0.5 mb-2">
                  {rec.lines.map((l, i) => (
                    <div key={i} className="flex justify-between text-gray-700">
                      <span>{l.description}</span>
                      <span className="font-mono">{fmt(l.amount)}/mo</span>
                    </div>
                  ))}
                  <div className="flex justify-between text-gray-800 font-semibold border-t border-gray-200 pt-0.5">
                    <span>Monthly total</span>
                    <span className="font-mono">{fmt(rec.monthly_total)}</span>
                  </div>
                </div>
                <label className="block text-gray-400 mb-0.5">Next run date</label>
                <input
                  type="date"
                  value={recurringStart}
                  onChange={(e) => setRecurringStart(e.target.value)}
                  className="text-xs border border-gray-200 rounded px-1.5 py-1"
                />
              </div>
            )}

            {missing.length > 0 && (
              <div className="text-xs text-red-600 bg-red-50 rounded p-2 flex items-center justify-between gap-2">
                <span>These services aren't mapped to QBO items and will block the push: {missing.join(', ')}</span>
                <button onClick={handleRefreshPlan} disabled={committing} className="shrink-0 text-ocean-600 hover:text-ocean-700 underline">
                  Refresh
                </button>
              </div>
            )}

            {pushStatus === 'pushing' && <p className="text-xs text-ocean-600">Pushing to QBO...</p>}
            {pushStatus === 'pushed' && <p className="text-xs text-green-600">Successfully pushed to QBO</p>}
            {error && <div className="text-xs text-red-600 bg-red-50 rounded p-2">{error}</div>}
          </div>

          <div className="p-4 border-t border-gray-200 flex justify-between gap-2">
            <Btn onClick={handleCancelCommit} variant="ghost" disabled={committing} className="text-red-600 hover:bg-red-50">
              Cancel
            </Btn>
            <div className="flex gap-2">
              <Btn onClick={handleSkipPush} variant="ghost" disabled={committing}>
                Skip QBO for now
              </Btn>
              <Btn onClick={handleConfirmPush} variant="primary" disabled={committing || missing.length > 0}>
                {committing ? 'Pushing...' : 'Confirm & Push'}
              </Btn>
            </div>
          </div>
        </div>
      </div>
    );
  }

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
