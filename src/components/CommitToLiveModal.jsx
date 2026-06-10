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

  // Review-first flow: the form gathers services/allocations, then (for a QBO
  // push) we fetch a read-only dry-run plan and show a review step where the
  // client details are verified. Nothing is written until the final Commit
  // button on that step — backing out leaves the quote untouched.
  const [phase, setPhase] = useState('form'); // 'form' | 'confirm'
  const [plan, setPlan] = useState(null);
  const [sendSetupNow, setSendSetupNow] = useState(false);
  const [recurringStart, setRecurringStart] = useState('');
  // When there's no client email on file: emails from other group members to
  // pick from, plus a manually chosen/entered one for this push.
  const [groupEmails, setGroupEmails] = useState([]); // [{ email, name }]
  const [chosenEmail, setChosenEmail] = useState('');
  const [chosenEmailIsNew, setChosenEmailIsNew] = useState(false);
  const [dueDays, setDueDays] = useState(14); // invoice due-date offset, default 14
  // Mandatory billing address — prefilled from the plan (entity billing_*),
  // editable here, persisted to the entity before the push.
  const [addr, setAddr] = useState({ line1: '', line2: '', city: '', postcode: '' });

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

  // Build the services JSONB from recurring line items. Shared by the commit
  // and the inline review (dry-run) plan.
  const buildServices = () => recurring.map((l) => ({
    service_id: l.service_id,
    description: l.description,
    annual_amount: Number(l.annual_amount) || 0,
    monthly_amount: Number(l.monthly_amount) || 0,
    detail: l.detail || null,
  }));

  // Persist the commit: live_billing + entity_fees + allocations + quote
  // status + audit log. No QBO writes. Returns the new live_billing row.
  // Called only from a terminal action — never optimistically.
  const persistCommit = async () => {
    try {
      // 1. Build services JSONB from recurring line items
      const services = buildServices();

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

      return billingRow;
    } catch (e) {
      // Re-throw so the calling terminal action surfaces the failure. These
      // writes aren't wrapped in a transaction (pre-existing), so a failure
      // partway through can leave a partial commit — same as before.
      throw new Error(e.message || 'Failed to commit to live billing');
    }
  };

  // Form primary action.
  //  - push: build a read-only plan from the inline services (NO writes) and
  //    move to the review step. The commit is written only by the final
  //    Commit button there.
  //  - csv / none: there is no review step, so this single click is the
  //    terminal commit.
  const handleFormPrimary = async () => {
    setCommitting(true);
    setError('');
    try {
      if (qboAction === 'push') {
        const hasSetupLines = (lineItems || []).some((l) => !l.is_recurring);
        const planResult = await pushToQbo(null, profile.id, {
          mode: 'recurring_template',
          quoteId: quote.id,
          alsoPushSetup: hasSetupLines,
          dryRun: true,
          services: buildServices(),
        });
        if (planResult?.success) {
          setPlan(planResult.plan);
          setAddr(addrFromPlan(planResult.plan));
          setRecurringStart(planResult.plan?.recurring?.next_run_date || '');
          if (planResult.plan?.due_date_offset_days != null) setDueDays(planResult.plan.due_date_offset_days);
          // No email on file + part of a group → offer other group emails.
          if (!planResult.plan?.contact?.has_email && quote.group_id) {
            await loadGroupEmails();
          }
          setPhase('confirm');
          setCommitting(false);
          return; // review step is where the commit actually happens
        }
        setError(`Couldn't build the QBO plan: ${planResult?.error || 'Unknown error'}.`);
        setCommitting(false);
        return;
      }

      // csv / none: commit now (single terminal action, no review step).
      await persistCommit();
      if (qboAction === 'csv') {
        const qboItems = recurring.map((l) => ({
          service_id: l.service_id,
          description: l.description,
          qty: 1,
          rate: Number(l.monthly_amount) || 0,
          amount: Number(l.monthly_amount) || 0,
        }));
        exportQboCsv(clientName, qboItems, true);
      }
      setCommitting(false);
      onCommitted();
    } catch (e) {
      setError(e.message || 'Failed to commit to live billing');
      setCommitting(false);
    }
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

  // Map the plan's QBO-shaped address (Line1/PostalCode…) back to our form.
  const addrFromPlan = (p) => {
    const a = p?.contact?.address || {};
    return { line1: a.Line1 || '', line2: a.Line2 || '', city: a.City || '', postcode: a.PostalCode || '' };
  };

  // Resolved client email: whatever the quote/entity had, else the user's
  // pick/entry. Used for the customer record, the recurring template, and the
  // setup invoice send.
  const resolvedEmail = plan?.contact?.email || chosenEmail || '';
  const effectiveSetupEmail = resolvedEmail;
  // Mandatory client details are satisfied once we have an email and a
  // minimally-valid address (line 1 + postcode).
  const addrReady = !!(addr.line1.trim() && addr.postcode.trim());
  const contactReady = !!resolvedEmail && addrReady;

  // Save the verified contact details onto the entity. The push reads the
  // address/email off the entity, and we keep them on file for next time.
  const persistContactDetails = async () => {
    if (chosenEmail && chosenEmailIsNew && entityId) {
      await supabase.from('entities').update({ billing_email: chosenEmail }).eq('id', entityId);
    }
    if (entityId && addrReady) {
      await supabase.from('entities').update({
        billing_line1: addr.line1.trim(),
        billing_line2: addr.line2.trim() || null,
        billing_city: addr.city.trim() || null,
        billing_postcode: addr.postcode.trim(),
      }).eq('id', entityId);
    }
  };

  // Review step — the final, terminal Commit. Saves the verified contact
  // details, writes the commit, then pushes to QBO. This is the ONLY place a
  // committed record is created on the push path.
  const handleConfirmCommit = async () => {
    setCommitting(true);
    setError('');
    setPushStatus('pushing');
    try {
      await persistContactDetails();
      const billingRow = await persistCommit();
      const hasSetupLines = (lineItems || []).some((l) => !l.is_recurring);
      const result = await pushToQbo(billingRow.id, profile.id, {
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
        setError(`Committed to live billing, but the QBO push failed: ${result?.error || 'Unknown error'}. You can push from the Billing page later.`);
      }
    } catch (pushErr) {
      setPushStatus('push_error');
      setError(`${pushErr.message}. If the commit was saved you can push from the Billing page later.`);
    }
    setCommitting(false);
  };

  // Review step — commit without pushing to QBO. Still a terminal commit, so
  // it writes the live billing record; it just skips the QBO push.
  const handleCommitWithoutPush = async () => {
    setCommitting(true);
    setError('');
    try {
      await persistContactDetails();
      await persistCommit();
      setCommitting(false);
      onCommitted();
    } catch (e) {
      setError(e.message || 'Failed to commit to live billing');
      setCommitting(false);
    }
  };

  // Re-fetch the dry-run plan (e.g. after fixing a service→QBO mapping).
  const handleRefreshPlan = async () => {
    setCommitting(true);
    setError('');
    try {
      const hasSetupLines = (lineItems || []).some((l) => !l.is_recurring);
      const planResult = await pushToQbo(null, profile.id, {
        mode: 'recurring_template',
        quoteId: quote.id,
        alsoPushSetup: hasSetupLines,
        dryRun: true,
        services: buildServices(),
      });
      if (planResult?.success) {
        setPlan(planResult.plan);
        setAddr(addrFromPlan(planResult.plan));
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
            <h2 className="text-lg font-bold text-ocean-700">Review &amp; commit</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              Nothing has been saved yet. Verify the client details below — the Commit button is the final step.
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

            {/* Client details — MANDATORY. Email + billing address are written
                to the QBO customer and the recurring/setup documents. */}
            <div className={`rounded-lg p-3 text-xs border ${contactReady ? 'bg-gray-50 border-gray-200' : 'bg-amber-50 border-amber-200'}`}>
              <h3 className="font-semibold text-gray-500 uppercase mb-2">Client details (required)</h3>

              {/* Email */}
              <div className="mb-2">
                <label className="text-gray-400 block mb-0.5">Email</label>
                {plan?.contact?.has_email ? (
                  <p className="text-gray-700">{plan.contact.email}</p>
                ) : (
                  <div className="space-y-1.5">
                    {groupEmails.length > 0 && (
                      <select
                        value={chosenEmailIsNew ? '' : chosenEmail}
                        onChange={(e) => { if (e.target.value) { setChosenEmail(e.target.value); setChosenEmailIsNew(false); } }}
                        className="w-full text-xs border border-gray-200 rounded px-1.5 py-1"
                      >
                        <option value="">— use an email from the group —</option>
                        {groupEmails.map((g, i) => (
                          <option key={i} value={g.email}>{g.email}{g.name ? ` (${g.name})` : ''}</option>
                        ))}
                      </select>
                    )}
                    <input
                      type="email"
                      placeholder="name@example.com"
                      value={chosenEmailIsNew ? chosenEmail : ''}
                      onChange={(e) => { setChosenEmail(e.target.value.trim()); setChosenEmailIsNew(true); }}
                      className="w-full text-xs border border-gray-200 rounded px-1.5 py-1"
                    />
                    <p className="text-gray-400">Saved as this client's billing email.</p>
                  </div>
                )}
              </div>

              {/* Billing address */}
              <div>
                <label className="text-gray-400 block mb-0.5">Billing address</label>
                <div className="space-y-1">
                  <input value={addr.line1} onChange={(e) => setAddr((a) => ({ ...a, line1: e.target.value }))} placeholder="Address line 1" className="w-full text-xs border border-gray-200 rounded px-1.5 py-1" />
                  <input value={addr.line2} onChange={(e) => setAddr((a) => ({ ...a, line2: e.target.value }))} placeholder="Address line 2 (optional)" className="w-full text-xs border border-gray-200 rounded px-1.5 py-1" />
                  <div className="flex gap-1">
                    <input value={addr.city} onChange={(e) => setAddr((a) => ({ ...a, city: e.target.value }))} placeholder="Town/City" className="flex-1 text-xs border border-gray-200 rounded px-1.5 py-1" />
                    <input value={addr.postcode} onChange={(e) => setAddr((a) => ({ ...a, postcode: e.target.value }))} placeholder="Postcode" className="w-28 text-xs border border-gray-200 rounded px-1.5 py-1" />
                  </div>
                </div>
                <p className="text-gray-400 mt-0.5">Saved to the client record and used on the invoice.</p>
                {plan?.contact?.address_hint && !addrReady && (
                  <p className="text-gray-500 mt-1">
                    On file in the client portal: <span className="text-gray-700">{plan.contact.address_hint}</span>
                  </p>
                )}
              </div>

              {!contactReady && (
                <p className="text-amber-700 mt-2">
                  Email and a billing address (line 1 + postcode) are required before pushing to QuickBooks.
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
                {/* Email is captured in the required "Client details" section above. */}
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
                {Array.isArray(rec.existing_templates) && rec.existing_templates.length > 0 && (
                  <div className="text-amber-700 bg-amber-50 rounded p-1.5 mb-2">
                    {rec.existing_templates.length === 1 ? (
                      <>Found 1 existing template in QBO for this customer: <span className="font-mono">{rec.existing_templates[0].name || '(unnamed)'}</span>. It will be updated rather than duplicated.</>
                    ) : (
                      <>Found {rec.existing_templates.length} existing templates in QBO for this customer ({rec.existing_templates.map((t) => t.name || '(unnamed)').join(', ')}). The closest match will be updated; you may want to tidy duplicates in QBO.</>
                    )}
                  </div>
                )}
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
            <Btn onClick={onClose} variant="ghost" disabled={committing} className="text-red-600 hover:bg-red-50">
              Cancel
            </Btn>
            <div className="flex gap-2">
              <Btn onClick={handleCommitWithoutPush} variant="ghost" disabled={committing}>
                Commit without QBO
              </Btn>
              <Btn onClick={handleConfirmCommit} variant="primary" disabled={committing || missing.length > 0 || !contactReady}>
                {committing ? 'Committing...' : 'Commit to Live'}
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
            {qboAction === 'push'
              ? "Review the services and allocations, then verify the client details before committing."
              : 'This will create a live billing record and update entity fees.'}
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
          <Btn onClick={handleFormPrimary} variant="primary" disabled={committing}>
            {committing
              ? (qboAction === 'push' ? 'Loading...' : 'Committing...')
              : (qboAction === 'push' ? 'Review' : 'Commit to Live')}
          </Btn>
        </div>
      </div>
    </div>
  );
}
