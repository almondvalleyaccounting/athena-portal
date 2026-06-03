import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { fmt, Btn } from '../components/ui';
import { useAuth } from '../shell/AppShell';
import { useFeeEngine } from '../contexts/FeeEngineContext';

// Driver definitions: what inputs drive each service's annual value
const DRIVER_DEFS = [
  { id: 'turnover', label: 'Estimated Turnover', section: 'Accounts & CT', type: 'currency' },
  { id: 'acc_type', label: 'Account Type', section: 'Accounts & CT', type: 'select', options: ['trading', 'dormant', 'property'] },
  { id: 'num_directors', label: 'Number of Directors', section: "Directors' Tax Returns", type: 'number' },
  { id: 'director_base', label: 'Director Base Rate', section: "Directors' Tax Returns", type: 'currency' },
  { id: 'bk_hours', label: 'Bookkeeping Hours / Month', section: 'Bookkeeping & VAT Returns', type: 'number' },
  { id: 'bk_rate', label: 'Bookkeeping Hourly Rate', section: 'Bookkeeping & VAT Returns', type: 'currency' },
  { id: 'bk_inc_vat', label: 'Includes VAT Returns', section: 'Bookkeeping & VAT Returns', type: 'boolean' },
  { id: 'vat_returns_pa', label: 'VAT Returns Per Year', section: 'VAT Returns', type: 'number' },
  { id: 'vat_per_return', label: 'Rate Per VAT Return', section: 'VAT Returns', type: 'currency' },
  { id: 'monthly_employees', label: 'Monthly Employees', section: 'Payroll', type: 'number' },
  { id: 'weekly_employees', label: 'Weekly Employees', section: 'Payroll', type: 'number' },
  { id: 'payroll_flat', label: 'Payroll Flat Fee / Month', section: 'Payroll', type: 'currency' },
  { id: 'monthly_ee_rate', label: 'Monthly Employee Rate', section: 'Payroll', type: 'currency' },
  { id: 'weekly_ee_rate', label: 'Weekly Employee Rate', section: 'Payroll', type: 'currency' },
  { id: 'ma_sets', label: 'Management Account Sets / Year', section: 'Management Accounts', type: 'number' },
  { id: 'ma_rate', label: 'Rate Per Set', section: 'Management Accounts', type: 'currency' },
  { id: 'rm_count', label: 'Review Meetings / Year', section: 'Review Meetings', type: 'number' },
  { id: 'rm_rate', label: 'Rate Per Meeting', section: 'Review Meetings', type: 'currency' },
  { id: 'cfo_days', label: 'CFO Days / Year', section: 'Fractional CFO', type: 'number' },
  { id: 'cfo_day_rate', label: 'CFO Day Rate', section: 'Fractional CFO', type: 'currency' },
];

const SERVICE_ROWS = [
  { id: 'accounts_ct', name: 'Accounts & CT' },
  { id: 'confirmation_statement', name: 'Confirmation Statement' },
  { id: 'directors_tax_return', name: "Directors' Tax Returns" },
  { id: 'bookkeeping_vat', name: 'Bookkeeping & VAT Returns' },
  { id: 'vat_returns', name: 'VAT Returns' },
  { id: 'payroll', name: 'Payroll' },
  { id: 'auto_enrolment', name: 'Auto-Enrolment' },
  { id: 'modulr', name: 'Modulr' },
  { id: 'management_accounts', name: 'Management Accounts' },
  { id: 'review_meetings', name: 'Review Meetings' },
  { id: 'budgeting', name: 'Budgeting & Forecasting' },
  { id: 'fractional_cfo', name: 'Fractional CFO' },
  { id: 'registered_office', name: 'Registered Office' },
  { id: 'software', name: 'Software' },
];

