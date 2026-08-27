import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { Inp, TabRow, Section, Btn, fmt, G4, C4 } from '../components/ui';
import DirectorCard from '../components/DirectorCard';
import useQuoteForm from '../hooks/useQuoteForm';
import { useAuth } from '../shell/AppShell';
import { useFeeEngine } from '../contexts/FeeEngineContext';

// Reverse-map a live_billing services[] array (whose service_id is the QBO
// item name) back to Athena service ids via the qbo_service_items map.
// Two QBO items map from two Athena services each (Payroll, Bookkeeping &
// VAT) — prefer the "primary". Returns mappable { serviceId, annual,
// monthly } lines plus any unmapped lines.
function mapServicesToSeed(services, maps) {
  const PRIMARY = { payroll: 1, bookkeeping_vat: 1 };
  const byItemName = {};
  for (const m of maps || []) {
    const key = (m.qbo_item_name || '').toLowerCase().trim();
    if (!key) continue;
    (byItemName[key] = byItemName[key] || []).push(m.service_id);
  }
  const resolve = (sids) => sids.slice().sort((a, b) => (PRIMARY[b] || 0) - (PRIMARY[a] || 0))[0];
  const lines = [];
  const unmapped = [];
  for (const s of services || []) {
    const k1 = String(s.service_id || '').toLowerCase().trim();
    const k2 = String(s.description || '').toLowerCase().trim();
    const sids = byItemName[k1] || byItemName[k2];
    const annual = Number(s.annual_amount) || (Number(s.monthly_amount) || 0) * 12;
    const monthly = Number(s.monthly_amount) || annual / 12;
    if (sids && sids.length) lines.push({ serviceId: resolve(sids), annual, monthly, source: s.description || s.service_id });
    else unmapped.push({ label: s.description || s.service_id, annual, monthly });
  }
  return { lines, unmapped };
}

