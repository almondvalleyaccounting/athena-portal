import React, { useEffect } from 'react';
import useQuoteForm from '../hooks/useQuoteForm';
import { Inp, TabRow, Section, Btn, fmt, G4, C4 } from './ui';
import DirectorCard from './DirectorCard';

// Renders a full quote form for one entity within a group quote.
// Reports totals changes to parent via onTotalsChange callback.
export default function EntityQuoteTab({ defaults: D, entity, onTotalsChange }) {
  const f = useQuoteForm(D);

  // Pre-fill entity info
  useEffect(() => {
    if (entity) {
      f.setClient(c => ({
        ...c,
        name: entity.name || c.name,
        companyNumber: entity.company_number || c.companyNumber,
        entityType: entity.type || c.entityType,
      }));
    }
  }, [entity?.id]);

  // Report totals to parent whenever they change
  useEffect(() => {
    if (onTotalsChange) {
      onTotalsChange(entity.id, {
        lines: f.lines,
        annualServices: f.annualServices,
        swAnnual: f.swAnnual,
        annualTotal: f.annualTotal,
        monthlyNet: f.monthlyNet,
        monthlyVat: f.monthlyVat,
        monthlyGross: f.monthlyGross,
        setupTotal: f.setupTotal,
        buildQuoteData: f.buildQuoteData,
        buildLineItems: f.buildLineItems,
      });
    }
  }, [f.annualServices, f.swAnnual, f.monthlyGross, f.setupTotal]);

  // Expose loadFromQuote for edit mode
  EntityQuoteTab.loadFromQuote = f.loadFromQuote;

  return (
    <div>
      {/* Turnover for band detection */}
      <div className="bg-white rounded-lg border border-gray-200 p-3 mb-3">
        <div className="grid grid-cols-2 gap-2">
          <span className="text-xs text-gray-500 col-span-2">{entity?.name} {entity?.company_number ? `(${entity.company_number})` : ''}</span>
          <input value={f.client.turnover} onChange={(e) => f.setClient({ ...f.client, turnover: e.target.value })} placeholder="Est. turnover (\u00A3)" type="number" className="text-sm border border-gray-200 rounded px-2 py-1.5" />
          <select value={f.client.entityType} onChange={(e) => f.setClient({ ...f.client, entityType: e.target.value })} className="text-sm border border-gray-200 rounded px-2 py-1.5 bg-white">
            <option value="limited_company">Limited Company</option>
            <option value="sole_trader">Sole Trader</option>
            <option value="partnership">Partnership</option>
            <option value="llp">LLP</option>
          </select>
        </div>
      </div>

      {/* All service sections — same as QuoteFormPage */}
      <Section title="Accounts & CT" enabled={f.accEnabled} onToggle={() => f.setAccEnabled(!f.accEnabled)} annual={f.accAnnual}>
        <div className="flex gap-1 mb-3">
          {['trading', 'dormant', 'property'].map((t) => (
            <button key={t} onClick={() => f.setAccType(t)} className={`text-xs px-3 py-1.5 rounded-full border transition-all ${f.accType === t ? 'bg-ocean-600 text-white border-ocean-600' : 'bg-white text-gray-600 border-gray-200'}`}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        {f.accType === 'trading' && <>
          {f.detectedBand && <p className="text-xs text-gray-400 mb-1">Band: {f.detectedBand.label}</p>}
          <div className="flex justify-between items-center text-xs"><span>Annual fee</span><Inp value={f.accRate} onChange={f.setAccRate} prefix="\u00A3" className="w-20" /></div>
        </>}
        {f.accType === 'dormant' && <div className="flex justify-between items-center text-xs"><span>Dormant fee</span><Inp value={f.accDormant} onChange={f.setAccDormant} prefix="\u00A3" className="w-20" /></div>}
        {f.accType === 'property' && <>
          <div className="flex justify-between items-center text-xs mb-1"><span>Base</span><Inp value={f.accPropBase} onChange={f.setAccPropBase} prefix="\u00A3" className="w-14" /></div>
          <div className="flex justify-between items-center text-xs"><span>Extra props</span><Inp value={Math.max(0, f.accProperties - 1)} onChange={(v) => f.setAccProperties(v + 1)} min={0} className="w-12" /> x <Inp value={f.accPropExtra} onChange={f.setAccPropExtra} prefix="\u00A3" className="w-14" /></div>
        </>}
      </Section>

      <Section title="Confirmation Statement" enabled={f.csEnabled} onToggle={() => f.setCsEnabled(!f.csEnabled)} annual={f.csFee}>
        <div className="flex justify-between text-xs"><span>Annual fee</span><Inp value={f.csFee} onChange={f.setCsFee} prefix="\u00A3" className="w-16" /></div>
      </Section>

      <Section title={`Directors' Tax (${f.directors.length})`} enabled={f.dtrEnabled} onToggle={() => f.setDtrEnabled(!f.dtrEnabled)} annual={f.dtrAnnual}>
        {f.directors.map((d, i) => (
          <DirectorCard key={i} d={d} idx={i} addonRates={f.addonRates} onAddonRate={f.onAddonRate}
            onChange={f.updateDir} onRemove={(idx) => f.setDirectors(f.directors.filter((_, j) => j !== idx))} canRemove={f.directors.length > 1} />
        ))}
        <button onClick={() => f.setDirectors([...f.directors, f.newDir()])} className="text-xs text-ocean-600 hover:text-ocean-700 font-medium">+ Add director</button>
      </Section>

      <Section title={f.bkIncVat ? 'Bookkeeping & VAT' : 'Bookkeeping'} enabled={f.bkEnabled} onToggle={() => f.setBkEnabled(!f.bkEnabled)} annual={f.bkAnnual}>
        <div className="flex justify-between text-xs mb-1"><span>Hours/mo</span><Inp value={f.bkHours} onChange={f.setBkHours} min={1} className="w-12" /> x <Inp value={f.bkRate} onChange={f.setBkRate} prefix="\u00A3" className="w-14" />/hr</div>
        <label className="flex items-center gap-1.5 text-xs cursor-pointer"><input type="checkbox" checked={f.bkIncVat} onChange={(e) => f.setBkIncVat(e.target.checked)} className="w-3 h-3 accent-ocean-600" />Inc VAT</label>
      </Section>

      <Section title="VAT Returns" enabled={f.vatEnabled} onToggle={() => f.setVatEnabled(!f.vatEnabled)} annual={f.vatAnnual}>
        <div className="flex justify-between text-xs"><span>Returns/yr</span><Inp value={f.vatFreq} onChange={f.setVatFreq} min={1} className="w-12" /> x <Inp value={f.vatRate} onChange={f.setVatRate} prefix="\u00A3" className="w-14" /></div>
      </Section>

      <Section title="Payroll" enabled={f.prEnabled} onToggle={() => f.setPrEnabled(!f.prEnabled)} annual={f.prAnnual}>
        <div className="space-y-1 text-xs">
          <div className="flex justify-between"><span>Flat/mo</span><Inp value={f.prFlat} onChange={f.setPrFlat} prefix="\u00A3" className="w-14" /></div>
          <div className="flex justify-between"><span>Monthly EE</span><Inp value={f.prMonthlyEe} onChange={f.setPrMonthlyEe} min={0} className="w-12" /> x <Inp value={f.prMonthlyEeRate} onChange={f.setPrMonthlyEeRate} prefix="\u00A3" className="w-14" /></div>
          <div className="flex justify-between"><span>Weekly EE</span><Inp value={f.prWeeklyEe} onChange={f.setPrWeeklyEe} min={0} className="w-12" /> x <Inp value={f.prWeeklyEeRate} onChange={f.setPrWeeklyEeRate} prefix="\u00A3" className="w-14" /></div>
          <div className="flex justify-between"><span>P11D</span><Inp value={f.prP11d} onChange={f.setPrP11d} min={0} className="w-12" /> x <Inp value={f.prP11dRate} onChange={f.setPrP11dRate} prefix="\u00A3" className="w-14" /></div>
        </div>
      </Section>

      <Section title="Auto-Enrolment" enabled={f.aeEnabled} onToggle={() => f.setAeEnabled(!f.aeEnabled)} annual={f.aeFee}>
        <div className="flex justify-between text-xs"><span>Annual fee</span><Inp value={f.aeFee} onChange={f.setAeFee} prefix="\u00A3" className="w-14" /></div>
      </Section>

      <Section title="Registered Office" enabled={f.roEnabled} onToggle={() => f.setRoEnabled(!f.roEnabled)} annual={f.roFee}>
        <div className="flex justify-between text-xs"><span>Annual fee</span><Inp value={f.roFee} onChange={f.setRoFee} prefix="\u00A3" className="w-16" /></div>
      </Section>

      {/* Software */}
      <div className="bg-white rounded-lg border border-ocean-300 p-3 mb-3">
        <h2 className="text-xs font-semibold text-ocean-600 mb-2">Software</h2>
        <select value={f.swId} onChange={(e) => f.setSwId(e.target.value)} className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white w-full mb-1">
          {D.software.map((s) => <option key={s.id} value={s.id}>{s.name}{s.monthly > 0 ? ` \u2014 ${fmt(s.monthly)}/mo` : ''}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-xs cursor-pointer">
          <input type="checkbox" checked={f.dextEnabled} onChange={(e) => f.setDextEnabled(e.target.checked)} className="w-3 h-3 accent-ocean-600" />
          Dext {fmt(f.dextPrice)}/mo
        </label>
      </div>
    </div>
  );
}
