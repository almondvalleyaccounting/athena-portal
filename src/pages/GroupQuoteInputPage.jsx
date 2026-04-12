import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { fmt, Btn } from '../components/ui';

// Service rows for the cross-tab grid
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

export default function GroupQuoteInputPage({ defaults, profile }) {
  const { groupId } = useParams();
  const navigate = useNavigate();

  const [group, setGroup] = useState(null);
  const [entities, setEntities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Grid data: { [entityId]: { [serviceId]: number } }
  const [grid, setGrid] = useState({});
  // Discount per entity: { [entityId]: number }
  const [discounts, setDiscounts] = useState({});

  useEffect(() => { loadGroupData(); }, [groupId]);

  const loadGroupData = async () => {
    setLoading(true);
    try {
      const [{ data: bg }, { data: bgm }] = await Promise.all([
        supabase.from('billing_groups').select('*').eq('id', groupId).single(),
        supabase.from('billing_group_members').select('entity_id').eq('group_id', groupId),
      ]);
      setGroup(bg);

      if (bgm && bgm.length > 0) {
        const entityIds = bgm.map(m => m.entity_id);
        const { data: ents } = await supabase
          .from('entities')
          .select('id, name, company_number')
          .in('id', entityIds);
        setEntities(ents || []);

        // Initialize grid with zeros
        const initialGrid = {};
        const initialDiscounts = {};
        (ents || []).forEach(e => {
          initialGrid[e.id] = {};
          SERVICE_ROWS.forEach(s => { initialGrid[e.id][s.id] = 0; });
          initialDiscounts[e.id] = 0;
        });
        setGrid(initialGrid);
        setDiscounts(initialDiscounts);
      }
    } catch {}
    setLoading(false);
  };

  const handleCellChange = (entityId, serviceId, value) => {
    setGrid(prev => ({
      ...prev,
      [entityId]: {
        ...prev[entityId],
        [serviceId]: parseFloat(value) || 0,
      },
    }));
  };

  const handleDiscountChange = (entityId, value) => {
    setDiscounts(prev => ({ ...prev, [entityId]: parseFloat(value) || 0 }));
  };

  // Computed totals
  const entityTotals = useMemo(() => {
    const totals = {};
    entities.forEach(e => {
      const sum = SERVICE_ROWS.reduce((s, svc) => s + (grid[e.id]?.[svc.id] || 0), 0);
      totals[e.id] = sum;
    });
    return totals;
  }, [grid, entities]);

  const serviceTotals = useMemo(() => {
    const totals = {};
    SERVICE_ROWS.forEach(svc => {
      const sum = entities.reduce((s, e) => s + (grid[e.id]?.[svc.id] || 0), 0);
      totals[svc.id] = sum;
    });
    return totals;
  }, [grid, entities]);

  const grandTotal = useMemo(() => {
    return entities.reduce((s, e) => s + (entityTotals[e.id] || 0), 0);
  }, [entityTotals, entities]);

  // After discount totals
  const afterDiscountTotals = useMemo(() => {
    const totals = {};
    entities.forEach(e => {
      const disc = discounts[e.id] || 0;
      totals[e.id] = (entityTotals[e.id] || 0) * (1 - disc / 100);
    });
    return totals;
  }, [entityTotals, discounts, entities]);

  const grandAfterDiscount = useMemo(() => {
    return entities.reduce((s, e) => s + (afterDiscountTotals[e.id] || 0), 0);
  }, [afterDiscountTotals, entities]);

  // Monthly calculations
  const monthlyCalc = (annual) => {
    const net = Math.round((annual / 12) * 100) / 100;
    const vat = Math.round(net * 0.2 * 100) / 100;
    const gross = Math.round((net + vat) * 100) / 100;
    return { net, vat, gross };
  };

  // Save: create individual quotes for each entity
  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      for (const entity of entities) {
        const disc = discounts[entity.id] || 0;
        const annualBeforeDisc = entityTotals[entity.id] || 0;
        const annualTotal = afterDiscountTotals[entity.id] || 0;

        if (annualTotal <= 0) continue; // skip entities with no amounts

        const m = monthlyCalc(annualTotal);
        const nameSlug = (entity.name || 'Entity').replace(/[^a-zA-Z0-9]/g, '');
        const dateSlug = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const prefix = `${nameSlug}_${dateSlug}`;

        const { data: existing } = await supabase
          .from('quotes').select('quote_ref').like('quote_ref', `${prefix}%`);
        const nums = (existing || []).map(q => parseInt(q.quote_ref.split('_').pop()) || 0);
        const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
        const quoteRef = `${prefix}_${String(next).padStart(3, '0')}`;

        const validUntil = new Date();
        validUntil.setDate(validUntil.getDate() + 30);

        const { data: quote, error: qErr } = await supabase.from('quotes').insert({
          quote_ref: quoteRef,
          entity_id: entity.id,
          group_id: groupId,
          status: 'draft',
          relationship_group: entity.name,
          annual_total: Math.round(annualTotal * 100) / 100,
          annual_services: Math.round(annualBeforeDisc * 100) / 100,
          monthly_net: m.net,
          monthly_vat: m.vat,
          monthly_gross: m.gross,
          one_off_total: 0,
          defaults_version: defaults?.version || '0.3',
          valid_until: validUntil.toISOString().slice(0, 10),
          created_by: profile?.id,
        }).select().single();

        if (qErr) throw qErr;

        // Insert line items for non-zero services
        const lineItems = [];
        let sortOrder = 0;
        SERVICE_ROWS.forEach(svc => {
          const amount = grid[entity.id]?.[svc.id] || 0;
          if (amount > 0) {
            const discountedAmount = amount * (1 - disc / 100);
            lineItems.push({
              quote_id: quote.id,
              service_id: svc.id,
              description: svc.name,
              annual_amount: Math.round(discountedAmount * 100) / 100,
              monthly_amount: Math.round((discountedAmount / 12) * 100) / 100,
              detail: disc > 0 ? `${disc}% group discount applied` : '',
              is_recurring: true,
              sort_order: sortOrder++,
            });
          }
        });

        if (lineItems.length > 0) {
          const { error: liErr } = await supabase.from('quote_line_items').insert(lineItems);
          if (liErr) throw liErr;
        }

        // Audit log
        await supabase.from('audit_log').insert({
          user_id: profile?.id,
          action: 'created',
          entity_type: 'quote',
          entity_id: quote.id,
          detail: { source: 'group_quote_input', group_id: groupId, monthly_gross: m.gross },
        });
      }

      setSuccess('Quotes saved successfully!');
      setTimeout(() => navigate(`/manage/quotes/group/${groupId}`), 800);
    } catch (e) {
      setError(e.message || 'Failed to save quotes.');
    }
    setSaving(false);
  };

  if (loading) return <div className="p-6"><p className="text-sm text-gray-400">Loading group...</p></div>;
  if (!group) return <div className="p-6"><p className="text-sm text-red-500">Group not found.</p></div>;
  if (entities.length === 0) return (
    <div className="p-6">
      <p className="text-sm text-gray-500">No entities in this group. Add members first.</p>
      <Btn onClick={() => navigate(`/manage/quotes/group/${groupId}`)} variant="secondary" className="mt-2">
        Back to Group
      </Btn>
    </div>
  );

  const grandMonthly = monthlyCalc(grandAfterDiscount);

  return (
    <div className="p-6">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h2 className="text-lg font-bold text-ocean-700">Group Quote Builder</h2>
          <p className="text-xs text-gray-400">{group.name} &middot; {entities.length} entities</p>
        </div>
        <div className="flex gap-2">
          <Btn onClick={() => navigate(`/manage/quotes/group/${groupId}`)} variant="ghost">Back</Btn>
          <Btn onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save Quotes'}
          </Btn>
        </div>
      </div>

      {error && <div className="text-xs text-red-600 bg-red-50 rounded p-2 mb-3">{error}</div>}
      {success && <div className="text-xs text-green-600 bg-green-50 rounded p-2 mb-3">{success}</div>}

      {/* Cross-tab spreadsheet */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto mb-4">
        <table className="w-full text-xs border-collapse min-w-[600px]">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left px-3 py-2 text-gray-500 font-medium sticky left-0 bg-gray-50 z-10 min-w-[180px]">
                Service
              </th>
              {entities.map(e => (
                <th key={e.id} className="text-right px-3 py-2 text-gray-500 font-medium min-w-[120px]">
                  {e.name}
                </th>
              ))}
              <th className="text-right px-3 py-2 text-ocean-600 font-semibold min-w-[100px] bg-ocean-50">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {/* Service rows */}
            {SERVICE_ROWS.map(svc => (
              <tr key={svc.id} className="border-b border-gray-50 hover:bg-gray-50">
                <td className="px-3 py-1.5 text-gray-700 font-medium sticky left-0 bg-white z-10">
                  {svc.name}
                </td>
                {entities.map(e => (
                  <td key={e.id} className="px-2 py-1">
                    <input
                      type="number"
                      value={grid[e.id]?.[svc.id] || ''}
                      onChange={ev => handleCellChange(e.id, svc.id, ev.target.value)}
                      placeholder="0"
                      min="0"
                      step="any"
                      className="w-full text-right text-xs font-mono border border-gray-200 rounded px-1.5 py-1 bg-white focus:border-ocean-300 focus:outline-none"
                    />
                  </td>
                ))}
                <td className="px-3 py-1.5 text-right font-mono text-ocean-600 bg-ocean-50">
                  {fmt(serviceTotals[svc.id] || 0)}
                </td>
              </tr>
            ))}

            {/* Annual totals row */}
            <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
              <td className="px-3 py-2 text-gray-700 sticky left-0 bg-gray-50 z-10">
                Annual Total
              </td>
              {entities.map(e => (
                <td key={e.id} className="px-3 py-2 text-right font-mono text-gray-700">
                  {fmt(entityTotals[e.id] || 0)}
                </td>
              ))}
              <td className="px-3 py-2 text-right font-mono text-ocean-700 bg-ocean-50">
                {fmt(grandTotal)}
              </td>
            </tr>

            {/* Discount row */}
            <tr className="border-b border-gray-100">
              <td className="px-3 py-1.5 text-gray-500 sticky left-0 bg-white z-10">
                Discount %
              </td>
              {entities.map(e => (
                <td key={e.id} className="px-2 py-1">
                  <input
                    type="number"
                    value={discounts[e.id] || ''}
                    onChange={ev => handleDiscountChange(e.id, ev.target.value)}
                    placeholder="0"
                    min="0"
                    max="100"
                    step="any"
                    className="w-full text-right text-xs font-mono border border-gray-200 rounded px-1.5 py-1 bg-white focus:border-ocean-300 focus:outline-none"
                  />
                </td>
              ))}
              <td className="px-3 py-1.5 text-right text-gray-400 bg-ocean-50">&mdash;</td>
            </tr>

            {/* After discount row */}
            <tr className="bg-gray-50 font-semibold">
              <td className="px-3 py-2 text-gray-700 sticky left-0 bg-gray-50 z-10">
                After Discount
              </td>
              {entities.map(e => (
                <td key={e.id} className="px-3 py-2 text-right font-mono text-gray-700">
                  {fmt(afterDiscountTotals[e.id] || 0)}
                </td>
              ))}
              <td className="px-3 py-2 text-right font-mono text-ocean-700 bg-ocean-50">
                {fmt(grandAfterDiscount)}
              </td>
            </tr>

            {/* Spacer */}
            <tr><td colSpan={entities.length + 2} className="h-2 bg-gray-100"></td></tr>

            {/* Monthly Net */}
            <tr className="border-b border-gray-50">
              <td className="px-3 py-1.5 text-gray-500 sticky left-0 bg-white z-10">Monthly Net</td>
              {entities.map(e => {
                const m = monthlyCalc(afterDiscountTotals[e.id] || 0);
                return <td key={e.id} className="px-3 py-1.5 text-right font-mono text-gray-600">{fmt(m.net)}</td>;
              })}
              <td className="px-3 py-1.5 text-right font-mono text-ocean-600 bg-ocean-50">{fmt(grandMonthly.net)}</td>
            </tr>

            {/* Monthly VAT */}
            <tr className="border-b border-gray-50">
              <td className="px-3 py-1.5 text-gray-500 sticky left-0 bg-white z-10">Monthly VAT</td>
              {entities.map(e => {
                const m = monthlyCalc(afterDiscountTotals[e.id] || 0);
                return <td key={e.id} className="px-3 py-1.5 text-right font-mono text-gray-400">{fmt(m.vat)}</td>;
              })}
              <td className="px-3 py-1.5 text-right font-mono text-gray-500 bg-ocean-50">{fmt(grandMonthly.vat)}</td>
            </tr>

            {/* Monthly Gross */}
            <tr className="bg-ocean-50 font-semibold">
              <td className="px-3 py-2 text-ocean-700 sticky left-0 bg-ocean-50 z-10">Monthly Gross (DD)</td>
              {entities.map(e => {
                const m = monthlyCalc(afterDiscountTotals[e.id] || 0);
                return <td key={e.id} className="px-3 py-2 text-right font-mono text-ocean-700">{fmt(m.gross)}</td>;
              })}
              <td className="px-3 py-2 text-right font-mono text-ocean-800 font-bold">{fmt(grandMonthly.gross)}</td>
            </tr>
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
          <Btn onClick={handleSave} disabled={saving} className="mt-1">
            {saving ? 'Saving...' : 'Save Quotes'}
          </Btn>
        </div>
      </div>
    </div>
  );
}
