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
  const [selectMode, setSelectMode] = useState(false);
  const [acting, setActing] = useState(false);

  const loadQuotes = async () => {
    try {
      const { data } = await supabase
        .from('quotes')
        .select('*')
        .order('created_at', { ascending: false });
      setQuotes(data || []);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { loadQuotes(); }, []);

  const toggleSelect = (id, e) => {
    e.stopPropagation();
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map(q => q.id)));
  };

  const exitSelectMode = () => { setSelectMode(false); setSelected(new Set()); };

  const selectedQuotes = quotes.filter(q => selected.has(q.id));

  // ── Batch actions ──
  const batchUpdateStatus = async (newStatus) => {
    setActing(true);
    for (const q of selectedQuotes) {
      await supabase.from('quotes').update({ status: newStatus }).eq('id', q.id);
    }
    await loadQuotes();
    setSelected(new Set());
    setActing(false);
  };

  const handleCreateGroup = async () => {
    if (selected.size < 2) return;
    setActing(true);
    try {
      const groupName = selectedQuotes.map(q => q.relationship_group || 'Entity').join(' + ');
      const { data: group } = await supabase
        .from('billing_groups')
        .insert({ name: groupName })
        .select().single();

      for (const q of selectedQuotes) {
        await supabase.from('quotes').update({ group_id: group.id }).eq('id', q.id);
        if (q.entity_id) {
          await supabase.from('billing_group_members')
            .upsert({ entity_id: q.entity_id, group_id: group.id });
        }
      }
      navigate('/manage/quotes/group/' + group.id);
    } catch (e) { console.error(e); }
    setActing(false);
  };

  // What batch actions are available based on selected quotes' statuses
  const selectedStatuses = new Set(selectedQuotes.map(q => q.status));
  const canSubmit = selectedStatuses.size === 1 && selectedStatuses.has('draft');
  const canApprove = selectedStatuses.size === 1 && selectedStatuses.has('pending_approval');
  const canMarkSent = selectedStatuses.size === 1 && selectedStatuses.has('approved');
  const canGroup = selected.size >= 2;

  // ── Filtering & sorting ──
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

  const gridCols = selectMode
    ? '24px 2fr 1.5fr 1fr 1fr 1fr 1fr'
    : '2fr 1.5fr 1fr 1fr 1fr 1fr';

  return (
    <div className="p-6 max-w-4xl">
      {/* Header */}
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-bold text-ocean-700">Quotes</h2>
        <div className="flex gap-2">
          {!selectMode ? (
            <>
              <Btn onClick={() => setSelectMode(true)} variant="ghost">Select</Btn>
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
          {canGroup && <Btn onClick={handleCreateGroup} disabled={acting} variant="secondary" className="text-xs py-1 px-2">Group</Btn>}
          {canSubmit && <Btn onClick={() => batchUpdateStatus('pending_approval')} disabled={acting} variant="secondary" className="text-xs py-1 px-2">Submit for Approval</Btn>}
          {canApprove && <Btn onClick={() => batchUpdateStatus('approved')} disabled={acting} variant="primary" className="text-xs py-1 px-2">Approve</Btn>}
          {canMarkSent && <Btn onClick={() => batchUpdateStatus('sent')} disabled={acting} variant="secondary" className="text-xs py-1 px-2">Mark Sent</Btn>}
          {!canSubmit && !canApprove && !canMarkSent && !canGroup && (
            <span className="text-xs text-gray-400">No batch actions available for this selection</span>
          )}
        </div>
      )}

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
          <div className="grid gap-2 px-4 py-2 border-b border-gray-200 bg-gray-50" style={{ gridTemplateColumns: gridCols }}>
            {selectMode && (
              <input
                type="checkbox"
                checked={selected.size === filtered.length && filtered.length > 0}
                onChange={selectAll}
                className="w-3 h-3 accent-ocean-600"
              />
            )}
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
              onClick={() => selectMode ? toggleSelect(q.id, { stopPropagation: () => {} }) : navigate('/manage/quotes/' + q.id)}
              className={`grid gap-2 px-4 py-2.5 border-b border-gray-50 last:border-0 cursor-pointer items-center text-xs transition-all ${
                selected.has(q.id) ? 'bg-ocean-50' : 'hover:bg-gray-50'
              }`}
              style={{ gridTemplateColumns: gridCols }}
            >
              {selectMode && (
                <input
                  type="checkbox"
                  checked={selected.has(q.id)}
                  onChange={(e) => toggleSelect(q.id, e)}
                  onClick={(e) => e.stopPropagation()}
                  className="w-3 h-3 accent-ocean-600"
                />
              )}
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
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