// Calculate service annual value from drivers + return explanation
function calcService(serviceId, drivers, defaults) {
  const D = defaults || {};
  const g = (k, fallback) => drivers[k] ?? fallback;

  switch (serviceId) {
    case 'accounts_ct': {
      const turnover = g('turnover', 0);
      const type = g('acc_type', 'trading');
      if (type === 'dormant') return { value: D.dormant_rate || 150, calc: `Dormant rate: ${fmt(D.dormant_rate || 150)}` };
      if (type === 'property') return { value: D.property_base || 650, calc: `Property base: ${fmt(D.property_base || 650)}` };
      const band = (D.accounts_bands || []).find(b => turnover >= b.min && turnover <= (b.max >= 999999999 ? Infinity : b.max));
      const rate = band?.rate || 750;
      return { value: rate, calc: `Turnover ${fmt(turnover)} \u2192 Band: ${band?.label || 'Up to \u00A390K'} = ${fmt(rate)}` };
    }
    case 'confirmation_statement':
      return { value: D.confirmation_statement?.fee || 110, calc: `Standard fee: ${fmt(D.confirmation_statement?.fee || 110)}` };
    case 'directors_tax_return': {
      const n = g('num_directors', 0);
      const base = g('director_base', D.director_base || 240);
      const val = n * base;
      return { value: val, calc: `${n} directors \u00D7 ${fmt(base)} = ${fmt(val)}` };
    }
    case 'bookkeeping_vat': {
      const hrs = g('bk_hours', 0);
      const rate = g('bk_rate', D.bookkeeping_rate || 45);
      const val = hrs * rate * 12;
      return { value: val, calc: `${hrs} hrs/mo \u00D7 ${fmt(rate)}/hr \u00D7 12 months = ${fmt(val)}` };
    }
    case 'vat_returns': {
      const n = g('vat_returns_pa', 0);
      const rate = g('vat_per_return', D.vat_per_return || 45);
      const val = n * rate;
      return { value: val, calc: `${n} returns \u00D7 ${fmt(rate)} = ${fmt(val)}` };
    }
    case 'payroll': {
      const flat = g('payroll_flat', 0);
      const mEe = g('monthly_employees', 0);
      const mRate = g('monthly_ee_rate', D.payroll?.monthly_ee_rate || 6);
      const wEe = g('weekly_employees', 0);
      const wRate = g('weekly_ee_rate', D.payroll?.weekly_ee_rate || 1.80);
      const monthly = flat + (mEe * mRate) + (wEe * wRate * 4.33);
      const val = monthly * 12;
      return { value: val, calc: `(${fmt(flat)} flat + ${mEe}\u00D7${fmt(mRate)} monthly + ${wEe}\u00D7${fmt(wRate)}\u00D74.33 weekly) \u00D7 12 = ${fmt(val)}` };
    }
    case 'auto_enrolment':
      return { value: D.auto_enrolment?.standard || 60, calc: `Standard rate: ${fmt(D.auto_enrolment?.standard || 60)}` };
    case 'management_accounts': {
      const sets = g('ma_sets', 0);
      const rate = g('ma_rate', D.management_accounts_per_set || 158);
      const val = sets * rate;
      return { value: val, calc: `${sets} sets \u00D7 ${fmt(rate)} = ${fmt(val)}` };
    }
    case 'review_meetings': {
      const n = g('rm_count', 0);
      const rate = g('rm_rate', D.review_meeting_rate || 210);
      const val = n * rate;
      return { value: val, calc: `${n} meetings \u00D7 ${fmt(rate)} = ${fmt(val)}` };
    }
    case 'fractional_cfo': {
      const days = g('cfo_days', 0);
      const rate = g('cfo_day_rate', D.cfo_day_rate || 1680);
      const val = days * rate;
      return { value: val, calc: `${days} days \u00D7 ${fmt(rate)} = ${fmt(val)}` };
    }
    default:
      return { value: 0, calc: 'Manual entry' };
  }
}

// Tooltip component
function Tooltip({ text, children }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show && text && (
        <span className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-gray-800 text-white text-[10px] rounded whitespace-nowrap max-w-[280px] text-center shadow-lg">
          {text}
        </span>
      )}
    </span>
  );
}

