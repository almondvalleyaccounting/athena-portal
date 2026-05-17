import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { fmt, Btn, StatusBadge } from '../components/ui';
import { exportQboCsv, downloadCsv, generateQboImportCsv } from '../lib/qboExport';
import { pushToQbo } from '../lib/qboApi';
import QboConnectionPanel from '../components/QboConnectionPanel';
import { useAuth } from '../shell/AppShell';
import AlphabetFilter, { firstCharBucket } from '../components/AlphabetFilter';
import BillingTabs from '../modules/billing/BillingTabs';
import { tones as semanticTones } from '../lib/tokens';

export default function BillingPage() {
  const { profile } = useAuth();
  const [billing, setBilling] = useState([]);
  const [quotes, setQuotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [letter, setLetter] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [cardFilter, setCardFilter] = useState(null); // 'recurring' | 'annual' | 'one_off' | 'billed' | null
  const [showMissingPanel, setShowMissingPanel] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [importSuccess, setImportSuccess] = useState('');
  const [pushingId, setPushingId] = useState(null);
  const [syncLog, setSyncLog] = useState([]);
  const [showSyncLog, setShowSyncLog] = useState(false);
  const fileRef = useRef(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // Manual entry form state
  const [newEntry, setNewEntry] = useState({
    entity_name: '',
    entity_id: '',
    billing_type: 'recurring',
    monthly_net: 0,
    monthly_vat: 0,
    monthly_gross: 0,
    annual_total: 0,
    services: [],
  });

  // Entities lookup for manual entry
  const [entities, setEntities] = useState([]);

  useEffect(() => {
    loadData();
    // Detect QBO connection callback
    const qboParam = searchParams.get('qbo');
    if (qboParam === 'connected') {
      setImportSuccess('Successfully connected to QuickBooks Online!');
      searchParams.delete('qbo');
      setSearchParams(searchParams, { replace: true });
    } else if (qboParam === 'error') {
      const msg = searchParams.get('message') || 'QBO connection failed';
      setImportError(`QBO connection error: ${msg}`);
      searchParams.delete('qbo');
      searchParams.delete('message');
      setSearchParams(searchParams, { replace: true });
    }
  }, []);

  const [groupMembers, setGroupMembers] = useState([]); // [{entity_id, group_id}]
  const [ignoredEntityIds, setIgnoredEntityIds] = useState(new Set());

  const loadData = async () => {
    setLoading(true);
    try {
      // Load live_billing with entity join
      const { data: billingData } = await supabase
        .from('live_billing')
        .select('*, entity:entities(id, name, company_number)')
        .order('committed_at', { ascending: false });

      // Load accepted quotes for comparison
      const { data: acceptedQuotes } = await supabase
        .from('quotes')
        .select('id, entity_id, primary_entity_id, relationship_group, monthly_gross, monthly_net, annual_total, status, accepted_at, committed_at')
        .in('status', ['accepted', 'committed'])
        .order('accepted_at', { ascending: false });

      // Load entities (full set — we need status + source to compute
      // "clients without billing" correctly, excluding prospects and
      // entities whose only QBO link is an ignored customer).
      const { data: ents } = await supabase
        .from('entities')
        .select('id, name, entity_status, source')
        .order('name');

      // Billing-group membership — if any member of a group has a
      // live_billing row, every member counts as billed (relationship
      // billing: sole trader billed via the connected company).
      const { data: groupMemberRows } = await supabase
        .from('billing_group_members')
        .select('entity_id, group_id');

      // QBO customer mappings: entities whose mapping is flagged
      // role='not_a_client' are explicitly ignored — exclude them from
      // the "without billing" count.
      const { data: mappingRows } = await supabase
        .from('qbo_customer_mappings')
        .select('entity_id, role')
        .eq('role', 'not_a_client');

      const ignored = new Set();
      for (const m of (mappingRows || [])) {
        if (m.entity_id) ignored.add(m.entity_id);
      }

      // Load QBO sync log
      const { data: logData } = await supabase
        .from('qbo_sync_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20);

      setBilling(billingData || []);
      setQuotes(acceptedQuotes || []);
      setEntities(ents || []);
      setGroupMembers(groupMemberRows || []);
      setIgnoredEntityIds(ignored);
      setSyncLog(logData || []);
    } catch (e) {
      console.error('Failed to load billing data:', e);
    }
    setLoading(false);
  };

  // Push a single billing record to QBO
  const handlePushToQbo = async (billingId) => {
    setPushingId(billingId);
    setImportError('');
    try {
      const result = await pushToQbo(billingId, profile.id);
      if (result?.success) {
        setImportSuccess('Successfully pushed to QuickBooks Online!');
        loadData();
      } else {
        setImportError(result?.error || 'Push to QBO failed');
      }
    } catch (err) {
      setImportError(err.message || 'Push to QBO failed');
    }
    setPushingId(null);
  };

  // -- Summary calculations --
  // Classification lives on the services jsonb (per-service cadence).
  // Row-level billing_type is the dominant cadence and drives legacy
  // filters, but £-for-£ KPIs are derived from services.cadence so a
  // client with a mix (monthly bookkeeping + annual year-end) splits
  // correctly.
  const activeBilling = billing.filter((b) => b.status === 'active');

  // Net for management view — VAT is pass-through, not revenue.
  // Only *approved* monthly services count toward "Recurring Monthly" —
  // everything else (suggested by the classifier, not yet reviewed) is
  // surfaced separately in a pending bucket so the headline number is
  // a curated truth, not a guess.
  let recurringMonthlyNet = 0;
  let pendingMonthlyNet = 0;
  let pendingCount = 0;
  let stagedRowCount = 0;
  let approvedRowCount = 0;
  for (const b of activeBilling) {
    const services = Array.isArray(b.services) ? b.services : [];
    const hasPending = services.some((s) => s.pending_monthly_amount != null);
    if (hasPending) {
      stagedRowCount += 1;
      if (b.uplift_review_status === 'approved') approvedRowCount += 1;
    }
    for (const s of services) {
      if (s.cadence !== 'monthly') continue;
      // Lines explicitly marked as ending live in their own bucket on
      // the review queue and shouldn't pad either the headline recurring
      // or the pending count — otherwise the dashboard disagrees with
      // what you find when you click through.
      if (s.recurring_status === 'ending') continue;
      const amt = Number(s.monthly_amount) || 0;
      const status = s.approval_status || (b.qbo_recurring_txn_id ? 'approved' : 'suggested');
      if (status === 'approved') recurringMonthlyNet += amt;
      else if (status === 'suggested') { pendingMonthlyNet += amt; pendingCount += 1; }
      // 'rejected' is excluded from both
    }
    // Back-compat: rows with no services jsonb fall back to the row's
    // monthly_net (and are treated as approved — pre-approval era).
    if (services.length === 0 && b.billing_type === 'recurring') {
      recurringMonthlyNet += Number(b.monthly_net) || 0;
    }
  }

  // Annual fees: sum of services.cadence='annual' annual_amount across
  // all rows. Contributes to monthly equivalent as annual/12.
  const annualFees = activeBilling.reduce((sum, b) => {
    const services = Array.isArray(b.services) ? b.services : [];
    for (const s of services) {
      if (s.cadence === 'annual') sum += Number(s.annual_amount) || 0;
    }
    return sum;
  }, 0);

  // Recurring annual headline = monthly × 12 + annual fees (so both
  // streams show up in one annualised £ number).
  const recurringAnnual = recurringMonthlyNet * 12 + annualFees;

  const oneOffRows = activeBilling.filter((b) => b.billing_type === 'one_off');
  const oneOffLast12mo = oneOffRows.reduce((s, b) => s + (Number(b.annual_total) || 0), 0);

  const rowsNeedingReview = activeBilling.filter((b) => b.needs_review).length;

  // "Clients with billing" counts the *entities* that appear in any
  // live_billing row (recurring or one-off).
  const billedEntityIds = new Set(activeBilling.map((b) => b.entity_id));
  const clientsWithBilling = billedEntityIds.size;

  // "Clients without billing" — BM-sourced, active, not billed, not
  // ignored-via-QBO, and not billed through a relationship-group mate.
  // Build: group_id → member entity_ids
  const membersByGroup = {};
  for (const m of groupMembers) {
    (membersByGroup[m.group_id] ||= []).push(m.entity_id);
  }
  // For each group, if any member is billed, every member is "billed
  // through the group" (relationship billing — company paid, sole
  // trader owner attached).
  const groupBilledEntityIds = new Set();
  for (const [, memberIds] of Object.entries(membersByGroup)) {
    const anyBilled = memberIds.some((id) => billedEntityIds.has(id));
    if (anyBilled) memberIds.forEach((id) => groupBilledEntityIds.add(id));
  }
  const effectivelyBilled = new Set([...billedEntityIds, ...groupBilledEntityIds]);

  // Only `active` clients are chase-worthy — `prospect`, `archived`,
  // and `third_party` entities are deliberately off the list.
  const clientsWithoutList = entities.filter((e) => {
    if (e.entity_status !== 'active') return false;
    if (e.source && e.source !== 'brightmanager' && e.source !== 'athena') return false;
    if (ignoredEntityIds.has(e.id)) return false;
    return !effectivelyBilled.has(e.id);
  });
  const clientsWithout = clientsWithoutList.length;

  // -- Revenue by service type, split by cadence --
  // Each service line now carries its own cadence ('monthly' | 'annual'
  // | 'one_off'). Aggregate £ into three buckets per service so the
  // dashboard can show the true mix.
  const serviceBreakdown = (() => {
    const map = new Map(); // service_id → { monthly_annualised, annual, one_off }
    for (const b of activeBilling) {
      const rowCadence = b.billing_type === 'one_off' ? 'one_off'
        : b.billing_type === 'annual' ? 'annual'
        : 'monthly';
      const services = Array.isArray(b.services) ? b.services : [];
      for (const s of services) {
        // New writer sets s.cadence; old rows fall back to s.billing_type
        // or the parent row cadence.
        const kind = s.cadence
          || (s.billing_type === 'one_off' ? 'one_off' : s.billing_type === 'annual' ? 'annual' : rowCadence);
        const key = s.service_id || s.description || 'Unknown';
        if (!map.has(key)) {
          map.set(key, {
            service_id: key,
            description: s.description || key,
            monthly_annualised: 0,
            annual: 0,
            one_off: 0,
          });
        }
        const entry = map.get(key);
        const amt = Number(s.annual_amount) || 0;
        if (kind === 'annual') entry.annual += amt;
        else if (kind === 'one_off') entry.one_off += amt;
        else entry.monthly_annualised += amt;
      }
    }
    return [...map.values()].sort((a, b) =>
      (b.monthly_annualised + b.annual + b.one_off) - (a.monthly_annualised + a.annual + a.one_off)
    );
  })();

  // -- Filtered billing --
  // Card filter narrows the table by cadence. A row matches 'recurring'
  // if it has any monthly service (approved + suggested both surface —
  // drilling into the headline), 'annual' if any annual-cadence service,
  // and 'one_off' for the legacy one-off billing_type.
  const rowMatchesCardFilter = (b) => {
    if (!cardFilter) return true;
    const services = Array.isArray(b.services) ? b.services : [];
    if (cardFilter === 'one_off') return b.billing_type === 'one_off';
    if (cardFilter === 'annual')  return services.some((s) => s.cadence === 'annual')  || b.billing_type === 'annual';
    if (cardFilter === 'recurring') return services.some((s) => s.cadence === 'monthly') || (services.length === 0 && b.billing_type === 'recurring');
    if (cardFilter === 'billed') return b.status === 'active';
    return true;
  };

  const filtered = billing.filter((b) => {
    if (!rowMatchesCardFilter(b)) return false;
    const name = b.entity?.name || '';
    if (letter && firstCharBucket(name) !== letter) return false;
    if (!search) return true;
    return name.toLowerCase().includes(search.toLowerCase());
  });

  // -- Comparison data: build map of entity_id -> latest accepted quote --
  const latestQuoteByEntity = {};
  for (const q of quotes) {
    const eid = q.entity_id || q.primary_entity_id;
    if (!eid) continue;
    if (!latestQuoteByEntity[eid] || new Date(q.accepted_at) > new Date(latestQuoteByEntity[eid].accepted_at)) {
      latestQuoteByEntity[eid] = q;
    }
  }

  // -- CSV Import --
  const handleCsvImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportError('');
    setImportSuccess('');

    try {
      const text = await file.text();
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2) throw new Error('CSV must have a header row and at least one data row');

      const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
      const custIdx = headers.findIndex((h) => /customer/i.test(h));
      const svcIdx = headers.findIndex((h) => /service/i.test(h));
      const descIdx = headers.findIndex((h) => /description/i.test(h));
      const annualIdx = headers.findIndex((h) => /annual/i.test(h));
      const monthlyIdx = headers.findIndex((h) => /monthly/i.test(h));

      if (custIdx < 0) throw new Error('CSV must have a "Customer" column');

      // Group rows by customer
      const byCustomer = {};
      for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i]);
        const customer = cols[custIdx]?.trim();
        if (!customer) continue;
        if (!byCustomer[customer]) byCustomer[customer] = [];
        byCustomer[customer].push({
          service: cols[svcIdx]?.trim() || '',
          description: cols[descIdx >= 0 ? descIdx : svcIdx]?.trim() || '',
          annual_amount: parseFloat(cols[annualIdx] || '0') || 0,
          monthly_amount: parseFloat(cols[monthlyIdx] || '0') || 0,
        });
      }

      let created = 0;
      for (const [customer, items] of Object.entries(byCustomer)) {
        // Try to find matching entity
        const { data: matchedEntity } = await supabase
          .from('entities')
          .select('id')
          .ilike('name', customer)
          .limit(1)
          .single();

        const entityId = matchedEntity?.id || null;
        const services = items.map((it) => ({
          service_id: it.service,
          description: it.description || it.service,
          annual_amount: it.annual_amount,
          monthly_amount: it.monthly_amount,
        }));

        const annualTotal = items.reduce((s, it) => s + it.annual_amount, 0);
        const monthlyNet = items.reduce((s, it) => s + it.monthly_amount, 0);
        const monthlyVat = monthlyNet * 0.2;
        const monthlyGross = monthlyNet + monthlyVat;

        // Insert live_billing record
        const { error: bErr } = await supabase.from('live_billing').insert({
          entity_id: entityId,
          billing_type: 'recurring',
          monthly_net: monthlyNet,
          monthly_vat: monthlyVat,
          monthly_gross: monthlyGross,
          annual_total: annualTotal,
          services,
          status: 'active',
          committed_at: new Date().toISOString(),
          committed_by: profile.id,
          source: 'csv_import',
        });

        if (bErr) {
          console.error('Error inserting billing for', customer, bErr);
          continue;
        }

        // Insert entity_fees if we have entity match
        if (entityId) {
          for (const svc of services) {
            await supabase.from('entity_fees').upsert(
              {
                entity_id: entityId,
                service_id: svc.service_id || svc.description,
                description: svc.description,
                annual_amount: svc.annual_amount,
                monthly_amount: svc.monthly_amount,
                source: 'csv_import',
              },
              { onConflict: 'entity_id,service_id' }
            );
          }
        }
        created++;
      }

      setImportSuccess(`Imported ${created} billing records from ${Object.keys(byCustomer).length} customers.`);
      loadData();
    } catch (err) {
      setImportError(err.message || 'CSV import failed');
    }
    setImporting(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  // -- Manual Entry --
  const handleAddManual = async () => {
    if (!newEntry.entity_id) return;
    try {
      const { error: bErr } = await supabase.from('live_billing').insert({
        entity_id: newEntry.entity_id,
        billing_type: newEntry.billing_type,
        monthly_net: Number(newEntry.monthly_net) || 0,
        monthly_vat: Number(newEntry.monthly_vat) || 0,
        monthly_gross: Number(newEntry.monthly_gross) || 0,
        annual_total: Number(newEntry.annual_total) || 0,
        services: newEntry.services,
        status: 'active',
        committed_at: new Date().toISOString(),
        committed_by: profile.id,
        source: 'manual',
      });
      if (bErr) throw bErr;

      await supabase.from('audit_log').insert({
        user_id: profile.id,
        action: 'manual_billing_entry',
        entity_type: 'live_billing',
        entity_id: newEntry.entity_id,
        detail: { monthly_gross: Number(newEntry.monthly_gross), annual_total: Number(newEntry.annual_total) },
      });

      setShowAddForm(false);
      setNewEntry({ entity_name: '', entity_id: '', billing_type: 'recurring', monthly_net: 0, monthly_vat: 0, monthly_gross: 0, annual_total: 0, services: [] });
      loadData();
    } catch (err) {
      setImportError(err.message || 'Failed to add manual entry');
    }
  };

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-sm text-gray-400">Loading billing data...</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl">
      {/* Header */}
      <div className="flex justify-between items-start mb-4">
        <div>
          <h2 className="text-lg font-bold text-ocean-700">Live Billing</h2>
          <p className="text-xs text-gray-400">Manage live billing records and compare against quotes</p>
        </div>
        <div className="flex gap-2">
          <Btn onClick={() => navigate('/manage/billing/fee-earners')} variant="secondary">
            Fee earner book
          </Btn>
        </div>
      </div>

      <BillingTabs active="dashboard" />

      {/* Action banner: surfaces what's waiting on you with one-click
          jumps into each step. Hidden if there's nothing to do. */}
      {(pendingCount > 0 || stagedRowCount > 0 || approvedRowCount > 0) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 16,
          padding: '12px 16px', marginBottom: 16,
          background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 10,
          fontFamily: "'Outfit', sans-serif", flexWrap: 'wrap',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
            {pendingCount > 0 && (
              <ActionLine
                count={pendingCount}
                noun={pendingCount === 1 ? 'service' : 'services'}
                tone="warning"
                label="waiting for approval"
                ctaLabel="Review →"
                onClick={() => navigate('/manage/billing/review')}
              />
            )}
            {stagedRowCount > 0 && (
              <ActionLine
                count={stagedRowCount}
                noun={stagedRowCount === 1 ? 'client' : 'clients'}
                tone="accent"
                label="with staged uplifts"
                ctaLabel="Change →"
                onClick={() => navigate('/manage/billing/change')}
              />
            )}
            {approvedRowCount > 0 && (
              <ActionLine
                count={approvedRowCount}
                noun={approvedRowCount === 1 ? 'template' : 'templates'}
                tone="success"
                label="ready to push to QBO"
                ctaLabel="Push →"
                onClick={() => navigate('/manage/billing/uplifts')}
              />
            )}
          </div>
        </div>
      )}

      {/* QBO Connection Panel (includes Pull from QBO + Manage mapping) */}
      <QboConnectionPanel profile={profile} onSyncComplete={loadData} />

      {/* Summary Cards — each one lands you on the work it implies.
          Action labels (verb first) over vanity labels. */}
      <div className="grid grid-cols-6 gap-3 mb-4">
        <SummaryCard
          label="Recurring Monthly (Approved)"
          value={fmt(recurringMonthlyNet)}
          color="ocean"
          hint={cardFilter === 'recurring' ? 'Showing ↓ (clear)' : 'Show recurring →'}
          onClick={() => { setCardFilter(cardFilter === 'recurring' ? null : 'recurring'); setShowMissingPanel(false); }}
          active={cardFilter === 'recurring'}
        />
        <SummaryCard
          label={`Pending Approval${pendingCount > 0 ? ` (${pendingCount})` : ''}`}
          value={fmt(pendingMonthlyNet)}
          color="amber"
          hint={pendingCount > 0 ? 'Approve pending →' : null}
          onClick={pendingCount > 0 ? () => navigate('/manage/billing/review') : null}
        />
        <SummaryCard
          label="Annual Fees (12mo)"
          value={fmt(annualFees)}
          color="teal"
          hint={cardFilter === 'annual' ? 'Showing ↓ (clear)' : 'Show annual fees →'}
          onClick={() => { setCardFilter(cardFilter === 'annual' ? null : 'annual'); setShowMissingPanel(false); }}
          active={cardFilter === 'annual'}
        />
        <SummaryCard
          label="One-off (last 12 mo)"
          value={fmt(oneOffLast12mo)}
          color="purple"
          hint={cardFilter === 'one_off' ? 'Showing ↓ (clear)' : 'Show one-offs →'}
          onClick={() => { setCardFilter(cardFilter === 'one_off' ? null : 'one_off'); setShowMissingPanel(false); }}
          active={cardFilter === 'one_off'}
        />
        <SummaryCard
          label="Clients with Billing"
          value={clientsWithBilling}
          color="green"
          hint={cardFilter === 'billed' ? 'Showing ↓ (clear)' : 'Show billed clients →'}
          onClick={() => { setCardFilter(cardFilter === 'billed' ? null : 'billed'); setShowMissingPanel(false); }}
          active={cardFilter === 'billed'}
        />
        <SummaryCard
          label="Clients Without Billing"
          value={clientsWithout < 0 ? 0 : clientsWithout}
          color="amber"
          hint={clientsWithout > 0 ? (showMissingPanel ? 'Hide list' : 'Chase missing billing →') : null}
          onClick={clientsWithout > 0 ? () => { setShowMissingPanel((v) => !v); setCardFilter(null); } : null}
          active={showMissingPanel}
        />
      </div>

      {/* Missing-billing list — revealed from the orange "Clients Without
          Billing" card. Third-party / prospect / archived entities are
          intentionally excluded from this count. */}
      {showMissingPanel && (
        <div className="mb-4 bg-white rounded-lg border border-amber-200 overflow-hidden">
          <div className="px-4 py-2 border-b border-amber-100 bg-amber-50 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-amber-800">Clients without billing ({clientsWithout})</h3>
              <p className="text-xs text-amber-700/80">Active clients with no live billing and no billing-group relation. Reclassify as <b>third-party</b>, <b>prospect</b>, or <b>archived</b> to remove from this list.</p>
            </div>
            <button
              onClick={() => setShowMissingPanel(false)}
              className="text-xs text-amber-700 hover:text-amber-900"
            >Close</button>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {clientsWithoutList.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-gray-400">None — every active client is billed.</div>
            ) : (
              clientsWithoutList.map((e) => (
                <div key={e.id} className="flex items-center justify-between px-4 py-2 text-xs border-b border-gray-50 last:border-0 hover:bg-gray-50">
                  <button
                    onClick={() => navigate(`/clients/${e.id}`)}
                    className="text-left text-gray-700 hover:text-ocean-700 hover:underline font-medium"
                  >
                    {e.name}
                  </button>
                  <div className="flex gap-2">
                    <button
                      onClick={() => navigate(`/manage/quotes/new?entity=${e.id}`)}
                      className="text-xs text-ocean-700 hover:underline"
                    >Create quote</button>
                    <button
                      onClick={() => navigate(`/clients/${e.id}`)}
                      className="text-xs text-gray-500 hover:underline"
                    >Reclassify</button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Revenue by service type — split by cadence */}
      {serviceBreakdown.length > 0 && (
        <div className="mb-4">
          <h3 className="text-sm font-bold text-ocean-700 mb-2">Revenue by service type (annualised)</h3>
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <div className="grid text-xs font-medium text-gray-400 uppercase px-4 py-2 border-b border-gray-100" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr' }}>
              <span>Service</span>
              <span className="text-right">Monthly</span>
              <span className="text-right">Monthly × 12</span>
              <span className="text-right">Annual fees</span>
              <span className="text-right">One-off (12mo)</span>
              <span className="text-right">Total</span>
            </div>
            {serviceBreakdown.map((s) => (
              <div key={s.service_id} className="grid text-xs px-4 py-2 border-b border-gray-50" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr' }}>
                <span className="text-gray-700 font-medium" title={s.description}>{s.service_id}</span>
                <span className="text-right font-mono text-ocean-700">{fmt(s.monthly_annualised / 12)}</span>
                <span className="text-right font-mono text-ocean-700">{fmt(s.monthly_annualised)}</span>
                <span className="text-right font-mono text-teal-700">{fmt(s.annual)}</span>
                <span className="text-right font-mono text-purple-700">{fmt(s.one_off)}</span>
                <span className="text-right font-mono text-gray-700 font-semibold">{fmt(s.monthly_annualised + s.annual + s.one_off)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mb-3">
        <AlphabetFilter
          items={billing.map(b => ({ name: b.entity?.name || '' }))}
          selected={letter}
          onChange={setLetter}
        />
      </div>

      {/* Active card filter chip */}
      {cardFilter && (
        <div className="mb-3 inline-flex items-center gap-2 bg-ocean-50 border border-ocean-200 rounded-full px-3 py-1 text-xs text-ocean-700">
          <span>Filtered: {cardFilter === 'one_off' ? 'One-off' : cardFilter === 'annual' ? 'Annual fees' : cardFilter === 'billed' ? 'All billed' : 'Recurring'}</span>
          <button onClick={() => setCardFilter(null)} className="hover:underline font-medium">Clear</button>
        </div>
      )}

      {/* Search + Actions */}
      <div className="flex items-center gap-3 mb-4">
        <input
          type="text"
          placeholder="Search by client name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-2 w-64 focus:outline-none focus:ring-1 focus:ring-ocean-300"
        />
        <Btn onClick={() => setShowAddForm(!showAddForm)} variant="secondary">
          {showAddForm ? 'Cancel' : 'Add Manual Entry'}
        </Btn>
        <label className="cursor-pointer">
          <Btn onClick={() => fileRef.current?.click()} variant="secondary" disabled={importing}>
            {importing ? 'Importing...' : 'Import from CSV'}
          </Btn>
          <input ref={fileRef} type="file" accept=".csv" onChange={handleCsvImport} className="hidden" />
        </label>
      </div>

      {importError && <div className="text-xs text-red-600 bg-red-50 rounded p-2 mb-3">{importError}</div>}
      {importSuccess && <div className="text-xs text-green-600 bg-green-50 rounded p-2 mb-3">{importSuccess}</div>}

      {/* Manual Entry Form */}
      {showAddForm && (
        <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
          <h3 className="text-sm font-semibold text-ocean-700 mb-3">Add Manual Billing Entry</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-500 block mb-1">Client</label>
              <select
                value={newEntry.entity_id}
                onChange={(e) => setNewEntry({ ...newEntry, entity_id: e.target.value })}
                className="w-full text-sm border border-gray-200 rounded px-2 py-1.5"
              >
                <option value="">Select client...</option>
                {entities.map((ent) => (
                  <option key={ent.id} value={ent.id}>{ent.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Billing Type</label>
              <select
                value={newEntry.billing_type}
                onChange={(e) => setNewEntry({ ...newEntry, billing_type: e.target.value })}
                className="w-full text-sm border border-gray-200 rounded px-2 py-1.5"
              >
                <option value="recurring">Recurring</option>
                <option value="one_off">One-Off</option>
                <option value="ad_hoc">Ad Hoc</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Monthly Net</label>
              <input
                type="number"
                step="0.01"
                value={newEntry.monthly_net}
                onChange={(e) => {
                  const net = parseFloat(e.target.value) || 0;
                  const vat = net * 0.2;
                  setNewEntry({ ...newEntry, monthly_net: net, monthly_vat: vat, monthly_gross: net + vat, annual_total: net * 12 });
                }}
                className="w-full text-sm border border-gray-200 rounded px-2 py-1.5 font-mono"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Monthly Gross</label>
              <input
                type="number"
                step="0.01"
                value={newEntry.monthly_gross}
                disabled
                className="w-full text-sm border border-gray-200 rounded px-2 py-1.5 font-mono bg-gray-50"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Annual Total</label>
              <input
                type="number"
                step="0.01"
                value={newEntry.annual_total}
                disabled
                className="w-full text-sm border border-gray-200 rounded px-2 py-1.5 font-mono bg-gray-50"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-3">
            <Btn onClick={() => setShowAddForm(false)} variant="ghost">Cancel</Btn>
            <Btn onClick={handleAddManual} variant="primary" disabled={!newEntry.entity_id}>Add Entry</Btn>
          </div>
        </div>
      )}

      {/* Billing Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden mb-6">
        <div className="grid text-xs font-medium text-gray-400 uppercase px-4 py-2 border-b border-gray-100" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr 1fr' }}>
          <span>Client</span>
          <span className="text-right">Type</span>
          <span className="text-right">Monthly Net</span>
          <span className="text-right">Monthly Gross</span>
          <span className="text-right">Annual</span>
          <span className="text-right">Status</span>
          <span className="text-right">QBO Sync</span>
        </div>
        {filtered.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-gray-400">
            No billing records found.
          </div>
        ) : (
          filtered.map((b) => {
            const isExpanded = expandedId === b.id;
            const services = Array.isArray(b.services) ? b.services : [];
            return (
              <div key={b.id}>
                <div
                  className={`grid text-xs px-4 py-2.5 border-b border-gray-50 cursor-pointer hover:bg-gray-50 transition-colors ${isExpanded ? 'bg-ocean-50' : ''}`}
                  style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr 1fr' }}
                  onClick={() => setExpandedId(isExpanded ? null : b.id)}
                >
                  <span className="text-gray-700 font-medium">{b.entity?.name || 'Unknown'}</span>
                  <span className="text-right text-gray-500 capitalize">{(b.billing_type || '').replace('_', ' ')}</span>
                  <span className="text-right font-mono text-gray-700">{fmt(b.monthly_net)}</span>
                  <span className="text-right font-mono text-ocean-700 font-semibold">{fmt(b.monthly_gross)}</span>
                  <span className="text-right font-mono text-gray-700">{fmt(b.annual_total)}</span>
                  <span className="text-right">
                    <span className={`inline-block px-1.5 py-0.5 rounded-full text-xs font-medium ${b.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {b.status || 'active'}
                    </span>
                  </span>
                  <span className="text-right text-gray-400 flex items-center justify-end gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      b.qbo_sync_status === 'synced' ? 'bg-green-500'
                      : b.qbo_sync_status === 'pending' ? 'bg-amber-500'
                      : b.qbo_sync_status === 'error' ? 'bg-red-500'
                      : 'bg-gray-300'
                    }`} />
                    {b.last_qbo_sync ? new Date(b.last_qbo_sync).toLocaleDateString('en-GB') : '--'}
                  </span>
                </div>
                {/* Expanded Service Breakdown */}
                {isExpanded && (
                  <div className="px-6 py-3 bg-gray-50 border-b border-gray-100">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-xs font-semibold text-gray-500 uppercase">Service Breakdown</h4>
                      <div className="flex gap-2">
                        <Btn
                          onClick={(e) => {
                            e.stopPropagation();
                            handlePushToQbo(b.id);
                          }}
                          variant="secondary"
                          className="text-xs"
                          disabled={pushingId === b.id}
                        >
                          {pushingId === b.id ? 'Pushing...' : 'Push to QBO'}
                        </Btn>
                        <Btn
                          onClick={(e) => {
                            e.stopPropagation();
                            const qboItems = services.map((s) => ({
                              service_id: s.service_id,
                              description: s.description,
                              qty: 1,
                              rate: s.monthly_amount,
                              amount: s.monthly_amount,
                            }));
                            exportQboCsv(b.entity?.name || 'Client', qboItems, true);
                          }}
                          variant="ghost"
                          className="text-xs"
                        >
                          Export CSV
                        </Btn>
                      </div>
                    </div>
                    {services.length > 0 ? (
                      <div className="space-y-1">
                        {services.map((s, idx) => (
                          <div key={idx} className="flex justify-between text-xs py-1 border-b border-gray-100 last:border-0">
                            <span className="text-gray-600">{s.description || s.service_id}</span>
                            <span className="font-mono text-gray-700">
                              {fmt(s.annual_amount)}/yr ({fmt(s.monthly_amount)}/mo)
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-gray-400">No service breakdown available.</p>
                    )}
                    {b.quote_id && (
                      <p className="text-xs text-gray-400 mt-2">
                        Source Quote: <span className="text-ocean-600">{b.quote_id.slice(0, 8)}</span>
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* QBO Sync History */}
      {syncLog.length > 0 && (
        <div className="mb-6">
          <button
            onClick={() => setShowSyncLog(!showSyncLog)}
            className="flex items-center gap-1 text-sm font-bold text-ocean-700 mb-3 hover:underline"
          >
            <span className={`transition-transform ${showSyncLog ? 'rotate-90' : ''}`}>&#9654;</span>
            QBO Sync History ({syncLog.length})
          </button>
          {showSyncLog && (
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <div className="grid text-xs font-medium text-gray-400 uppercase px-4 py-2 border-b border-gray-100" style={{ gridTemplateColumns: '60px 1.5fr 1fr 1fr 2fr' }}>
                <span>Dir</span>
                <span>Entity</span>
                <span>Status</span>
                <span>Time</span>
                <span>Detail</span>
              </div>
              {syncLog.map((log) => (
                <div key={log.id} className="grid text-xs px-4 py-2 border-b border-gray-50" style={{ gridTemplateColumns: '60px 1.5fr 1fr 1fr 2fr' }}>
                  <span className={`font-medium ${log.direction === 'push' ? 'text-blue-600' : 'text-purple-600'}`}>
                    {log.direction === 'push' ? '↑ Push' : '↓ Pull'}
                  </span>
                  <span className="text-gray-700">{log.entity_name || '--'}</span>
                  <span>
                    <span className={`inline-block px-1.5 py-0.5 rounded-full text-xs font-medium ${
                      log.status === 'success' ? 'bg-green-100 text-green-700'
                      : log.status === 'error' ? 'bg-red-100 text-red-700'
                      : log.status === 'skipped' ? 'bg-gray-100 text-gray-500'
                      : 'bg-amber-100 text-amber-700'
                    }`}>
                      {log.status}
                    </span>
                  </span>
                  <span className="text-gray-400">
                    {new Date(log.created_at).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="text-gray-500 truncate">
                    {log.error_message || (log.detail ? JSON.stringify(log.detail).slice(0, 80) : '--')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Comparison Section */}
      <div className="mb-6">
        <h3 className="text-sm font-bold text-ocean-700 mb-3">Live vs Quote Comparison</h3>
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="grid text-xs font-medium text-gray-400 uppercase px-4 py-2 border-b border-gray-100" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr' }}>
            <span>Client</span>
            <span className="text-right">Live Monthly</span>
            <span className="text-right">Quote Monthly</span>
            <span className="text-right">Delta</span>
          </div>
          {activeBilling.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-gray-400">
              No active billing records to compare.
            </div>
          ) : (
            activeBilling.map((b) => {
              const latestQuote = latestQuoteByEntity[b.entity_id];
              const liveGross = Number(b.monthly_gross) || 0;
              const quoteGross = latestQuote ? Number(latestQuote.monthly_gross) || 0 : null;
              const delta = quoteGross != null ? liveGross - quoteGross : null;
              let deltaColor = 'text-gray-400';
              let deltaBg = '';
              if (delta != null && delta > 0.5) {
                deltaColor = 'text-green-700';
                deltaBg = 'bg-green-50';
              } else if (delta != null && delta < -0.5) {
                deltaColor = 'text-red-700';
                deltaBg = 'bg-red-50';
              }
              return (
                <div key={b.id} className={`grid text-xs px-4 py-2.5 border-b border-gray-50 ${deltaBg}`} style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr' }}>
                  <span className="text-gray-700 font-medium">{b.entity?.name || 'Unknown'}</span>
                  <span className="text-right font-mono text-ocean-700 font-semibold">{fmt(liveGross)}</span>
                  <span className="text-right font-mono text-gray-600">
                    {quoteGross != null ? fmt(quoteGross) : <span className="text-gray-300">No quote</span>}
                  </span>
                  <span className={`text-right font-mono font-semibold ${deltaColor}`}>
                    {delta != null ? (delta >= 0 ? '+' : '') + fmt(delta) : '--'}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// -- Helper Components --

function SummaryCard({ label, value, color, hint, onClick, active }) {
  const colors = {
    ocean: 'bg-ocean-50 text-ocean-700 border-ocean-200',
    green: 'bg-green-50 text-green-700 border-green-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    purple: 'bg-purple-50 text-purple-700 border-purple-200',
    teal: 'bg-teal-50 text-teal-700 border-teal-200',
  };
  const clickable = typeof onClick === 'function';
  const activeRing = active ? 'ring-2 ring-offset-1 ring-current' : '';
  return (
    <div
      className={`rounded-lg border p-3 transition-all ${colors[color] || colors.ocean} ${clickable ? 'cursor-pointer hover:shadow-sm hover:-translate-y-px' : ''} ${activeRing}`}
      onClick={clickable ? onClick : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
    >
      <p className="text-xs opacity-70 mb-1">{label}</p>
      <p className="text-lg font-bold font-mono">{value}</p>
      {hint && <p className="text-xs opacity-80 mt-1 underline">{hint}</p>}
    </div>
  );
}

function ActionLine({ count, noun, tone, label, ctaLabel, onClick }) {
  const t = semanticTones[tone] || semanticTones.warning;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#1e293b' }}>
      <span style={{
        fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
        background: t.bg, color: t.fg,
      }}>{count}</span>
      <span>{noun} {label}</span>
      <button onClick={onClick} style={{
        fontSize: 12, fontWeight: 600, padding: '3px 10px',
        background: '#fff', color: '#0f172a',
        border: '1px solid #e5e7eb', borderRadius: 6,
        cursor: 'pointer', fontFamily: "'Outfit', sans-serif",
      }}>{ctaLabel}</button>
    </span>
  );
}

// Simple CSV line parser handling quoted fields
function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}
