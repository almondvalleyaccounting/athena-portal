import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { Btn, fmt } from '../components/ui';
import AlphabetFilter, { firstCharBucket } from '../components/AlphabetFilter';
import DataTable from '../components/DataTable';
import { fetchAllRows } from '../lib/fetchAllRows';

const statusPillClass = (status) => (
  status === 'draft' ? 'bg-gray-100 text-gray-600' :
  status === 'pending_approval' ? 'bg-amber-50 text-amber-700' :
  status === 'approved' ? 'bg-blue-50 text-blue-700' :
  status === 'sent' ? 'bg-purple-50 text-purple-700' :
  status === 'accepted' ? 'bg-green-50 text-green-700' :
  status === 'committed' ? 'bg-teal-50 text-teal-700' :
  status === 'declined' ? 'bg-red-50 text-red-600' :
  status === 'expired' ? 'bg-gray-50 text-gray-400' :
  'bg-gray-100 text-gray-600'
);

const statusPillLabel = (status) => (
  status === 'pending_approval' ? 'Pending' : status === 'sent' ? 'Sent' : status === 'declined' ? 'Rejected' : status === 'accepted' ? 'Accepted' : status === 'committed' ? 'Committed' : status.charAt(0).toUpperCase() + status.slice(1)
);

const PIPELINE_STATUSES = ['draft', 'pending_approval', 'approved', 'sent', 'accepted'];