export default function GroupQuoteInputPage() {
  const { profile } = useAuth();
  const { defaults } = useFeeEngine();
  const { groupId } = useParams();
  const navigate = useNavigate();

  const [group, setGroup] = useState(null);
  const [entities, setEntities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Drivers: { [entityId]: { [driverId]: value } }
  const [drivers, setDrivers] = useState({});
  // Manual overrides: { [entityId]: { [serviceId]: number|null } }
  const [overrides, setOverrides] = useState({});
  // Discounts
  const [discounts, setDiscounts] = useState({});
  // Which value cell is being edited (so it shows the raw number while
  // focused, but a 2dp figure otherwise).
  const [focusedCell, setFocusedCell] = useState(null); // `${entityId}:${svcId}`
  const [focusedText, setFocusedText] = useState(''); // raw text while editing a value cell

  useEffect(() => { loadGroupData(); }, [groupId, defaults]);

  const loadGroupData = async () => {
    setLoading(true);
    try {
      const [{ data: bg }, { data: bgm }, { data: gQuotesForEnts }] = await Promise.all([
        supabase.from('billing_groups').select('*').eq('id', groupId).single(),
        supabase.from('billing_group_members').select('entity_id').eq('group_id', groupId),
        supabase.from('quotes').select('entity_id').eq('group_id', groupId).neq('status', 'deleted'),
      ]);
      setGroup(bg);
      // Entities are the UNION of billing_group_members and any entity that
      // has a (non-deleted) quote in this group — membership rows can lag
      // behind quotes created/assigned to the group.
      const entityIds = [...new Set([
        ...(bgm || []).map(m => m.entity_id),
        ...(gQuotesForEnts || []).map(q => q.entity_id),
      ].filter(Boolean))];
      if (entityIds.length > 0) {
        const { data: ents } = await supabase.from('entities').select('id, name, company_number').in('id', entityIds);
        setEntities(ents || []);

        // Pre-populate from any existing (non-deleted) quote per entity, so
        // Build Group Quote and the individual quotes are two views of the
        // same thing. We pull the real DRIVERS out of each quote's detail
        // JSONs (bookkeeping hours, director count, payroll employees,
        // turnover, etc.) so the matrix is genuinely editable by driver.
        // An override is set only where the matrix calc can't reproduce the
        // saved line amount (custom rate, addons, VAT adjustments, or a
        // driverless service like Confirmation/RO/Software), keeping the
        // displayed value faithful to the quote.
        const { data: gQuotes } = await supabase
          .from('quotes')
          .select('id, entity_id, status, created_at, estimated_turnover, accounts_detail, directors, bookkeeping_detail, payroll_detail, management_accounts_detail, review_meetings_detail, cfo_detail, modulr_detail, budgeting_detail, software_detail, line_items:quote_line_items(service_id, annual_amount, is_recurring)')
          .in('entity_id', entityIds)
          .neq('status', 'deleted')
          .order('created_at', { ascending: false });
        const quoteByEntity = {};
        for (const q of gQuotes || []) {
          if (q.entity_id && !quoteByEntity[q.entity_id]) quoteByEntity[q.entity_id] = q;
        }
        const toRowId = (sid) => {
          if (!sid) return null;
          if (sid.startsWith('software')) return 'software';
          if (sid === 'cfo') return 'fractional_cfo';
          if (sid === 'bookkeeping') return 'bookkeeping_vat';
          return SERVICE_ROWS.some(r => r.id === sid) ? sid : null;
        };

        const defaultDrivers = () => ({
          director_base: defaults?.director_base || 240,
          // Payroll is opt-in — no flat fee until the client actually has
          // payroll (a flat fee or employees entered). The brightpay rate is
          // the suggested value once payroll is added, not a default charge.
          payroll_flat: 0,
          bk_rate: defaults?.bookkeeping_rate || 45,
          vat_per_return: defaults?.vat_per_return || 45,
          monthly_ee_rate: defaults?.payroll?.monthly_ee_rate || 6,
          weekly_ee_rate: defaults?.payroll?.weekly_ee_rate || 1.80,
          ma_rate: defaults?.management_accounts_per_set || 158,
          rm_rate: defaults?.review_meeting_rate || 210,
          cfo_day_rate: defaults?.cfo_day_rate || 1680,
        });

        // Pull drivers out of a saved quote's detail JSONs.
        const driversFromQuote = (q) => {
          const d = defaultDrivers();
          if (!q) return d;
          if (q.estimated_turnover != null) d.turnover = Number(q.estimated_turnover) || 0;
          if (q.accounts_detail?.type) d.acc_type = q.accounts_detail.type;
          const dirs = Array.isArray(q.directors) ? q.directors : [];
          if (dirs.length) { d.num_directors = dirs.length; if (dirs[0]?.base != null) d.director_base = Number(dirs[0].base) || d.director_base; }
          const bk = q.bookkeeping_detail;
          if (bk) { d.bk_hours = Number(bk.hours_per_month) || 0; if (bk.rate != null) d.bk_rate = Number(bk.rate); d.bk_inc_vat = bk.includes_vat !== false; }
          const pr = q.payroll_detail;
          if (pr) {
            d.payroll_flat = Number(pr.flat_monthly) || 0;
            d.monthly_employees = Number(pr.monthly_ee) || 0;
            d.weekly_employees = Number(pr.weekly_ee) || 0;
            if (pr.monthly_ee_rate != null) d.monthly_ee_rate = Number(pr.monthly_ee_rate);
            if (pr.weekly_ee_rate != null) d.weekly_ee_rate = Number(pr.weekly_ee_rate);
          }
          const ma = q.management_accounts_detail;
          if (ma) { d.ma_sets = Number(ma.sets) || 0; if (ma.rate_per_set != null) d.ma_rate = Number(ma.rate_per_set); }
          const rm = q.review_meetings_detail;
          if (rm) { d.rm_count = Number(rm.count) || 0; if (rm.rate != null) d.rm_rate = Number(rm.rate); }
          const cfo = q.cfo_detail;
          if (cfo) { d.cfo_days = Number(cfo.days) || 0; if (cfo.day_rate != null) d.cfo_day_rate = Number(cfo.day_rate); }
          return d;
        };

        const initDrivers = {}, initOverrides = {}, initDiscounts = {};
        (ents || []).forEach(e => {
          const q = quoteByEntity[e.id];
          const drv = driversFromQuote(q);
          initDrivers[e.id] = drv;

          // Saved amount per matrix row from the quote's line items.
          const savedByRow = {};
          for (const li of (q?.line_items || [])) {
            if (li.is_recurring === false) continue; // skip one-off setup lines
            const rowId = toRowId(li.service_id);
            if (!rowId) continue;
            savedByRow[rowId] = (savedByRow[rowId] || 0) + (Number(li.annual_amount) || 0);
          }
          const ov = {};
          if (q) {
            // Faithfully mirror the quote: services NOT on it are £0 (the
            // matrix calc would otherwise fabricate a default, e.g.
            // Auto-Enrolment £60, Confirmation £110, for clients who don't
            // have them).
            SERVICE_ROWS.forEach((svc) => {
              if (!(svc.id in savedByRow)) ov[svc.id] = 0;
            });
            // Services that ARE on the quote: override only where the driver
            // calc can't reproduce the saved figure (driverless service,
            // custom rate, director addons, VAT adjustment…).
            for (const [rowId, saved] of Object.entries(savedByRow)) {
              const calc = calcService(rowId, drv, defaults).value;
              if (Math.abs(calc - saved) > 0.5) ov[rowId] = saved;
            }
          }
          initOverrides[e.id] = ov;
          initDiscounts[e.id] = 0; // saved amounts are already net of any discount
        });
        setDrivers(initDrivers);
        setOverrides(initOverrides);
        setDiscounts(initDiscounts);
      }
    } catch {}
    setLoading(false);
  };

  const setDriver = (entityId, driverId, value) => {
    setDrivers(prev => ({ ...prev, [entityId]: { ...prev[entityId], [driverId]: value } }));
  };

  const setOverride = (entityId, serviceId, value) => {
    setOverrides(prev => ({ ...prev, [entityId]: { ...prev[entityId], [serviceId]: value === '' ? null : (parseFloat(value) || 0) } }));
  };

  // Computed values per entity per service
  const computed = useMemo(() => {
    const result = {};
    entities.forEach(e => {
      result[e.id] = {};
      SERVICE_ROWS.forEach(svc => {
        const calc = calcService(svc.id, drivers[e.id] || {}, defaults);
        const override = overrides[e.id]?.[svc.id];
        const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
        result[e.id][svc.id] = {
          value: round2(override != null ? override : calc.value),
          calc: override != null ? `Manual override (calculated: ${fmt(calc.value)})` : calc.calc,
          isOverride: override != null,
          calculatedValue: round2(calc.value),
        };
      });
    });
    return result;
  }, [drivers, overrides, entities, defaults]);

  // Totals
  const entityTotals = useMemo(() => {
    const t = {};
    entities.forEach(e => {
      t[e.id] = SERVICE_ROWS.reduce((s, svc) => s + (computed[e.id]?.[svc.id]?.value || 0), 0);
    });
    return t;
  }, [computed, entities]);

  const serviceTotals = useMemo(() => {
    const t = {};
    SERVICE_ROWS.forEach(svc => {
      t[svc.id] = entities.reduce((s, e) => s + (computed[e.id]?.[svc.id]?.value || 0), 0);
    });
    return t;
  }, [computed, entities]);

  const grandTotal = entities.reduce((s, e) => s + (entityTotals[e.id] || 0), 0);
  const afterDiscountTotals = {};
  entities.forEach(e => { afterDiscountTotals[e.id] = (entityTotals[e.id] || 0) * (1 - (discounts[e.id] || 0) / 100); });
  const grandAfterDiscount = entities.reduce((s, e) => s + (afterDiscountTotals[e.id] || 0), 0);
  const monthlyCalc = (annual) => {
    const net = Math.round((annual / 12) * 100) / 100;
    const vat = Math.round(net * 0.2 * 100) / 100;
    return { net, vat, gross: Math.round((net + vat) * 100) / 100 };
  };
  const grandMonthly = monthlyCalc(grandAfterDiscount);

  // Group driver sections
  const driverSections = {};
  DRIVER_DEFS.forEach(d => {
    if (!driverSections[d.section]) driverSections[d.section] = [];
    driverSections[d.section].push(d);
  });

  const handleSave = async () => {
    setSaving(true); setError(''); setSuccess('');
    try {
      for (const entity of entities) {
        const disc = discounts[entity.id] || 0;
        const annualTotal = afterDiscountTotals[entity.id] || 0;
        if (annualTotal <= 0) continue;
        const m = monthlyCalc(annualTotal);
        const nameSlug = (entity.name || 'Entity').replace(/[^a-zA-Z0-9]/g, '');
        const dateSlug = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const prefix = `${nameSlug}_${dateSlug}`;
        const { data: existing } = await supabase.from('quotes').select('quote_ref').like('quote_ref', `${prefix}%`);
        const nums = (existing || []).map(q => parseInt(q.quote_ref.split('_').pop()) || 0);
        const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
        const quoteRef = `${prefix}_${String(next).padStart(3, '0')}`;
        const validUntil = new Date(); validUntil.setDate(validUntil.getDate() + 30);

        const { data: quote, error: qErr } = await supabase.from('quotes').insert({
          quote_ref: quoteRef, entity_id: entity.id, group_id: groupId, status: 'draft',
          relationship_group: entity.name, annual_total: Math.round(annualTotal * 100) / 100,
          annual_services: Math.round((entityTotals[entity.id] || 0) * 100) / 100,
          monthly_net: m.net, monthly_vat: m.vat, monthly_gross: m.gross, one_off_total: 0,
          defaults_version: defaults?.version || '0.3', valid_until: validUntil.toISOString().slice(0, 10), created_by: profile?.id,
        }).select().single();
        if (qErr) throw qErr;

        const lineItems = [];
        let sortOrder = 0;
        SERVICE_ROWS.forEach(svc => {
          const val = computed[entity.id]?.[svc.id]?.value || 0;
          if (val > 0) {
            const discVal = val * (1 - disc / 100);
            lineItems.push({
              quote_id: quote.id, service_id: svc.id, description: svc.name,
              annual_amount: Math.round(discVal * 100) / 100, monthly_amount: Math.round((discVal / 12) * 100) / 100,
              detail: computed[entity.id]?.[svc.id]?.calc || '', is_recurring: true, sort_order: sortOrder++,
            });
          }
        });
        if (lineItems.length > 0) await supabase.from('quote_line_items').insert(lineItems);
      }
      setSuccess('Quotes saved!');
      setTimeout(() => navigate(`/manage/quotes/group/${groupId}`), 800);
    } catch (e) { setError(e.message || 'Failed to save'); }
    setSaving(false);
  };

  if (loading) return <div className="p-6"><p className="text-sm text-gray-400">Loading group...</p></div>;
  if (!group) return <div className="p-6"><p className="text-sm text-red-500">Group not found.</p></div>;
  if (!entities.length) return <div className="p-6"><p className="text-sm text-gray-500">No entities in this group.</p><Btn onClick={() => navigate(`/manage/quotes/group/${groupId}`)} variant="secondary" className="mt-2">Back</Btn></div>;

  return (
    <div className="p-6">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h2 className="text-lg font-bold text-ocean-700">Group Quote Builder</h2>
          <p className="text-xs text-gray-400">{group.name} &middot; {entities.length} entities</p>
        </div>
        <div className="flex gap-2">
          <Btn onClick={() => navigate(`/manage/quotes/group/${groupId}`)} variant="ghost">Back</Btn>
          <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save Quotes'}</Btn>
        </div>
      </div>

      {error && <div className="text-xs text-red-600 bg-red-50 rounded p-2 mb-3">{error}</div>}
      {success && <div className="text-xs text-green-600 bg-green-50 rounded p-2 mb-3">{success}</div>}

      {/* ═══ DRIVERS CROSS-TAB ═══ */}
      <div className="bg-white rounded-lg border border-blue-200 overflow-x-auto mb-4">
        <div className="px-3 py-2 bg-blue-50 border-b border-blue-200">
          <h3 className="text-xs font-semibold text-blue-700">Quote Drivers</h3>
          <p className="text-[10px] text-blue-400">Set the inputs — values calculate automatically below</p>
        </div>
        <table className="w-full text-xs border-collapse table-fixed">
          <colgroup>
            <col style={{ width: 200 }} />
            {entities.map(e => <col key={e.id} style={{ width: 120 }} />)}
            <col style={{ width: 120 }} />
          </colgroup>
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="text-left px-3 py-2 text-gray-500 font-medium sticky left-0 bg-gray-50 z-10">Driver</th>
              {entities.map(e => <th key={e.id} className="text-center px-2 py-2 text-gray-500 font-medium truncate">{e.name}</th>)}
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {Object.entries(driverSections).map(([section, defs]) => (
              <React.Fragment key={section}>
                <tr><td colSpan={entities.length + 2} className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase bg-gray-50 border-t border-gray-100">{section}</td></tr>
                {defs.map(d => (
                  <tr key={d.id} className="border-b border-gray-50 hover:bg-blue-50/30">
                    <td className="px-3 py-1 text-gray-600 sticky left-0 bg-white z-10">{d.label}</td>
                    {entities.map(e => (
                      <td key={e.id} className="px-1 py-0.5">
                        {d.type === 'select' ? (
                          <select value={drivers[e.id]?.[d.id] || d.options[0]} onChange={ev => setDriver(e.id, d.id, ev.target.value)} className="w-full text-xs border border-gray-200 rounded px-1 py-1 bg-white text-center">
                            {d.options.map(o => <option key={o} value={o}>{o}</option>)}
                          </select>
                        ) : d.type === 'boolean' ? (
                          <div className="flex justify-end pr-1.5">
                            <input type="checkbox" checked={!!drivers[e.id]?.[d.id]} onChange={ev => setDriver(e.id, d.id, ev.target.checked)} className="w-3 h-3 accent-ocean-600" />
                          </div>
                        ) : (
                          <input
                            type="number" value={drivers[e.id]?.[d.id] ?? ''} onChange={ev => setDriver(e.id, d.id, parseFloat(ev.target.value) || 0)}
                            placeholder="0" min="0" step="any"
                            className="w-full text-right text-xs font-mono border border-gray-200 rounded px-1.5 py-1 bg-white focus:border-blue-300 focus:outline-none"
                          />
                        )}
                      </td>
                    ))}
                    <td className="px-3" />
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* ═══ VALUES CROSS-TAB ═══ */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto mb-4">
        <div className="px-3 py-2 bg-ocean-50 border-b border-ocean-200">
          <h3 className="text-xs font-semibold text-ocean-700">Calculated Values (Annual)</h3>
          <p className="text-[10px] text-ocean-400">Hover any number to see its calculation. Override by typing directly.</p>
        </div>
        <table className="w-full text-xs border-collapse table-fixed">
          <colgroup>
            <col style={{ width: 200 }} />
            {entities.map(e => <col key={e.id} style={{ width: 120 }} />)}
            <col style={{ width: 120 }} />
          </colgroup>
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left px-3 py-2 text-gray-500 font-medium sticky left-0 bg-gray-50 z-10">Service</th>
              {entities.map(e => <th key={e.id} className="text-right px-3 py-2 text-gray-500 font-medium truncate">{e.name}</th>)}
              <th className="text-right px-3 py-2 text-ocean-600 font-semibold bg-ocean-50">Total</th>
            </tr>
          </thead>
          <tbody>
            {SERVICE_ROWS.map(svc => (
              <tr key={svc.id} className="border-b border-gray-50 hover:bg-gray-50">
                <td className="px-3 py-1.5 text-gray-700 font-medium sticky left-0 bg-white z-10">{svc.name}</td>
                {entities.map(e => {
                  const cell = computed[e.id]?.[svc.id] || { value: 0, calc: '' };
                  // Below standard: a positive value under the standard
                  // (defaults-calculated) amount for this client/service.
                  const belowStandard = cell.value > 0 && cell.calculatedValue > 0 && cell.value < cell.calculatedValue - 0.5;
                  const cls = belowStandard
                    ? 'border-red-300 bg-red-50 text-red-700'
                    : cell.isOverride ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-white';
                  const tip = belowStandard
                    ? `${cell.calc} — below standard ${fmt(cell.calculatedValue)}`
                    : cell.calc;
                  const cellKey = `${e.id}:${svc.id}`;
                  const isFocused = focusedCell === cellKey;
                  // Raw text while editing (smooth decimal entry); 2dp otherwise.
                  const display = isFocused
                    ? focusedText
                    : (cell.value ? cell.value.toFixed(2) : '');
                  return (
                    <td key={e.id} className="px-1 py-0.5">
                      <Tooltip text={tip}>
                        <input
                          type="text" inputMode="decimal" value={display}
                          onChange={ev => { setFocusedText(ev.target.value); setOverride(e.id, svc.id, ev.target.value); }}
                          onFocus={() => { setFocusedCell(cellKey); setFocusedText(cell.value ? String(cell.value) : ''); }}
                          onBlur={() => setFocusedCell(null)}
                          placeholder="0.00"
                          title={belowStandard ? `Below standard (${fmt(cell.calculatedValue)})` : undefined}
                          className={`w-full text-right text-xs font-mono border rounded px-1.5 py-1 focus:border-ocean-300 focus:outline-none ${cls}`}
                        />
                      </Tooltip>
                    </td>
                  );
                })}
                <td className="px-3 py-1.5 text-right font-mono text-ocean-600 bg-ocean-50">
                  <Tooltip text={`Sum across ${entities.length} entities`}>{fmt(serviceTotals[svc.id] || 0)}</Tooltip>
                </td>
              </tr>
            ))}

            <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
              <td className="px-3 py-2 text-gray-700 sticky left-0 bg-gray-50 z-10">Annual Total</td>
              {entities.map(e => (
                <td key={e.id} className="px-3 py-2 text-right font-mono text-gray-700">
                  <Tooltip text={`Sum of all services for ${e.name}`}>{fmt(entityTotals[e.id] || 0)}</Tooltip>
                </td>
              ))}
              <td className="px-3 py-2 text-right font-mono text-ocean-700 bg-ocean-50">{fmt(grandTotal)}</td>
            </tr>

            <tr className="border-b border-gray-100">
              <td className="px-3 py-1.5 text-gray-500 sticky left-0 bg-white z-10">Discount (%)</td>
              {entities.map(e => (
                <td key={e.id} className="px-1 py-0.5">
                  <input type="number" value={discounts[e.id] || ''} onChange={ev => setDiscounts(prev => ({ ...prev, [e.id]: parseFloat(ev.target.value) || 0 }))}
                    placeholder="0" min="0" max="100" className="w-full text-right text-xs font-mono border border-gray-200 rounded px-1.5 py-1" />
                </td>
              ))}
              <td className="px-3 py-1.5 text-right text-gray-400 bg-ocean-50">&mdash;</td>
            </tr>

            <tr className="bg-gray-50 font-semibold">
              <td className="px-3 py-2 text-gray-700 sticky left-0 bg-gray-50 z-10">After Discount</td>
              {entities.map(e => <td key={e.id} className="px-3 py-2 text-right font-mono text-gray-700">{fmt(afterDiscountTotals[e.id] || 0)}</td>)}
              <td className="px-3 py-2 text-right font-mono text-ocean-700 bg-ocean-50">{fmt(grandAfterDiscount)}</td>
            </tr>

            <tr><td colSpan={entities.length + 2} className="h-2 bg-gray-100"></td></tr>

            {['net', 'vat', 'gross'].map(type => (
              <tr key={type} className={type === 'gross' ? 'bg-ocean-50 font-semibold' : 'border-b border-gray-50'}>
                <td className={`px-3 py-1.5 sticky left-0 z-10 ${type === 'gross' ? 'text-ocean-700 bg-ocean-50' : 'text-gray-500 bg-white'}`}>
                  {type === 'net' ? 'Monthly Net' : type === 'vat' ? 'Monthly VAT' : 'Monthly Gross (Direct Debit)'}
                </td>
                {entities.map(e => {
                  const m = monthlyCalc(afterDiscountTotals[e.id] || 0);
                  return <td key={e.id} className={`px-3 py-1.5 text-right font-mono ${type === 'gross' ? 'text-ocean-700' : type === 'vat' ? 'text-gray-400' : 'text-gray-600'}`}>
                    <Tooltip text={`${fmt(afterDiscountTotals[e.id] || 0)} / 12${type === 'vat' ? ' \u00D7 20%' : type === 'gross' ? ' \u00D7 1.2' : ''}`}>{fmt(m[type])}</Tooltip>
                  </td>;
                })}
                <td className={`px-3 py-1.5 text-right font-mono bg-ocean-50 ${type === 'gross' ? 'text-ocean-800 font-bold' : type === 'vat' ? 'text-gray-500' : 'text-ocean-600'}`}>
                  {fmt(grandMonthly[type])}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Grand summary */}
      <div className="bg-ocean-50 rounded-lg border border-ocean-200 p-4 flex items-center justify-between">
        <div>
          <p className="text-xs text-ocean-600">Grand Total ({entities.length} entities)</p>
          <p className="text-lg font-bold text-ocean-700 font-mono">{fmt(grandMonthly.gross)}<span className="text-sm font-normal text-ocean-500">/mo</span></p>
        </div>
        <div className="text-right">
          <p className="text-xs text-ocean-500">Annual: {fmt(grandAfterDiscount)}</p>
          <Btn onClick={handleSave} disabled={saving} className="mt-1">{saving ? 'Saving...' : 'Save Quotes'}</Btn>
        </div>
      </div>
    </div>
  );
}
