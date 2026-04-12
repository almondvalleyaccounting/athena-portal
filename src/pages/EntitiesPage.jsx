import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { Btn, fmt } from '../components/ui';

const PIPELINE_STATUSES = ['draft', 'pending_approval', 'approved', 'sent', 'accepted'];

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
  const [deleting, setDeleting] = useState(null);

  useEffect(() => {
    supabase.from('billing_groups').select('*').order('name')
      .then(({ data }) => setGroups(data || []));
  }, []);

  const [membershipMap, setMembershipMap] = useState({});

  const loadEntities = async () => {
    try {
      const { data: ents } = await supabase
        .from('entities')
        .select('*')
        .order('name');

      if (ents?.length) {
        const [{ data: quotes }, { data: members }] = await Promise.all([
          supabase
            .from('quotes')
            .select('entity_id, status, monthly_gross, monthly_net, annual_total, quote_ref, created_at')
            .in('entity_id', ents.map(e => e.id))
            .order('created_at', { ascending: false }),
          supabase
            .from('billing_group_members')
            .select('entity_id, group_id, group:billing_groups(id, name)')
            .in('entity_id', ents.map(e => e.id)),
        ]);

        const mMap = {};
        (members || []).forEach(m => {
          if (m.group) mMap[m.entity_id] = { groupId: m.group.id, groupName: m.group.name };
        });
        setMembershipMap(mMap);

        const enriched = ents.map(e => {
          const entityQuotes = (quotes || []).filter(q => q.entity_id === e.id);
          const statusCounts = {};
          entityQuotes.forEach(q => {
            statusCounts[q.status] = (statusCounts[q.status] || 0) + 1;
          });
          // Pipeline total: sum of annual_total for all pipeline-status quotes
          const pipelineQuotes = entityQuotes.filter(q => PIPELINE_STATUSES.includes(q.status));
          const pipelineTotal = pipelineQuotes.reduce((s, q) => s + (parseFloat(q.annual_total) || 0), 0);
          const hasPendingQuotes = pipelineQuotes.length > 0;
          return { ...e, entityQuotes, statusCounts, pipelineTotal, hasPendingQuotes, pipelineCount: pipelineQuotes.length };
        });
        setEntities(enriched);
      } else {
        setEntities([]);
      }
    } catch {}
    setLoading(false);
  };

  useEffect(() => { loadEntities(); }, []);

  const filtered = entities.filter(
    (e) => !search || e.name?.toLowerCase().includes(search.toLowerCase()) || e.company_number?.includes(search)
  );

  // Split into pending (has pipeline quotes) and other
  const withPending = filtered.filter(e => e.hasPendingQuotes);
  const withoutPending = filtered.filter(e => !e.hasPendingQuotes);

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
        await supabase.from('quotes')
          .update({ group_id: group.id })
          .eq('entity_id', ent.id)
          .is('group_id', null);
      }
      navigate('/manage/quotes/group/' + group.id);
    } catch (e) { console.error(e); }
    setActing(false);
  };

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

  const handleQuoteAll = async () => {
    if (selected.size < 1) return;
    setActing(true);
    try {
      if (selected.size === 1) {
        navigate('/manage/quotes/new?entity=' + selectedEntities[0].id);
        return;
      }
      const groupName = selectedEntities.map(e => e.name).join(' + ');
      const { data: group } = await supabase
        .from('billing_groups')
        .insert({ name: groupName })
        .select().single();
      for (const ent of selectedEntities) {
        await supabase.from('billing_group_members')
          .upsert({ entity_id: ent.id, group_id: group.id });
      }
      navigate(`/manage/quotes/new?entity=${selectedEntities[0].id}&group=${group.id}`);
    } catch (e) { console.error(e); }
    setActing(false);
  };

  const handleDeleteClient = async (entityId, entityName) => {
    if (!confirm(`Delete client "${entityName}"? This will remove the client record. Quotes linked to this client will remain but lose their client link.`)) return;
    setDeleting(entityId);
    try {
      // Remove from billing group memberships
      await supabase.from('billing_group_members').delete().eq('entity_id', entityId);
      // Delete entity
      const { error } = await supabase.from('entities').delete().eq('id', entityId);
      if (error) throw error;
      await loadEntities();
    } catch (err) {
      alert('Failed to delete client: ' + (err.message || 'Unknown error'));
    }
    setDeleting(null);
  };

  const renderClientRow = (e) => (
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
        <div className="min-w-0" onClick={(ev) => { if (!selectMode) { ev.stopPropagation(); navigate('/manage/clients/' + e.id); } }}>
          <p className={`text-sm font-medium text-gray-700 ${!selectMode ? 'hover:text-ocean-600 cursor-pointer' : ''}`}>{e.name}</p>
          <p className="text-xs text-gray-400">
            {e.type?.replace('_', ' ')}{e.company_number ? ` \u00B7 ${e.company_number}` : ''}
            {e.status && e.status !== 'prospect' && ` \u00B7 ${e.status}`}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {/* Pipeline total */}
        {e.pipelineTotal > 0 && (
          <span className="text-xs font-mono text-ocean-600 bg-ocean-50 border border-ocean-200 rounded px-2 py-0.5">
            {fmt(e.pipelineTotal)}/yr
          </span>
        )}
        {membershipMap[e.id] && (
          <button
            onClick={(ev) => { ev.stopPropagation(); navigate('/manage/quotes/group/' + membershipMap[e.id].groupId); }}
            className="text-[10px] bg-ocean-50 text-ocean-600 border border-ocean-200 rounded px-1.5 py-0.5 hover:bg-ocean-100 truncate max-w-[120px]"
            title={membershipMap[e.id].groupName}
          >
            {membershipMap[e.id].groupName}
          </button>
        )}
        {e.statusCounts && Object.keys(e.statusCounts).length > 0 ? (
          <div className="flex items-center gap-1 flex-wrap">
            {Object.entries(e.statusCounts).map(([status, count]) => (
              <button
                key={status}
                onClick={(ev) => { ev.stopPropagation(); navigate(`/manage/quotes?client=${encodeURIComponent(e.name)}&status=${status}`); }}
                className={`text-[10px] rounded px-1.5 py-0.5 font-medium hover:opacity-80 ${
                  status === 'draft' ? 'bg-gray-100 text-gray-600' :
                  status === 'pending_approval' ? 'bg-amber-50 text-amber-700' :
                  status === 'approved' ? 'bg-blue-50 text-blue-700' :
                  status === 'sent' ? 'bg-purple-50 text-purple-700' :
                  status === 'accepted' ? 'bg-green-50 text-green-700' :
                  status === 'committed' ? 'bg-teal-50 text-teal-700' :
                  status === 'declined' ? 'bg-red-50 text-red-600' :
                  status === 'expired' ? 'bg-gray-50 text-gray-400' :
                  'bg-gray-100 text-gray-600'
                }`}
              >
                {count} {status === 'pending_approval' ? 'Pending' : status === 'sent' ? 'Sent' : status === 'declined' ? 'Rejected' : status === 'accepted' ? 'Accepted' : status === 'committed' ? 'Committed' : status.charAt(0).toUpperCase() + status.slice(1)}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-xs text-gray-300">No quotes</span>
        )}
        {!selectMode && (
          <div className="flex gap-1">
            <Btn onClick={() => navigate('/manage/quotes/new?entity=' + e.id)} variant="secondary" className="text-xs py-1 px-3">
              Quote
            </Btn>
            <button
              onClick={(ev) => { ev.stopPropagation(); handleDeleteClient(e.id, e.name); }}
              disabled={deleting === e.id}
              className="text-xs text-gray-400 hover:text-red-600 px-1.5 py-1 rounded hover:bg-red-50 transition-colors"
              title="Delete client"
            >
              {deleting === e.id ? '...' : '\u2715'}
            </button>
          </div>
        )}
      </div>
    </div>
  );

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
        <div className="space-y-4">
          {/* Clients with pending quotes */}
          {withPending.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-ocean-700 uppercase tracking-wide mb-2">
                Clients with Pending Quotes ({withPending.length})
              </h3>
              <div className="bg-white rounded-lg border-2 border-ocean-200 overflow-hidden">
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
                {withPending.map(renderClientRow)}
              </div>
            </div>
          )}

          {/* All other clients */}
          {withoutPending.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                {withPending.length > 0 ? 'Other Clients' : 'All Clients'} ({withoutPending.length})
              </h3>
              <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                {selectMode && !withPending.length && (
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
                {withoutPending.map(renderClientRow)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
