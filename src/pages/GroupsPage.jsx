import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { fmt, StatusBadge, Btn } from '../components/ui';
import { useAuth } from '../shell/AppShell';

const STATUS_ORDER = ['draft', 'pending_approval', 'approved', 'sent', 'accepted', 'declined', 'expired'];

function worstStatus(quotes) {
  if (!quotes.length) return 'draft';
  const statuses = quotes.map(q => q.status);
  for (const s of STATUS_ORDER) {
    if (statuses.includes(s)) return s;
  }
  return statuses[0] || 'draft';
}

export default function GroupsPage() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [groups, setGroups] = useState([]);
  const [members, setMembers] = useState([]);
  const [quotes, setQuotes] = useState([]);
  const [entities, setEntities] = useState([]);
  const [loading, setLoading] = useState(true);

  // New group creation state
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedClients, setSelectedClients] = useState([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [newClientName, setNewClientName] = useState('');
  const [newClientType, setNewClientType] = useState('limited_company');
  const [showNewClient, setShowNewClient] = useState(false);
  const [addingNew, setAddingNew] = useState(false);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [{ data: bg }, { data: bgm }, { data: q }, { data: ent }] = await Promise.all([
        supabase.from('billing_groups').select('*').order('name'),
        supabase.from('billing_group_members').select('*'),
        supabase.from('quotes').select('id, group_id, status, monthly_gross, annual_total').not('group_id', 'is', null),
        supabase.from('entities').select('id, name, company_number'),
      ]);
      setGroups(bg || []);
      setMembers(bgm || []);
      setQuotes(q || []);
      setEntities(ent || []);
    } catch {}
    setLoading(false);
  };

  // Build lookup maps
  const membersByGroup = {};
  members.forEach(m => {
    if (!membersByGroup[m.group_id]) membersByGroup[m.group_id] = [];
    membersByGroup[m.group_id].push(m);
  });

  const quotesByGroup = {};
  quotes.forEach(q => {
    if (!quotesByGroup[q.group_id]) quotesByGroup[q.group_id] = [];
    quotesByGroup[q.group_id].push(q);
  });

  // Client search results
  const filteredEntities = searchTerm.trim()
    ? entities.filter(e =>
        !selectedClients.find(s => s.id === e.id) &&
        (e.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
         e.company_number?.toLowerCase().includes(searchTerm.toLowerCase()))
      ).slice(0, 8)
    : [];

  const handleAddClient = (entity) => {
    if (!selectedClients.find(c => c.id === entity.id)) {
      setSelectedClients(prev => [...prev, entity]);
    }
    setSearchTerm('');
  };

  const handleRemoveClient = (id) => {
    setSelectedClients(prev => prev.filter(c => c.id !== id));
  };

  const handleCreateNewClient = async () => {
    if (!newClientName.trim()) return;
    setAddingNew(true);
    try {
      const { data: newEnt, error: err } = await supabase
        .from('entities')
        .insert({ name: newClientName.trim(), type: newClientType })
        .select().single();
      if (err) throw err;
      setSelectedClients(prev => [...prev, newEnt]);
      setEntities(prev => [...prev, newEnt]);
      setNewClientName('');
      setShowNewClient(false);
    } catch (e) {
      setError(e.message || 'Failed to create client');
    }
    setAddingNew(false);
  };

  const handleCreateGroup = async () => {
    if (selectedClients.length === 0) { setError('Add at least one client.'); return; }
    const groupName = newName.trim() || selectedClients.map(c => c.name).join(' & ');
    setCreating(true);
    setError('');
    try {
      const { data: group, error: gErr } = await supabase
        .from('billing_groups')
        .insert({ name: groupName })
        .select()
        .single();
      if (gErr) throw gErr;

      for (const client of selectedClients) {
        await supabase.from('billing_group_members')
          .upsert({ entity_id: client.id, group_id: group.id });
      }

      navigate(`/manage/quotes/group/${group.id}`);
    } catch (e) {
      setError(e.message || 'Failed to create group.');
    }
    setCreating(false);
  };

  if (loading) {
    return <div className="p-6"><p className="text-sm text-gray-400">Loading groups...</p></div>;
  }

  return (
    <div className="p-6 max-w-4xl">
      {/* Header */}
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-bold text-ocean-700">Groups</h2>
        <Btn onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? 'Cancel' : 'New Group'}
        </Btn>
      </div>

      {/* New Group Panel — Step by step */}
      {showCreate && (
        <div className="bg-white rounded-lg border border-ocean-200 p-4 mb-4">
          <h3 className="text-sm font-semibold text-ocean-700 mb-1">Create New Group</h3>
          <p className="text-xs text-gray-400 mb-3">Add clients one at a time, then name the group and create it.</p>
          {error && <div className="text-xs text-red-600 bg-red-50 rounded p-2 mb-3">{error}</div>}

          {/* Step 1: Clients added so far */}
          {selectedClients.length > 0 && (
            <div className="mb-3">
              <label className="text-xs text-gray-500 block mb-1.5">Clients in this group ({selectedClients.length})</label>
              <div className="space-y-1">
                {selectedClients.map((c, i) => (
                  <div key={c.id} className="flex items-center justify-between bg-ocean-50 border border-ocean-100 rounded-lg px-3 py-2">
                    <div>
                      <span className="text-xs font-medium text-ocean-700">{i + 1}. {c.name}</span>
                      {c.company_number && <span className="text-xs text-ocean-400 ml-2">{c.company_number}</span>}
                      <span className="text-[10px] text-ocean-400 ml-2 capitalize">{c.type?.replace('_', ' ')}</span>
                    </div>
                    <button onClick={() => handleRemoveClient(c.id)} className="text-ocean-400 hover:text-red-500 text-sm">&times;</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Step 2: Add another client */}
          <div className="mb-3 bg-gray-50 rounded-lg p-3 border border-gray-100">
            <label className="text-xs font-medium text-gray-600 block mb-2">
              {selectedClients.length === 0 ? 'Add first client' : 'Add another client'}
            </label>

            {/* Search existing */}
            <div className="relative mb-2">
              <input
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                placeholder="Search existing clients..."
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
              />
              {filteredEntities.length > 0 && (
                <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                  {filteredEntities.map(e => (
                    <button
                      key={e.id}
                      onClick={() => handleAddClient(e)}
                      className="w-full text-left px-3 py-2.5 text-xs hover:bg-ocean-50 border-b border-gray-50 last:border-0"
                    >
                      <span className="font-medium text-gray-700">{e.name}</span>
                      {e.company_number && <span className="text-gray-400 ml-2">{e.company_number}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Or create new */}
            {!showNewClient ? (
              <button onClick={() => setShowNewClient(true)} className="text-xs text-ocean-600 hover:text-ocean-700 font-medium">
                + Create new client
              </button>
            ) : (
              <div className="bg-white border border-gray-200 rounded-lg p-3 mt-1">
                <p className="text-xs text-gray-500 mb-2">New client details</p>
                <input
                  value={newClientName}
                  onChange={e => setNewClientName(e.target.value)}
                  placeholder="Client name"
                  className="w-full text-sm border border-gray-200 rounded px-2 py-1.5 mb-2"
                />
                <select value={newClientType} onChange={e => setNewClientType(e.target.value)} className="w-full text-sm border border-gray-200 rounded px-2 py-1.5 bg-white mb-2">
                  <option value="limited_company">Limited Company</option>
                  <option value="sole_trader">Sole Trader</option>
                  <option value="partnership">Partnership</option>
                  <option value="llp">LLP</option>
                </select>
                <div className="flex gap-2">
                  <Btn onClick={handleCreateNewClient} disabled={addingNew || !newClientName.trim()} variant="secondary" className="text-xs py-1 px-3">
                    {addingNew ? 'Adding...' : 'Add Client'}
                  </Btn>
                  <button onClick={() => { setShowNewClient(false); setNewClientName(''); }} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                </div>
              </div>
            )}
          </div>

          {/* Step 3: Name group and create */}
          {selectedClients.length >= 1 && (
            <div className="border-t border-gray-100 pt-3">
              <label className="text-xs text-gray-500 block mb-1">Group name</label>
              <input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder={selectedClients.map(c => c.name).join(' & ') || 'e.g. Acme Group'}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 mb-3"
              />
              <div className="flex gap-2">
                <Btn onClick={handleCreateGroup} disabled={creating || selectedClients.length === 0}>
                  {creating ? 'Creating...' : `Create Group (${selectedClients.length} clients)`}
                </Btn>
                <Btn onClick={() => { setShowCreate(false); setSelectedClients([]); setNewName(''); setError(''); }} variant="ghost">Cancel</Btn>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Groups List */}
      {groups.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-6 text-center">
          <p className="text-sm text-gray-400 mb-3">No billing groups yet. Create one to get started.</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          {/* Column headers */}
          <div
            className="grid gap-2 px-4 py-2 border-b border-gray-200 bg-gray-50"
            style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr' }}
          >
            <span className="text-xs text-gray-400 font-medium">Group Name</span>
            <span className="text-xs text-gray-400 font-medium text-right">Entities</span>
            <span className="text-xs text-gray-400 font-medium text-right">Monthly DD</span>
            <span className="text-xs text-gray-400 font-medium text-right">Status</span>
          </div>
          {/* Rows */}
          {groups.map(g => {
            const gMembers = membersByGroup[g.id] || [];
            const gQuotes = quotesByGroup[g.id] || [];
            const totalMonthlyGross = gQuotes.reduce((s, q) => s + (Number(q.monthly_gross) || 0), 0);
            const status = worstStatus(gQuotes);

            return (
              <div
                key={g.id}
                onClick={() => navigate(`/manage/quotes/group/${g.id}`)}
                className="grid gap-2 px-4 py-2.5 border-b border-gray-50 last:border-0 cursor-pointer items-center text-xs hover:bg-gray-50 transition-all"
                style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr' }}
              >
                <span className="font-medium text-gray-700 truncate">{g.name}</span>
                <span className="text-right text-gray-500">{gMembers.length}</span>
                <span className="text-right font-mono text-ocean-600">{fmt(totalMonthlyGross)}</span>
                <span className="text-right"><StatusBadge status={status} /></span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
