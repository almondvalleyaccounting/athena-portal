import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { fmt, StatusBadge, Btn } from '../components/ui';

const STATUSES = ['all', 'draft', 'pending_approval', 'approved', 'sent', 'accepted', 'declined', 'expired'];
const STATUS_LABELS = { all: 'All', draft: 'Draft', pending_approval: 'Pending', approved: 'Approved', sent: 'Sent', accepted: 'Accepted', declined: 'Declined', expired: 'Expired' };

export default function QuotesPage() {
  const navigate = useNavigate();
  const [quotes, setQuotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState('created_at');
  const [sortAsc, setSortAsc] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [creatingGroup, setCreatingGroup] = useState(false);

  const toggleSelect = (id, e) => {
    e.stopPropagation();
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleCreateGroup = async () => {
    if (selected.size < 2) return;
    setCreatingGroup(true);
    try {
      const selectedQuotes = quotes.filter(q => selected.has(q.id));
      const groupName = selectedQuotes.map(q => q.relationship_group || 'Entity').join(' + ');

      const { data: group } = await supabase
        .from('billing_groups')
        .insert({ name: groupName })
        .select().single();

      // Link all selected quotes to the group
      for (const q of selectedQuotes) {
        await supabase.from('quotes').update({ group_id: group.id }).eq('id', q.id);
        if (q.entity_id) {
          await supabase.from('billing_group_members')
            .upsert({ entity_id: q.entity_id, group_id: group.id });
        }
      }

      navigate('/manage/quotes/group/' + group.id);
    } catch (e) {
      console.error(e);
    }
    setCreatingGroup(false);
  };

  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase
          .from('quotes')
          .select('*, created_by_profile:staff_profiles!created_by(name)')
          .order('created_at', { ascending: false });
        setQuotes(data || []);
      } catch {}
      setLoading(false);
    })();
  }, []);

  const filtered = useMemo(() => {
    let list = quotes;
    if (statusFilter !== 'all') list = list.filter(q => q.status === statusFilter);
    if (search) {
      const s = search.toLowerCase();
      list = list.filter(q =>
        q.quote_ref?.toLowerCase().includes(s) ||
        q.relationship_group?.toLowerCase().includes(s)
      );
    }
    // Sort
    list = [...list].sort((a, b) => {
      let va = a[sortCol], vb = b[sortCol];
      if (sortCol === 'created_at') { va = new Date(va); vb = new Date(vb); }
      if (sortCol === 'monthly_gross' || sortCol === 'annual_total') { va = va || 0; vb = vb || 0; }
      if (sortCol === 'quote_ref' || sortCol === 'relationship_group' || sortCol === 'status') { va = (va || '').toLowerCase(); vb = (vb || '').toLowerCase(); }
      if (va < vb) return sortAsc ? -1 : 1;
      if (va > vb) return sortAsc ? 1 : -1;
      return 0;
    });
    return list;
  }, [quotes, statusFilter, search, sortCol, sortAsc]);

  const statusCounts = useMemo(() => {
    const c = { all: quotes.length };
    STATUSES.forEach(s => { if (s !== 'all') c[s] = quotes.filter(q => q.status === s).length; });
    return c;
  }, [quotes]);

  const toggleSort = (col) => {
    if (sortCol === col) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(true); }
  };

  const SortHeader = ({ col, children, className = '' }) => (
    <button onClick={() => toggleSort(col)} className={`text-left text-xs text-gray-400 hover:text-gray-600 flex items-center gap-0.5 ${className}`}>
      {children}
      {sortCol === col && <span className="text-ocean-500">{sortAsc ? '\u25B2' : '\u25BC'}</span>}
    </button>
  );

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-bold text-ocean-700">Quotes</h2>
        <div className="flex gap-2">
          {selected.size >= 2 && (
            <Btn onClick={handleCreateGroup} disabled={creatingGroup} variant="primary">
              {creatingGroup ? 'Creating...' : `Group ${selected.size} Quotes`}
            </Btn>
          )}
          <Btn onClick={() => navigate('/manage/quotes/new')}>New Quote</Btn>
        </div>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-1 mb-3 flex-wrap">
        {STATUSES.filter(s => s === 'all' || statusCounts[s] > 0).map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`text-xs px-3 py-1.5 rounded-full border transition-all ${
              statusFilter === s
                ? 'bg-ocean-600 text-white border-ocean-600'
                : 'bg-white text-gray-500 border-gray-200 hover:border-ocean-300'
            }`}
          >
            {STATUS_LABELS[s]}
            <span className="ml-1 opacity-60">{statusCounts[s]}</span>
          </button>
        ))}
      </div>

      {/* Search */}
      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search by quote ref or client name..."
        className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 mb-3"
      />

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-6 text-center">
          <p className="text-sm text-gray-400 mb-3">
            {quotes.length === 0 ? 'No quotes yet. Create your first quote to get started.' : 'No quotes match your filters.'}
          </p>
          {quotes.length === 0 && <Btn onClick={() => navigate('/manage/quotes/new')}>New Quote</Btn>}
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          {/* Column headers */}
          <div className="grid gap-2 px-4 py-2 border-b border-gray-200 bg-gray-50" style={{ gridTemplateColumns: '24px 2fr 1.5fr 1fr 1fr 1fr 1fr' }}>
            <span></span>
            <SortHeader col="quote_ref">Quote Ref</SortHeader>
            <SortHeader col="relationship_group">Client</SortHeader>
            <SortHeader col="status">Status</SortHeader>
            <SortHeader col="monthly_gross" className="justify-end">Monthly DD</SortHeader>
            <SortHeader col="annual_total" className="justify-end">Annual</SortHeader>
            <SortHeader col="created_at" className="justify-end">Created</SortHeader>
          </div>
          {/* Rows */}
          {filtered.map(q => (
            <div
              key={q.id}
              onClick={() => navigate('/manage/quotes/' + q.id)}
              className="grid gap-2 px-4 py-2.5 border-b border-gray-50 last:border-0 hover:bg-gray-50 cursor-pointer items-center text-xs"
              style={{ gridTemplateColumns: '24px 2fr 1.5fr 1fr 1fr 1fr 1fr' }}
            >
              <input
                type="checkbox"
                checked={selected.has(q.id)}
                onChange={(e) => toggleSelect(q.id, e)}
                onClick={(e) => e.stopPropagation()}
                className="w-3 h-3 accent-ocean-600"
              />
              <span className="font-medium text-gray-700 truncate">
                {q.quote_ref}
                {q.group_id && <span className="ml-1 text-[9px] bg-ocean-50 text-ocean-600 px-1 rounded">group</span>}
              </span>
              <span className="text-gray-500 truncate">{q.relationship_group || '\u2014'}</span>
              <span><StatusBadge status={q.status} /></span>
              <span className="text-right font-mono text-ocean-600">{fmt(q.monthly_gross)}</span>
              <span className="text-right font-mono text-gray-500">{fmt(q.annual_total)}</span>
              <div className="text-right">
                <span className="text-gray-500">{new Date(q.created_at).toLocaleDateString('en-GB')}</span>
                {q.created_by_profile?.name && (
                  <p className="text-gray-400 text-[10px]">{q.created_by_profile.name}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
