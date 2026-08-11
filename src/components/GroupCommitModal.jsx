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
  const [addressOptions, setAddressOptions] = useState([]); // [{ label, addr }] shared pool
  const [loadingIds, setLoadingIds] = useState({}); // quoteId -> QBO lookup in progress
  const [current, setCurrent] = useState(0); // which company is being edited
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [results, setResults] = useState({}); // quoteId -> { status, action?, error? }
  const [error, setError] = useState('');
  // The dry-run plan's customer block per company, and the user's mapping
  // decision where none could be resolved ('' = undecided, blocks the commit;
  // a customer id = link it; 'new' = create one).
  const [custPlans, setCustPlans] = useState({}); // quoteId -> plan.customer
  const [custChoice, setCustChoice] = useState({}); // quoteId -> '' | id | 'new'

  const contactOf = (id) => contacts[id] || BLANK;
  const setContact = (id, patch) =>
    setContacts((prev) => ({ ...prev, [id]: { ...(prev[id] || BLANK), ...patch } }));

  // Which QBO customer a company will invoice, from its plan plus any pick.
  // Named rather than "new vs existing" because the QBO customer usually
  // carries the trading name, so the difference is the thing worth seeing.
  const custTargetOf = (id) => {
    const c = custPlans[id];
    if (!c) return null;
    if (c.action !== 'create') {
      if (c.missing) return { mode: 'missing', name: null, id: c.qbo_customer_id };
      return { mode: 'existing', name: c.qbo_customer_name || '(unnamed customer)', id: c.qbo_customer_id, source: c.source, inactive: c.inactive };
    }
    const choice = custChoice[id] || '';
    if (choice && choice !== 'new') {
      const cand = (c.candidates || []).find((x) => String(x.id) === String(choice));
      return { mode: 'link', name: cand?.name || `Customer ${choice}`, id: choice, inactive: cand ? !cand.active : false };
    }
    if (choice === 'new') return { mode: 'new', name: c.name, id: null };
    return { mode: 'undecided', name: null, id: null };
  };
  // Undecided (or a broken mapping) blocks that company. A plan that hasn't
  // arrived yet doesn't block — readiness is judged once it lands.
  const custReady = (id) => {
    const t = custTargetOf(id);
    if (!t) return true;
    return t.mode !== 'undecided' && t.mode !== 'missing';
  };

  const addrLabel = (a) => [a.line1, a.city, a.postcode].filter(Boolean).join(', ');
  const addrKey = (a) => `${(a.line1 || '').toLowerCase().trim()}|${(a.postcode || '').toLowerCase().trim()}`;

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
      const addrMap = new Map();
      members.forEach((q) => {
        const e = entById[q.entity_id] || {};
        if (e.billing_email) emailSet.add(e.billing_email);
        if (q.accepted_client_email) emailSet.add(q.accepted_client_email);
        if (e.prospect_email) emailSet.add(e.prospect_email);
        if (e.billing_line1) {
          const a = { line1: e.billing_line1 || '', line2: e.billing_line2 || '', city: e.billing_city || '', postcode: e.billing_postcode || '' };
          const k = addrKey(a);
          if (!addrMap.has(k)) addrMap.set(k, { label: addrLabel(a), addr: a });
        }
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
      setAddressOptions([...addrMap.values()]);

      // One dry-run per company: enriches anything still missing from that
      // member's QBO customer record, AND resolves which QBO customer it will
      // invoice. The plan is fetched for every company now (not just those
      // missing contact details) because the customer mapping has to be shown
      // and confirmed for all of them.
      await Promise.all(members.map(async (q) => {
        const c = seeded[q.id];
        const needEmail = !c.email;
        const needAddr = !(c.line1 && c.postcode);
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
          // Customer mapping for this company. No near matches → nothing to
          // confuse it with, so default to "create"; otherwise leave the
          // choice blank so the commit waits for a look.
          const cust = res?.plan?.customer;
          if (cust) {
            setCustPlans((prev) => ({ ...prev, [q.id]: cust }));
            if (cust.action === 'create' && !(cust.candidates || []).length) {
              setCustChoice((prev) => ({ ...prev, [q.id]: prev[q.id] || 'new' }));
            }
          }

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
          if (a?.Line1) {
            const opt = { line1: a.Line1 || '', line2: a.Line2 || '', city: a.City || '', postcode: a.PostalCode || '' };
            setAddressOptions((prev) => (prev.some((o) => addrKey(o.addr) === addrKey(opt)) ? prev : [...prev, { label: addrLabel(opt), addr: opt }]));
          }
          if (Object.keys(patch).length) setContact(q.id, patch);
        } catch { /* leave blank for manual entry */ }
        finally {
          setLoadingIds((prev) => { const n = { ...prev }; delete n[q.id]; return n; });
        }
      }));
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const contactReady = (id) => {
    const c = contactOf(id);
    return !!(c.email?.trim() && c.line1?.trim() && c.postcode?.trim());
  };
  const isReady = (id) => contactReady(id) && custReady(id);
  const notReady = members.filter((q) => !contactReady(q.id));
  const custUndecided = members.filter((q) => !custReady(q.id));
  const allReady = members.length > 0 && members.every((q) => isReady(q.id));

  const cur = members[Math.min(current, Math.max(0, members.length - 1))];
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
    const fails = []; // [{ name, reason }] for a persistent summary
    const label = (q) => q.relationship_group || q.quote_ref;
    for (const q of members) {
      setResults((prev) => ({ ...prev, [q.id]: { status: 'running' } }));
      let billingRow = null; // tracked so we can roll back if the push fails
      try {
        const entityId = q.entity_id || q.primary_entity_id;
        const cc = contactOf(q.id);
        // 1. Save this company's billing contact to its client record (so the
        //    push reads it, and it's on file for a retry).
        if (entityId) {
          await supabase.from('entities').update({
            billing_email: cc.email.trim() || null,
            billing_line1: cc.line1.trim() || null,
            billing_line2: cc.line2.trim() || null,
            billing_city: cc.city.trim() || null,
            billing_postcode: cc.postcode.trim() || null,
          }).eq('id', entityId);
        }

        const recurring = (q.line_items || []).filter((l) => l.is_recurring);
        const services = recurring.map((l) => ({
          service_id: l.service_id,
          description: l.description,
          annual_amount: Number(l.annual_amount) || 0,
          monthly_amount: Number(l.monthly_amount) || 0,
          detail: l.detail || null,
        }));

        // 2. Create the live_billing row — the push needs a billing_id. This
        //    is NOT the commit yet; we only record the commit (quote status +
        //    fees + audit) once the QBO push succeeds, so a failed company is
        //    never left marked committed.
        const { data: bRow, error: bErr } = await supabase
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
        billingRow = bRow;

        // 3. Push to QBO FIRST. The commit is contingent on this succeeding.
        const hasSetup = (q.line_items || []).some((l) => !l.is_recurring);
        const ct = custTargetOf(q.id);
        const res = await pushToQbo(billingRow.id, profile.id, {
          mode: 'recurring_template',
          quoteId: q.id,
          alsoPushSetup: hasSetup,
          billEmail: cc.email.trim() || undefined,
          // This company's customer-mapping decision. Without one of these the
          // push refuses rather than creating a duplicate customer.
          linkCustomerId: ct?.mode === 'link' ? String(ct.id) : undefined,
          newCustomerOk: ct?.mode === 'new' || undefined,
        });

        if (!res?.success) {
          // Push failed — roll back the live_billing row and leave the quote
          // 'accepted' so it stays in the to-commit list for a retry.
          await supabase.from('live_billing').delete().eq('id', billingRow.id);
          anyIssue = true;
          let reason = res?.error || 'QBO push failed — not committed.';
          if (Array.isArray(res?.missing_mappings) && res.missing_mappings.length) {
            reason = `Not committed — these services aren't mapped to QBO items: ${res.missing_mappings.join(', ')}`;
          } else if (Array.isArray(res?.missing_contact) && res.missing_contact.length) {
            reason = `Not committed — missing ${res.missing_contact.join(', ')}`;
          } else if (res?.customer_unmapped) {
            reason = `Not committed — no QuickBooks customer mapped. ${res.error || ''}`.trim();
          }
          fails.push({ name: label(q), reason });
          setResults((prev) => ({ ...prev, [q.id]: { status: 'error', error: reason } }));
          continue;
        }

        // 4. Push succeeded → now record the commit. (entity_fees is no
        // longer written — live_billing.services is the single fee store.)
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

        setResults((prev) => ({ ...prev, [q.id]: { status: 'done', action: res.data?.recurring_action || 'pushed' } }));
      } catch (e) {
        // Roll back any live_billing row we created so a failed company isn't
        // left half-committed.
        if (billingRow?.id) {
          try { await supabase.from('live_billing').delete().eq('id', billingRow.id); } catch { /* */ }
        }
        anyIssue = true;
        fails.push({ name: label(q), reason: e.message || 'Failed' });
        setResults((prev) => ({ ...prev, [q.id]: { status: 'error', error: e.message || 'Failed' } }));
      }
    }
    setRunning(false);
    if (fails.length) {
      setError(`Not committed (${fails.length}): ` + fails.map((f) => `${f.name} — ${f.reason}`).join('  ·  '));
    }
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

              {/* QuickBooks customer for this company. Named, because the QBO
                  customer usually carries the trading name — and where none is
                  mapped it's a choice, not a silent create (which would give
                  this company a duplicate customer AND template). */}
              {(() => {
                const t = custTargetOf(curId);
                const cp = custPlans[curId];
                if (!cp) return null;
                const cands = cp.candidates || [];
                const tone = t.mode === 'missing' ? 'bg-red-50 border-red-200'
                  : (t.mode === 'existing' || t.mode === 'link') ? 'bg-sky-50 border-sky-200'
                  : 'bg-amber-50 border-amber-200';
                return (
                  <div className={`rounded-lg border p-2 mb-2 text-xs ${tone}`}>
                    <div className="font-semibold text-gray-500 uppercase mb-0.5">QuickBooks customer</div>
                    {t.mode === 'missing' ? (
                      <p className="text-red-700">
                        Mapped to QuickBooks customer <span className="font-mono">#{t.id}</span>, which QuickBooks no longer returns. Fix the mapping on the client record before committing.
                      </p>
                    ) : t.mode === 'existing' || t.mode === 'link' ? (
                      <>
                        <p className="text-gray-800 font-medium truncate" title={t.name}>
                          {t.name}{t.id && <span className="font-normal text-gray-400"> · #{t.id}</span>}
                        </p>
                        <p className="text-gray-500">
                          {t.mode === 'link' ? 'Will be linked on commit'
                            : t.source === 'name_match' ? 'Matched on name'
                            : 'Mapped on the client record'}
                          {t.name && cp.name && t.name.toLowerCase() !== String(cp.name).toLowerCase() && ` — differs from the Athena name (${cp.name})`}
                          {t.inactive && ' · inactive in QuickBooks'}
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-amber-800 mb-1">
                          Nothing mapped to <span className="font-medium">{cp.name}</span>.
                          {cands.length > 0
                            ? ` ${cands.length} similar ${cands.length === 1 ? 'customer' : 'customers'} already exist — link the right one rather than creating a duplicate.`
                            : ' Nothing similar found in QuickBooks.'}
                        </p>
                        <select
                          value={custChoice[curId] || ''}
                          onChange={(e) => setCustChoice((prev) => ({ ...prev, [curId]: e.target.value }))}
                          disabled={running}
                          className="w-full text-xs border border-gray-200 rounded px-1.5 py-1"
                        >
                          <option value="">Choose the QuickBooks customer…</option>
                          {cands.map((x) => (
                            <option key={x.id} value={x.id}>
                              Link to: {x.name}{x.active ? '' : ' (inactive)'}{x.address_label ? ` — ${x.address_label}` : ''}
                            </option>
                          ))}
                          <option value="new">Create a new customer called &quot;{cp.name}&quot;</option>
                        </select>
                      </>
                    )}
                  </div>
                );
              })()}

              <label className="text-xs text-gray-500 block mb-0.5">Email</label>
              {emailOptions.length > 0 && (
                <select
                  value=""
                  onChange={(e) => { if (e.target.value) setContact(curId, { email: e.target.value }); }}
                  disabled={running}
                  className="w-full text-xs text-gray-500 border border-gray-200 rounded-lg px-3 py-1.5 mb-1 bg-gray-50"
                >
                  <option value="">Select email from group…</option>
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
              {addressOptions.length > 0 && (
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value === '') return;
                    const a = addressOptions[Number(e.target.value)]?.addr;
                    if (a) setContact(curId, { line1: a.line1, line2: a.line2, city: a.city, postcode: a.postcode });
                  }}
                  disabled={running}
                  className="w-full text-xs text-gray-500 border border-gray-200 rounded-lg px-3 py-1.5 mb-1 bg-gray-50"
                >
                  <option value="">Select address from group…</option>
                  {addressOptions.map((o, i) => <option key={i} value={i}>{o.label}</option>)}
                </select>
              )}
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
              {!contactReady(curId) && <p className="text-xs text-amber-700 mt-1.5">This company needs an email and address (line 1 + postcode) before pushing.</p>}
            </div>
          )}

          {/* Members — click to edit, with readiness + per-company results */}
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            {members.map((q, idx) => {
              const ready = contactReady(q.id);
              const ct = custTargetOf(q.id);
              return (
                <button
                  key={q.id}
                  onClick={() => setCurrent(idx)}
                  disabled={running}
                  className={`w-full flex items-center justify-between px-3 py-2 border-b border-gray-50 last:border-0 text-sm text-left ${idx === current ? 'bg-ocean-50' : 'hover:bg-gray-50'}`}
                >
                  <span className="text-gray-700 truncate flex items-center gap-1.5 min-w-0">
                    {idx === current && <span className="text-ocean-600">▸</span>}
                    <span className="truncate">
                      {q.relationship_group || q.quote_ref}
                      {/* The QBO customer, on its own line — the Athena name
                          and the QBO name are often different and that has to
                          be visible without opening each company. */}
                      {ct && (ct.mode === 'existing' || ct.mode === 'link') && (
                        <span className="block text-xs text-gray-400 truncate" title={`Invoices QuickBooks customer "${ct.name}"${ct.id ? ` (#${ct.id})` : ''}`}>→ {ct.name}</span>
                      )}
                      {ct && ct.mode === 'new' && (
                        <span className="block text-xs text-amber-600 truncate">→ new customer</span>
                      )}
                    </span>
                  </span>
                  <div className="flex items-center gap-3 shrink-0">
                    {ct && ct.mode === 'undecided' && !results[q.id] && <span className="text-xs text-amber-600" title="No QuickBooks customer mapped — pick one">⚠ customer</span>}
                    {ct && ct.mode === 'missing' && !results[q.id] && <span className="text-xs text-red-600" title="Mapped to a QuickBooks customer that no longer exists">⚠ customer</span>}
                    {!ready && !results[q.id] && <span className="text-xs text-amber-600" title="Needs email + address">⚠ details</span>}
                    <span className="font-mono text-xs text-gray-500">{fmt(q.monthly_gross)}/mo</span>
                    {statusPill(results[q.id])}
                  </div>
                </button>
              );
            })}
            {members.length === 0 && <div className="px-3 py-3 text-sm text-gray-400">No accepted companies awaiting commit.</div>}
          </div>

          {!done && notReady.length > 0 && (
            <p className="text-xs text-amber-700">
              {notReady.length} {notReady.length === 1 ? 'company' : 'companies'} still need an email + address before you can commit.
            </p>
          )}
          {!done && custUndecided.length > 0 && (
            <p className="text-xs text-amber-700">
              {custUndecided.length} {custUndecided.length === 1 ? 'company needs' : 'companies need'} a QuickBooks customer chosen ({custUndecided.map((q) => q.relationship_group || q.quote_ref).join(', ')}) — committing without it would create a second customer for a client that may already have one.
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