export default function EntitiesPage() {
  const navigate = useNavigate();
  const [entities, setEntities] = useState([]);
  const [search, setSearch] = useState('');
  const [letter, setLetter] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [acting, setActing] = useState(false);
  const [groups, setGroups] = useState([]);
  const [showGroupPicker, setShowGroupPicker] = useState(false);

  useEffect(() => {
    supabase.from('billing_groups').select('*').order('name')
      .then(({ data }) => setGroups(data || []));
  }, []);

  const [membershipMap, setMembershipMap] = useState({});

  const loadEntities = async () => {
    try {
      // Paged past PostgREST's silent 1000-row cap; id breaks name ties so
      // pages are stable.
      const ents = await fetchAllRows(() => supabase
        .from('entities')
        .select('*')
        .order('name')
        .order('id', { ascending: true }));

      if (ents?.length) {
        // Quotes and group memberships are read whole and matched to clients
        // here, rather than with .in(~600 ids): that URL is too long, and the
        // response would be cut at 1000 rows without saying so. A failed list
        // comes back empty, as a failed query did before.
        const all = (label, build) => fetchAllRows(build).catch((err) => {
          console.error(`Loading ${label} failed`, err);
          return [];
        });
        const [quotes, members] = await Promise.all([
          all('quotes', () => supabase
            .from('quotes')
            .select('entity_id, status, monthly_gross, monthly_net, annual_total, quote_ref, created_at')
            .neq('status', 'deleted') // soft-deleted quotes must not surface as a "Deleted" pill on the client row
            .order('created_at', { ascending: false })
            .order('id', { ascending: true })),
          all('billing group members', () => supabase
            .from('billing_group_members')
            .select('entity_id, group_id, group:billing_groups(id, name)')
            .order('entity_id', { ascending: true })
            .order('group_id', { ascending: true })),
        ]);

        const entityIds = new Set(ents.map(e => e.id));
        const mMap = {};
        members.forEach(m => {
          if (m.group && entityIds.has(m.entity_id)) mMap[m.entity_id] = { groupId: m.group.id, groupName: m.group.name };
        });
        setMembershipMap(mMap);

        // Newest first within each client, as the query returned them.
        const quotesByEntity = {};
        quotes.forEach(q => { (quotesByEntity[q.entity_id] ||= []).push(q); });

        const enriched = ents.map(e => {
          const entityQuotes = quotesByEntity[e.id] || [];
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
    } catch (err) { console.error('Loading clients failed', err); }
    setLoading(false);
  };

  useEffect(() => { loadEntities(); }, []);

  // Former (NLAC) and archived records aren't quotable clients; the Clients
  // page hides them the same way.
  const filtered = entities.filter((e) => {
    if (e.entity_status === 'nlac' || e.entity_status === 'archived') return false;
    if (letter && firstCharBucket(e.name) !== letter) return false;
    if (!search) return true;
    return e.name?.toLowerCase().includes(search.toLowerCase()) || e.company_number?.includes(search);
  });

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


  // Columns shared by both sections. The name opens the client record (a
  // real link, so Ctrl-click opens a new tab); in Select mode it is plain
  // text and a row click ticks the row, as before.
  const openClient = (ev, id) => {
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button !== 0) return;
    ev.preventDefault();
    navigate('/clients/' + id);
  };

  const columns = [
    {
      key: 'name', label: 'Client',
      sortValue: (e) => (e.name || '').toLowerCase(),
      render: (e) => (
        <div className="min-w-0">
          {selectMode ? (
            <p className="text-sm font-medium text-gray-700 truncate">{e.name}</p>
          ) : (
            <a
              href={'/clients/' + e.id}
              onClick={(ev) => openClient(ev, e.id)}
              className="block text-sm font-medium text-gray-700 hover:text-ocean-600 truncate"
            >
              {e.name}
            </a>
          )}
          <p className="text-xs text-gray-400 truncate">
            {e.type?.replace('_', ' ')}{e.company_number ? ` \u00B7 ${e.company_number}` : ''}
            {e.entity_status && e.entity_status !== 'prospect' && ` \u00B7 ${e.entity_status}`}
          </p>
        </div>
      ),
    },
    {
      key: 'pipelineTotal', label: 'Pipeline', width: 130, align: 'right', firstDir: 'desc',
      sortValue: (e) => (e.pipelineTotal > 0 ? e.pipelineTotal : null),
      render: (e) => (e.pipelineTotal > 0 ? (
        <span className="text-xs font-mono text-ocean-600 bg-ocean-50 border border-ocean-200 rounded px-2 py-0.5">
          {fmt(e.pipelineTotal)}/yr
        </span>
      ) : null),
    },
    {
      key: 'group', label: 'Group', width: 150,
      sortValue: (e) => membershipMap[e.id]?.groupName?.toLowerCase() ?? null,
      render: (e) => (membershipMap[e.id] ? (
        <button
          onClick={(ev) => { ev.stopPropagation(); navigate('/manage/quotes/group/' + membershipMap[e.id].groupId); }}
          className="text-[11px] bg-ocean-50 text-ocean-600 border border-ocean-200 rounded px-1.5 py-0.5 hover:bg-ocean-100 truncate max-w-full"
          title={membershipMap[e.id].groupName}
        >
          {membershipMap[e.id].groupName}
        </button>
      ) : null),
    },
    {
      key: 'quotes', label: 'Quotes', width: 260, wrap: true, firstDir: 'desc',
      sortValue: (e) => e.entityQuotes?.length || null,
      render: (e) => (e.statusCounts && Object.keys(e.statusCounts).length > 0 ? (
        <div className="flex items-center gap-1 flex-wrap">
          {Object.entries(e.statusCounts).map(([status, count]) => (
            <button
              key={status}
              onClick={(ev) => { ev.stopPropagation(); navigate(`/manage/quotes?client=${encodeURIComponent(e.name)}&status=${status}`); }}
              className={`text-[11px] rounded px-1.5 py-0.5 font-medium hover:opacity-80 ${statusPillClass(status)}`}
            >
              {count} {statusPillLabel(status)}
            </button>
          ))}
        </div>
      ) : (
        <span className="text-xs text-gray-300">No quotes</span>
      )),
    },
    {
      key: 'actions', label: '', width: 100, align: 'right', sortable: false,
      render: (e) => (!selectMode ? (
        <Btn onClick={() => navigate('/manage/quotes/new?entity=' + e.id)} variant="secondary" className="text-xs py-1 px-3">
          Quote
        </Btn>
      ) : null),
    },
  ];

  // One table per section; both share the one set of ticked clients.
  const sectionTable = (rows) => (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(e) => e.id}
      onRowClick={selectMode ? (e) => toggleSelect(e.id) : undefined}
      selection={selectMode ? { selected, onChange: setSelected } : undefined}
    />
  );

  return (
    <div className="p-6">
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
        className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 mb-2"
      />

      <div className="mb-3">
        <AlphabetFilter items={entities} selected={letter} onChange={setLetter} />
      </div>

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
              <h3 className="text-xs font-semibold text-ocean-700 mb-2">
                Clients with Pending Quotes ({withPending.length})
              </h3>
              {sectionTable(withPending)}
            </div>
          )}

          {/* All other clients */}
          {withoutPending.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">
                {withPending.length > 0 ? 'Other Clients' : 'All Clients'} ({withoutPending.length})
              </h3>
              {sectionTable(withoutPending)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