export default function QuoteFormPage({ mode = 'new' }) {
  const { profile } = useAuth();
  const { defaults: D } = useFeeEngine();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { id: quoteId } = useParams();
  const entityId = searchParams.get('entity');
  const fromId = searchParams.get('from');
  const groupParam = searchParams.get('group');
  const seedParam = searchParams.get('seed'); // 'source' → open cross-client picker

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [entity, setEntity] = useState(null);
  const [existingQuoteRef, setExistingQuoteRef] = useState(null);
  const [formLoading, setFormLoading] = useState(mode === 'edit' || !!fromId);
  // Existing recurring bill available to seed this quote from (new quotes only).
  const [billingSeed, setBillingSeed] = useState(null); // { lines: [{serviceId, annual, monthly}], unmapped: [], raw }
  const [seedReview, setSeedReview] = useState(null); // string[] after seeding

  // The hook holds all form state, computed values, and builders
  const f = useQuoteForm(D);

  // Load entity from URL param
  useEffect(() => {
    if (entityId) {
      supabase.from('entities').select('*').eq('id', entityId).single()
        .then(({ data }) => {
          if (data) {
            setEntity(data);
            f.setClient(c => ({
              ...c,
              name: data.name || c.name,
              companyNumber: data.company_number || c.companyNumber,
              entityType: data.type || c.entityType,
            }));
          }
        });
    }
  }, [entityId]);

  // New quotes can be seeded from a recurring bill — either this client's
  // own (auto-detected below) or another client's (picker). Load the
  // service→item map and the list of clients that have an active recurring
  // bill once, up front.
  const [serviceMaps, setServiceMaps] = useState([]);
  const [sourceClients, setSourceClients] = useState([]); // [{entity_id, name, monthly_net, services}]
  const [showSourcePicker, setShowSourcePicker] = useState(seedParam === 'source');
  const [sourceId, setSourceId] = useState('');
  const [sourcePriceMode, setSourcePriceMode] = useState('copy'); // 'copy' | 'services'

  useEffect(() => {
    if (mode === 'edit') return;
    let cancelled = false;
    (async () => {
      const [{ data: maps }, { data: billing }] = await Promise.all([
        // Canonical rows only — is_adhoc rows reuse item names (see sql/175).
        supabase.from('qbo_service_items').select('service_id, qbo_item_name').eq('is_adhoc', false),
        supabase.from('live_billing')
          .select('entity_id, monthly_net, services, entity:entities(id, name)')
          .eq('status', 'active'),
      ]);
      if (cancelled) return;
      setServiceMaps(maps || []);
      // Dedupe to one bill per entity (the richest), only those with services.
      const byEntity = new Map();
      for (const r of billing || []) {
        if (!r.entity_id || !Array.isArray(r.services) || r.services.length === 0) continue;
        const prev = byEntity.get(r.entity_id);
        if (!prev || (r.services.length > (prev.services?.length || 0))) {
          byEntity.set(r.entity_id, { entity_id: r.entity_id, name: r.entity?.name || 'Client', monthly_net: r.monthly_net, services: r.services });
        }
      }
      setSourceClients([...byEntity.values()].sort((a, b) => a.name.localeCompare(b.name)));
    })();
    return () => { cancelled = true; };
  }, [mode]);

  // Auto-detect this client's own bill once maps + source list are loaded.
  useEffect(() => {
    if (mode === 'edit' || fromId || !entityId || sourceClients.length === 0) return;
    const own = sourceClients.find((c) => c.entity_id === entityId);
    if (!own) { setBillingSeed(null); return; }
    const { lines, unmapped } = mapServicesToSeed(own.services, serviceMaps);
    setBillingSeed({ lines, unmapped, monthlyNet: own.monthly_net });
  }, [entityId, mode, fromId, sourceClients, serviceMaps]);

  const handleSeedFromBilling = () => {
    if (!billingSeed) return;
    const review = f.seedFromBilling(billingSeed.lines, { priceMode: 'copy' });
    const unmappedLabels = (billingSeed.unmapped || []).map((u) => `${u.label} (£${Math.round(u.monthly)}/mo — not mapped to a service)`);
    setSeedReview([...review, ...unmappedLabels]);
  };

  const handleSeedFromSource = () => {
    const src = sourceClients.find((c) => c.entity_id === sourceId);
    if (!src) return;
    const { lines, unmapped } = mapServicesToSeed(src.services, serviceMaps);
    const review = f.seedFromBilling(lines, { priceMode: sourcePriceMode });
    const unmappedLabels = (unmapped || []).map((u) => `${u.label} (£${Math.round(u.monthly)}/mo — not mapped to a service)`);
    const modeNote = sourcePriceMode === 'services'
      ? [`Services copied from ${src.name}; priced at this client's standard rates — review every figure.`]
      : [`Prices copied from ${src.name}'s bill.`];
    setSeedReview([...modeNote, ...review, ...unmappedLabels]);
    setShowSourcePicker(false);
  };

  // Load existing quote for edit or re-quote
  useEffect(() => {
    const loadId = mode === 'edit' ? quoteId : fromId;
    if (!loadId) return;

    (async () => {
      const { data: q } = await supabase.from('quotes').select('*').eq('id', loadId).single();
      if (!q) { navigate('/manage/quotes'); return; }
      if (mode === 'edit' && q.status !== 'draft' && q.status !== 'pending_approval') { navigate(`/manage/quotes/${loadId}`); return; }

      f.loadFromQuote(q);

      // Several services are only persisted as line_items (no matching
      // *_detail JSON on the quote row): confirmation statement, VAT
      // returns, auto-enrolment, registered office. Re-hydrate their
      // enabled flags and rates from the saved line items.
      const { data: lineItems } = await supabase
        .from('quote_line_items')
        .select('service_id, annual_amount')
        .eq('quote_id', loadId);
      const items = lineItems || [];
      const findLI = (sid) => items.find((l) => l.service_id === sid);

      const csLI = findLI('confirmation_statement');
      f.setCsEnabled(!!csLI);
      if (csLI?.annual_amount != null) f.setCsFee(Number(csLI.annual_amount));

      const vatLI = findLI('vat_returns');
      if (vatLI) {
        f.setVatEnabled(true);
        // The line stores annual = freq × rate. Default freq is 4
        // (quarterly); derive a per-return rate from the saved annual so
        // the form round-trips to the same total.
        const annual = Number(vatLI.annual_amount) || 0;
        f.setVatFreq(4);
        if (annual > 0) f.setVatRate(Math.round((annual / 4) * 100) / 100);
      }

      const aeLI = findLI('auto_enrolment');
      if (aeLI) {
        f.setAeEnabled(true);
        if (aeLI.annual_amount != null) f.setAeFee(Number(aeLI.annual_amount));
      }

      const roLI = findLI('registered_office');
      if (roLI) {
        f.setRoEnabled(true);
        if (roLI.annual_amount != null) f.setRoFee(Number(roLI.annual_amount));
      }

      const staLI = findLI('sole_trader_accounts');
      if (staLI) {
        f.setStaEnabled(true);
        if (staLI.annual_amount != null) f.setStaFee(Number(staLI.annual_amount));
      }

      const mtdLI = findLI('mtd_returns');
      if (mtdLI) {
        f.setMtdEnabled(true);
        // Line stores annual = freq × rate. Default freq 4 (quarterly); derive
        // a per-return rate from the saved annual so the form round-trips.
        const annual = Number(mtdLI.annual_amount) || 0;
        f.setMtdFreq(4);
        if (annual > 0) f.setMtdRate(Math.round((annual / 4) * 100) / 100);
      }

      if (mode === 'edit') {
        setExistingQuoteRef(q.quote_ref);
      }
      // Carry the source quote's entity link forward for both edit and
      // re-quote — otherwise re-quote auto-creates a duplicate entity (or,
      // worse, silently saves the new quote with entity_id=NULL).
      if (q.entity_id) setEntity({ id: q.entity_id });

      setFormLoading(false);
    })();
  }, [mode, quoteId, fromId]);

  // ── Save to Supabase ──
  const handleSave = async (redirectTo) => {
    setSaving(true);
    setError('');
    try {
      const { data: quoteData, setupLines } = f.buildQuoteData();

      if (mode === 'edit') {
        const { error: updateErr } = await supabase
          .from('quotes').update(quoteData).eq('id', quoteId);
        if (updateErr) throw updateErr;

        await supabase.from('quote_line_items').delete().eq('quote_id', quoteId);
        const items = f.buildLineItems(quoteId, setupLines);
        if (items.length > 0) {
          const { error: liErr } = await supabase.from('quote_line_items').insert(items);
          if (liErr) throw liErr;
        }

        await supabase.from('audit_log').insert({
          user_id: profile.id, action: 'updated', entity_type: 'quote', entity_id: quoteId,
          detail: { monthly_gross: f.monthlyGross },
        });

        navigate('/manage/quotes/' + quoteId);
      } else {
        const nameSlug = (f.client.name || 'Quote').replace(/[^a-zA-Z0-9]/g, '');
        const dateSlug = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const prefix = `${nameSlug}_${dateSlug}`;

        const { data: existing } = await supabase
          .from('quotes').select('quote_ref').like('quote_ref', `${prefix}%`);

        const nums = (existing || []).map((q) => parseInt(q.quote_ref.split('_').pop()) || 0);
        const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
        const quoteRef = `${prefix}_${String(next).padStart(3, '0')}`;

        // Resolve entity link: prefer the already-loaded entity, else
        // match an existing entity by name (case-insensitive), else create
        // one. Surface errors instead of silently saving a quote with
        // entity_id=NULL — that's how unlinked group quotes happened.
        let entityId = entity?.id || null;
        if (!entityId && f.client.name) {
          const name = f.client.name.trim();
          const { data: existingEnt } = await supabase
            .from('entities')
            .select('id, name, type, company_number')
            .ilike('name', name)
            .limit(1)
            .maybeSingle();
          if (existingEnt) {
            entityId = existingEnt.id;
            setEntity(existingEnt);
          } else {
            const { data: newEntity, error: entErr } = await supabase
              .from('entities')
              .insert({
                name,
                type: f.client.entityType || 'limited_company',
                company_number: f.client.companyNumber || null,
              })
              .select().single();
            if (entErr) {
              setError(`Couldn't create the client record: ${entErr.message}`);
              setSaving(false);
              return;
            }
            if (newEntity) {
              entityId = newEntity.id;
              setEntity(newEntity);
            }
          }
        }
        if (!entityId) {
          setError("Couldn't determine the client for this quote. Pick an existing client or enter a client name.");
          setSaving(false);
          return;
        }

        const { data: savedQuotes, error: quoteErr } = await supabase
          .from('quotes')
          .insert({
            ...quoteData,
            quote_ref: quoteRef,
            entity_id: entityId,
            group_id: groupParam || null,
            status: 'draft',
            created_by: profile.id,
          })
          .select();

        if (quoteErr) {
          if (quoteErr.message?.includes('duplicate') || quoteErr.code === '23505') {
            setError('Quote ref collision \u2014 please try saving again.');
            setSaving(false);
            return;
          }
          throw quoteErr;
        }

        const savedQuote = savedQuotes[0];
        const items = f.buildLineItems(savedQuote.id, setupLines);
        if (items.length > 0) {
          const { error: liErr } = await supabase.from('quote_line_items').insert(items);
          if (liErr) throw liErr;
        }

        // If "Save & Add Another", ensure group exists then navigate to new form
        if (redirectTo === 'add-another') {
          let gid = savedQuote.group_id || groupParam;
          if (!gid) {
            // Create a group from the client name
            const { data: newGroup } = await supabase
              .from('billing_groups')
              .insert({ name: f.client.name || 'Group', created_by: profile.id })
              .select().single();
            gid = newGroup.id;
            // Link this quote to the group
            await supabase.from('quotes').update({ group_id: gid }).eq('id', savedQuote.id);
            if (entity?.id) {
              await supabase.from('billing_group_members')
                .upsert({ entity_id: entity.id, group_id: gid });
            }
          }
          navigate('/manage/quotes/new?group=' + gid);
        } else {
          navigate('/manage/quotes/' + savedQuote.id);
        }
      }
    } catch (e) {
      setError(e.message || 'Save failed');
    }
    setSaving(false);
  };

  // ── RENDER ──
  if (formLoading) {
    return <div className="p-6"><p className="text-sm text-gray-400">Loading quote...</p></div>;
  }

  return (
    <div className="p-6 max-w-2xl">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h2 className="text-lg font-bold text-ocean-700">
            {mode === 'edit' ? 'Edit Quote' : fromId ? 'Re-quote' : 'New Quote'}
          </h2>
          {existingQuoteRef && <p className="text-xs text-gray-400">{existingQuoteRef}</p>}
          {entity?.name && <p className="text-xs text-gray-400">{entity.name} {entity.company_number ? `(${entity.company_number})` : ''}</p>}
        </div>
        <Btn onClick={() => navigate(-1)} variant="ghost">Cancel</Btn>
      </div>

      {error && <div className="text-xs text-red-600 bg-red-50 rounded p-2 mb-3">{error}</div>}

      {/* Seed from this client's own recurring bill */}
      {mode !== 'edit' && !fromId && billingSeed && !seedReview && (
        <div className="bg-ocean-50 border border-ocean-200 rounded-lg p-3 mb-3 flex items-center justify-between gap-3">
          <div className="text-xs text-ocean-800">
            This client has a live recurring bill ({fmt(billingSeed.monthlyNet)}/mo net across {billingSeed.lines.length + (billingSeed.unmapped?.length || 0)} services).
            Seed this quote from it?
          </div>
          <Btn onClick={handleSeedFromBilling} variant="secondary" className="whitespace-nowrap">Seed from current bill</Btn>
        </div>
      )}

      {/* Seed from ANOTHER client's recurring bill (e.g. "use Dog Bothwell pricing") */}
      {mode !== 'edit' && !fromId && !seedReview && sourceClients.length > 0 && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 mb-3">
          {!showSourcePicker ? (
            <Btn onClick={() => setShowSourcePicker(true)} variant="primary" className="text-xs">
              ⎘ Seed from another client's pricing…
            </Btn>
          ) : (
            <div className="space-y-2">
              <div className="text-xs font-medium text-gray-700">Copy pricing from another client's recurring bill</div>
              <select
                value={sourceId}
                onChange={(e) => setSourceId(e.target.value)}
                className="w-full text-xs border border-gray-200 rounded px-2 py-1.5 bg-white"
              >
                <option value="">— choose a client —</option>
                {sourceClients.filter((c) => c.entity_id !== entityId).map((c) => (
                  <option key={c.entity_id} value={c.entity_id}>{c.name} ({fmt(c.monthly_net)}/mo)</option>
                ))}
              </select>
              <div className="flex flex-col gap-1">
                <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
                  <input type="radio" name="srcMode" checked={sourcePriceMode === 'copy'} onChange={() => setSourcePriceMode('copy')} className="accent-ocean-600" />
                  Copy their exact bill prices
                </label>
                <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
                  <input type="radio" name="srcMode" checked={sourcePriceMode === 'services'} onChange={() => setSourcePriceMode('services')} className="accent-ocean-600" />
                  Same services, priced at this client's standard rates
                </label>
              </div>
              <div className="flex gap-2">
                <Btn onClick={handleSeedFromSource} disabled={!sourceId} variant="secondary" className="text-xs">Apply</Btn>
                <Btn onClick={() => { setShowSourcePicker(false); setSourceId(''); }} variant="ghost" className="text-xs">Cancel</Btn>
              </div>
            </div>
          )}
        </div>
      )}
      {seedReview && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-3">
          <p className="text-xs font-semibold text-amber-800 mb-1">Quote seeded from a recurring bill. Please review:</p>
          {seedReview.length === 0 ? (
            <p className="text-xs text-amber-700">All services mapped cleanly. Check the figures and add any driver detail.</p>
          ) : (
            <ul className="text-xs text-amber-700 list-disc pl-4 space-y-0.5">
              {seedReview.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          )}
          <p className="text-[11px] text-amber-600 mt-1.5">Driver detail (director count, bookkeeping hours, etc.) can't be read from a flat bill amount — set these so the quote rebuilds correctly.</p>
        </div>
      )}

      {/* Client info */}
      <div className="bg-white rounded-lg border border-gray-200 p-3 mb-3">
        <div className="grid grid-cols-2 gap-2">
          <input value={f.client.name} onChange={(e) => f.setClient({ ...f.client, name: e.target.value })} placeholder="Client name" className="text-sm border border-gray-200 rounded px-2 py-1.5 col-span-2" />
          <input value={f.client.companyNumber} onChange={(e) => f.setClient({ ...f.client, companyNumber: e.target.value })} placeholder="Company number" className="text-sm border border-gray-200 rounded px-2 py-1.5" />
          <select value={f.client.entityType} onChange={(e) => f.setClient({ ...f.client, entityType: e.target.value })} className="text-sm border border-gray-200 rounded px-2 py-1.5 bg-white">
            <option value="limited_company">Limited Company</option>
            <option value="sole_trader">Sole Trader</option>
            <option value="partnership">Partnership</option>
            <option value="llp">LLP</option>
            <option value="llp">LLP</option>
          </select>
          <input value={f.client.turnover} onChange={(e) => f.setClient({ ...f.client, turnover: e.target.value })} placeholder="Est. turnover (£)" type="number" className="text-sm border border-gray-200 rounded px-2 py-1.5" />
          <div className="col-span-2 flex items-center gap-2">
            <label className="text-xs text-gray-500 whitespace-nowrap">Valid until</label>
            <input type="date" value={f.validUntil} onChange={e => f.setValidUntil(e.target.value)} className="text-sm border border-gray-200 rounded px-2 py-1.5" />
          </div>
        </div>
      </div>

      {/* Below-standard pricing warning */}
      {f.belowStandard.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-3">
          <p className="text-xs font-semibold text-red-700 mb-1">
            {f.belowStandard.length} service{f.belowStandard.length === 1 ? '' : 's'} priced below standard:
          </p>
          <ul className="text-xs text-red-700 space-y-0.5">
            {f.belowStandard.map((b) => (
              <li key={b.id} className="flex justify-between gap-4">
                <span>{b.name}</span>
                <span className="font-mono">{fmt(b.actual)} <span className="text-red-400">vs {fmt(b.standard)} standard</span></span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Setup Fees */}
      <Section title="One-Off Setup Fees" enabled={f.setupTotal > 0 || f.suFormation || f.suHmrc} onToggle={() => { if (!f.suFormation && !f.suHmrc) f.setSuFormation(true); else { f.setSuFormation(false); f.setSuHmrc(false); f.setSuRegFee(0); f.setSuOthers([]); } }} annual={f.setupTotal}>
        <TabRow cells={['Item', 'Qty', 'Rate', 'Total']} header />
        <div className={G4} style={C4}>
          <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={f.suFormation} onChange={(e) => f.setSuFormation(e.target.checked)} className="w-3 h-3 accent-ocean-600" />Company formation</label>
          <span className="text-right"><Inp value={f.suFormationQty} onChange={f.setSuFormationQty} min={1} className="w-12" /></span>
          <span className="text-right"><Inp value={f.suFormationRate} onChange={f.setSuFormationRate} prefix="£" className="w-14" /></span>
          <span className="text-right font-mono">{f.suFormation ? fmt(f.suFormationQty * f.suFormationRate) : '\u2014'}</span>
        </div>
        <div className={G4} style={C4}>
          <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={f.suHmrc} onChange={(e) => f.setSuHmrc(e.target.checked)} className="w-3 h-3 accent-ocean-600" />HMRC registrations</label>
          <span className="text-right"><Inp value={f.suHmrcQty} onChange={f.setSuHmrcQty} min={1} className="w-12" /></span>
          <span className="text-right"><Inp value={f.suHmrcRate} onChange={f.setSuHmrcRate} prefix="£" className="w-14" /></span>
          <span className="text-right font-mono">{f.suHmrc ? fmt(f.suHmrcQty * f.suHmrcRate) : '\u2014'}</span>
        </div>
        {f.suOthers.map((o, i) => (
          <div key={i} className={G4} style={C4}>
            <input value={o.description} onChange={(e) => { const os = [...f.suOthers]; os[i] = { ...os[i], description: e.target.value }; f.setSuOthers(os); }} placeholder="Description" className="text-xs border border-gray-200 rounded px-1.5 py-0.5 bg-white" />
            <span></span><span></span>
            <span className="text-right flex items-center justify-end gap-1">
              <Inp value={o.amount} onChange={(v) => { const os = [...f.suOthers]; os[i] = { ...os[i], amount: v }; f.setSuOthers(os); }} prefix="£" className="w-14" />
              <button onClick={() => f.setSuOthers(f.suOthers.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-600">&#x2715;</button>
            </span>
          </div>
        ))}
        <button onClick={() => f.setSuOthers([...f.suOthers, { description: '', amount: 0 }])} className="text-xs text-ocean-600 hover:text-ocean-700 mt-1">+ Other setup item</button>
      </Section>

      {/* Accounts & CT */}
      <Section title="Accounts & CT" enabled={f.accEnabled} onToggle={() => f.setAccEnabled(!f.accEnabled)} annual={f.accAnnual}>
        <div className="flex gap-1 mb-3">
          {['trading', 'dormant', 'property'].map((t) => (
            <button key={t} onClick={() => f.setAccType(t)} className={`text-xs px-3 py-1.5 rounded-full border transition-all ${f.accType === t ? 'bg-ocean-600 text-white border-ocean-600' : 'bg-white text-gray-600 border-gray-200 hover:border-ocean-300'}`}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        {f.accType === 'trading' && <>
          {f.detectedBand && <p className="text-xs text-gray-400 mb-1">Band: {f.detectedBand.label} \u2192 standard {fmt(f.detectedBand.rate)}</p>}
          <div className="flex justify-between items-center text-xs"><span className="font-medium">Annual fee</span><Inp value={f.accRate} onChange={f.setAccRate} prefix="£" className="w-20" /></div>
        </>}
        {f.accType === 'dormant' && <div className="flex justify-between items-center text-xs"><span className="font-medium">Dormant company fee</span><Inp value={f.accDormant} onChange={f.setAccDormant} prefix="£" className="w-20" /></div>}
        {f.accType === 'property' && <>
          <TabRow cells={['Component', 'Qty', 'Rate', 'Total']} header />
          <div className={G4} style={C4}><span>Base (1 property)</span><span></span><span className="text-right"><Inp value={f.accPropBase} onChange={f.setAccPropBase} prefix="£" className="w-14" /></span><span className="text-right font-mono">{fmt(f.accPropBase)}</span></div>
          <div className={G4} style={C4}><span>Additional properties</span><span className="text-right"><Inp value={Math.max(0, f.accProperties - 1)} onChange={(v) => f.setAccProperties(v + 1)} min={0} className="w-12" /></span><span className="text-right"><Inp value={f.accPropExtra} onChange={f.setAccPropExtra} prefix="£" className="w-14" /></span><span className="text-right font-mono">{fmt(Math.max(0, f.accProperties - 1) * f.accPropExtra)}</span></div>
        </>}
      </Section>

      {/* Sole Trader Accounts */}
      <Section title="Sole Trader Accounts" enabled={f.staEnabled} onToggle={() => f.setStaEnabled(!f.staEnabled)} annual={f.staAnnual}>
        <div className="flex justify-between items-center text-xs"><span className="font-medium">Annual fee</span><Inp value={f.staFee} onChange={f.setStaFee} prefix="£" className="w-20" /></div>
        <p className="text-[10px] text-gray-400 mt-1">Year-end accounts for an unincorporated business (no Corporation Tax or Companies House filing).</p>
      </Section>

      {/* Confirmation Statement */}
      <Section title="Confirmation Statement" enabled={f.csEnabled} onToggle={() => f.setCsEnabled(!f.csEnabled)} annual={f.csFee}>
        <div className="flex justify-between items-center text-xs"><span className="font-medium">Annual fee (+ VAT)</span><Inp value={f.csFee} onChange={f.setCsFee} prefix="£" className="w-16" /></div>
      </Section>

      {/* Directors */}
      <Section title={`Directors' Tax Returns (${f.directors.length})`} enabled={f.dtrEnabled} onToggle={() => f.setDtrEnabled(!f.dtrEnabled)} annual={f.dtrAnnual}>
        {f.directors.map((d, i) => (
          <DirectorCard key={i} d={d} idx={i} addonRates={f.addonRates} onAddonRate={f.onAddonRate}
            onChange={f.updateDir} onRemove={(idx) => f.setDirectors(f.directors.filter((_, j) => j !== idx))} canRemove={f.directors.length > 1} />
        ))}
        <button onClick={() => f.setDirectors([...f.directors, f.newDir()])} className="text-xs text-ocean-600 hover:text-ocean-700 font-medium">+ Add director</button>
      </Section>

      {/* Bookkeeping */}
      <Section title={f.bkIncVat ? 'Bookkeeping & VAT' : 'Bookkeeping'} enabled={f.bkEnabled} onToggle={() => f.setBkEnabled(!f.bkEnabled)} annual={f.bkAnnual}>
        <TabRow cells={['', 'Qty', 'Rate', 'Annual']} header />
        <div className={G4} style={C4}><span>Monthly hours</span><span className="text-right"><Inp value={f.bkHours} onChange={f.setBkHours} min={1} step={0.5} className="w-12" /></span><span className="text-right"><Inp value={f.bkRate} onChange={f.setBkRate} prefix="£" className="w-14" />/hr</span><span className="text-right font-mono">{fmt(f.bkHours * f.bkRate * 12)}</span></div>
        <div className="flex items-center justify-between text-xs mt-1">
          <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={f.bkIncVat} onChange={(e) => f.setBkIncVat(e.target.checked)} className="w-3 h-3 accent-ocean-600" />Includes VAT returns</label>
          {f.bkIncVat && <span>adj <Inp value={f.bkVatAdj} onChange={f.setBkVatAdj} prefix="£" className="w-14" /></span>}
        </div>
      </Section>

      {/* VAT standalone */}
      <Section title="VAT Returns (standalone)" enabled={f.vatEnabled} onToggle={() => f.setVatEnabled(!f.vatEnabled)} annual={f.vatAnnual}>
        <TabRow cells={['', 'Returns', 'Per return', 'Annual']} header />
        <div className={G4} style={C4}><span>VAT returns</span><span className="text-right"><Inp value={f.vatFreq} onChange={f.setVatFreq} min={1} max={12} className="w-12" /></span><span className="text-right"><Inp value={f.vatRate} onChange={f.setVatRate} prefix="£" className="w-14" /></span><span className="text-right font-mono">{fmt(f.vatAnnual)}</span></div>
      </Section>

      {/* MTD Returns */}
      <Section title="MTD Returns" enabled={f.mtdEnabled} onToggle={() => f.setMtdEnabled(!f.mtdEnabled)} annual={f.mtdAnnual}>
        <TabRow cells={['', 'Returns/yr', 'Per return', 'Annual']} header />
        <div className={G4} style={C4}><span>MTD for Income Tax</span><span className="text-right"><Inp value={f.mtdFreq} onChange={f.setMtdFreq} min={1} max={12} className="w-12" /></span><span className="text-right"><Inp value={f.mtdRate} onChange={f.setMtdRate} prefix="£" className="w-14" /></span><span className="text-right font-mono">{fmt(f.mtdAnnual)}</span></div>
        <p className="text-[10px] text-gray-400 mt-1">Quarterly Making Tax Digital submissions to HMRC (ITSA).</p>
      </Section>

      {/* Payroll */}
      <Section title="Payroll" enabled={f.prEnabled} onToggle={() => f.setPrEnabled(!f.prEnabled)} annual={f.prAnnual}>
        <TabRow cells={['Component', 'Qty', 'Rate', 'Monthly']} header />
        <div className={G4} style={C4}><span>Flat fee</span><span></span><span></span><span className="text-right"><Inp value={f.prFlat} onChange={f.setPrFlat} prefix="£" className="w-14" /></span></div>
        <div className={G4} style={C4}><span>Monthly employees</span><span className="text-right"><Inp value={f.prMonthlyEe} onChange={f.setPrMonthlyEe} min={0} className="w-12" /></span><span className="text-right"><Inp value={f.prMonthlyEeRate} onChange={f.setPrMonthlyEeRate} prefix="£" className="w-14" />/mo</span><span className="text-right font-mono">{fmt(f.prMonthlyEe * f.prMonthlyEeRate)}</span></div>
        <div className={G4} style={C4}><span>Weekly employees</span><span className="text-right"><Inp value={f.prWeeklyEe} onChange={f.setPrWeeklyEe} min={0} className="w-12" /></span><span className="text-right"><Inp value={f.prWeeklyEeRate} onChange={f.setPrWeeklyEeRate} prefix="£" className="w-14" />/wk</span><span className="text-right font-mono">{fmt(f.prWeeklyEe * f.prWeeklyEeRate * 4.33)}</span></div>
        <div className={G4} style={C4}><span>CIS subcontractors</span><span className="text-right"><Inp value={f.prCis} onChange={f.setPrCis} min={0} className="w-12" /></span><span className="text-right"><Inp value={f.prCisRate} onChange={f.setPrCisRate} prefix="£" className="w-14" />/wk</span><span className="text-right font-mono">{fmt(f.prCis * f.prCisRate * 4.33)}</span></div>
        <TabRow cells={['Monthly total', '', '', fmt(f.prMoCalc)]} bold />
        <div className={G4} style={{ ...C4, marginTop: '0.5rem' }}><span>P11D returns (annual)</span><span className="text-right"><Inp value={f.prP11d} onChange={f.setPrP11d} min={0} className="w-12" /></span><span className="text-right"><Inp value={f.prP11dRate} onChange={f.setPrP11dRate} prefix="£" className="w-14" /> ea</span><span className="text-right font-mono">{fmt(f.prP11d * f.prP11dRate)}</span></div>
      </Section>

      {/* Auto-enrolment */}
      <Section title="Auto-Enrolment" enabled={f.aeEnabled} onToggle={() => f.setAeEnabled(!f.aeEnabled)} annual={f.aeFee}>
        <div className="flex justify-between text-xs"><span>Annual fee</span><Inp value={f.aeFee} onChange={f.setAeFee} prefix="£" className="w-14" /></div>
      </Section>

      {/* Modulr Wage Payments */}
      <Section title="Modulr Wage Payments" enabled={f.modEnabled} onToggle={() => f.setModEnabled(!f.modEnabled)} annual={f.modAnnual}>
        <TabRow cells={['Component', 'Qty', 'Rate', 'Monthly']} header />
        <div className={G4} style={C4}><span>Software</span><span></span><span></span><span className="text-right"><Inp value={f.modSwPrice} onChange={f.setModSwPrice} prefix="£" className="w-14" /></span></div>
        <div className={G4} style={C4}><span>Payments/month</span><span className="text-right"><Inp value={f.modPayments} onChange={f.setModPayments} min={0} className="w-12" /></span><span className="text-right"><Inp value={f.modPaymentRate} onChange={f.setModPaymentRate} prefix="£" className="w-14" /></span><span className="text-right font-mono">{fmt(f.modPayments * f.modPaymentRate)}</span></div>
        <div className={G4} style={C4}><span>Pay runs/month</span><span className="text-right"><Inp value={f.modRuns} onChange={f.setModRuns} min={0} className="w-12" /></span><span className="text-right"><Inp value={f.modRunRate} onChange={f.setModRunRate} prefix="£" className="w-14" /></span><span className="text-right font-mono">{fmt(f.modRuns * f.modRunRate)}</span></div>
        <TabRow cells={['Monthly total', '', '', fmt(f.modMonthly)]} bold />
      </Section>

      {/* Management Accounts */}
      <Section title="Management Accounts" enabled={f.maEnabled} onToggle={() => f.setMaEnabled(!f.maEnabled)} annual={f.maAnnual}>
        <TabRow cells={['', 'Sets/yr', 'Per set', 'Annual']} header />
        <div className={G4} style={C4}><span>Accounts sets</span><span className="text-right"><Inp value={f.maSets} onChange={f.setMaSets} min={1} max={12} className="w-12" /></span><span className="text-right"><Inp value={f.maRate} onChange={f.setMaRate} prefix="£" className="w-16" /></span><span className="text-right font-mono">{fmt(f.maAnnual)}</span></div>
      </Section>

      {/* Review Meetings */}
      <Section title="Review Meetings" enabled={f.rmEnabled} onToggle={() => f.setRmEnabled(!f.rmEnabled)} annual={f.rmAnnual}>
        <TabRow cells={['', 'Meetings/yr', 'Rate', 'Annual']} header />
        <div className={G4} style={C4}><span>Client meetings</span><span className="text-right"><Inp value={f.rmCount} onChange={f.setRmCount} min={1} max={12} className="w-12" /></span><span className="text-right"><Inp value={f.rmRate} onChange={f.setRmRate} prefix="£" className="w-16" /></span><span className="text-right font-mono">{fmt(f.rmAnnual)}</span></div>
      </Section>

      {/* Budgeting & Forecasting */}
      <Section title="Budgeting & Forecasting" enabled={f.budEnabled} onToggle={() => f.setBudEnabled(!f.budEnabled)} annual={f.budAnnual}>
        <div className="space-y-1.5">
          <label className="flex items-center justify-between text-xs cursor-pointer">
            <span className="flex items-center gap-1.5"><input type="checkbox" checked={f.budBasic} onChange={e => f.setBudBasic(e.target.checked)} className="w-3 h-3 accent-ocean-600" />Basic budget</span>
            <Inp value={f.budBasicRate} onChange={f.setBudBasicRate} prefix="£" className="w-20" />
          </label>
          <label className="flex items-center justify-between text-xs cursor-pointer">
            <span className="flex items-center gap-1.5"><input type="checkbox" checked={f.budAdvanced} onChange={e => f.setBudAdvanced(e.target.checked)} className="w-3 h-3 accent-ocean-600" />Advanced budget</span>
            <Inp value={f.budAdvancedRate} onChange={f.setBudAdvancedRate} prefix="£" className="w-20" />
          </label>
          <div className="flex items-center justify-between text-xs">
            <span>Reforecasts</span>
            <span className="flex items-center gap-1"><Inp value={f.budReforecastQty} onChange={f.setBudReforecastQty} min={0} className="w-10" /> x <Inp value={f.budReforecastRate} onChange={f.setBudReforecastRate} prefix="£" className="w-16" /></span>
          </div>
        </div>
      </Section>

      {/* Fractional CFO */}
      <Section title="Fractional CFO" enabled={f.cfoEnabled} onToggle={() => f.setCfoEnabled(!f.cfoEnabled)} annual={f.cfoAnnual}>
        <TabRow cells={['', 'Days/yr', 'Day rate', 'Annual']} header />
        <div className={G4} style={C4}><span>CFO days</span><span className="text-right"><Inp value={f.cfoDays} onChange={f.setCfoDays} min={1} className="w-12" /></span><span className="text-right"><Inp value={f.cfoDayRate} onChange={f.setCfoDayRate} prefix="£" className="w-20" /></span><span className="text-right font-mono">{fmt(f.cfoAnnual)}</span></div>
      </Section>

      {/* Registered office */}
      <Section title="Registered Office" enabled={f.roEnabled} onToggle={() => f.setRoEnabled(!f.roEnabled)} annual={f.roFee}>
        <div className="flex justify-between text-xs"><span>Annual fee</span><Inp value={f.roFee} onChange={f.setRoFee} prefix="£" className="w-16" /></div>
      </Section>

      {/* Software */}
      <div className="bg-white rounded-lg border border-ocean-300 p-3 mb-3">
        <h2 className="text-xs font-semibold text-ocean-600 mb-2">Software</h2>
        <div className="grid gap-1 items-center text-xs text-gray-700 mb-1" style={{ gridTemplateColumns: '2fr 1fr 1fr' }}>
          <select value={f.swId} onChange={(e) => f.setSwId(e.target.value)} className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white">
            {D.software.map((s) => <option key={s.id} value={s.id}>{s.name}{s.monthly > 0 ? ` \u2014 ${fmt(s.monthly)}/mo` : ''}</option>)}
          </select>
          <span className="text-right font-mono">{f.sw.monthly > 0 ? fmt(f.sw.monthly) : '\u2014'}</span>
          <span className="text-right font-mono">{f.sw.monthly > 0 ? fmt(f.sw.monthly * 12) : '\u2014'}</span>
        </div>
        <div className="grid gap-1 items-center text-xs text-gray-700 mb-1" style={{ gridTemplateColumns: '2fr 1fr 1fr' }}>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={f.dextEnabled} onChange={(e) => f.setDextEnabled(e.target.checked)} className="w-3 h-3 accent-ocean-600" />
            Dext <Inp value={f.dextPrice} onChange={f.setDextPrice} prefix="£" className="w-12" />/mo
          </label>
          <span className="text-right font-mono">{f.dextEnabled ? fmt(f.dextPrice) : '\u2014'}</span>
          <span className="text-right font-mono">{f.dextEnabled ? fmt(f.dextPrice * 12) : '\u2014'}</span>
        </div>
        {f.swMonthly > 0 && <TabRow cells={['Total software', fmt(f.swMonthly) + '/mo', fmt(f.swAnnual)]} bold />}
      </div>

      {/* Totals */}
      <div className="bg-ocean-700 text-white rounded-lg p-4 mb-3">
        {f.setupTotal > 0 && <div className="flex justify-between text-xs mb-2 pb-2 border-b border-ocean-600"><span className="text-ocean-300">One-Off Setup</span><span className="font-mono">{fmt(f.setupTotal)}</span></div>}
        <div className="space-y-0.5">
          {f.lines.map((l, i) => <div key={i} className="flex justify-between text-xs"><span className="text-ocean-300 truncate mr-3">{l.name}</span><span className="font-mono whitespace-nowrap">{fmt(l.annual)}</span></div>)}
          {f.swAnnual > 0 && <div className="flex justify-between text-xs"><span className="text-ocean-300">Software</span><span className="font-mono">{fmt(f.swAnnual)}</span></div>}
        </div>
        <div className="border-t border-ocean-600 mt-2 pt-2 space-y-1">
          <div className="flex justify-between text-xs"><span className="text-ocean-300">Annual Total (Net)</span><span className="font-mono font-medium">{fmt(f.annualTotal)}</span></div>
          <div className="flex justify-between text-xs"><span className="text-ocean-300">Monthly (Net)</span><span className="font-mono">{fmt(f.monthlyNet)}</span></div>
          <div className="flex justify-between text-xs"><span className="text-ocean-300">VAT</span><span className="font-mono">{fmt(f.monthlyVat)}</span></div>
          <div className="flex justify-between text-base font-bold pt-1.5 border-t border-ocean-500"><span>Monthly Direct Debit (Inc VAT)</span><span className="font-mono text-sun-300">{fmt(f.monthlyGross)}</span></div>
        </div>
      </div>

      {/* Save */}
      <div className="flex gap-2 flex-wrap">
        <Btn onClick={() => handleSave()} disabled={saving || !f.client.name} className="flex-1">
          {saving ? 'Saving...' : mode === 'edit' ? 'Update Quote' : 'Save Quote'}
        </Btn>
        {mode !== 'edit' && (
          <Btn onClick={() => handleSave('add-another')} disabled={saving || !f.client.name} variant="secondary">
            Save & Add Another Entity
          </Btn>
        )}
        <Btn onClick={() => navigate(-1)} variant="ghost">Cancel</Btn>
      </div>
    </div>
  );
}
