import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { fmt, Btn } from './ui';
import { pushToQbo } from '../lib/qboApi';

// Batch commit + QBO push for a group. Processes every accepted-but-not-yet-
// committed member quote: applies ONE shared billing contact (email +
// address) to each client, commits it to live billing (no fee-earner step),
// then pushes to QuickBooks. The push auto-detects new (create) vs existing
// (overwrite) per client — no decision needed here. One failure doesn't stop
// the rest; results are shown per company.
export default function GroupCommitModal({ group, quotes, profile, onClose, onDone }) {
  // Accepted members that haven't been committed yet.
  const members = (quotes || []).filter((q) => q.status === 'accepted');

  const [email, setEmail] = useState('');
  const [emailOptions, setEmailOptions] = useState([]);
  const [addr, setAddr] = useState({ line1: '', line2: '', city: '', postcode: '' });
  const [prefillingAddr, setPrefillingAddr] = useState(false);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [results, setResults] = useState({}); // quoteId -> { status, action?, error? }
  const [error, setError] = useState('');

  // Pre-fill the group's billing contact from members' existing details.
  useEffect(() => {
    (async () => {
      const ids = members.map((q) => q.entity_id).filter(Boolean);
      if (ids.length === 0) return;
      const { data: ents } = await supabase
        .from('entities')
        .select('id, billing_email, prospect_email, billing_line1, billing_line2, billing_city, billing_postcode')
        .in('id', ids);
      const emailSet = new Set();
      (ents || []).forEach((e) => { if (e.billing_email) emailSet.add(e.billing_email); });
      members.forEach((q) => { if (q.accepted_client_email) emailSet.add(q.accepted_client_email); });
      (ents || []).forEach((e) => { if (e.prospect_email) emailSet.add(e.prospect_email); });
      const options = [...emailSet];
      setEmailOptions(options);
      setEmail((prev) => prev || options[0] || '');
      const withAddr = (ents || []).find((e) => e.billing_line1);
      if (withAddr) {
        setAddr({
          line1: withAddr.billing_line1 || '',
          line2: withAddr.billing_line2 || '',
          city: withAddr.billing_city || '',
          postcode: withAddr.billing_postcode || '',
        });
      } else {
        // No member has a billing address on file in Athena. Fall back to the
        // QBO customer record of an existing member (e.g. an existing Bill) —
        // the dry-run plan resolves entity billing_* then the QBO BillAddr.
        // Use the first usable address we find; also pick up any email.
        setPrefillingAddr(true);
        try {
        for (const q of members) {
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
            if (qboEmail) setEmailOptions((prev) => (prev.includes(qboEmail) ? prev : [...prev, qboEmail]));
            if (a?.Line1) {
              setAddr({ line1: a.Line1 || '', line2: a.Line2 || '', city: a.City || '', postcode: a.PostalCode || '' });
              break;
            }
          } catch { /* try the next member */ }
        }
        } finally {
          setPrefillingAddr(false);
        }
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addrReady = !!(addr.line1.trim() && addr.postcode.trim());
  const contactReady = !!email.trim() && addrReady;

  const handleRun = async () => {
    setRunning(true);
    setError('');
    let anyIssue = false;
    for (const q of members) {
      setResults((prev) => ({ ...prev, [q.id]: { status: 'running' } }));
      try {
        const entityId = q.entity_id || q.primary_entity_id;
        // 1. Save the shared billing contact to this client.
        if (entityId) {
          await supabase.from('entities').update({
            billing_email: email.trim() || null,
            billing_line1: addr.line1.trim() || null,
            billing_line2: addr.line2.trim() || null,
            billing_city: addr.city.trim() || null,
            billing_postcode: addr.postcode.trim() || null,
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
    if (!r) return <span style={{ fontSize: 11, color: '#cbd5e1' }}>—</span>;
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
            {group?.name} · {members.length} accepted {members.length === 1 ? 'company' : 'companies'}. Each is committed to live billing and pushed to QBO (new customers are created, existing recurring invoices updated).
          </p>
        </div>

        <div className="p-4 space-y-3">
          {/* One billing contact for the whole group */}
          <div className="bg-gray-50 rounded-lg p-3">
            <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Billing contact (applied to every company)</h3>
            <label className="text-xs text-gray-500 block mb-0.5">Email</label>
            {emailOptions.length > 1 && (
              <select
                value={emailOptions.includes(email) ? email : ''}
                onChange={(e) => { if (e.target.value) setEmail(e.target.value); }}
                disabled={running}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 mb-1"
              >
                <option value="">— pick an email from the group —</option>
                {emailOptions.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
              </select>
            )}
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={running}
              placeholder="billing@example.com"
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 mb-2"
            />
            <label className="text-xs text-gray-500 block mb-0.5">
              Billing address
              {prefillingAddr && <span className="text-ocean-600 ml-1">· looking up from QuickBooks…</span>}
            </label>
            <div className="space-y-1">
              <input value={addr.line1} onChange={(e) => setAddr((a) => ({ ...a, line1: e.target.value }))} disabled={running} placeholder="Address line 1" className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2" />
              <input value={addr.line2} onChange={(e) => setAddr((a) => ({ ...a, line2: e.target.value }))} disabled={running} placeholder="Address line 2 (optional)" className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2" />
              <div className="flex gap-1">
                <input value={addr.city} onChange={(e) => setAddr((a) => ({ ...a, city: e.target.value }))} disabled={running} placeholder="Town/City" className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2" />
                <input value={addr.postcode} onChange={(e) => setAddr((a) => ({ ...a, postcode: e.target.value }))} disabled={running} placeholder="Postcode" className="w-32 text-sm border border-gray-200 rounded-lg px-3 py-2" />
              </div>
            </div>
            {!contactReady && <p className="text-xs text-amber-700 mt-1.5">An email and address (line 1 + postcode) are required before pushing.</p>}
          </div>

          {/* Members + per-company results */}
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            {members.map((q) => (
              <div key={q.id} className="flex items-center justify-between px-3 py-2 border-b border-gray-50 last:border-0 text-sm">
                <span className="text-gray-700 truncate">{q.relationship_group || q.quote_ref}</span>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="font-mono text-xs text-gray-500">{fmt(q.monthly_gross)}/mo</span>
                  {statusPill(results[q.id])}
                </div>
              </div>
            ))}
            {members.length === 0 && <div className="px-3 py-3 text-sm text-gray-400">No accepted companies awaiting commit.</div>}
          </div>

          {error && <div className="text-xs text-red-600 bg-red-50 rounded p-2">{error}</div>}
        </div>

        <div className="p-4 border-t border-gray-200 flex justify-end gap-2">
          <Btn onClick={onClose} variant="ghost" disabled={running}>{done ? 'Close' : 'Cancel'}</Btn>
          {!done && (
            <Btn onClick={handleRun} variant="primary" disabled={running || !contactReady || members.length === 0}>
              {running ? 'Processing…' : `Commit & Push ${members.length}`}
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}
