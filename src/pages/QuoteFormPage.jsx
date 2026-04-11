import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { Inp, TabRow, Section, Btn, fmt, G4, C4 } from '../components/ui';
import DirectorCard from '../components/DirectorCard';

export default function QuoteFormPage({ defaults: D, profile, mode = 'new' }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { id: quoteId } = useParams();
  const entityId = searchParams.get('entity');
  const fromId = searchParams.get('from');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [entity, setEntity] = useState(null);
  const [existingQuoteRef, setExistingQuoteRef] = useState(null);

  // Load entity from URL param
  useEffect(() => {
    if (entityId) {
      supabase.from('entities').select('*').eq('id', entityId).single()
        .then(({ data }) => {
          if (data) {
            setEntity(data);
            setClient(c => ({
              ...c,
              name: data.name || c.name,
              companyNumber: data.company_number || c.companyNumber,
              entityType: data.type || c.entityType,
            }));
          }
        });
    }
  }, [entityId]);

  // ── Client ──
  const [client, setClient] = useState({
    name: '',
    companyNumber: '',
    entityType: 'limited_company',
    turnover: '',
  });

  // ── Setup fees ──
  const [suFormation, setSuFormation] = useState(false);
  const [suFormationQty, setSuFormationQty] = useState(1);
  const [suFormationRate, setSuFormationRate] = useState(D.setup.formation_rate);
  const [suHmrc, setSuHmrc] = useState(false);
  const [suHmrcQty, setSuHmrcQty] = useState(1);
  const [suHmrcRate, setSuHmrcRate] = useState(D.setup.hmrc_reg_rate);
  const [suRegFee, setSuRegFee] = useState(0);
  const [suOthers, setSuOthers] = useState([]);
  const setupTotal =
    (suFormation ? suFormationQty * suFormationRate : 0) +
    (suHmrc ? suHmrcQty * suHmrcRate : 0) +
    suRegFee +
    suOthers.reduce((s, o) => s + (o.amount || 0), 0);

  // ── Accounts & CT ──
  const [accEnabled, setAccEnabled] = useState(true);
  const [accType, setAccType] = useState('trading');
  const [accRate, setAccRate] = useState(900);
  const [accProperties, setAccProperties] = useState(1);
  const [accPropBase, setAccPropBase] = useState(D.property_base);
  const [accPropExtra, setAccPropExtra] = useState(D.property_per_extra);
  const [accDormant, setAccDormant] = useState(D.dormant_rate);

  const turnoverNum = parseFloat(client.turnover) || 0;
  const detectedBand = D.accounts_bands.find(
    (b) => turnoverNum >= b.min && turnoverNum <= (b.max === Infinity ? 999999999 : b.max)
  );
  useEffect(() => {
    if (accType === 'trading' && detectedBand) setAccRate(detectedBand.rate);
  }, [turnoverNum, accType]);

  const accAnnual =
    accType === 'dormant'
      ? accDormant
      : accType === 'property'
      ? accPropBase + Math.max(0, accProperties - 1) * accPropExtra
      : accRate;

  // ── Confirmation statement ──
  const [csEnabled, setCsEnabled] = useState(true);
  const [csFee, setCsFee] = useState(D.confirmation_statement.fee);

  // ── Directors ──
  const [dtrEnabled, setDtrEnabled] = useState(true);
  const [addonRates, setAddonRates] = useState({ ...D.director_addons });
  const onAddonRate = (k, v) => setAddonRates((p) => ({ ...p, [k]: v }));
  const newDir = () => ({
    name: '', base: D.director_base, otherDividends: false,
    hasRentals: false, rentalProperties: 1, capitalGains: false,
    savingsIncome: false, otherSources: [],
  });
  const [directors, setDirectors] = useState([newDir()]);
  const updateDir = (i, f, v) => {
    const d = [...directors]; d[i] = { ...d[i], [f]: v }; setDirectors(d);
  };
  const dirTotal = (d) =>
    d.base +
    (d.otherDividends ? addonRates.other_dividends : 0) +
    (d.hasRentals ? d.rentalProperties * addonRates.rental_property : 0) +
    (d.capitalGains ? addonRates.capital_gains : 0) +
    (d.savingsIncome ? addonRates.savings_income : 0) +
    (d.otherSources || []).reduce((s, o) => s + (o.amount || 0), 0);
  const dtrAnnual = directors.reduce((s, d) => s + dirTotal(d), 0);

  // ── Bookkeeping ──
  const [bkEnabled, setBkEnabled] = useState(false);
  const [bkHours, setBkHours] = useState(8);
  const [bkRate, setBkRate] = useState(D.bookkeeping_rate);
  const [bkIncVat, setBkIncVat] = useState(true);
  const [bkVatAdj, setBkVatAdj] = useState(0);
  const bkAnnual = bkHours * bkRate * 12 + (bkIncVat ? bkVatAdj : 0);

  // ── VAT standalone ──
  const [vatEnabled, setVatEnabled] = useState(false);
  const [vatFreq, setVatFreq] = useState(4);
  const [vatRate, setVatRate] = useState(D.vat_per_return);
  const vatAnnual = vatFreq * vatRate;

  // ── Payroll ──
  const [prEnabled, setPrEnabled] = useState(false);
  const prFlatCalc = Math.ceil(
    (D.payroll.brightpay_annual / D.payroll.payroll_client_count) * (1 + D.payroll.markup_pct / 100)
  );
  const [prFlat, setPrFlat] = useState(prFlatCalc);
  const [prMonthlyEe, setPrMonthlyEe] = useState(0);
  const [prMonthlyEeRate, setPrMonthlyEeRate] = useState(D.payroll.monthly_ee_rate);
  const [prWeeklyEe, setPrWeeklyEe] = useState(0);
  const [prWeeklyEeRate, setPrWeeklyEeRate] = useState(D.payroll.weekly_ee_rate);
  const [prCis, setPrCis] = useState(0);
  const [prCisRate, setPrCisRate] = useState(D.payroll.cis_rate);
  const [prP11d, setPrP11d] = useState(0);
  const [prP11dRate, setPrP11dRate] = useState(D.payroll.p11d_rate);
  const prMoCalc = prFlat + prMonthlyEe * prMonthlyEeRate + prWeeklyEe * prWeeklyEeRate * 4.33 + prCis * prCisRate * 4.33;
  const prAnnual = prMoCalc * 12 + prP11d * prP11dRate;

  // ── Auto-enrolment ──
  const [aeEnabled, setAeEnabled] = useState(false);
  const [aeFee, setAeFee] = useState(D.auto_enrolment.standard);

  // ── Registered office ──
  const [roEnabled, setRoEnabled] = useState(false);
  const [roFee, setRoFee] = useState(D.registered_office);

  // ── Software ──
  const [swId, setSwId] = useState('none');
  const [dextEnabled, setDextEnabled] = useState(false);
  const [dextPrice, setDextPrice] = useState(D.dext.monthly_price);
  const sw = D.software.find((s) => s.id === swId) || D.software[0];
  const swMonthly = (sw?.monthly || 0) + (dextEnabled ? dextPrice : 0);
  const swAnnual = swMonthly * 12;

  // ── Totals ──
  const lines = [];
  if (accEnabled) lines.push({ id: 'accounts_ct', name: 'Accounts & CT', annual: accAnnual, detail: accType === 'dormant' ? 'Dormant' : accType === 'property' ? `Property (${accProperties})` : detectedBand?.label || '' });
  if (csEnabled) lines.push({ id: 'confirmation_statement', name: 'Conf Statement', annual: csFee });
  if (dtrEnabled) lines.push({ id: 'directors_tax_return', name: `Directors' Tax (${directors.length})`, annual: dtrAnnual });
  if (bkEnabled) lines.push({ id: bkIncVat ? 'bookkeeping_vat' : 'bookkeeping', name: bkIncVat ? 'BK & VAT' : 'Bookkeeping', annual: bkAnnual, detail: `${bkHours}h × ${fmt(bkRate)}` });
  if (vatEnabled) lines.push({ id: 'vat_returns', name: 'VAT Returns', annual: vatAnnual });
  if (prEnabled) lines.push({ id: 'payroll', name: 'Payroll', annual: prAnnual });
  if (aeEnabled) lines.push({ id: 'auto_enrolment', name: 'Auto-Enrolment', annual: aeFee });
  if (roEnabled) lines.push({ id: 'registered_office', name: 'Registered Office', annual: roFee });

  const annualServices = lines.reduce((s, l) => s + l.annual, 0);
  const annualTotal = annualServices + swAnnual;
  const monthlyNet = Math.round((annualTotal / 12) * 100) / 100;
  const monthlyVat = Math.round(monthlyNet * 0.2 * 100) / 100;
  const monthlyGross = Math.round((monthlyNet + monthlyVat) * 100) / 100;

  // ── Save to Supabase ──
  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      // Generate quote ref with collision avoidance
      const nameSlug = (client.name || 'Quote').replace(/[^a-zA-Z0-9]/g, '');
      const dateSlug = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const prefix = `${nameSlug}_${dateSlug}`;

      const { data: existing } = await supabase
        .from('quotes')
        .select('quote_ref')
        .like('quote_ref', `${prefix}%`);

      const nums = (existing || [])
        .map((q) => parseInt(q.quote_ref.split('_').pop()) || 0);
      const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
      const quoteRef = `${prefix}_${String(next).padStart(3, '0')}`;

      // Build setup fee lines
      const setupLines = [];
      if (suFormation) setupLines.push({ type: 'formation', description: 'Company formation', qty: suFormationQty, rate: suFormationRate, amount: suFormationQty * suFormationRate });
      if (suHmrc) setupLines.push({ type: 'hmrc', description: 'HMRC registrations', qty: suHmrcQty, rate: suHmrcRate, amount: suHmrcQty * suHmrcRate });
      if (suRegFee > 0) setupLines.push({ type: 'reg_fee', description: 'Registration fee', amount: suRegFee });
      suOthers.forEach((o) => { if (o.amount > 0) setupLines.push({ type: 'other', description: o.description || 'Other', amount: o.amount }); });

      // Insert quote
      const { data: savedQuotes, error: quoteErr } = await supabase
        .from('quotes')
        .insert({
          quote_ref: quoteRef,
          entity_id: entity?.id || null,
          group_id: null,
          status: 'draft',
          estimated_turnover: turnoverNum || null,
          annual_services: Math.round(annualServices * 100) / 100,
          annual_software: swAnnual,
          annual_total: Math.round(annualTotal * 100) / 100,
          monthly_net: monthlyNet,
          monthly_vat: monthlyVat,
          monthly_gross: monthlyGross,
          one_off_total: setupTotal,
          defaults_version: D.version,
          directors: dtrEnabled ? directors.map((d) => ({
            name: d.name, base: d.base, other_dividends: d.otherDividends,
            has_rentals: d.hasRentals, rental_properties: d.hasRentals ? d.rentalProperties : 0,
            capital_gains: d.capitalGains, savings_income: d.savingsIncome,
            other_sources: d.otherSources || [], addon_rates_used: addonRates, total: dirTotal(d),
          })) : [],
          setup_fees: setupLines,
          payroll_detail: prEnabled ? { flat_monthly: prFlat, monthly_ee: prMonthlyEe, monthly_ee_rate: prMonthlyEeRate, weekly_ee: prWeeklyEe, weekly_ee_rate: prWeeklyEeRate, cis: prCis, cis_rate: prCisRate, p11d: prP11d, p11d_rate: prP11dRate } : null,
          bookkeeping_detail: bkEnabled ? { hours_per_month: bkHours, rate: bkRate, includes_vat: bkIncVat, vat_adj: bkVatAdj } : null,
          software_detail: swMonthly > 0 ? { accounting: sw?.id !== 'none' ? { id: sw.id, name: sw.name, monthly: sw.monthly, cost: sw.cost } : null, dext: dextEnabled ? { monthly: dextPrice, cost: D.dext.cost } : null } : null,
          accounts_detail: accEnabled ? { type: accType, band: detectedBand?.label, rate: accAnnual, properties: accType === 'property' ? accProperties : undefined } : null,
          relationship_group: client.name || null,
          created_by: profile.id,
        })
        .select();

      if (quoteErr) {
        // Retry on quote_ref collision
        if (quoteErr.message?.includes('duplicate') || quoteErr.code === '23505') {
          setError('Quote ref collision — please try saving again.');
          setSaving(false);
          return;
        }
        throw quoteErr;
      }

      const savedQuote = savedQuotes[0];

      // Build and insert line items
      const lineItems = lines.map((l, i) => ({
        quote_id: savedQuote.id,
        service_id: l.id,
        description: l.name,
        annual_amount: Math.round(l.annual * 100) / 100,
        monthly_amount: Math.round((l.annual / 12) * 100) / 100,
        detail: l.detail || '',
        is_recurring: true,
        sort_order: i,
      }));

      if (sw?.id !== 'none' && sw?.monthly > 0) {
        lineItems.push({ quote_id: savedQuote.id, service_id: 'software_accounting', description: sw.name, annual_amount: sw.monthly * 12, monthly_amount: sw.monthly, detail: '', is_recurring: true, sort_order: lineItems.length });
      }
      if (dextEnabled) {
        lineItems.push({ quote_id: savedQuote.id, service_id: 'software_dext', description: 'Dext', annual_amount: dextPrice * 12, monthly_amount: dextPrice, detail: '', is_recurring: true, sort_order: lineItems.length });
      }
      setupLines.forEach((sl, i) => {
        lineItems.push({ quote_id: savedQuote.id, service_id: `setup_${sl.type}`, description: sl.description, annual_amount: sl.amount, monthly_amount: 0, detail: '', is_recurring: false, sort_order: 100 + i });
      });

      if (lineItems.length > 0) {
        const { error: liErr } = await supabase.from('quote_line_items').insert(lineItems);
        if (liErr) throw liErr;
      }

      navigate('/manage/quotes/' + savedQuote.id);
    } catch (e) {
      setError(e.message || 'Save failed');
    }
    setSaving(false);
  };

  // ── RENDER ──
  return (
    <div className="p-6 max-w-2xl">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h2 className="text-lg font-bold text-ocean-700">New Quote</h2>
          {entity && <p className="text-xs text-gray-400">{entity.name} {entity.company_number ? `(${entity.company_number})` : ''}</p>}
        </div>
        <Btn onClick={() => navigate(-1)} variant="ghost">Cancel</Btn>
      </div>

      {error && <div className="text-xs text-red-600 bg-red-50 rounded p-2 mb-3">{error}</div>}

      {/* Client info */}
      <div className="bg-white rounded-lg border border-gray-200 p-3 mb-3">
        <div className="grid grid-cols-2 gap-2">
          <input value={client.name} onChange={(e) => setClient({ ...client, name: e.target.value })} placeholder="Client name" className="text-sm border border-gray-200 rounded px-2 py-1.5 col-span-2" />
          <input value={client.companyNumber} onChange={(e) => setClient({ ...client, companyNumber: e.target.value })} placeholder="Company number" className="text-sm border border-gray-200 rounded px-2 py-1.5" />
          <select value={client.entityType} onChange={(e) => setClient({ ...client, entityType: e.target.value })} className="text-sm border border-gray-200 rounded px-2 py-1.5 bg-white">
            <option value="limited_company">Limited Company</option>
            <option value="sole_trader">Sole Trader</option>
            <option value="partnership">Partnership</option>
            <option value="llp">LLP</option>
          </select>
          <input value={client.turnover} onChange={(e) => setClient({ ...client, turnover: e.target.value })} placeholder="Est. turnover (£)" type="number" className="text-sm border border-gray-200 rounded px-2 py-1.5" />
        </div>
      </div>

      {/* Setup Fees */}
      <Section title="One-Off Setup Fees" enabled={setupTotal > 0 || suFormation || suHmrc} onToggle={() => { if (!suFormation && !suHmrc) setSuFormation(true); else { setSuFormation(false); setSuHmrc(false); setSuRegFee(0); setSuOthers([]); } }} annual={setupTotal}>
        <TabRow cells={['Item', 'Qty', 'Rate', 'Total']} header />
        <div className={G4} style={C4}>
          <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={suFormation} onChange={(e) => setSuFormation(e.target.checked)} className="w-3 h-3 accent-ocean-600" />Company formation</label>
          <span className="text-right"><Inp value={suFormationQty} onChange={setSuFormationQty} min={1} className="w-12" /></span>
          <span className="text-right"><Inp value={suFormationRate} onChange={setSuFormationRate} prefix="£" className="w-14" /></span>
          <span className="text-right font-mono">{suFormation ? fmt(suFormationQty * suFormationRate) : '—'}</span>
        </div>
        <div className={G4} style={C4}>
          <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={suHmrc} onChange={(e) => setSuHmrc(e.target.checked)} className="w-3 h-3 accent-ocean-600" />HMRC registrations</label>
          <span className="text-right"><Inp value={suHmrcQty} onChange={setSuHmrcQty} min={1} className="w-12" /></span>
          <span className="text-right"><Inp value={suHmrcRate} onChange={setSuHmrcRate} prefix="£" className="w-14" /></span>
          <span className="text-right font-mono">{suHmrc ? fmt(suHmrcQty * suHmrcRate) : '—'}</span>
        </div>
        {suOthers.map((o, i) => (
          <div key={i} className={G4} style={C4}>
            <input value={o.description} onChange={(e) => { const os = [...suOthers]; os[i] = { ...os[i], description: e.target.value }; setSuOthers(os); }} placeholder="Description" className="text-xs border border-gray-200 rounded px-1.5 py-0.5 bg-white" />
            <span></span><span></span>
            <span className="text-right flex items-center justify-end gap-1">
              <Inp value={o.amount} onChange={(v) => { const os = [...suOthers]; os[i] = { ...os[i], amount: v }; setSuOthers(os); }} prefix="£" className="w-14" />
              <button onClick={() => setSuOthers(suOthers.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-600">✕</button>
            </span>
          </div>
        ))}
        <button onClick={() => setSuOthers([...suOthers, { description: '', amount: 0 }])} className="text-xs text-ocean-600 hover:text-ocean-700 mt-1">+ Other setup item</button>
      </Section>

      {/* Accounts & CT */}
      <Section title="Accounts & CT" enabled={accEnabled} onToggle={() => setAccEnabled(!accEnabled)} annual={accAnnual}>
        <div className="flex gap-1 mb-3">
          {['trading', 'dormant', 'property'].map((t) => (
            <button key={t} onClick={() => setAccType(t)} className={`text-xs px-3 py-1.5 rounded-full border transition-all ${accType === t ? 'bg-ocean-600 text-white border-ocean-600' : 'bg-white text-gray-600 border-gray-200 hover:border-ocean-300'}`}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        {accType === 'trading' && <>
          {detectedBand && <p className="text-xs text-gray-400 mb-1">Band: {detectedBand.label} → standard {fmt(detectedBand.rate)}</p>}
          <div className="flex justify-between items-center text-xs"><span className="font-medium">Annual fee</span><Inp value={accRate} onChange={setAccRate} prefix="£" className="w-20" /></div>
        </>}
        {accType === 'dormant' && <div className="flex justify-between items-center text-xs"><span className="font-medium">Dormant company fee</span><Inp value={accDormant} onChange={setAccDormant} prefix="£" className="w-20" /></div>}
        {accType === 'property' && <>
          <TabRow cells={['Component', 'Qty', 'Rate', 'Total']} header />
          <div className={G4} style={C4}><span>Base (1 property)</span><span></span><span className="text-right"><Inp value={accPropBase} onChange={setAccPropBase} prefix="£" className="w-14" /></span><span className="text-right font-mono">{fmt(accPropBase)}</span></div>
          <div className={G4} style={C4}><span>Additional properties</span><span className="text-right"><Inp value={Math.max(0, accProperties - 1)} onChange={(v) => setAccProperties(v + 1)} min={0} className="w-12" /></span><span className="text-right"><Inp value={accPropExtra} onChange={setAccPropExtra} prefix="£" className="w-14" /></span><span className="text-right font-mono">{fmt(Math.max(0, accProperties - 1) * accPropExtra)}</span></div>
        </>}
      </Section>

      {/* Confirmation Statement */}
      <Section title="Confirmation Statement" enabled={csEnabled} onToggle={() => setCsEnabled(!csEnabled)} annual={csFee}>
        <div className="flex justify-between items-center text-xs"><span className="font-medium">Annual fee (+ VAT)</span><Inp value={csFee} onChange={setCsFee} prefix="£" className="w-16" /></div>
      </Section>

      {/* Directors */}
      <Section title={`Directors' Tax Returns (${directors.length})`} enabled={dtrEnabled} onToggle={() => setDtrEnabled(!dtrEnabled)} annual={dtrAnnual}>
        {directors.map((d, i) => (
          <DirectorCard key={i} d={d} idx={i} addonRates={addonRates} onAddonRate={onAddonRate}
            onChange={updateDir} onRemove={(idx) => setDirectors(directors.filter((_, j) => j !== idx))} canRemove={directors.length > 1} />
        ))}
        <button onClick={() => setDirectors([...directors, newDir()])} className="text-xs text-ocean-600 hover:text-ocean-700 font-medium">+ Add director</button>
      </Section>

      {/* Bookkeeping */}
      <Section title={bkIncVat ? 'Bookkeeping & VAT' : 'Bookkeeping'} enabled={bkEnabled} onToggle={() => setBkEnabled(!bkEnabled)} annual={bkAnnual}>
        <TabRow cells={['', 'Qty', 'Rate', 'Annual']} header />
        <div className={G4} style={C4}><span>Monthly hours</span><span className="text-right"><Inp value={bkHours} onChange={setBkHours} min={1} step={0.5} className="w-12" /></span><span className="text-right"><Inp value={bkRate} onChange={setBkRate} prefix="£" className="w-14" />/hr</span><span className="text-right font-mono">{fmt(bkHours * bkRate * 12)}</span></div>
        <div className="flex items-center justify-between text-xs mt-1">
          <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={bkIncVat} onChange={(e) => setBkIncVat(e.target.checked)} className="w-3 h-3 accent-ocean-600" />Includes VAT returns</label>
          {bkIncVat && <span>adj <Inp value={bkVatAdj} onChange={setBkVatAdj} prefix="£" className="w-14" /></span>}
        </div>
      </Section>

      {/* VAT standalone */}
      <Section title="VAT Returns (standalone)" enabled={vatEnabled} onToggle={() => setVatEnabled(!vatEnabled)} annual={vatAnnual}>
        <TabRow cells={['', 'Returns', 'Per return', 'Annual']} header />
        <div className={G4} style={C4}><span>VAT returns</span><span className="text-right"><Inp value={vatFreq} onChange={setVatFreq} min={1} max={12} className="w-12" /></span><span className="text-right"><Inp value={vatRate} onChange={setVatRate} prefix="£" className="w-14" /></span><span className="text-right font-mono">{fmt(vatAnnual)}</span></div>
      </Section>

      {/* Payroll */}
      <Section title="Payroll" enabled={prEnabled} onToggle={() => setPrEnabled(!prEnabled)} annual={prAnnual}>
        <TabRow cells={['Component', 'Qty', 'Rate', 'Monthly']} header />
        <div className={G4} style={C4}><span>Flat fee</span><span></span><span></span><span className="text-right"><Inp value={prFlat} onChange={setPrFlat} prefix="£" className="w-14" /></span></div>
        <div className={G4} style={C4}><span>Monthly employees</span><span className="text-right"><Inp value={prMonthlyEe} onChange={setPrMonthlyEe} min={0} className="w-12" /></span><span className="text-right"><Inp value={prMonthlyEeRate} onChange={setPrMonthlyEeRate} prefix="£" className="w-14" />/mo</span><span className="text-right font-mono">{fmt(prMonthlyEe * prMonthlyEeRate)}</span></div>
        <div className={G4} style={C4}><span>Weekly employees</span><span className="text-right"><Inp value={prWeeklyEe} onChange={setPrWeeklyEe} min={0} className="w-12" /></span><span className="text-right"><Inp value={prWeeklyEeRate} onChange={setPrWeeklyEeRate} prefix="£" className="w-14" />/wk</span><span className="text-right font-mono">{fmt(prWeeklyEe * prWeeklyEeRate * 4.33)}</span></div>
        <div className={G4} style={C4}><span>CIS subcontractors</span><span className="text-right"><Inp value={prCis} onChange={setPrCis} min={0} className="w-12" /></span><span className="text-right"><Inp value={prCisRate} onChange={setPrCisRate} prefix="£" className="w-14" />/wk</span><span className="text-right font-mono">{fmt(prCis * prCisRate * 4.33)}</span></div>
        <TabRow cells={['Monthly total', '', '', fmt(prMoCalc)]} bold />
        <div className={G4} style={{ ...C4, marginTop: '0.5rem' }}><span>P11D returns (annual)</span><span className="text-right"><Inp value={prP11d} onChange={setPrP11d} min={0} className="w-12" /></span><span className="text-right"><Inp value={prP11dRate} onChange={setPrP11dRate} prefix="£" className="w-14" /> ea</span><span className="text-right font-mono">{fmt(prP11d * prP11dRate)}</span></div>
      </Section>

      {/* Auto-enrolment */}
      <Section title="Auto-Enrolment" enabled={aeEnabled} onToggle={() => setAeEnabled(!aeEnabled)} annual={aeFee}>
        <div className="flex justify-between text-xs"><span>Annual fee</span><Inp value={aeFee} onChange={setAeFee} prefix="£" className="w-14" /></div>
      </Section>

      {/* Registered office */}
      <Section title="Registered Office" enabled={roEnabled} onToggle={() => setRoEnabled(!roEnabled)} annual={roFee}>
        <div className="flex justify-between text-xs"><span>Annual fee</span><Inp value={roFee} onChange={setRoFee} prefix="£" className="w-16" /></div>
      </Section>

      {/* Software */}
      <div className="bg-white rounded-lg border border-ocean-300 p-3 mb-3">
        <h2 className="text-xs font-semibold text-ocean-600 mb-2">Software</h2>
        <div className="grid gap-1 items-center text-xs text-gray-700 mb-1" style={{ gridTemplateColumns: '2fr 1fr 1fr' }}>
          <select value={swId} onChange={(e) => setSwId(e.target.value)} className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white">
            {D.software.map((s) => <option key={s.id} value={s.id}>{s.name}{s.monthly > 0 ? ` — ${fmt(s.monthly)}/mo` : ''}</option>)}
          </select>
          <span className="text-right font-mono">{sw.monthly > 0 ? fmt(sw.monthly) : '—'}</span>
          <span className="text-right font-mono">{sw.monthly > 0 ? fmt(sw.monthly * 12) : '—'}</span>
        </div>
        <div className="grid gap-1 items-center text-xs text-gray-700 mb-1" style={{ gridTemplateColumns: '2fr 1fr 1fr' }}>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={dextEnabled} onChange={(e) => setDextEnabled(e.target.checked)} className="w-3 h-3 accent-ocean-600" />
            Dext <Inp value={dextPrice} onChange={setDextPrice} prefix="£" className="w-12" />/mo
          </label>
          <span className="text-right font-mono">{dextEnabled ? fmt(dextPrice) : '—'}</span>
          <span className="text-right font-mono">{dextEnabled ? fmt(dextPrice * 12) : '—'}</span>
        </div>
        {swMonthly > 0 && <TabRow cells={['Total software', fmt(swMonthly) + '/mo', fmt(swAnnual)]} bold />}
      </div>

      {/* Totals */}
      <div className="bg-ocean-700 text-white rounded-lg p-4 mb-3">
        {setupTotal > 0 && <div className="flex justify-between text-xs mb-2 pb-2 border-b border-ocean-600"><span className="text-ocean-300">One-Off Setup</span><span className="font-mono">{fmt(setupTotal)}</span></div>}
        <div className="space-y-0.5">
          {lines.map((l, i) => <div key={i} className="flex justify-between text-xs"><span className="text-ocean-300 truncate mr-3">{l.name}</span><span className="font-mono whitespace-nowrap">{fmt(l.annual)}</span></div>)}
          {swAnnual > 0 && <div className="flex justify-between text-xs"><span className="text-ocean-300">Software</span><span className="font-mono">{fmt(swAnnual)}</span></div>}
        </div>
        <div className="border-t border-ocean-600 mt-2 pt-2 space-y-1">
          <div className="flex justify-between text-xs"><span className="text-ocean-300">Annual (Net)</span><span className="font-mono font-medium">{fmt(annualTotal)}</span></div>
          <div className="flex justify-between text-xs"><span className="text-ocean-300">Monthly (Net)</span><span className="font-mono">{fmt(monthlyNet)}</span></div>
          <div className="flex justify-between text-xs"><span className="text-ocean-300">VAT</span><span className="font-mono">{fmt(monthlyVat)}</span></div>
          <div className="flex justify-between text-base font-bold pt-1.5 border-t border-ocean-500"><span>Monthly DD (Inc VAT)</span><span className="font-mono text-sun-300">{fmt(monthlyGross)}</span></div>
        </div>
      </div>

      {/* Save */}
      <div className="flex gap-2">
        <Btn onClick={handleSave} disabled={saving || !client.name} className="flex-1">
          {saving ? 'Saving...' : 'Save Quote to Athena'}
        </Btn>
        <Btn onClick={() => navigate(-1)} variant="secondary">Cancel</Btn>
      </div>
    </div>
  );
}
