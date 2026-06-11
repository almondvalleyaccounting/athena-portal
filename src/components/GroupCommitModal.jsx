import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { fmt, Btn } from './ui';
import { pushToQbo } from '../lib/qboApi';

// Batch commit + QBO push for a group. Each accepted-but-not-yet-committed
// member quote gets its OWN billing contact (email + address), pre-filled from
// Athena then the member's QBO customer record, and editable per company via
// the navigator. On commit each member is written to live billing and pushed
// to QBO (new customers created, existing recurring invoices updated). One
// failure doesn't stop the rest; results are shown per company.
const BLANK = { email: '', line1: '', line2: '', city: '', postcode: '' };

export default function GroupCommitModal({ group, quotes, profile, onClose, onDone }) {
  // Accepted members that haven't been committed yet.
  const members = (quotes || []).filter((q) => q.status === 'accepted');

  // Per-company billing contact, keyed by quote id.
  const [contacts, setContacts] = useState({});
  const [emailOptions, setEmailOptions] = useState([]); // shared pool to pick from
  const [loadingIds, setLoadingIds] = useState({}); // quoteId -> QBO lookup in progress
  const [current, setCurrent] = useState(0); // which company is being edited
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [results, setResults] = useState({}); // quoteId -> { status, action?, error? }
  const [error, setError] = useState('');

  const contactOf = (id) => contacts[id] || BLANK;
  const setContact = (id, patch) =>
    setContacts((prev) => ({ ...prev, [id]: { ...(prev[id] || BLANK), ...patch } }));

  // Pre-fill each company's contact: Athena billing_* first, then fall back to
  // that member's own QBO customer record (email + BillAddr) for anything
  // missing. New companies with nothing on file stay blank for manual entry.
  useEffect(() => {
    (async () => {
      const ids = members.map((q) => q.entity_id).filter(Boolean);
      const entById = {};
      if (ids.length) {
        const { data: ents } = await supabase
          .from('entities')
          .select('id, billing_email, prospect_email, billing_line1, billing_line2, billing_city, billing_postcode')
          .in('id', ids);
        (ents || []).forEach((e) => { entById[e.id] = e; });
      }

      // Seed from Athena synchronously so fields aren't blank during lookup.
      const seeded = {};
      const emailSet = new Set();
      members.forEach((q) => {
        const e = entById[q.entity_id] || {};
        if (e.billing_email) emailSet.add(e.billing_email);
        if (q.accepted_client_email) emailSet.add(q.accepted_client_email);
        if (e.prospect_email) emailSet.add(e.prospect_email);
        seeded[q.id] = {
          email: e.billing_email || q.accepted_client_email || e.prospect_email || '',
          line1: e.billing_line1 || '',
          line2: e.billing_line2 || '',
          city: e.billing_city || '',
          postcode: e.billing_postcode || '',
        };
      });
      setContacts(seeded);
      setEmailOptions([...emailSet]);

      // Enrich anything still missing from the member's QBO customer record.
      await Promise.all(members.map(async (q) => {
        const c = seeded[q.id];
        const needEmail = !c.email;
        const needAddr = !(c.line1 && c.postcode);
        if (!needEmail && !needAddr) return;
        setLoadingIds((prev) => ({ ...prev, [q.id]: true }));
        try {
          const recurring = (q.line_items || []).filter((l) => l.is_recurring);
          const services = recurring.map((l) => ({
            service_id: l.service_id,
            description: l.description,
            annual_amount: Number(l.annual_amount) || 0,
            monthly_amount: Number(l.monthly_amount) || 0,
            detail: l.detail || null,
          }));
          const res = await pushToQbo(null, profile.id, {
            mode: 'recurring_template',
            quoteId: q.id,
            dryRun: true,
            services,
          });
          const a = res?.plan?.contact?.address;
          const qboEmail = res?.plan?.contact?.email;
          const patch = {};
          if (needEmail && qboEmail) patch.email = qboEmail;
          if (needAddr && a?.Line1) {
            patch.line1 = a.Line1 || '';
            patch.line2 = a.Line2 || '';
            patch.city = a.City || '';
            patch.postcode = a.PostalCode || '';
          }
          if (qboEmail) setEmailOptions((prev) => (prev.includes(qboEmail) ? prev : [...prev, qboEmail]));
          if (Object.keys(patch).length) setContact(q.id, patch);
        } catch { /* leave blank for manual entry */ }
        finally {
          setLoadingIds((prev) => { const n = { ...prev }; delete n[q.id]; return n; });
        }
      }));
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isReady = (id) => {
    const c = contactOf(id);
    return !!(c.email?.trim() && c.line1?.trim() && c.postcode?.trim());
  };
  const notReady = members.filter((q) => !isReady(q.id));
  const allReady = members.length > 0 && notReady.length === 0;

  const cur = members[current];
  const curId = cur?.id;
  const c = contactOf(curId);

  // Copy the current company's address to every company (groups often share
  // a billing address). Email is left per-company.
  const applyAddressToAll = () => {
    const src = contactOf(curId);
    setContacts((prev) => {
      const next = { ...prev };
      members.forEach((q) => {
        next[q.id] = { ...(next[q.id] || BLANK), line1: src.line1, line2: src.line2, city: src.city, postcode: src.postcode };
      });
      return next;
    });
  };

  const handleRun = async () => {
    setRunning(true);
    setError('');
    let anyIssue = false;
    for (const q of members) {
      setResults((prev) => ({ ...prev, [q.id]: { status: 'running' } }));
      try {
        const entityId = q.entity_id || q.primary_entity_id;
        const cc = contactOf(q.id);
        // 1. Save this company's billing contact to its client record.
        if (entityId) {
          await supabase.from('entities').update({
            billing_email: cc.email.trim() || null,
            billing_line1: cc.line1.trim() || null,
            billing_line2: cc.line2.trim() || null,
            billing_city: cc.city.trim() || null,
            billing_postcode: cc.postcode.trim() || null,
          }).eq('id', entityId);
        }

        // 2. Commit to live billing (recurring lines only; no fee-earner step).
        const recurring = (q.line_items || []).filter((l) => l.is_recurring);
        const services = recurring.map((l) => ({
          service_id: l.service_id,
          description: l.description,
          annual_amount: Number(l.annual_amount) || 0,
          monthly_amount: Number(l.monthly_amount) || 0,
          detail: l.detail || null,
        }));
        const { data: billingRow, error: bErr } = await supabase
          .from('live_billing')
          .insert({
            entity_id: entityId,
            quote_id: q.id,
            billing_type: 'recurring',
            monthly_net: Number(q.monthly_net) || 0,
            monthly_vat: Number(q.monthly_vat) || 0,
            monthly_gross: Number(q.monthly_gross) || 0,
            annual_total: Number(q.annual_total) || 0,
            services,
            status: 'active',
            committed_at: new Date().toISOString(),
            committed_by: profile.id,
          })
          .select()
          .single();
        if (bErr) throw bErr;

        const feeRows = recurring.map((l) => ({
          entity_id: entityId,
          service_id: l.service_id,
          description: l.description,
          annual_amount: Number(l.annual_amount) || 0,
          monthly_amount: Number(l.monthly_amount) || 0,
          source: 'committed_quote',
          source_quote_id: q.id,
        }));
        if (feeRows.length) {
          await supabase.from('entity_fees').upsert(feeRows, { onConflict: 'entity_id,service_id' });
        }

        await supabase.from('quotes').update({
          committed_at: new Date().toISOString(),
          committed_by: profile.id,
          status: 'committed',
        }).eq('id', q.id);

        await supabase.from('audit_log').insert({
          user_id: profile.id,
          action: 'commit_to_live',
          entity_type: 'quote',
          entity_id: q.id,
          detail: { from: q.status, to: 'committed', billing_id: billingRow.id, via: 'group_batch' },
        });

        // 3. Push to QBO (auto create-vs-overwrite). Setup lines, if any, go as a draft.
        const hasSetup = (q.line_items || []).some((l) => !l.is_recurring);
        const res = await pushToQbo(billingRow.id, profile.id, {
          mode: 'recurring_template',
          quoteId: q.id,
          alsoPushSetup: hasSetup,
          billEmail: cc.email.trim() || undefined,
        });
        if (res?.success) {
          setResults((prev) => ({ ...prev, [q.id]: { status: 'done', action: res.data?.recurring_action || 'pushed' } }));
        } else {
          // Commit is saved; only the push failed.
          anyIssue = true;
          setResults((prev) => ({ ...prev, [q.id]: { status: 'warn', error: res?.error || 'Committed, but QBO push failed — push later from Billing.' } }));
        }
      } catch (e) {
        anyIssue = true;
        setResults((prev) => ({ ...prev, [q.id]: { status: 'error', error: e.message || 'Failed' } }));
      }
    }
    setRunning(false);
    if (onDone) await onDone();
    // All companies pushed cleanly → close automatically. If anything failed
    // or only partially committed, stay open so the per-company results are
    // visible and can be acted on.
    if (anyIssue) {
      setDone(true);
    } else {
      onClose();
    }
  };

  const statusPill = (r) => {
    if (!r) return null;
    if (r.status === 'running') return <span style={{ fontSize: 11, color: '#0e7fe0' }}>Pushing…</span>;
    if (r.status === 'done') return <span style={{ fontSize: 11, color: '#15803d' }}>✓ {r.action === 'overwrite' ? 'Updated' : r.action === 'create' ? 'Created' : 'Pushed'}</span>;
    if (r.status === 'warn') return <span style={{ fontSize: 11, color: '#b45309' }} title={r.error}>⚠ Committed, push failed</span>;
    if (r.status === 'error') return <span style={{ fontSize: 11, color: '#b91c1c' }} title={r.error}>✗ Failed</span>;
    return null;
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-auto">
        <div className="p-4 border-b border-gray-200">
          <h2 className="text-lg font-bold text-ocean-700">Commit &amp; push to QuickBooks</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            {group?.name} · {members.length} accepted {members.length === 1 ? 'company' : 'companies'}. Set each company's billing contact, then commit. New customers are created in QBO; existing recurring invoices are updated.
          </p>
        </div>

        <div className="p-4 space-y-3">
          {/* Per-company billing contact with a navigator to rotate companies */}
          {cur && (
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="flex items-center justify-between mb-1.5">
                <h3 className="text-xs font-semibold text-gray-500 uppercase">Billing contact</h3>
                {members.length > 1 && (
                  <div className="flex items-center gap-2 text-xs text-gray-600">
                    <button onClick={() => setCurrent((i) => (i - 1 + members.length) % members.length)} disabled={running} className="px-1.5 py-0.5 rounded hover:bg-gray-200 disabled:opacity-40" title="Previous company">‹</button>
                    <span>{current + 1} of {members.length}</span>
                    <button onClick={() => setCurrent((i) => (i + 1) % members.length)} disabled={running} className="px-1.5 py-0.5 rounded hover:bg-gray-200 disabled:opacity-40" title="Next company">›</button>
                  </div>
                )}
              </div>
              <p className="text-sm font-semibold text-ocean-700 mb-2 truncate">{cur.relationship_group || cur.quote_ref}</p>

              <label className="text-xs text-gray-500 block mb-0.5">Email</label>
              {emailOptions.length > 0 && (
                <select
                  value={emailOptions.includes(c.email) ? c.email : ''}
                  onChange={(e) => { if (e.target.value) setContact(curId, { email: e.target.value }); }}
                  disabled={running}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 mb-1"
                >
                  <option value="">— pick an email from the group —</option>
                  {emailOptions.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              )}
              <input
                type="email"
                value={c.email}
                onChange={(e) => setContact(curId, { email: e.target.value })}
                disabled={running}
                placeholder="billing@example.com"
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 mb-2"
              />

              <label className="text-xs text-gray-500 block mb-0.5">
                Billing address
                {loadingIds[curId] && <span className="text-ocean-600 ml-1">· looking up from QuickBooks…</span>}
              </label>
              <div className="space-y-1">
                <input value={c.line1} onChange={(e) => setContact(curId, { line1: e.target.value })} disabled={running} placeholder="Address line 1" className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2" />
                <input value={c.line2} onChange={(e) => setContact(curId, { line2: e.target.value })} disabled={running} placeholder="Address line 2 (optional)" className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2" />
                <div className="flex gap-1">
                  <input value={c.city} onChange={(e) => setContact(curId, { city: e.target.value })} disabled={running} placeholder="Town/City" className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2" />
                  <input value={c.postcode} onChange={(e) => setContact(curId, { postcode: e.target.value })} disabled={running} placeholder="Postcode" className="w-32 text-sm border border-gray-200 rounded-lg px-3 py-2" />
                </div>
              </div>

              {members.length > 1 && (
                <button onClick={applyAddressToAll} disabled={running} className="text-xs text-ocean-600 hover:underline mt-2 disabled:opacity-40">
                  Apply this address to all companies
                </button>
              )}
              {!isReady(curId) && <p className="text-xs text-amber-700 mt-1.5">This company needs an email and address (line 1 + postcode) before pushing.</p>}
            </div>
          )}

          {/* Members — click to edit, with readiness + per-company results */}
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            {members.map((q, idx) => {
              const ready = isReady(q.id);
              return (
                <button
                  key={q.id}
                  onClick={() => setCurrent(idx)}
                  disabled={running}
                  className={`w-full flex items-center justify-between px-3 py-2 border-b border-gray-50 last:border-0 text-sm text-left ${idx === current ? 'bg-ocean-50' : 'hover:bg-gray-50'}`}
                >
                  <span className="text-gray-700 truncate flex items-center gap-1.5">
                    {idx === current && <span className="text-ocean-600">▸</span>}
                    {q.relationship_group || q.quote_ref}
                  </span>
                  <div className="flex items-center gap-3 shrink-0">
                    {!ready && !results[q.id] && <span className="text-xs text-amber-600" title="Needs email + address">⚠ details</span>}
                    <span className="font-mono text-xs text-gray-500">{fmt(q.monthly_gross)}/mo</span>
                    {statusPill(results[q.id])}
                  </div>
                </button>
              );
            })}
            {members.length === 0 && <div className="px-3 py-3 text-sm text-gray-400">No accepted companies awaiting commit.</div>}
          </div>

          {!done && !allReady && notReady.length > 0 && (
            <p className="text-xs text-amber-700">
              {notReady.length} {notReady.length === 1 ? 'company' : 'companies'} still need an email + address before you can commit.
            </p>
          )}
          {error && <div className="text-xs text-red-600 bg-red-50 rounded p-2">{error}</div>}
        </div>

        <div className="p-4 border-t border-gray-200 flex justify-end gap-2">
          <Btn onClick={onClose} variant="ghost" disabled={running}>{done ? 'Close' : 'Cancel'}</Btn>
          {!done && (
            <Btn onClick={handleRun} variant="primary" disabled={running || !allReady || members.length === 0}>
              {running ? 'Processing…' : `Commit & Push ${members.length}`}
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}
