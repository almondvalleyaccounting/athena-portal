import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { INITIAL_DEFAULTS } from '../lib/defaults';
import { Inp, Btn, fmt } from '../components/ui';
import { useAuth } from '../shell/AppShell';
import { useFeeEngine } from '../contexts/FeeEngineContext';

const SectionHeader = ({ title }) => (
  <h3 className="text-xs font-semibold text-ocean-600 uppercase tracking-wider mt-8 mb-3 border-b border-gray-100 pb-1">{title}</h3>
);

const Row = ({ label, children }) => (
  <div className="flex items-center justify-between py-1.5 text-xs text-gray-700 gap-4">
    <span className="text-gray-600 text-left shrink-0">{label}</span>
    <div className="flex items-center gap-2 justify-end">{children}</div>
  </div>
);

export default function PricingDefaultsPage() {
  const { profile } = useAuth();
  const { defaults: currentDefaults, reloadDefaults } = useFeeEngine();
  const [rates, setRates] = useState(null);
  const [version, setVersion] = useState('');
  const [dbId, setDbId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);

  // Load current defaults from DB
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('quote_defaults')
        .select('*')
        .eq('is_current', true)
        .single();
      if (data?.rates) {
        const r = typeof data.rates === 'string' ? JSON.parse(data.rates) : data.rates;
        setRates({ ...INITIAL_DEFAULTS, ...r });
        setVersion(data.version || r.version || '0.3');
        setDbId(data.id);
      } else {
        setRates({ ...INITIAL_DEFAULTS });
        setVersion(INITIAL_DEFAULTS.version);
      }
    })();
  }, []);

  // Load version history
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('quote_defaults')
        .select('id, version, created_at, created_by')
        .order('created_at', { ascending: false })
        .limit(20);
      setHistory(data || []);
    })();
  }, [saved]);

  if (!rates) return <div className="p-6"><p className="text-sm text-gray-400">Loading fee schedule...</p></div>;

  const set = (path, val) => {
    setRates(prev => {
      const r = { ...prev };
      const parts = path.split('.');
      let obj = r;
      for (let i = 0; i < parts.length - 1; i++) {
        obj[parts[i]] = { ...obj[parts[i]] };
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = val;
      return r;
    });
    setSaved(false);
  };

  const setBand = (idx, field, val) => {
    setRates(prev => {
      const bands = [...prev.accounts_bands];
      bands[idx] = { ...bands[idx], [field]: val };
      return { ...prev, accounts_bands: bands };
    });
    setSaved(false);
  };

  const setSoftware = (idx, field, val) => {
    setRates(prev => {
      const sw = [...prev.software];
      sw[idx] = { ...sw[idx], [field]: val };
      return { ...prev, software: sw };
    });
    setSaved(false);
  };

  const incrementVersion = (v) => {
    const parts = v.split('.');
    const minor = parseInt(parts[1] || '0') + 1;
    return `${parts[0]}.${minor}`;
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const newVersion = incrementVersion(version);

      // Mark current as not current
      await supabase
        .from('quote_defaults')
        .update({ is_current: false })
        .eq('is_current', true);

      // Insert new version
      const { data, error: insertErr } = await supabase
        .from('quote_defaults')
        .insert({
          version: newVersion,
          is_current: true,
          rates: { ...rates, version: newVersion },
          created_by: profile.id,
        })
        .select()
        .single();

      if (insertErr) throw insertErr;

      // Audit log
      await supabase.from('audit_log').insert({
        user_id: profile.id,
        action: 'defaults_updated',
        entity_type: 'quote_defaults',
        entity_id: data.id,
        detail: { from_version: version, to_version: newVersion, note: note || null },
      });

      setVersion(newVersion);
      setDbId(data.id);
      setSaved(true);
      setNote('');
      reloadDefaults();
    } catch (e) {
      setError(e.message || 'Save failed');
    }
    setSaving(false);
  };

  const canEdit = profile?.can_edit_fee_schedule;
  const D = rates;

  return (
    <div className="p-6 max-w-2xl">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h2 className="text-lg font-bold text-ocean-700">Pricing Defaults</h2>
          <p className="text-xs text-gray-400">Fee schedule v{version} {canEdit ? '— edit rates below' : '— read only'}</p>
        </div>
        {canEdit && (
          <Btn onClick={handleSave} disabled={saving || saved}>
            {saving ? 'Saving...' : saved ? 'Saved \u2713' : 'Save New Version'}
          </Btn>
        )}
      </div>

      {error && <div className="text-xs text-red-600 bg-red-50 rounded p-2 mb-3">{error}</div>}
      {saved && <div className="text-xs text-green-700 bg-green-50 rounded p-2 mb-3">Fee schedule updated to v{version}. All new quotes will use these rates.</div>}

      <div className="bg-white rounded-lg border border-gray-200 p-4">

        {/* Accounts Bands */}
        <SectionHeader title="Accounts & CT Bands" />
        <div className="grid gap-2 text-xs text-gray-500 mb-1" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr' }}>
          <span>Band</span><span className="text-right">Min</span><span className="text-right">Max</span><span className="text-right">Rate</span>
        </div>
        {D.accounts_bands.map((b, i) => (
          <div key={i} className="grid gap-2 items-center text-xs" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr' }}>
            <span className="text-gray-600 text-left">{b.label}</span>
            <span className="text-right font-mono text-gray-400">{fmt(b.min)}</span>
            <span className="text-right font-mono text-gray-400">{b.max >= 999999999 ? '\u221E' : fmt(b.max)}</span>
            <div className="flex justify-end"><Inp value={b.rate} onChange={v => setBand(i, 'rate', v)} prefix="£" className="w-20" disabled={!canEdit} /></div>
          </div>
        ))}

        {/* Dormant & Property */}
        <SectionHeader title="Dormant & Property" />
        <Row label="Dormant company"><Inp value={D.dormant_rate} onChange={v => set('dormant_rate', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="Property base (1 property)"><Inp value={D.property_base} onChange={v => set('property_base', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="Per additional property"><Inp value={D.property_per_extra} onChange={v => set('property_per_extra', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>

        {/* Confirmation Statement */}
        <SectionHeader title="Confirmation Statement" />
        <Row label="Client fee"><Inp value={D.confirmation_statement.fee} onChange={v => set('confirmation_statement.fee', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="CH filing fee (cost)"><Inp value={D.confirmation_statement.ch_filing_fee} onChange={v => set('confirmation_statement.ch_filing_fee', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>

        {/* Directors */}
        <SectionHeader title="Directors' Tax Returns" />
        <Row label="Base return rate"><Inp value={D.director_base} onChange={v => set('director_base', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="Other dividends add-on"><Inp value={D.director_addons.other_dividends} onChange={v => set('director_addons.other_dividends', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="Rental property add-on"><Inp value={D.director_addons.rental_property} onChange={v => set('director_addons.rental_property', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="Capital gains add-on"><Inp value={D.director_addons.capital_gains} onChange={v => set('director_addons.capital_gains', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="Savings income add-on"><Inp value={D.director_addons.savings_income} onChange={v => set('director_addons.savings_income', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>

        {/* Bookkeeping & VAT */}
        <SectionHeader title="Bookkeeping & VAT" />
        <Row label="Bookkeeping hourly rate"><Inp value={D.bookkeeping_rate} onChange={v => set('bookkeeping_rate', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="VAT per return"><Inp value={D.vat_per_return} onChange={v => set('vat_per_return', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>

        {/* Payroll */}
        <SectionHeader title="Payroll" />
        <Row label="BrightPay annual cost"><Inp value={D.payroll.brightpay_annual} onChange={v => set('payroll.brightpay_annual', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="Payroll client count"><Inp value={D.payroll.payroll_client_count} onChange={v => set('payroll.payroll_client_count', v)} className="w-20" disabled={!canEdit} /></Row>
        <Row label="Markup %"><Inp value={D.payroll.markup_pct} onChange={v => set('payroll.markup_pct', v)} suffix="%" className="w-20" disabled={!canEdit} /></Row>
        {D.payroll.brightpay_annual > 0 && D.payroll.payroll_client_count > 0 && (
          <p className="text-[10px] text-gray-400 mb-1">Calc flat fee: {fmt(Math.ceil((D.payroll.brightpay_annual / D.payroll.payroll_client_count) * (1 + D.payroll.markup_pct / 100)))}/mo</p>
        )}
        <Row label="Monthly employee rate"><Inp value={D.payroll.monthly_ee_rate} onChange={v => set('payroll.monthly_ee_rate', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="Weekly employee rate"><Inp value={D.payroll.weekly_ee_rate} onChange={v => set('payroll.weekly_ee_rate', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="CIS rate"><Inp value={D.payroll.cis_rate} onChange={v => set('payroll.cis_rate', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="P11D rate"><Inp value={D.payroll.p11d_rate} onChange={v => set('payroll.p11d_rate', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>

        {/* Auto-Enrolment */}
        <SectionHeader title="Auto-Enrolment" />
        <Row label="Standard rate"><Inp value={D.auto_enrolment.standard} onChange={v => set('auto_enrolment.standard', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="Active rate"><Inp value={D.auto_enrolment.active} onChange={v => set('auto_enrolment.active', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>

        {/* Modulr */}
        <SectionHeader title="Modulr" />
        <Row label="Software monthly cost"><Inp value={D.modulr.software_monthly_cost} onChange={v => set('modulr.software_monthly_cost', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="Software monthly price"><Inp value={D.modulr.software_monthly_price} onChange={v => set('modulr.software_monthly_price', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="Per payment"><Inp value={D.modulr.per_payment} onChange={v => set('modulr.per_payment', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="Per pay run"><Inp value={D.modulr.per_run} onChange={v => set('modulr.per_run', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>

        {/* Other Rates */}
        <SectionHeader title="Other Rates" />
        <Row label="Management accounts (per set)"><Inp value={D.management_accounts_per_set} onChange={v => set('management_accounts_per_set', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="Review meeting rate"><Inp value={D.review_meeting_rate} onChange={v => set('review_meeting_rate', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="Registered office"><Inp value={D.registered_office} onChange={v => set('registered_office', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="Budget basic"><Inp value={D.budget_basic} onChange={v => set('budget_basic', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="Budget advanced"><Inp value={D.budget_advanced} onChange={v => set('budget_advanced', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="Reforecast"><Inp value={D.reforecast} onChange={v => set('reforecast', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="CFO day rate"><Inp value={D.cfo_day_rate} onChange={v => set('cfo_day_rate', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>

        {/* Setup Fees */}
        <SectionHeader title="Setup Fees" />
        <Row label="Company formation"><Inp value={D.setup.formation_rate} onChange={v => set('setup.formation_rate', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="HMRC registrations"><Inp value={D.setup.hmrc_reg_rate} onChange={v => set('setup.hmrc_reg_rate', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="Registration fee"><Inp value={D.setup.reg_fee} onChange={v => set('setup.reg_fee', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>

        {/* Software Products */}
        <SectionHeader title="Software Products" />
        <div className="grid gap-2 text-xs text-gray-500 mb-1" style={{ gridTemplateColumns: '2fr 1fr 1fr' }}>
          <span>Product</span><span className="text-right">Monthly</span><span className="text-right">Cost</span>
        </div>
        {D.software.filter(s => s.id !== 'none').map((s, i) => {
          const realIdx = D.software.findIndex(x => x.id === s.id);
          return (
            <div key={s.id} className="grid gap-2 items-center text-xs" style={{ gridTemplateColumns: '2fr 1fr 1fr' }}>
              <span className="text-gray-600 text-left">{s.name}</span>
              <div className="flex justify-end"><Inp value={s.monthly} onChange={v => setSoftware(realIdx, 'monthly', v)} prefix="£" className="w-20" disabled={!canEdit} /></div>
              <div className="flex justify-end"><Inp value={s.cost} onChange={v => setSoftware(realIdx, 'cost', v)} prefix="£" className="w-20" disabled={!canEdit} /></div>
            </div>
          );
        })}

        {/* Dext */}
        <SectionHeader title="Dext" />
        <Row label="Monthly price"><Inp value={D.dext.monthly_price} onChange={v => set('dext.monthly_price', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="Cost"><Inp value={D.dext.cost} onChange={v => set('dext.cost', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
        <Row label="Direct cost"><Inp value={D.dext.direct_cost} onChange={v => set('dext.direct_cost', v)} prefix="£" className="w-20" disabled={!canEdit} /></Row>
      </div>

      {/* Change note + save */}
      {canEdit && (
        <div className="mt-4 flex gap-2 items-end">
          <div className="flex-1">
            <label className="text-xs text-gray-500 mb-1 block">Change note (optional)</label>
            <input
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="e.g. Updated BrightPay annual cost"
              className="w-full text-xs border border-gray-200 rounded px-2 py-1.5"
            />
          </div>
          <Btn onClick={handleSave} disabled={saving || saved}>
            {saving ? 'Saving...' : saved ? 'Saved \u2713' : 'Save v' + incrementVersion(version)}
          </Btn>
        </div>
      )}

      {/* Version History */}
      <div className="mt-6">
        <button
          onClick={() => setShowHistory(!showHistory)}
          className="text-xs text-ocean-600 hover:text-ocean-700 font-medium"
        >
          {showHistory ? '\u25BC' : '\u25B6'} Version History ({history.length})
        </button>
        {showHistory && (
          <div className="mt-2 bg-white rounded-lg border border-gray-200 overflow-hidden">
            {history.map((h) => (
              <div key={h.id} className="flex items-center justify-between px-3 py-2 border-b border-gray-50 last:border-0 text-xs">
                <div>
                  <span className="font-mono text-ocean-600 font-medium">v{h.version}</span>
                  {h.id === dbId && <span className="ml-2 text-green-600 text-[10px] font-medium">CURRENT</span>}
                </div>
                <span className="text-gray-400">{new Date(h.created_at).toLocaleDateString('en-GB')}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
