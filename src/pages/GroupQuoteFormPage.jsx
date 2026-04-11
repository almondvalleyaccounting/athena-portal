import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { Btn, fmt } from '../components/ui';
import EntityQuoteTab from '../components/EntityQuoteTab';
import ConsolidationTable from '../components/ConsolidationTable';

export default function GroupQuoteFormPage({ defaults: D, profile, mode = 'new' }) {
  const navigate = useNavigate();
  const { id: quoteId } = useParams();

  const [groupName, setGroupName] = useState('');
  const [selectedEntities, setSelectedEntities] = useState([]);
  const [activeEntityId, setActiveEntityId] = useState(null);
  const [entityTotals, setEntityTotals] = useState({});
  const [discounts, setDiscounts] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(mode === 'edit');

  // Entity search state
  const [allEntities, setAllEntities] = useState([]);
  const [entitySearch, setEntitySearch] = useState('');

  // Load all entities for selector
  useEffect(() => {
    supabase.from('entities').select('*').order('name').then(({ data }) => setAllEntities(data || []));
  }, []);

  // Handle totals changes from entity tabs
  const handleTotalsChange = useCallback((entityId, totals) => {
    setEntityTotals(prev => ({ ...prev, [entityId]: totals }));
  }, []);

  const handleDiscountChange = (entityId, pct) => {
    setDiscounts(prev => ({ ...prev, [entityId]: pct }));
  };

  // Add entity to group
  const addEntity = (entity) => {
    if (selectedEntities.find(e => e.id === entity.id)) return;
    setSelectedEntities(prev => [...prev, entity]);
    if (!activeEntityId) setActiveEntityId(entity.id);
    setEntitySearch('');
  };

  // Remove entity from group
  const removeEntity = (entityId) => {
    setSelectedEntities(prev => prev.filter(e => e.id !== entityId));
    setEntityTotals(prev => { const n = { ...prev }; delete n[entityId]; return n; });
    setDiscounts(prev => { const n = { ...prev }; delete n[entityId]; return n; });
    if (activeEntityId === entityId) {
      const remaining = selectedEntities.filter(e => e.id !== entityId);
      setActiveEntityId(remaining.length > 0 ? remaining[0].id : null);
    }
  };

  // Filtered entity search results
  const searchResults = entitySearch.length >= 2
    ? allEntities.filter(e =>
        !selectedEntities.find(s => s.id === e.id) &&
        (e.name?.toLowerCase().includes(entitySearch.toLowerCase()) ||
         e.company_number?.includes(entitySearch))
      ).slice(0, 5)
    : [];

  // Compute group totals for save
  const computeGroupTotals = () => {
    let annualServices = 0, annualSoftware = 0, setupTotal = 0;
    selectedEntities.forEach(e => {
      const t = entityTotals[e.id] || {};
      const disc = discounts[e.id] || 0;
      const sub = (t.annualServices || 0) + (t.swAnnual || 0);
      annualServices += (t.annualServices || 0) * (1 - disc / 100);
      annualSoftware += (t.swAnnual || 0) * (1 - disc / 100);
      setupTotal += t.setupTotal || 0;
    });
    const annualTotal = annualServices + annualSoftware;
    const monthlyNet = Math.round((annualTotal / 12) * 100) / 100;
    const monthlyVat = Math.round(monthlyNet * 0.2 * 100) / 100;
    const monthlyGross = Math.round((monthlyNet + monthlyVat) * 100) / 100;
    return { annualServices, annualSoftware, annualTotal, monthlyNet, monthlyVat, monthlyGross, setupTotal };
  };

  // ── Save ──
  const handleSave = async () => {
    if (!groupName || selectedEntities.length === 0) {
      setError('Enter a group name and add at least one entity.');
      return;
    }
    setSaving(true);
    setError('');

    try {
      // 1. Create billing group
      const { data: group, error: grpErr } = await supabase
        .from('billing_groups')
        .insert({ name: groupName, created_by: profile.id })
        .select().single();
      if (grpErr) throw grpErr;

      // 2. Add billing group members
      await supabase.from('billing_group_members').insert(
        selectedEntities.map(e => ({ entity_id: e.id, group_id: group.id }))
      );

      // 3. Generate quote ref
      const nameSlug = (groupName || 'Group').replace(/[^a-zA-Z0-9]/g, '');
      const dateSlug = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const prefix = `${nameSlug}_${dateSlug}`;
      const { data: existing } = await supabase.from('quotes').select('quote_ref').like('quote_ref', `${prefix}%`);
      const nums = (existing || []).map(q => parseInt(q.quote_ref.split('_').pop()) || 0);
      const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
      const quoteRef = `${prefix}_${String(next).padStart(3, '0')}`;

      // 4. Insert consolidated quote
      const groupTotals = computeGroupTotals();
      const { data: savedQuotes, error: qErr } = await supabase
        .from('quotes')
        .insert({
          quote_ref: quoteRef,
          group_id: group.id,
          entity_id: null,
          status: 'draft',
          relationship_group: groupName,
          annual_services: Math.round(groupTotals.annualServices * 100) / 100,
          annual_software: Math.round(groupTotals.annualSoftware * 100) / 100,
          annual_total: Math.round(groupTotals.annualTotal * 100) / 100,
          monthly_net: groupTotals.monthlyNet,
          monthly_vat: groupTotals.monthlyVat,
          monthly_gross: groupTotals.monthlyGross,
          one_off_total: groupTotals.setupTotal,
          defaults_version: D.version,
          created_by: profile.id,
        })
        .select().single();
      if (qErr) throw qErr;

      // 5. Per entity: quote_entities + line items
      for (let idx = 0; idx < selectedEntities.length; idx++) {
        const entity = selectedEntities[idx];
        const t = entityTotals[entity.id] || {};
        const disc = discounts[entity.id] || 0;
        const annualBefore = (t.annualServices || 0) + (t.swAnnual || 0);
        const annualAfter = annualBefore * (1 - disc / 100);
        const entMonthlyGross = Math.round((annualAfter / 12) * 1.2 * 100) / 100;

        // Get the entity's quote data for details column
        const quoteData = t.buildQuoteData ? t.buildQuoteData() : { data: {}, setupLines: [] };

        const { data: qe, error: qeErr } = await supabase
          .from('quote_entities')
          .insert({
            quote_id: savedQuotes.id,
            entity_id: entity.id,
            discount_pct: disc,
            annual_before_discount: Math.round(annualBefore * 100) / 100,
            annual_after_discount: Math.round(annualAfter * 100) / 100,
            monthly_gross: entMonthlyGross,
            sort_order: idx,
            details: quoteData.data,
          })
          .select().single();
        if (qeErr) throw qeErr;

        // Line items with quote_entity_id
        const lineItems = t.buildLineItems ? t.buildLineItems(savedQuotes.id, quoteData.setupLines) : [];
        const itemsWithEntity = lineItems.map(item => ({ ...item, quote_entity_id: qe.id }));
        if (itemsWithEntity.length > 0) {
          const { error: liErr } = await supabase.from('quote_line_items').insert(itemsWithEntity);
          if (liErr) throw liErr;
        }
      }

      navigate('/manage/quotes/' + savedQuotes.id);
    } catch (e) {
      setError(e.message || 'Save failed');
    }
    setSaving(false);
  };

  if (loading) return <div className="p-6"><p className="text-sm text-gray-400">Loading group quote...</p></div>;

  return (
    <div className="p-6">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h2 className="text-lg font-bold text-ocean-700">{mode === 'edit' ? 'Edit Group Quote' : 'New Group Quote'}</h2>
          <p className="text-xs text-gray-400">{selectedEntities.length} entities in group</p>
        </div>
        <Btn onClick={() => navigate(-1)} variant="ghost">Cancel</Btn>
      </div>

      {error && <div className="text-xs text-red-600 bg-red-50 rounded p-2 mb-3">{error}</div>}

      {/* Panel 1: Group Header */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
        <input
          value={groupName}
          onChange={e => setGroupName(e.target.value)}
          placeholder="Group name (e.g. Clarkson Group)"
          className="text-sm font-medium border border-gray-200 rounded-lg px-3 py-2 w-full mb-3"
        />

        {/* Entity selector */}
        <div className="relative">
          <input
            value={entitySearch}
            onChange={e => setEntitySearch(e.target.value)}
            placeholder="Search entities to add..."
            className="text-xs border border-gray-200 rounded px-2 py-1.5 w-full"
          />
          {searchResults.length > 0 && (
            <div className="absolute z-10 top-full left-0 right-0 bg-white border border-gray-200 rounded-b shadow-lg">
              {searchResults.map(e => (
                <button key={e.id} onClick={() => addEntity(e)} className="w-full text-left px-3 py-2 text-xs hover:bg-gray-50 border-b border-gray-50">
                  {e.name} {e.company_number ? `(${e.company_number})` : ''}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Selected entity chips */}
        {selectedEntities.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {selectedEntities.map(e => (
              <span key={e.id} className="inline-flex items-center gap-1 text-xs bg-ocean-50 text-ocean-700 px-2 py-1 rounded-full">
                {e.name}
                <button onClick={() => removeEntity(e.id)} className="text-ocean-400 hover:text-red-500">\u00D7</button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Panel 2: Entity Tabs */}
      {selectedEntities.length > 0 && (
        <div className="mb-4">
          {/* Tab bar */}
          <div className="flex gap-1 mb-3 border-b border-gray-200 pb-1">
            {selectedEntities.map(e => (
              <button
                key={e.id}
                onClick={() => setActiveEntityId(e.id)}
                className={`text-xs px-4 py-2 rounded-t-lg border border-b-0 transition-all ${
                  activeEntityId === e.id
                    ? 'bg-white text-ocean-700 font-medium border-gray-200'
                    : 'bg-gray-50 text-gray-500 border-transparent hover:text-gray-700'
                }`}
              >
                {e.name}
              </button>
            ))}
          </div>

          {/* Entity forms — all mounted, only active visible */}
          <div className="max-w-2xl">
            {selectedEntities.map(e => (
              <div key={e.id} style={{ display: activeEntityId === e.id ? 'block' : 'none' }}>
                <EntityQuoteTab
                  defaults={D}
                  entity={e}
                  onTotalsChange={handleTotalsChange}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Panel 3: Consolidation Table (sticky) */}
      {selectedEntities.length > 0 && (
        <div className="sticky bottom-0 bg-gray-50 pt-3 pb-3 -mx-6 px-6 border-t border-gray-200">
          <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Group Summary</h3>
          <ConsolidationTable
            entities={selectedEntities}
            entityTotals={entityTotals}
            discounts={discounts}
            onDiscountChange={handleDiscountChange}
          />

          {/* Save */}
          <div className="flex gap-2 mt-3">
            <Btn onClick={handleSave} disabled={saving || !groupName || selectedEntities.length === 0} className="flex-1">
              {saving ? 'Saving...' : mode === 'edit' ? 'Update Group Quote' : 'Save Group Quote'}
            </Btn>
            <Btn onClick={() => navigate(-1)} variant="secondary">Cancel</Btn>
          </div>
        </div>
      )}
    </div>
  );
}
