import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { Btn, fmt, StatusBadge } from '../components/ui';

export default function EntitiesPage() {
  const navigate = useNavigate();
  const [entities, setEntities] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [acting, setActing] = useState(false);
  const [groups, setGroups] = useState([]);
  const [showGroupPicker, setShowGroupPicker] = useState(false);

  // Load billing groups for "Add to Group"
  useEffect(() => {
    supabase.from('billing_groups').select('*').order('name')
      .then(({ data }) => setGroups(data || []));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const { data: ents } = await supabase
          .from('entities')
          .select('*')
          .order('name');

        if (ents?.length) {
          const { data: quotes } = await supabase
            .from('quotes')
            .select('entity_id, status, monthly_gross, quote_ref, created_at')
            .in('entity_id', ents.map(e => e.id))
            .order('created_at', { ascending: false });

          const enriched = ents.map(e => {
            const latestQuote = quotes?.find(q => q.entity_id === e.id);
            return { ...e, latestQuote };
          });
          setEntities(enriched);
        } else {
          setEntities([]);
        }
      } catch {}
      setLoading(false);
    })();
  }, []);

  const filtered = entities.filter(
    (e) => !search || e.name?.toLowerCase().includes(search.toLowerCase()) || e.company_number?.includes(search)
  );

  const toggleSelect = (id, e) => {
    if (e) e.stopPropagation();
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map(e => e.id)));
  };

  const exitSelectMode = () => { setSelectMode(false); setSelected(new Set()); };

  const selectedEntities = entities.filter(e => selected.has(e.id));

  // Batch: create billing group from selected clients
  const handleCreateGroup = async () => {
    if (selected.size < 2) return;
    setActing(true);
    try {
      const groupName = selectedEntities.map(e => e.name).join(' + ');
      const { data: group } = await supabase
        .from('billing_groups')
        .insert({ name: groupName })
        .select().single();

      for (const ent of selectedEntities) {
        await supabase.from('billing_group_members')
          .upsert({ entity_id: ent.id, group_id: group.id });

        // Link any existing quotes for these entities to the group
        await supabase.from('quotes')
          .update({ group_id: group.id })
          .eq('entity_id', ent.id)
          .is('group_id', null);
      }

      navigate('/manage/quotes/group/' + group.id);
    } catch (e) { console.error(e); }
    setActing(false);
  };

  // Batch: add selected clients to an existing group
  const handleAddToGroup = async (groupId) => {
    setActing(true);
    setShowGroupPicker(false);
    try {
      for (const ent of selectedEntities) {
        await supabase.from('billing_group_members')
          .upsert({ entity_id: ent.id, group_id: groupId });
        await supabase.from('quotes')
          .update({ group_id: groupId })
          .eq('entity_id', ent.id)
          .is('group_id', null);
      }
      navigate('/manage/quotes/group/' + groupId);
    } catch (e) { console.error(e); }
    setActing(false);
  };

  // Batch: quote all selected clients together (new group + redirect to first quote)
  const handleQuoteAll = async () => {
    if (selected.size < 1) return;
    setActing(true);
    try {
      if (selected.size === 1) {
        // Single client — just quote them
        navigate('/manage/quotes/new?entity=' + selectedEntities[0].id);
        return;
      }

      // Multiple clients — create group, then redirect to quote first entity with group linked
      const groupName = selectedEntities.map(e => e.name).join(' + ');
      const { data: group } = await supabase
        .from('billing_groups')
        .insert({ name: groupName })
        .select().single();

      for (const ent of selectedEntities) {
        await supabase.from('billing_group_members')
          .upsert({ entity_id: ent.id, group_id: group.id });
      }

      // Navigate to quote the first entity, with group linked
      navigate(`/manage/quotes/new?entity=${selectedEntities[0].id}&group=${group.id}`);
    } catch (e) { console.error(e); }
    setActing(false);
  };

  return (
    <div className="p-6 max-w-3xl">
      {/* Header */}
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-bold text-ocean-700">Clients</h2>
        <div className="flex gap-2">
          {!selectMode ? (
            <>
              {entities.length > 0 && <Btn onClick={() => setSelectMode(true)} variant="ghost">Select</Btn>}
              <Btn onClick={() => navigate('/manage/quotes/new')}>New Quote</Btn>
            </>
          ) : (
            <Btn onClick={exitSelectMode} variant="ghost">Cancel</Btn>
          )}
        </div>
      </div>

      {/* Batch action bar */}
      {selectMode && selected.size > 0 && (
        <div className="flex items-center gap-2 mb-3 bg-ocean-50 rounded-lg p-2 border border-ocean-200">
          <span className="text-xs text-ocean-700 font-medium">{selected.size} selected</span>
          <span className="text-ocean-300">|</span>
          {selected.size >= 2 && (
            <Btn onClick={handleCreateGroup} disabled={acting} variant="secondary" className="text-xs py-1 px-2">
              Create Group
            </Btn>
          )}
          <div className="relative">
            <Btn onClick={() => setShowGroupPicker(!showGroupPicker)} disabled={acting || groups.length === 0} variant="secondary" className="text-xs py-1 px-2">
              Add to Group
            </Btn>
            {showGroupPicker && groups.length > 0 && (
              <div className="absolute z-20 top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg min-w-[180px]">
                {groups.map(g => (
                  <button key={g.id} onClick={() => handleAddToGroup(g.id)} className="w-full text-left px-3 py-2 text-xs hover:bg-gray-50 border-b border-gray-50 last:border-0">
                    {g.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <Btn onClick={handleQuoteAll} disabled={acting} variant="primary" className="text-xs py-1 px-2">
            {selected.size === 1 ? 'Quote' : `Quote All (${selected.size})`}
          </Btn>
        </div>
      )}

      {/* Search */}
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by name or company number..."
        className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 mb-4"
      />

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-6 text-center">
          <p className="text-sm text-gray-400 mb-1">
            {entities.length === 0
              ? 'No clients yet. Clients are created automatically when you build a quote.'
              : 'No matches.'}
          </p>
          {entities.length === 0 && (
            <p className="text-xs text-gray-300 mb-3">Create your first quote and the client will appear here.</p>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          {/* Header row in select mode */}
          {selectMode && (
            <div className="flex items-center px-4 py-2 border-b border-gray-200 bg-gray-50">
              <input
                type="checkbox"
                checked={selected.size === filtered.length && filtered.length > 0}
                onChange={selectAll}
                className="w-3 h-3 accent-ocean-600 mr-3"
              />
              <span className="text-xs text-gray-400">Select all</span>
            </div>
          )}
          {filtered.map((e) => (
            <div
              key={e.id}
              onClick={() => selectMode ? toggleSelect(e.id) : null}
              className={`flex items-center justify-between px-4 py-3 border-b border-gray-50 last:border-0 transition-all ${
                selected.has(e.id) ? 'bg-ocean-50' : 'hover:bg-gray-50'
              } ${selectMode ? 'cursor-pointer' : ''}`}
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                {selectMode && (
                  <input
                    type="checkbox"
                    checked={selected.has(e.id)}
                    onChange={(ev) => toggleSelect(e.id, ev)}
                    onClick={(ev) => ev.stopPropagation()}
                    className="w-3 h-3 accent-ocean-600 shrink-0"
                  />
                )}
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-700">{e.name}</p>
                  <p className="text-xs text-gray-400">
                    {e.type?.replace('_', ' ')}{e.company_number ? ` \u00B7 ${e.company_number}` : ''}
                    {e.status && e.status !== 'prospect' && ` \u00B7 ${e.status}`}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {e.latestQuote ? (
                  <>
                    <span className="text-xs font-mono text-ocean-600">{fmt(e.latestQuote.monthly_gross)}/mo</span>
                    <StatusBadge status={e.latestQuote.status} />
                  </>
                ) : (
                  <span className="text-xs text-gray-300">No quotes</span>
                )}
                {!selectMode && (
                  <Btn onClick={() => navigate('/manage/quotes/new?entity=' + e.id)} variant="secondary" className="text-xs py-1 px-3">
                    Quote
                  </Btn>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
