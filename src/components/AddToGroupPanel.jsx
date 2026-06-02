import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { Btn, fmt } from './ui';

// Panel for adding a quote to a billing group (new or existing).
// Shows existing groups and quotes already in a group.
export default function AddToGroupPanel({ quote, profile, onDone }) {
  const navigate = useNavigate();
  const [groups, setGroups] = useState([]);
  const [selectedGroupId, setSelectedGroupId] = useState(null);
  const [newGroupName, setNewGroupName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [groupQuotes, setGroupQuotes] = useState([]); // other quotes in selected group

  // Load existing billing groups
  useEffect(() => {
    supabase.from('billing_groups').select('*').order('name')
      .then(({ data }) => setGroups(data || []));
  }, []);

  // If quote already in a group, show that group's quotes
  useEffect(() => {
    if (quote?.group_id) {
      setSelectedGroupId(quote.group_id);
      loadGroupQuotes(quote.group_id);
    }
  }, [quote?.group_id]);

  // Load quotes in a group
  const loadGroupQuotes = async (groupId) => {
    const { data } = await supabase
      .from('quotes')
      .select('id, quote_ref, relationship_group, monthly_gross, status')
      .eq('group_id', groupId)
      .order('created_at');
    setGroupQuotes(data || []);
  };

  const handleSelectGroup = (groupId) => {
    setSelectedGroupId(groupId);
    if (groupId) loadGroupQuotes(groupId);
    else setGroupQuotes([]);
  };

  const handleAddToGroup = async () => {
    setCreating(true);
    setError('');
    try {
      let groupId = selectedGroupId;

      // Create new group if needed
      if (!groupId && newGroupName) {
        const { data: newGroup, error: grpErr } = await supabase
          .from('billing_groups')
          .insert({ name: newGroupName, created_by: profile.id })
          .select().single();
        if (grpErr) throw grpErr;
        groupId = newGroup.id;

        // Add entity to billing_group_members if quote has an entity_id
        if (quote.entity_id) {
          await supabase.from('billing_group_members')
            .upsert({ entity_id: quote.entity_id, group_id: groupId });
        }
      }

      if (!groupId) {
        setError('Select a group or enter a name for a new one.');
        setCreating(false);
        return;
      }

      // Link this quote to the group
      const { error: updateErr } = await supabase
        .from('quotes')
        .update({ group_id: groupId })
        .eq('id', quote.id);
      if (updateErr) throw updateErr;

      // Add entity to billing_group_members
      if (quote.entity_id) {
        await supabase.from('billing_group_members')
          .upsert({ entity_id: quote.entity_id, group_id: groupId });
      }

      // Navigate to group detail
      navigate('/manage/quotes/group/' + groupId);
    } catch (e) {
      setError(e.message || 'Failed to add to group');
    }
    setCreating(false);
  };

  const alreadyInGroup = quote?.group_id != null;

  return (
    <div className="bg-white rounded-lg border border-ocean-200 p-4">
      <h3 className="text-xs font-semibold text-ocean-600 uppercase mb-3">
        {alreadyInGroup ? 'Group' : 'Add to Group'}
      </h3>

      {error && <div className="text-xs text-red-600 bg-red-50 rounded p-2 mb-2">{error}</div>}

      {alreadyInGroup ? (
        <>
          <p className="text-xs text-gray-500 mb-2">This quote is in a billing group with {groupQuotes.length} quote(s).</p>
          {groupQuotes.filter(q => q.id !== quote.id).map(q => (
            <div key={q.id} onClick={() => navigate('/manage/quotes/' + q.id)} className="flex justify-between text-xs py-1.5 border-b border-gray-50 cursor-pointer hover:bg-gray-50 rounded px-1">
              <span className="text-gray-700">{q.relationship_group || q.quote_ref}</span>
              <span className="font-mono text-ocean-600">{fmt(q.monthly_gross)}/mo</span>
            </div>
          ))}
        </>
      ) : (
        <>
          {/* Existing groups */}
          {groups.length > 0 && (
            <div className="mb-3">
              <label className="text-xs text-gray-500 mb-1 block">Existing group</label>
              <select
                value={selectedGroupId || ''}
                onChange={(e) => handleSelectGroup(e.target.value || null)}
                className="w-full text-xs border border-gray-200 rounded px-2 py-1.5 bg-white"
              >
                <option value="">New group...</option>
                {groups.map(g => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* New group name */}
          {!selectedGroupId && (
            <div className="mb-3">
              <label className="text-xs text-gray-500 mb-1 block">Group name</label>
              <input
                value={newGroupName}
                onChange={e => setNewGroupName(e.target.value)}
                placeholder="e.g. Acme Group"
                className="w-full text-xs border border-gray-200 rounded px-2 py-1.5"
              />
            </div>
          )}

          {/* Quotes already in selected group */}
          {selectedGroupId && groupQuotes.length > 0 && (
            <div className="mb-3">
              <p className="text-xs text-gray-400 mb-1">Quotes in this group:</p>
              {groupQuotes.map(q => (
                <div key={q.id} className="flex justify-between text-xs py-1 border-b border-gray-50">
                  <span className="text-gray-600">{q.relationship_group || q.quote_ref}</span>
                  <span className="font-mono text-ocean-600">{fmt(q.monthly_gross)}/mo</span>
                </div>
              ))}
            </div>
          )}

          <Btn onClick={handleAddToGroup} disabled={creating || (!selectedGroupId && !newGroupName)}>
            {creating ? 'Adding...' : 'Add to Group'}
          </Btn>
        </>
      )}
    </div>
  );
}
